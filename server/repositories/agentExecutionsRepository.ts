/**
 * Bloco 16 — Fase D — Execution Journal do Agent Runtime.
 *
 * Persistência ADITIVA da tabela `public.agent_executions` criada pela
 * migration 20260816_agent_executions (RLS ON, zero policies públicas,
 * CHECKs fechados, idempotência real por intention_key).
 *
 * Fronteiras preservadas:
 *   POLICY != EXECUTION · DECISION != EXECUTION
 *   ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL
 *   EXECUTOR != AUTHORITY
 *
 * Este repositório NUNCA autoriza, executa ou aprova nada. Ele apenas
 * grava o registro auditável da execução governada produzida pelo
 * pipeline (decisão do Policy Engine + estado de aprovação + resultado
 * sanitizado) e permite a leitura read-only do journal.
 *
 * Padrão injetável dos Blocos 13/14/15: cliente Supabase injetado por
 * setAgentExecutionClient em server.ts; clientes de teste via
 * setAgentExecutionClientForTests; SEM fallback silencioso — cliente
 * ausente produz missing_supabase explícito (fail-closed; nunca
 * transforma falha de journal em sucesso de execução).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson } from "../agentRuntime/execution";
import {
  sanitizeMetadata,
  sanitizeText,
} from "./policyJournalRepository";

// ============================================================================
// Catálogos fechados (espelho da migration 20260816_agent_executions)
// ============================================================================
const STORED_DECISIONS: ReadonlySet<string> = new Set([
  "ALLOW",
  "DENY",
  "REQUIRES_APPROVAL",
]);

const STORED_LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  "REQUESTED",
  "POLICY_EVALUATED",
  "DENIED",
  "WAITING_APPROVAL",
  "APPROVED",
  "PLANNED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

const STORED_EXECUTOR_STATUSES: ReadonlySet<string> = new Set([
  "NOT_CONNECTED",
  "SKIPPED",
  "EXECUTED",
]);

const STORED_APPROVAL_STATES: ReadonlySet<string> = new Set([
  "NONE",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "NOT_REQUIRED",
]);

const STORED_REQUESTED_BY: ReadonlySet<string> = new Set([
  "operator",
  "operator-admin",
  "system",
]);

const STORED_RISKS: ReadonlySet<string> = new Set([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

// ============================================================================
// Contratos de leitura/escrita
// ============================================================================
export interface StoredExecution {
  execution_id: string;
  intention_key: string;
  agent_id: string;
  agent_version: string;
  policy_version: string;
  runtime_version: string;
  tool: string;
  action: string;
  risk: string;
  target_table: string;
  target_type: string;
  target_id: string | null;
  decision: string;
  reason_code: string;
  approval_state: string | null;
  approval_id: string | null;
  lifecycle_state: string;
  result_reference: string | null;
  error_code: string | null;
  error_message: string | null;
  input_fingerprint: string;
  input_reference: string;
  identity_context_digest: string;
  executor_status: string;
  executor_adapter_version: string | null;
  correlation_id: string | null;
  request_id: string;
  requested_by: string | null;
  evaluation_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

/** Saída de uma operação de escrita (padrão WriteOutcome dos Blocos 13–15). */
export interface ExecutionWriteResult {
  outcome:
    | "inserted"
    | "identical_duplicate"
    | "conflict_rejected"
    | "database_error"
    | "missing_supabase";
  record?: StoredExecution;
  error?: string;
  /** Verdadeiro quando o journal NÃO conseguiu gravar (fail-closed explícito). */
  journalFailure: boolean;
}

/**
 * Entrada de inserção do journal de execuções. Todos os valores passam por
 * sanitização — nunca grava input bruto, credenciais ou prompts.
 */
export interface ExecutionInsertInput {
  executionId: string;
  intentionKey: string;
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  runtimeVersion: string;
  tool: string;
  action: string;
  risk: string;
  targetTable: string;
  targetType: string;
  targetId?: string | null;
  decision: string;
  reasonCode: string;
  approvalState: string | null;
  approvalId?: string | null;
  lifecycleState: string;
  resultReference?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  inputFingerprint: string;
  inputReference: string;
  identityContextDigest: string;
  executorStatus: string;
  executorAdapterVersion?: string | null;
  correlationId?: string | null;
  requestId: string;
  requestedBy?: string | null;
  evaluationId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

// ============================================================================
// Cliente injetável (padrão dos Blocos 13/14/15)
// ============================================================================
const AGENT_EXECUTIONS_TABLE = "agent_executions";
const AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION = "1.0";

let client: SupabaseClient | null = null;

/** Cliente de PRODUÇÃO — injetado uma única vez em server.ts (service role). */
export function setAgentExecutionClient(
  productionClient: SupabaseClient,
): void {
  client = productionClient;
}

/** Cliente de TESTE — TEST-ONLY; produção nunca usa isto. */
export function setAgentExecutionClientForTests(
  testClient: SupabaseClient | null | undefined,
): void {
  client = testClient ?? null;
}

/** Estado de diagnóstico do repositório (auditável; usado em /health). */
export function getAgentExecutionClientState(): {
  configured: boolean;
} {
  return { configured: client !== null };
}

function requireClient(): SupabaseClient | null {
  return client;
}

// ============================================================================
// Validação de contrato (defesa, não reavaliação)
// ============================================================================
export function validateExecutionRecord(record: {
  decision: string;
  lifecycleState: string;
  executorStatus: string;
  risk: string;
  requestedBy?: string | null;
}): { valid: true } | { valid: false; error: string } {
  if (!STORED_DECISIONS.has(record.decision)) {
    return {
      valid: false,
      error: `decision inválida no catálogo fechado: ${record.decision}`,
    };
  }
  if (!STORED_LIFECYCLE_STATES.has(record.lifecycleState)) {
    return {
      valid: false,
      error: `lifecycle_state fora do catálogo fechado: ${record.lifecycleState}`,
    };
  }
  if (!STORED_EXECUTOR_STATUSES.has(record.executorStatus)) {
    return {
      valid: false,
      error: `executor_status fora do catálogo fechado: ${record.executorStatus}`,
    };
  }
  if (!STORED_RISKS.has(record.risk)) {
    return { valid: false, error: `risk inválido no catálogo fechado: ${record.risk}` };
  }
  if (
    record.requestedBy !== undefined &&
    record.requestedBy !== null &&
    !STORED_REQUESTED_BY.has(record.requestedBy)
  ) {
    return {
      valid: false,
      error: `requested_by fora do catálogo fechado: ${record.requestedBy}`,
    };
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
 * Persiste o registro de uma execução governada com idempotência real:
 * - mesma intention_key + mesmo contexto de identidade → identical_duplicate;
 * - mesma intention_key + contexto incompatível → conflict_rejected;
 * - Supabase indisponível → missing_supabase (NUNCA falha silenciosa).
 *
 * Falha de journal NUNCA transforma a decisão do Policy Engine em outra
 * coisa: o pipeline decide; o journal apenas registra.
 */
export async function insertExecution(
  input: ExecutionInsertInput,
): Promise<ExecutionWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "missing_supabase",
      error: "cliente Supabase indisponível; execution journal não gravado. A decisão e o plano da execução NÃO são afetados.",
      journalFailure: true,
    };
  }

  const validation = validateExecutionRecord({
    decision: input.decision,
    lifecycleState: input.lifecycleState,
    executorStatus: input.executorStatus,
    risk: input.risk,
    requestedBy: input.requestedBy,
  });
  if (validation.valid === false) {
    return {
      outcome: "conflict_rejected",
      error: validation.error,
      journalFailure: true,
    };
  }

  const inputReference =
    typeof input.inputReference === "string" ? sanitizeText(input.inputReference) : "";
  const errorMessage =
    typeof input.errorMessage === "string" ? sanitizeText(input.errorMessage) : null;
  const metadata = sanitizeMetadata(input.metadata ?? {}) as Record<string, unknown>;
  if (metadata.schema_version) {
    metadata.schema_version = AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION;
  }

  const row: Record<string, unknown> = {
    execution_id: String(input.executionId),
    intention_key: String(input.intentionKey),
    agent_id: String(input.agentId),
    agent_version: String(input.agentVersion),
    policy_version: String(input.policyVersion),
    runtime_version: String(input.runtimeVersion),
    tool: String(input.tool),
    action: String(input.action),
    risk: input.risk,
    target_table: String(input.targetTable),
    target_type: String(input.targetType),
    target_id: input.targetId ?? null,
    decision: input.decision,
    reason_code: String(input.reasonCode),
    approval_state: input.approvalState,
    approval_id: input.approvalId ?? null,
    lifecycle_state: input.lifecycleState,
    result_reference: input.resultReference ?? null,
    error_code: input.errorCode ?? null,
    error_message: errorMessage,
    input_fingerprint: String(input.inputFingerprint),
    input_reference: inputReference,
    identity_context_digest: String(input.identityContextDigest),
    executor_status: input.executorStatus,
    executor_adapter_version: input.executorAdapterVersion ?? null,
    correlation_id: input.correlationId ?? null,
    request_id: String(input.requestId),
    requested_by: input.requestedBy ?? null,
    evaluation_id: input.evaluationId ?? null,
    started_at: input.startedAt ?? null,
    finished_at: input.finishedAt ?? null,
    metadata,
  };

  // Idempotência: consulta explícita ANTES do insert (a constraint UNIQUE
  // de intention_key+identity_context_digest é a rede de segurança, mas a
  // decisão identical vs conflict exige comparação de conteúdo).
  try {
    const { data: existing } = await supabase
      .from(AGENT_EXECUTIONS_TABLE)
      .select("*")
      .eq("intention_key", input.intentionKey)
      .eq("identity_context_digest", input.identityContextDigest)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return await resolveDuplicate(input.intentionKey, input.identityContextDigest, input.executionId, row);
    }
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : "erro desconhecido";
    return {
      outcome: "database_error",
      error: `falha ao verificar duplicidade: ${message}`,
      journalFailure: true,
    };
  }

  try {
    const { data, error } = await supabase
      .from(AGENT_EXECUTIONS_TABLE)
      .insert(row)
      .select()
      .single();
    if (error) {
      if (isIdempotencyViolation(error)) {
        return await resolveDuplicate(input.intentionKey, input.identityContextDigest, input.executionId, row);
      }
      return {
        outcome: "database_error",
        error: error.message,
        journalFailure: true,
      };
    }
    return {
      outcome: "inserted",
      record: (data ?? row) as StoredExecution,
      journalFailure: false,
    };
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : "erro desconhecido";
    if (isIdempotencyViolation({ message })) {
      return await resolveDuplicate(input.intentionKey, input.identityContextDigest, input.executionId, row);
    }
    return {
      outcome: "database_error",
      error: message,
      journalFailure: true,
    };
  }
}

/**
 * Atualiza o estado de lifecycle de uma execução já persistida (transições
 * fechadas da máquina da Fase A). O update é restritivo: somente as
 * colunas de resultado podem mudar; identity/decisão/plan são imutáveis
 * por construção (sem column-targeted update nessas colunas).
 */
export async function updateExecutionState(
  executionId: string,
  parts: {
    lifecycleState: string;
    resultReference?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    executorStatus?: string | null;
    executorAdapterVersion?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ExecutionWriteResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      outcome: "missing_supabase",
      error: "cliente Supabase indisponível; estado não atualizado.",
      journalFailure: true,
    };
  }
  if (!STORED_LIFECYCLE_STATES.has(parts.lifecycleState)) {
    return {
      outcome: "conflict_rejected",
      error: `lifecycle_state fora do catálogo fechado: ${parts.lifecycleState}`,
      journalFailure: true,
    };
  }

  const patch: Record<string, unknown> = {
    lifecycle_state: parts.lifecycleState,
  };
  if (parts.resultReference !== undefined) patch.result_reference = parts.resultReference;
  if (parts.errorCode !== undefined) patch.error_code = parts.errorCode;
  if (parts.errorMessage !== undefined) {
    patch.error_message =
      typeof parts.errorMessage === "string" ? sanitizeText(parts.errorMessage) : null;
  }
  if (parts.executorStatus !== undefined) {
    if (!STORED_EXECUTOR_STATUSES.has(parts.executorStatus)) {
      return {
        outcome: "conflict_rejected",
        error: `executor_status fora do catálogo fechado: ${parts.executorStatus}`,
        journalFailure: true,
      };
    }
    patch.executor_status = parts.executorStatus;
  }
  if (parts.executorAdapterVersion !== undefined) {
    patch.executor_adapter_version = parts.executorAdapterVersion;
  }
  if (parts.startedAt !== undefined) patch.started_at = parts.startedAt;
  if (parts.finishedAt !== undefined) patch.finished_at = parts.finishedAt;
  if (parts.metadata !== undefined) {
    patch.metadata = sanitizeMetadata(parts.metadata) as Record<string, unknown>;
  }

  try {
    const { data, error } = await supabase
      .from(AGENT_EXECUTIONS_TABLE)
      .update(patch)
      .eq("execution_id", executionId)
      .select()
      .single();
    if (error) {
      return {
        outcome: "database_error",
        error: error.message,
        journalFailure: true,
      };
    }
    return {
      outcome: "inserted",
      record: (data ?? { execution_id: executionId, ...patch }) as StoredExecution,
      journalFailure: false,
    };
  } catch (caught: unknown) {
    return {
      outcome: "database_error",
      error: caught instanceof Error ? caught.message : "erro ao atualizar estado",
      journalFailure: true,
    };
  }
}

/** Resolve um duplicate: idêntico → identical_duplicate; conflitante → conflict_rejected. */
async function resolveDuplicate(
  intentionKey: string,
  identityContextDigest: string,
  executionId: string,
  candidate: Record<string, unknown>,
): Promise<ExecutionWriteResult> {
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
      .from(AGENT_EXECUTIONS_TABLE)
      .select("*")
      .eq("intention_key", intentionKey)
      .eq("identity_context_digest", identityContextDigest)
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      return {
        outcome: "database_error",
        error: error?.message ?? "registro duplicado não localizado",
        journalFailure: true,
      };
    }
    const existing = data as StoredExecution;
    // Mesmo intention_key + mesmo digest de contexto = mesma intenção. O
    // execution_id derivado é determinístico: divergência só se o contexto
    // declaratório mudar, o que a consulta já eliminou.
    const sameExecutionId = existing.execution_id === executionId;
    const sameDecision = existing.decision === candidate.decision;
    const sameMetadata =
      canonicalJson(existing.metadata) === canonicalJson(candidate.metadata);
    if (sameExecutionId && sameDecision && sameMetadata) {
      return {
        outcome: "identical_duplicate",
        record: existing,
        journalFailure: false,
      };
    }
    return {
      outcome: "conflict_rejected",
      error: `conteúdo incompatível para intention_key "${intentionKey}" (execution_id, decisão ou metadados divergem)`,
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

// ============================================================================
// Leitura read-only do journal (admin-only via rota)
// ============================================================================
export interface ExecutionListParams {
  executionId?: string;
  intentionKey?: string;
  decision?: string;
  lifecycleState?: string;
  page?: number;
  pageSize?: number;
}

export interface ExecutionListResult {
  success: boolean;
  executions?: StoredExecution[];
  total?: number;
  error?: string;
}

/**
 * Consulta read-only do journal. `missing_supabase` quando indisponível —
 * nunca inventa registros.
 */
export async function listExecutions(
  params: ExecutionListParams = {},
): Promise<ExecutionListResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      success: false,
      error: "cliente Supabase indisponível; journal não consultável.",
    };
  }
  const page = Math.max(1, Math.min(params.page ?? 1, 100));
  const pageSize = Math.max(1, Math.min(params.pageSize ?? 20, 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    let query = supabase
      .from(AGENT_EXECUTIONS_TABLE)
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });
    if (params.executionId) query = query.eq("execution_id", params.executionId);
    if (params.intentionKey) query = query.eq("intention_key", params.intentionKey);
    if (params.decision) query = query.eq("decision", params.decision);
    if (params.lifecycleState) query = query.eq("lifecycle_state", params.lifecycleState);
    const { data, error, count } = await query.range(from, to);
    if (error) {
      return { success: false, error: error.message };
    }
    return {
      success: true,
      executions: (data ?? []) as StoredExecution[],
      total: count ?? 0,
    };
  } catch (caught: unknown) {
    return {
      success: false,
      error: caught instanceof Error ? caught.message : "erro ao consultar journal",
    };
  }
}

/** Consulta read-only por execution_id (única rota de leitura primária). */
export async function getExecution(
  executionId: string,
): Promise<ExecutionListResult> {
  const supabase = requireClient();
  if (!supabase) {
    return {
      success: false,
      error: "cliente Supabase indisponível; journal não consultável.",
    };
  }
  try {
    const { data, error } = await supabase
      .from(AGENT_EXECUTIONS_TABLE)
      .select("*")
      .eq("execution_id", executionId)
      .limit(1)
      .maybeSingle();
    if (error) {
      return { success: false, error: error.message };
    }
    if (!data) {
      return { success: true, executions: [], total: 0 };
    }
    return {
      success: true,
      executions: [data as StoredExecution],
      total: 1,
    };
  } catch (caught: unknown) {
    return {
      success: false,
      error: caught instanceof Error ? caught.message : "erro ao consultar execution",
    };
  }
}
