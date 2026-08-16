/**
 * Cerberus Finds Archive — Bloco 15 — Fase C — Decision Journal
 * Repositório de persistência das decisões do Policy Engine.
 *
 * Fronteiras: POLICY != EXECUTION · DECISION JOURNAL != EXECUTOR
 *             ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL
 *             MEMORY != AUTHORITY
 *
 * Este módulo registra o resultado do Policy Engine. Ele NÃO reavalia,
 * NÃO modifica decisão, NÃO infere ALLOW/DENY, NÃO altera reason_code,
 * NÃO aplica política própria. O journal armazena; o Policy Engine decide.
 *
 * Regras:
 * - Idempotência real via evaluation_id (PK) + request_fingerprint
 *   (UNIQUE). Duplicate idêntico → identical_duplicate; conteúdo
 *   conflitante → conflict_rejected; nunca falha silenciosa.
 * - Sem lock em memória como mecanismo de consistência: a concorrência
 *   é resolvida pelas constraints do banco (tratamento explícito do
 *   duplicate code 23505).
 * - Falha de persistência NUNCA vira ALLOW: o resultado WriteOutcome
 *   distingue explicitamente missing_supabase/database_error da decisão.
 * - Sanitização coerente com os Blocos 10/11/13/14: checks e metadata
 *   jamais contêm token, secret, password, authorization, prompt,
 *   instruction externa ou credenciais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PolicyDecision,
  PolicyEvaluationChecks,
  PolicyReasonCode,
} from "../policyEngine/types";

export const POLICY_EVALUATIONS_TABLE = "policy_evaluations" as const;
export const POLICY_JOURNAL_SCHEMA_VERSION = "1.0";

/** Digest determinístico: SHA-256 do JSON canônico (ordenado, estável). */
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  return `{${entries
    .map(([k, v]) => `${canonicalJson(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest do request completo, determinístico (evaluation idempotent key). */
export function requestFingerprint(
  decision: PolicyDecision & { context?: string; approvalState?: string }
): string {
  const payload = {
    agentId: decision.agentId,
    agentVersion: decision.agentVersion,
    policyVersion: decision.policyVersion,
    policyEngineVersion: decision.policyEngineVersion,
    tool: decision.tool,
    action: decision.action,
    risk: decision.risk,
    targetTable: decision.targetTable,
    memoryScope: decision.memoryScope,
    context: decision.context ?? null,
    approvalState: decision.approvalState ?? null,
  };
  return sha256(canonicalJson(payload));
}

/** Digest do contrato da decisão (integridade do registro). */
export function decisionFingerprint(decision: PolicyDecision): string {
  const payload = {
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    checks: decision.checks,
    policyEngineVersion: decision.policyEngineVersion,
  };
  return sha256(canonicalJson(payload));
}

export type StoredDecision = "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
export type StoredRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type StoredApprovalState =
  | "NONE"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | null;

export interface StoredEvaluation {
  evaluation_id: string;
  agent_id: string;
  agent_version: string;
  policy_version: string;
  policy_engine_version: string;
  policy_reason_code_version: string;
  decision: StoredDecision;
  reason_code: PolicyReasonCode;
  reason: string;
  tool: string;
  action: string;
  risk: StoredRisk;
  target_table: string;
  memory_scope: string;
  context: string | null;
  approval_state: StoredApprovalState;
  correlation_id: string | null;
  causation_id: string | null;
  request_fingerprint: string;
  decision_fingerprint: string;
  checks: Record<string, unknown>;
  metadata: Record<string, unknown>;
  schema_version: string;
  evaluated_at: string;
  created_at: string;
}

export type JournalWriteOutcome =
  | "inserted"
  | "identical_duplicate"
  | "conflict_rejected"
  | "missing_supabase"
  | "database_error";

export interface JournalWriteResult {
  outcome: JournalWriteOutcome;
  error?: string;
  record?: StoredEvaluation;
  /** Semântica CRÍTICA: journalFailure !== decisionDenied. A falha do
   *  journal nunca altera/autoriza a decisão do Policy Engine. */
  journalFailure: boolean;
}

export interface JournalInsertInput {
  decision: PolicyDecision;
  /** evaluation_id declarado pelo caller (determinístico; o journal não o inventa). */
  evaluationId: string;
  context?: string;
  approvalState?: StoredApprovalState;
  correlationId?: string | null;
  causationId?: string | null;
}

// ============================================================================
// Cliente injetável (padrão dos repositórios dos Blocos 13/14)
// ============================================================================
let client: SupabaseClient | null = null;

export function setPolicyJournalClientForTests(
  testClient: SupabaseClient | null | undefined,
): void {
  client = testClient ?? null;
}

export function setPolicyJournalClient(productionClient: SupabaseClient): void {
  client = productionClient;
}

function requireClient(): SupabaseClient | null {
  return client;
}

// ============================================================================
// Sanitização (coerente com os Blocos 10/11/13/14)
// ============================================================================
const CHECKS_SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "api_key",
  "rawcontent",
  "raw_content",
  "prompt",
  "system_prompt",
  "instruction",
]);

/**
 * Sanitiza o objeto checks: jamais pode conter credenciais ou conteúdo
 * bruto. O checks do Policy Engine é {request,agent,enabled,version,tool,
 * action,scope,risk} — esta função garante por construção e por filtragem.
 */
export function sanitizeChecks(
  checks: PolicyEvaluationChecks | Record<string, unknown>,
): Record<string, unknown> {
  const allowedKeys = new Set([
    "request",
    "agent",
    "enabled",
    "version",
    "tool",
    "action",
    "scope",
    "risk",
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checks)) {
    if (!allowedKeys.has(key)) continue;
    if (CHECKS_SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const METADATA_SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "password",
  "authorization",
  "api_key",
  "service_role",
  "supabase_secret",
  "raw_content",
  "rawcontent",
  "prompt",
  "system_prompt",
  "instruction",
  "credential",
  "credentials",
]);

export function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (METADATA_SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      sanitized[key] = sanitizeMetadata(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

/** Sanitiza texto livre (context): remove tokens/secrets conhecidos. */
export const TEXT_SENSITIVE_PATTERNS: ReadonlyArray<string> = [
  "Authorization:",
  "Bearer ",
  "sk-",
  "x-admin-password",
  "SUPABASE",
  "service_role",
  "TELEGRAM_BOT_TOKEN",
  "apikey",
];

export function sanitizeText(text: string): string {
  let sanitized = text;
  for (const pattern of TEXT_SENSITIVE_PATTERNS) {
    if (sanitized.toLowerCase().includes(pattern.toLowerCase())) {
      sanitized = sanitized.replace(
        new RegExp(pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi"),
        "[SANITIZED]"
      );
    }
  }
  return sanitized;
}

// ============================================================================
// Catálogo fechado de reason codes (espelho do Policy Engine)
// ============================================================================
const STORED_REASON_CODES: ReadonlySet<string> = new Set([
  "AGENT_NOT_FOUND",
  "AGENT_DISABLED",
  "AGENT_VERSION_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "TOOL_NOT_ALLOWED",
  "ACTION_NOT_ALLOWED",
  "TABLE_NOT_ALLOWED",
  "RISK_EXCEEDS_MAX",
  "MEMORY_SCOPE_NOT_ALLOWED",
  "TOOL_ACTION_MISMATCH",
  "ACTION_RISK_MISMATCH",
  "APPROVAL_REQUIRED",
  "CONTEXT_INVALID",
  "REQUEST_INVALID",
  "POLICY_ENGINE_ERROR",
  "TOOL_UNKNOWN",
  "ACTION_UNKNOWN",
  "TABLE_UNKNOWN",
  "MEMORY_SCOPE_UNKNOWN",
  "RISK_UNKNOWN",
  "VERSION_MISMATCH",
  "AGENT_UNKNOWN",
  "POLICY_ALLOW",
]);

const STORED_DECISIONS: ReadonlySet<string> = new Set([
  "ALLOW",
  "DENY",
  "REQUIRES_APPROVAL",
]);

const STORED_RISKS: ReadonlySet<string> = new Set([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

export function isValidStoredDecision(value: string): value is StoredDecision {
  return STORED_DECISIONS.has(value);
}

export function isValidStoredReasonCode(value: string): boolean {
  return STORED_REASON_CODES.has(value);
}

export function isValidStoredRisk(value: string): value is StoredRisk {
  return STORED_RISKS.has(value);
}

// ============================================================================
// Validação de contrato antes de persistir (defesa, não reavaliação)
// ============================================================================
export function validateEvaluationRecord(record: {
  decision: string;
  reason_code: string;
  risk: string;
}): { valid: true } | { valid: false; error: string } {
  if (!isValidStoredDecision(record.decision)) {
    return {
      valid: false,
      error: `decision inválida no catálogo fechado: ${record.decision}`,
    };
  }
  if (!isValidStoredReasonCode(record.reason_code)) {
    return {
      valid: false,
      error: `reason_code fora do catálogo fechado: ${record.reason_code}`,
    };
  }
  if (!isValidStoredRisk(record.risk)) {
    return { valid: false, error: `risk inválido no catálogo fechado: ${record.risk}` };
  }
  return { valid: true };
}

// ============================================================================
// Persistência com idempotência real
// ============================================================================
function isIdempotencyViolation(error: { message?: string; code?: string | number }): boolean {
  const code = String(error.code ?? "");
  return (
    code === "23505" ||
    (error.message ?? "").toLowerCase().includes("unique") ||
    (error.message ?? "").toLowerCase().includes("duplicate key")
  );
}

/**
 * Persiste uma decisão do Policy Engine com idempotência real:
 * - mesmo evaluation_id + conteúdo idêntico → identical_duplicate;
 * - mesmo evaluation_id + conteúdo incompatível → conflict_rejected;
 * - Supabase indisponível → missing_supabase (nunca falha silenciosa;
 *   o caller NUNCA transforma journalFailure em ALLOW).
 */
export async function insertEvaluation(
  input: JournalInsertInput,
): Promise<JournalWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "missing_supabase",
      error: "cliente Supabase indisponível; journal não gravado. A decisão do Policy Engine NÃO é afetada.",
      journalFailure: true,
    };
  }

  const validation = validateEvaluationRecord({
    decision: input.decision.decision,
    reason_code: input.decision.reasonCode,
    risk: input.decision.risk,
  });
  if (validation.valid === false) {
    return {
      outcome: "conflict_rejected",
      error: validation.error,
      journalFailure: true,
    };
  }

  const rf = requestFingerprint(
    input.decision as PolicyDecision & { context?: string; approvalState?: string }
  );
  const df = decisionFingerprint(input.decision);

  const contextSanitized =
    typeof input.context === "string" ? sanitizeText(input.context) : null;

  const row: Record<string, unknown> = {
    evaluation_id: input.evaluationId,
    agent_id: String(input.decision.agentId),
    agent_version: String(input.decision.agentVersion),
    policy_version: String(input.decision.policyVersion),
    policy_engine_version: String(input.decision.policyEngineVersion),
    policy_reason_code_version: "1.0",
    decision: input.decision.decision,
    reason_code: input.decision.reasonCode,
    reason: sanitizeText(String(input.decision.reason ?? "")),
    tool: String(input.decision.tool),
    action: String(input.decision.action),
    risk: input.decision.risk,
    target_table: String(input.decision.targetTable),
    memory_scope: String(input.decision.memoryScope),
    context: contextSanitized,
    approval_state: input.approvalState ?? null,
    correlation_id: input.correlationId ?? null,
    causation_id: input.causationId ?? null,
    request_fingerprint: rf,
    decision_fingerprint: df,
    checks: sanitizeChecks(input.decision.checks),
    metadata: {},
    schema_version: POLICY_JOURNAL_SCHEMA_VERSION,
    evaluated_at: input.decision.evaluatedAt,
  };

  // Verificação explícita de idempotência ANTES do insert: a constraint
  // UNIQUE de evaluation_id em produção atua como rede de segurança, mas
  // a decisão determinística de duplicate (identical vs conflict) precisa
  // de consulta explícita — não pode depender de exceção da PK.
  try {
    const { data: existing } = await supabase
      .from(POLICY_EVALUATIONS_TABLE)
      .select("*")
      .eq("evaluation_id", input.evaluationId)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return await resolveDuplicate(input.evaluationId, rf, df, row);
    }
  } catch (caught: unknown) {
    const message =
      caught instanceof Error ? caught.message : "erro desconhecido";
    return {
      outcome: "database_error",
      error: `falha ao verificar duplicidade: ${message}`,
      journalFailure: true,
    };
  }

  try {
    const { data, error } = await supabase
      .from(POLICY_EVALUATIONS_TABLE)
      .insert(row)
      .select()
      .single();
    if (error) {
      if (isIdempotencyViolation(error)) {
        return await resolveDuplicate(input.evaluationId, rf, df, row);
      }
      return {
        outcome: "database_error",
        error: error.message,
        journalFailure: true,
      };
    }
    return {
      outcome: "inserted",
      record: (data ?? row) as StoredEvaluation,
      journalFailure: false,
    };
  } catch (caught: unknown) {
    const message =
      caught instanceof Error ? caught.message : "erro desconhecido";
    if (isIdempotencyViolation({ message })) {
      return await resolveDuplicate(input.evaluationId, rf, df, row);
    }
    return {
      outcome: "database_error",
      error: message,
      journalFailure: true,
    };
  }
}

/** Resolve um duplicate: idêntico → identical_duplicate; conflitante → conflict_rejected. */
async function resolveDuplicate(
  evaluationId: string,
  requestFp: string,
  decisionFp: string,
  candidate: Record<string, unknown>,
): Promise<JournalWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "database_error",
      error: "cliente indisponível ao resolver duplicate",
      journalFailure: true,
    };
  }
  try {
    const { data, error } = await supabase
      .from(POLICY_EVALUATIONS_TABLE)
      .select("*")
      .eq("evaluation_id", evaluationId)
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return {
        outcome: "database_error",
        error: error?.message ?? "registro duplicado não localizado",
        journalFailure: true,
      };
    }
    const existing = data as StoredEvaluation;
    const sameRequest = existing.request_fingerprint === requestFp;
    const sameDecision = existing.decision_fingerprint === decisionFp;
    // Comparação canônica: o JSONB do Postgres não preserva ordem de
    // chaves; JSON.stringify ordem-dependente falsamente rejeitaria
    // duplicatas idênticas. Reuso da mesma canonicalJson dos fingerprints.
    const sameChecks =
      canonicalJson(existing.checks) === canonicalJson(candidate.checks);
    if (sameRequest && sameDecision && sameChecks) {
      return {
        outcome: "identical_duplicate",
        record: existing,
        journalFailure: false,
      };
    }
    return {
      outcome: "conflict_rejected",
      error: `conteúdo incompatível para evaluation_id "${evaluationId}" (request ou decisão divergente)`,
      journalFailure: true,
    };
  } catch (caught: unknown) {
    return {
      outcome: "database_error",
      error: caught instanceof Error ? caught.message : "erro ao resolver duplicate",
      journalFailure: true,
    };
  }
}

/**
 * Consulta read-only por evaluation_id (única rota de leitura primária).
 * Retorna missing_supabase quando o journal não pode ser consultado —
 * nunca inventa um registro.
 */
export async function getEvaluation(
  evaluationId: string,
): Promise<JournalWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "missing_supabase",
      error: "cliente Supabase indisponível",
      journalFailure: true,
    };
  }
  const { data, error } = await supabase
    .from(POLICY_EVALUATIONS_TABLE)
    .select("*")
    .eq("evaluation_id", evaluationId)
    .limit(1)
    .maybeSingle();
  if (error) {
    return { outcome: "database_error", error: error.message, journalFailure: true };
  }
  if (!data) {
    return {
      outcome: "missing_supabase",
      error: `avaliação não encontrada: ${evaluationId}`,
      journalFailure: false,
    };
  }
  return { outcome: "inserted", record: data as StoredEvaluation, journalFailure: false };
}

/**
 * Lista read-only paginada (admin), ordenada pela avaliação mais recente.
 * page/pageSize com defaults seguros; jamais expõe sensíveis.
 */
export async function listEvaluations(params?: {
  page?: number;
  pageSize?: number;
  decision?: StoredDecision | null;
}): Promise<JournalWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "missing_supabase",
      error: "cliente Supabase indisponível",
      journalFailure: true,
    };
  }
  const page = Math.max(1, Math.floor(params?.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params?.pageSize ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  let query = supabase
    .from(POLICY_EVALUATIONS_TABLE)
    .select("*", { count: "exact" })
    .order("evaluated_at", { ascending: false })
    .range(from, to);
  if (params?.decision && isValidStoredDecision(params.decision)) {
    query = query.eq("decision", params.decision);
  }
  const { data, error, count } = await query;
  if (error) {
    return { outcome: "database_error", error: error.message, journalFailure: true };
  }
  return {
    outcome: "inserted",
    record: {
      __list: true,
      evaluations: (data ?? []) as StoredEvaluation[],
      page,
      pageSize,
      total: count ?? 0,
    } as unknown as StoredEvaluation,
    journalFailure: false,
  };
}

/** Deriva o evaluation_id determinístico do request (mesma convenção usada
 *  pela Fase D quando o caller não declara um ID próprio). */
export function deriveEvaluationId(
  decision: PolicyDecision & { context?: string; approvalState?: string },
): string {
  return `pev-${requestFingerprint(decision)}`.slice(0, 64);
}
