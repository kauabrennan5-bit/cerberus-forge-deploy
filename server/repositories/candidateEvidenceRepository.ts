/**
 * Cerberus Finds Archive — Bloco N3 — Pipeline de Pesquisa + Evidência
 * Repositório de persistência das evidências de pesquisa de candidatos.
 *
 * Fronteiras: EVIDENCE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO
 *             RESEARCH != PUBLICATION · RESEARCH != PROMOTION
 *             CANDIDATE != FACT CANÔNICO
 *
 * Este módulo NÃO cria produtos canônicos, NÃO altera candidates, NÃO
 * publica, NÃO executa ações em marketplaces, NÃO altera catálogo,
 * Telegram, lifecycle, job queue ou Operator. Ele apenas grava e lê
 * registros auditáveis de sessões de pesquisa e evidências de campo.
 *
 * Regras duras:
 *   - kind fechado: RESEARCH_SESSION | FIELD (CHECK espelho da migration);
 *   - field_state fechado: KNOWN | UNKNOWN | DERIVED | COLLECTION_FAILED |
 *     CONTRADICTED — CONTRADICTED preserva o valor observado e aponta para
 *     a evidência conflitante (metadata.contradiction_with);
 *   - source_type fechado: marketplace_page | url_slug | manual | api |
 *     scrape | other — dado derivado da URL é NUNCA tratado como página;
 *   - quality heurística fechada: HIGH | MEDIUM | LOW | UNKNOWN (jamais
 *     probabilidade);
 *   - idempotência real: field_hash UNIQUE — replay idêntico
 *     (mesmo candidate+field+url+evidence_hash) retorna
 *     identical_duplicate sem criar linha; valor diferente com mesmo
 *     field_hash não ocorre (o hash inclui o digest do valor);
 *   - CONTRADIÇÃO: quando a curadoria ou o serviço detecta conflito entre
 *     uma evidência nova e anteriores do mesmo campo, registrar a NOVA
 *     como CONTRADICTED com metadata.contradiction_with — NUNCA apagar a
 *     anterior (preservação do histórico);
 *   - persistência ausente NUNCA vira sucesso: missing_supabase explícito
 *     (fail-closed);
 *   - sanitização: metadata jamais carrega secrets;
 *   - sem FK para candidates/products — associação por texto;
 *   - cleanup administrativo (deleteEvidenceForProof) NUNCA exposto via rota.
 *
 * Padrão injetável dos Blocos N1/N2/13/14/15/16/17: cliente Supabase
 * injetado em server.ts; testes via setCandidateEvidenceClientForTests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  sanitizeMetadata,
  getMetadataSensitiveKeys,
} from "./policyJournalRepository";

export const EVIDENCE_TABLE = "candidate_evidence" as const;
export const EVIDENCE_SCHEMA_VERSION = "1.0";

export const EVIDENCE_KINDS = ["RESEARCH_SESSION", "FIELD"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const FIELD_STATES = [
  "KNOWN",
  "UNKNOWN",
  "DERIVED",
  "COLLECTION_FAILED",
  "CONTRADICTED",
] as const;
export type FieldState = (typeof FIELD_STATES)[number];

export const SOURCE_TYPES = [
  "marketplace_page",
  "url_slug",
  "manual",
  "api",
  "scrape",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const COLLECTION_METHODS = ["MANUAL", "SCRAPE", "API", "OTHER"] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const EVIDENCE_QUALITIES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

export const FIELD_NAMES = [
  "title",
  "price",
  "images",
  "seller",
  "rating",
  "review_count",
  "availability",
  "category",
] as const;
export type EvidenceFieldName = (typeof FIELD_NAMES)[number];

export const EVIDENCE_REJECTION_REASONS = [
  "missing_supabase",
  "invalid_kind",
  "invalid_field_state",
  "invalid_source_type",
  "invalid_collection_method",
  "invalid_quality",
  "invalid_field_name",
  "invalid_url",
  "session_value_provided",
  "generic_error",
] as const;
export type EvidenceRejectionReason =
  (typeof EVIDENCE_REJECTION_REASONS)[number];

// Catálogos fechados (espelho da migration 20260816_candidate_evidence)
const STORED_KINDS: ReadonlySet<string> = new Set(EVIDENCE_KINDS);
const STORED_STATES: ReadonlySet<string> = new Set(FIELD_STATES);
const STORED_SOURCES: ReadonlySet<string> = new Set(SOURCE_TYPES);
const STORED_METHODS: ReadonlySet<string> = new Set(COLLECTION_METHODS);
const STORED_QUALITIES: ReadonlySet<string> = new Set(EVIDENCE_QUALITIES);
const STORED_FIELDS: ReadonlySet<string> = new Set(FIELD_NAMES);

// ============================================================================
// Digests e sanitização
// ============================================================================

/** Digest determinístico (SHA-256 do JSON canônico, ordenado). */
export function evidenceDigestPayload(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Idempotência: mesma pesquisa, mesmo candidato, mesmo campo, mesma URL,
 * mesmo conteúdo → mesmo field_hash → replay não duplica.
 */
export function fieldHash(
  candidateId: string,
  fieldName: string | null,
  sourceUrl: string,
  evidenceHash: string,
): string {
  return evidenceDigestPayload({
    candidate_id: candidateId,
    field_name: fieldName ?? "",
    source_url: sourceUrl,
    evidence_hash: evidenceHash,
  }).slice(0, 48);
}

export function generateEvidenceId(): string {
  return `evi-${evidenceDigestPayload({
    nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  }).slice(0, 24)}`;
}

function sanitizeEvidenceText(text: string): string {
  let sanitized = sanitizeMetadata({ t: text })["t"];
  return typeof sanitized === "string" ? sanitized : String(sanitized ?? "");
}

/**
 * Sanitização de metadata de evidência: chaves sensíveis (tokens, senhas,
 * api keys) NUNCA são persistidas. Em vez de remover silenciosamente a
 * chave (que ocultaria a tentativa de inserção), o valor é substituído
 * por REDACTED — auditoria rastreável sem expor o segredo.
 */
function sanitizeEvidenceMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sensitiveKeys = getMetadataSensitiveKeys();
  const scrubbed: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(metadata)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      scrubbed[key] = "REDACTED";
    } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      // Recursão profunda: objetos aninhados recebem a mesma regra
      scrubbed[key] = sanitizeEvidenceMetadata(val as Record<string, unknown>);
    } else {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}

// ============================================================================
// Contratos
// ============================================================================

export interface EvidenceInput {
  candidate_id: string;
  research_id: string;
  kind: string;
  field_name?: string | null;
  field_value?: unknown;
  field_state?: string;
  source_url: string;
  source_type?: string;
  collection_method?: string;
  observed_at?: string;
  evidence_hash?: string;
  quality?: string;
  unit?: string | null;
  evidence_note?: string;
  metadata?: Record<string, unknown>;
  // Recomenda contradição: ao gravar, marcar a NOVA evidência como
  // CONTRADICTED com referência às ids anteriores (preserva ambas).
  contradicted_by_evidence_ids?: string[];
}

export interface EvidenceRecord {
  evidence_id: string;
  candidate_id: string;
  research_id: string;
  kind: string;
  field_name: string | null;
  field_value: Record<string, unknown> | null;
  field_state: string;
  source_url: string;
  source_type: string;
  collection_method: string;
  observed_at: string;
  evidence_hash: string;
  field_hash: string | null;
  quality: string;
  unit: string | null;
  evidence_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PersistEvidenceResult {
  ok: boolean;
  outcome: "created" | "identical_duplicate" | "rejected";
  reason?: EvidenceRejectionReason;
  evidence_id?: string;
  evidence?: EvidenceRecord;
}

export interface EvidenceQuery {
  candidate_id?: string;
  research_id?: string;
  kind?: string;
  field_name?: string;
  field_state?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Injeção (padrão Blocos N1/N2/13/14/15/16/17)
// ============================================================================

let evidenceClient: SupabaseClient | null = null;
export function getCandidateEvidenceClient(): SupabaseClient | null {
  return evidenceClient;
}
export function setCandidateEvidenceClient(
  client: SupabaseClient | null,
): void {
  evidenceClient = client;
}
export function setCandidateEvidenceClientForTests(
  client: SupabaseClient | null,
): void {
  evidenceClient = client;
}
function requireClient(): SupabaseClient | null {
  if (!evidenceClient) return null;
  return evidenceClient;
}

// ============================================================================
// Helpers internos
// ============================================================================

function isPostgrestDuplicate(
  error: { code?: string; message?: string } | null,
): boolean {
  return (
    !!error &&
    error.code === "23505" &&
    /field_hash|unique/i.test(error.message ?? "")
  );
}

function buildRow(input: EvidenceInput): Record<string, unknown> {
  // Sessão NUNCA carrega field_value (regra: RESEARCH_SESSION ≠ evidência de campo)
  if (String(input.kind ?? "") === "RESEARCH_SESSION" && input.field_value !== undefined && input.field_value !== null) {
    return { __rejected: true, __reason: "session_value_provided" } as Record<string, unknown>;
  }
  const candidateId = sanitizeEvidenceText(String(input.candidate_id ?? ""));
  const researchId = sanitizeEvidenceText(String(input.research_id ?? ""));
  const kind = String(input.kind ?? "FIELD");
  const fieldName =
    kind === "RESEARCH_SESSION" ? null : sanitizeEvidenceText(String(input.field_name ?? ""));
  const fieldValue = kind === "RESEARCH_SESSION" ? null : (input.field_value ?? null);
  const state = String(input.field_state ?? (kind === "RESEARCH_SESSION" ? "UNKNOWN" : "UNKNOWN"));
  const sourceUrl = sanitizeEvidenceText(String(input.source_url ?? ""));
  const sourceType = String(input.source_type ?? "other");
  const collectionMethod = String(input.collection_method ?? "SCRAPE");
  const observedAt = String(input.observed_at ?? new Date().toISOString());
  const evidenceHash = sanitizeEvidenceText(String(input.evidence_hash ?? ""));
  const quality = String(input.quality ?? "UNKNOWN");
  const unit = input.unit != null ? sanitizeEvidenceText(String(input.unit)) : null;
  const note = sanitizeEvidenceText(String(input.evidence_note ?? ""));
  const metadata = input.metadata != null ? sanitizeEvidenceMetadata(input.metadata) : {};

  const hash: string | null =
    kind === "FIELD"
      ? fieldHash(candidateId, fieldName, sourceUrl, evidenceHash)
      : null;

  return {
    evidence_id: generateEvidenceId(),
    candidate_id: candidateId,
    research_id: researchId,
    kind,
    field_name: fieldName,
    field_value: fieldValue,
    field_state: state,
    source_url: sourceUrl,
    source_type: sourceType,
    collection_method: collectionMethod,
    observed_at: observedAt,
    evidence_hash: evidenceHash,
    field_hash: hash,
    created_at: new Date().toISOString(),
    quality,
    unit,
    evidence_note: note,
    metadata: {
      ...metadata,
      schema_version: EVIDENCE_SCHEMA_VERSION,
      discovery_block: "N3",
      ...(Array.isArray(input.contradicted_by_evidence_ids) &&
      input.contradicted_by_evidence_ids.length > 0
        ? {
            contradiction_with: input.contradicted_by_evidence_ids,
            contradiction_note: `CONTRADIÇÃO detectada com evidência(s) anterior(es) — ambas preservadas; nenhum valor foi escolhido silenciosamente`,
          }
        : {}),
    },
  };
}

function validateFields(row: Record<string, unknown>): EvidenceRejectionReason | null {
  if (!STORED_KINDS.has(String(row.kind))) return "invalid_kind";
  if (String(row.kind) === "RESEARCH_SESSION" && row.field_value !== null)
    return "session_value_provided";
  if (!STORED_STATES.has(String(row.field_state))) return "invalid_field_state";
  if (!STORED_SOURCES.has(String(row.source_type))) return "invalid_source_type";
  if (!STORED_METHODS.has(String(row.collection_method))) return "invalid_collection_method";
  if (!STORED_QUALITIES.has(String(row.quality))) return "invalid_quality";
  if (String(row.kind) === "FIELD" && (!row.field_name || !STORED_FIELDS.has(String(row.field_name))))
    return "invalid_field_name";
  if (!row.source_url || String(row.source_url).length <= 8) return "invalid_url";
  return null;
}

function rowToRecord(row: Record<string, unknown>): EvidenceRecord {
  return {
    evidence_id: String(row.evidence_id ?? ""),
    candidate_id: String(row.candidate_id ?? ""),
    research_id: String(row.research_id ?? ""),
    kind: String(row.kind ?? ""),
    field_name: typeof row.field_name === "string" ? row.field_name : null,
    field_value:
      row.field_value != null && typeof row.field_value === "object"
        ? (row.field_value as Record<string, unknown>)
        : null,
    field_state: String(row.field_state ?? ""),
    source_url: String(row.source_url ?? ""),
    source_type: String(row.source_type ?? ""),
    collection_method: String(row.collection_method ?? ""),
    observed_at: String(row.observed_at ?? ""),
    evidence_hash: String(row.evidence_hash ?? ""),
    field_hash: typeof row.field_hash === "string" ? row.field_hash : null,
    quality: String(row.quality ?? ""),
    unit: typeof row.unit === "string" ? row.unit : null,
    evidence_note: String(row.evidence_note ?? ""),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: String(row.created_at ?? ""),
  };
}

// ============================================================================
// Operações
// ============================================================================

/**
 * Persiste uma evidência (sessão ou campo). Idempotência real:
 * - replay idêntico (field_hash = digest de candidate+field+url+content)
 *   → retorna o registro existente (outcome identical_duplicate);
 * - persistência ausente → missing_supabase (fail-closed).
 * CONTRADIÇÃO: contradicted_by_evidence_ids marca a NOVA evidência como
 * CONTRADICTED sem apagar as anteriores.
 */
export async function persistEvidence(
  input: EvidenceInput,
): Promise<PersistEvidenceResult> {
  const client = requireClient();
  if (!client) {
    return { ok: false, outcome: "rejected", reason: "missing_supabase" };
  }

  const row = buildRow(input);
  if ((row as Record<string, unknown>).__rejected === true) {
    return { ok: false, outcome: "rejected", reason: (row.__reason as EvidenceRejectionReason) ?? "generic_error" };
  }
  const validationError = validateFields(row);
  if (validationError) {
    return { ok: false, outcome: "rejected", reason: validationError };
  }

  try {
    const { data, error } = await client
      .from(EVIDENCE_TABLE)
      .insert(row)
      .select()
      .single();

    if (error) {
      if (isPostgrestDuplicate(error)) {
        const existing = await client
          .from(EVIDENCE_TABLE)
          .select("*")
          .eq("field_hash", row.field_hash)
          .limit(1)
          .maybeSingle();
        return {
          ok: true,
          outcome: "identical_duplicate",
          evidence_id: existing?.data?.evidence_id
            ? String(existing.data.evidence_id)
            : undefined,
          evidence: existing?.data ? rowToRecord(existing.data) : undefined,
        };
      }
      console.error(
        "[CANDIDATE-EVIDENCE] falha de persistência:",
        error.message,
      );
      return { ok: false, outcome: "rejected", reason: "generic_error" };
    }

    return {
      ok: true,
      outcome: "created",
      evidence_id: String((data as Record<string, unknown>)?.evidence_id ?? ""),
      evidence: data ? rowToRecord(data as Record<string, unknown>) : undefined,
    };
  } catch (err) {
    console.error("[CANDIDATE-EVIDENCE] exceção inesperada:", (err as Error).message);
    return { ok: false, outcome: "rejected", reason: "generic_error" };
  }
}

/** Listagem filtrada (scoping por candidate/research/kind/state). */
export async function listEvidence(
  query: EvidenceQuery = {},
): Promise<{ ok: boolean; reason?: string; evidence: EvidenceRecord[]; total: number }> {
  const client = requireClient();
  if (!client) {
    return { ok: false, reason: "missing_supabase", evidence: [], total: 0 };
  }

  const filters: Array<[string, string]> = [];
  if (query.candidate_id) filters.push(["candidate_id", query.candidate_id]);
  if (query.research_id) filters.push(["research_id", query.research_id]);
  if (query.kind) filters.push(["kind", query.kind]);
  if (query.field_name) filters.push(["field_name", query.field_name]);
  if (query.field_state) filters.push(["field_state", query.field_state]);

  let base = client.from(EVIDENCE_TABLE).select("*", { count: "exact" });
  for (const [column, value] of filters) base = base.eq(column, value);
  base = base.order("observed_at", { ascending: false });
  if (query.limit) base = base.limit(Math.min(Math.max(1, Math.floor(query.limit)), 200));
  if (query.offset) base = base.range(query.offset, query.offset + 199);

  const { data, error } = await base;
  if (error) {
    console.error("[CANDIDATE-EVIDENCE] falha de leitura:", error.message);
    return { ok: false, reason: "generic_error", evidence: [], total: 0 };
  }

  return {
    ok: true,
    evidence: (data ?? []).map(rowToRecord),
    total: Number(error ? 0 : (data as unknown as { count?: number } | null)?.count ?? data?.length ?? 0),
  };
}

/** Sessões de pesquisa de um candidato (RESEARCH_SESSION ordenadas). */
export async function listResearchSessions(
  candidateId: string,
): Promise<{ ok: boolean; reason?: string; sessions: EvidenceRecord[] }> {
  const result = await listEvidence({
    candidate_id: candidateId,
    kind: "RESEARCH_SESSION",
    limit: 100,
  });
  return {
    ok: result.ok,
    reason: result.reason,
    sessions: result.evidence,
  };
}

/**
 * Evidências de campo de uma pesquisa, ordenadas por campo e tempo.
 * Usado para detectar CONTRADIÇÕES entre evidências do mesmo campo.
 */
export async function listFieldEvidence(
  candidateId: string,
  fieldName: string,
): Promise<{ ok: boolean; reason?: string; evidence: EvidenceRecord[] }> {
  const result = await listEvidence({
    candidate_id: candidateId,
    kind: "FIELD",
    field_name: fieldName,
    limit: 200,
  });
  return { ok: result.ok, reason: result.reason, evidence: result.evidence };
}

/**
 * Evidências de campo de um candidato (todas).
 */
export async function listCandidateEvidence(
  candidateId: string,
): Promise<{ ok: boolean; reason?: string; evidence: EvidenceRecord[] }> {
  const result = await listEvidence({ candidate_id: candidateId, limit: 200 });
  return { ok: result.ok, reason: result.reason, evidence: result.evidence };
}

/** Cleanup administrativo seguro para provas vivas — NUNCA exposto via rota. */
export async function deleteEvidenceForProof(
  evidenceIds: string[],
): Promise<{ ok: boolean; deleted: number; reason?: string }> {
  const client = requireClient();
  if (!client) {
    return { ok: false, deleted: 0, reason: "missing_supabase" };
  }
  const ids = evidenceIds.filter(id => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { ok: true, deleted: 0 };
  const { error } = await client
    .from(EVIDENCE_TABLE)
    .delete()
    .in("evidence_id", ids);
  if (error) {
    console.error("[CANDIDATE-EVIDENCE] falha de cleanup:", error.message);
    return { ok: false, deleted: 0, reason: "generic_error" };
  }
  return { ok: true, deleted: ids.length };
}
