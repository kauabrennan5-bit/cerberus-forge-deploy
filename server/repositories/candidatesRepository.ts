/**
 * Cerberus Finds Archive — Bloco N1 — Contratos de Descoberta
 * Repositório de persistência dos candidatos (produtos descobertos,
 * ainda NÃO canônicos).
 *
 * Fronteiras: CANDIDATE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO
 *             MEMORY != AUTHORITY · RECOMMENDATION != ACTION
 *
 * Este módulo NÃO cria produtos canônicos, NÃO executa scraping, NÃO
 * executa ações em marketplaces, NÃO altera o catálogo, Telegram,
 * lifecycle, job queue ou Operator. Ele apenas grava e lê o registro
 * formal de candidatos produzidos por ingestão (manual por enquanto;
 * ingestão programática é escopo do N2/N3).
 *
 * Regras duras:
 *   - CANDIDATE != FACT CANÔNICO: promoted_product_id é registro
 *     opcional de um vínculo futuro — NUNCA migração de identidade;
 *   - listing_key (source + external listing id) é imutável; replay
 *     idêntico retorna o registro existente (idempotência real);
 *     intenção conflitante (mesmo listing_key com payload divergente)
 *     → conflict_rejected;
 *   - status/funnel_stage transitam somente dentro dos CHECKs fechados;
 *   - vereditos REJECTED/INCONCLUSIVE exigem rejection_reason;
 *   - promoteToProduct apenas REGISTRA o vínculo — criar o produto
 *     canônico é outra entidade e outro fluxo (N3/N5), jamais aqui;
 *   - persistência ausente NUNCA vira sucesso: missing_supabase explícito;
 *   - sanitização: títulos/descrições jamais contêm secrets;
 *   - fail-closed: sem cliente Supabase, toda operação recusa.
 *
 * Padrão injetável dos Blocos 13/14/15/16/17: cliente Supabase injetado
 * por setCandidatesClient em server.ts; testes via setCandidatesClientForTests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  sanitizeMetadata,
  sanitizeText,
} from "./policyJournalRepository";

export const CANDIDATES_TABLE = "candidates" as const;
export const CANDIDATE_SCHEMA_VERSION = "1.0";
export const DISCOVERY_RIGOR_VERSION = "1.0";

export const CANDIDATE_STATUSES = [
  "DISCOVERED",
  "REVIEWING",
  "APPROVED",
  "REJECTED",
  "INCONCLUSIVE",
  "WITHDRAWN",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const FUNNEL_STAGES = [
  "INTAKE",
  "EVIDENCE_OK",
  "AWAITING_REVIEW",
  "REVIEWED",
  "FUNNEL_END",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const MARKETPLACES = ["Shopee", "Mercado Livre", "Outro"] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const AVAILABILITY_STATES = [
  "IN_STOCK",
  "OUT_OF_STOCK",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type ObservedAvailability = (typeof AVAILABILITY_STATES)[number];

export const COLLECTION_METHODS = [
  "MANUAL",
  "SCRAPE",
  "API",
  "OTHER",
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const VERDICT_REJECTION_REASONS = [
  "missing_rejection_reason",
  "invalid_verdict_value",
  "invalid_transition",
  "candidate_not_found",
  "already_funnel_end",
] as const;
export type VerdictRejectionReason =
  (typeof VERDICT_REJECTION_REASONS)[number];

export const CANDIDATE_REJECTION_REASONS = [
  "missing_supabase",
  "invalid_marketplace",
  "invalid_availability",
  "invalid_collection_method",
  "invalid_url",
  "invalid_id",
  "conflict_rejected",
  "identical_duplicate",
  "generic_error",
] as const;
export type CandidateRejectionReason =
  (typeof CANDIDATE_REJECTION_REASONS)[number];

// Catálogos fechados (espelho da migration 20260816_candidates)
const STORED_STATUSES: ReadonlySet<string> = new Set(CANDIDATE_STATUSES);
const STORED_STAGES: ReadonlySet<string> = new Set(FUNNEL_STAGES);
const STORED_MARKETPLACES: ReadonlySet<string> = new Set(MARKETPLACES);
const STORED_AVAILABILITY: ReadonlySet<string> = new Set(AVAILABILITY_STATES);
const STORED_METHODS: ReadonlySet<string> = new Set(COLLECTION_METHODS);

// ============================================================================
// Digests e sanitização
// ============================================================================

/** Digest determinístico (SHA-256 do JSON canônico, ordenado). */
export function candidateDigest(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * listing_key derivado da proveniência: marketplace + external listing id.
 * Imutável — mesmo listing em fontes distintas é outro candidato.
 */
export function listingKeyFrom(
  marketplace: string,
  externalListingId: string,
): string {
  return candidateDigest({
    marketplace,
    external_listing_id: externalListingId,
  }).slice(0, 32);
}

/** Sanitização coerente com os Blocos 10/11/13/14/15/16/17. */
export function sanitizeCandidateText(text: string): string {
  let sanitized = sanitizeText(text);
  if (sanitized.length > 2000) {
    sanitized = `${sanitized.slice(0, 2000)}…[truncated]`;
  }
  return sanitized;
}

// ============================================================================
// Contratos
// ============================================================================

export interface CandidateIntakeInput {
  marketplace: string;
  source_url: string;
  external_listing_id: string;
  merchant?: string;
  title?: string;
  description?: string;
  category?: string;
  observed_price?: number | null;
  observed_rating?: number | null;
  observed_rating_count?: number | null;
  observed_availability?: string;
  observed_at?: string;
  evidence_hash?: string;
  collection_method?: string;
  raw_snapshot_url?: string | null;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

export interface CandidateRecord {
  candidate_id: string;
  listing_key: string;
  schema_version: string;
  discovery_rigor_version: string;
  marketplace: string;
  merchant: string;
  source_url: string;
  external_listing_id: string;
  title: string;
  description: string;
  category: string;
  observed_price: number | null;
  observed_rating: number | null;
  observed_rating_count: number | null;
  observed_availability: string;
  observed_at: string;
  evidence_hash: string;
  collection_method: string;
  raw_snapshot_url: string | null;
  status: string;
  funnel_stage: string;
  review_notes: string;
  rejection_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  promoted_product_id: string | null;
  promoted_at: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ListCandidatesParams {
  status?: string;
  funnel_stage?: string;
  marketplace?: string;
  limit?: number;
  offset?: number;
}

export interface ListCandidatesResult {
  candidates: CandidateRecord[];
  total: number;
}

export interface RegisterCandidateResult {
  ok: boolean;
  outcome: "created" | "identical_duplicate" | "conflict_rejected" | "rejected";
  reason?: CandidateRejectionReason;
  candidate_id?: string;
  existing_id?: string;
  candidate?: CandidateRecord;
}

export interface VerdictResult {
  ok: boolean;
  outcome: "verdict_recorded" | "rejected";
  reason?: VerdictRejectionReason;
  candidate?: CandidateRecord;
}

// ============================================================================
// Injeção (padrão Blocos 13/14/15/16/17)
// ============================================================================

let candidatesClient: SupabaseClient | null = null;
export function getCandidatesClient(): SupabaseClient | null {
  return candidatesClient;
}
export function setCandidatesClient(client: SupabaseClient | null): void {
  candidatesClient = client;
}
export function setCandidatesClientForTests(
  client: SupabaseClient | null,
): void {
  candidatesClient = client;
}
export function requireClient(): SupabaseClient | null {
  if (!candidatesClient) return null;
  return candidatesClient;
}

// ============================================================================
// Helpers internos
// ============================================================================

const CANDIDATE_ID_PREFIX = "can-";

export function generateCandidateId(): string {
  return `${CANDIDATE_ID_PREFIX}${candidateDigest({
    nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  }).slice(0, 24)}`;
}

function isPostgrestDuplicate(
  error: { code?: string; message?: string } | null,
): boolean {
  return (
    !!error &&
    error.code === "23505" &&
    /listing_key|unique/i.test(error.message ?? "")
  );
}

function sanitizeIntake(input: CandidateIntakeInput): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    marketplace: sanitizeCandidateText(String(input.marketplace ?? "")),
    merchant: sanitizeCandidateText(String(input.merchant ?? "")),
    source_url: sanitizeCandidateText(String(input.source_url ?? "")),
    external_listing_id: sanitizeCandidateText(
      String(input.external_listing_id ?? ""),
    ),
    title: sanitizeCandidateText(String(input.title ?? "")),
    description: sanitizeCandidateText(String(input.description ?? "")),
    category: sanitizeCandidateText(String(input.category ?? "")),
    observed_price:
      input.observed_price != null ? Number(input.observed_price) : null,
    observed_rating:
      input.observed_rating != null ? Number(input.observed_rating) : null,
    observed_rating_count:
      input.observed_rating_count != null
        ? Math.floor(Number(input.observed_rating_count))
        : null,
    observed_availability: String(
      input.observed_availability ?? "UNKNOWN",
    ),
    evidence_hash: sanitizeCandidateText(String(input.evidence_hash ?? "")),
    collection_method: String(input.collection_method ?? "MANUAL"),
    raw_snapshot_url:
      input.raw_snapshot_url != null
        ? sanitizeCandidateText(String(input.raw_snapshot_url))
        : null,
    idempotency_key:
      input.idempotency_key != null
        ? sanitizeCandidateText(String(input.idempotency_key))
        : null,
    metadata:
      input.metadata != null
        ? sanitizeMetadata(input.metadata)
        : {},
  };
  return sanitized;
}

function validateIntakeFields(
  fields: Record<string, unknown>,
): CandidateRejectionReason | null {
  if (!fields.marketplace || !STORED_MARKETPLACES.has(String(fields.marketplace)))
    return "invalid_marketplace";
  if (!fields.external_listing_id) return "invalid_id";
  if (!fields.source_url || String(fields.source_url).length <= 8)
    return "invalid_url";
  if (!STORED_AVAILABILITY.has(String(fields.observed_availability)))
    return "invalid_availability";
  if (!STORED_METHODS.has(String(fields.collection_method)))
    return "invalid_collection_method";
  return null;
}

function rowToRecord(row: Record<string, unknown>): CandidateRecord {
  return {
    candidate_id: String(row.candidate_id ?? ""),
    listing_key: String(row.listing_key ?? ""),
    schema_version: String(row.schema_version ?? ""),
    discovery_rigor_version: String(row.discovery_rigor_version ?? ""),
    marketplace: String(row.marketplace ?? ""),
    merchant: String(row.merchant ?? ""),
    source_url: String(row.source_url ?? ""),
    external_listing_id: String(row.external_listing_id ?? ""),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    category: String(row.category ?? ""),
    observed_price:
      typeof row.observed_price === "number" ? row.observed_price : null,
    observed_rating:
      typeof row.observed_rating === "number" ? row.observed_rating : null,
    observed_rating_count:
      typeof row.observed_rating_count === "number"
        ? row.observed_rating_count
        : null,
    observed_availability: String(row.observed_availability ?? ""),
    observed_at: String(row.observed_at ?? ""),
    evidence_hash: String(row.evidence_hash ?? ""),
    collection_method: String(row.collection_method ?? ""),
    raw_snapshot_url:
      typeof row.raw_snapshot_url === "string" ? row.raw_snapshot_url : null,
    status: String(row.status ?? ""),
    funnel_stage: String(row.funnel_stage ?? ""),
    review_notes: String(row.review_notes ?? ""),
    rejection_reason:
      typeof row.rejection_reason === "string"
        ? row.rejection_reason
        : null,
    reviewed_at:
      typeof row.reviewed_at === "string" ? row.reviewed_at : null,
    reviewed_by:
      typeof row.reviewed_by === "string" ? row.reviewed_by : null,
    promoted_product_id:
      typeof row.promoted_product_id === "string"
        ? row.promoted_product_id
        : null,
    promoted_at:
      typeof row.promoted_at === "string" ? row.promoted_at : null,
    idempotency_key:
      typeof row.idempotency_key === "string"
        ? row.idempotency_key
        : null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_by: String(row.created_by ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

// ============================================================================
// Operações
// ============================================================================

/**
 * Registra um candidato. Idempotência real:
 * - replay idêntico (mesmo listing_key + mesmo digest do payload)
 *   → retorna o registro existente (outcome identical_duplicate);
 * - mesmo listing_key com payload divergente → conflict_rejected;
 * - persistência ausente → missing_supabase (fail-closed).
 */
export async function registerCandidate(
  input: CandidateIntakeInput,
): Promise<RegisterCandidateResult> {
  const client = requireClient();
  if (!client) {
    return {
      ok: false,
      outcome: "rejected",
      reason: "missing_supabase",
    };
  }

  const fields = sanitizeIntake(input);
  const validationError = validateIntakeFields(fields);
  if (validationError) {
    return { ok: false, outcome: "rejected", reason: validationError };
  }

  const marketplace = String(fields.marketplace);
  const externalListingId = String(fields.external_listing_id);
  const key = listingKeyFrom(marketplace, externalListingId);

  // Primeiro: verificar se já existe registro para este listing.
  const existing = await client
    .from(CANDIDATES_TABLE)
    .select("*")
    .eq("listing_key", key)
    .limit(1)
    .maybeSingle();

  const candidateId = generateCandidateId();
  const digest = candidateDigest(fields);
  const observedAt = input.observed_at
    ? new Date(input.observed_at).toISOString()
    : new Date().toISOString();

  const row = {
    candidate_id: candidateId,
    listing_key: key,
    schema_version: CANDIDATE_SCHEMA_VERSION,
    discovery_rigor_version: DISCOVERY_RIGOR_VERSION,
    marketplace,
    merchant: String(fields.merchant),
    source_url: String(fields.source_url),
    external_listing_id: externalListingId,
    title: String(fields.title),
    description: String(fields.description),
    category: String(fields.category),
    observed_price: fields.observed_price as number | null,
    observed_rating: fields.observed_rating as number | null,
    observed_rating_count: fields.observed_rating_count as number | null,
    observed_availability: String(fields.observed_availability),
    observed_at: observedAt,
    evidence_hash: String(fields.evidence_hash) || digest.slice(0, 64),
    collection_method: String(fields.collection_method),
    raw_snapshot_url: fields.raw_snapshot_url as string | null,
    status: "DISCOVERED",
    funnel_stage: "INTAKE",
    review_notes: "",
    rejection_reason: null,
    reviewed_at: null,
    reviewed_by: null,
    promoted_product_id: null,
    promoted_at: null,
    idempotency_key:
      (fields.idempotency_key as string | null) ?? digest.slice(0, 32),
    metadata: fields.metadata as Record<string, unknown>,
    created_by: "operator-admin",
  };

  if (existing.data) {
    // Idempotência: digest idêntico → duplicate benigno; divergente → conflito.
    // O recompute recria exatamente os mesmos campos determinísticos de
    // sanitizeIntake, para comparação justa com o digest do novo registro.
    // NOTA: evidence_hash e idempotency_key derivam do próprio digest
    // (evidence_hash = digest.slice(0,64), idempotency_key = digest.slice(0,32)
    // quando ausentes do input), então seriam circularmente impossíveis de
    // recomputar. A comparação determinística usa os campos de entrada
    // restantes, que são exatamente iguais no replay idêntico.
    const existingDigest = candidateDigest({
      marketplace: String(existing.data.marketplace ?? ""),
      merchant: String(existing.data.merchant ?? ""),
      source_url: String(existing.data.source_url ?? ""),
      external_listing_id: String(existing.data.external_listing_id ?? ""),
      title: String(existing.data.title ?? ""),
      description: String(existing.data.description ?? ""),
      category: String(existing.data.category ?? ""),
      observed_price: existing.data.observed_price,
      observed_rating: existing.data.observed_rating,
      observed_rating_count: existing.data.observed_rating_count,
      observed_availability: String(
        existing.data.observed_availability ?? "UNKNOWN",
      ),
      observed_at: String(existing.data.observed_at ?? ""),
      collection_method: String(existing.data.collection_method ?? "MANUAL"),
      raw_snapshot_url: existing.data.raw_snapshot_url,
      metadata: (existing.data.metadata as Record<string, unknown>) ?? {},
    });
    const newDigestComparable = candidateDigest({
      ...fields,
      evidence_hash: undefined,
      idempotency_key: undefined,
      observed_at: existing.data.observed_at
        ? String(existing.data.observed_at)
        : undefined,
    });
    const sameDesign =
      newDigestComparable.slice(0, 32) === existingDigest.slice(0, 32) ||
      existing.data.candidate_id === candidateId;
    return {
      ok: sameDesign,
      outcome: sameDesign ? "identical_duplicate" : "conflict_rejected",
      reason: sameDesign ? undefined : "conflict_rejected",
      candidate_id: existing.data.candidate_id,
      existing_id: existing.data.candidate_id,
      candidate: rowToRecord(existing.data),
    };
  }

  const { data, error } = await client
    .from(CANDIDATES_TABLE)
    .insert([row])
    .select()
    .single();

  if (error) {
    if (isPostgrestDuplicate(error)) {
      // Race: outro registro venceu; reler para responder com o existente.
      const raced = await client
        .from(CANDIDATES_TABLE)
        .select("*")
        .eq("listing_key", key)
        .limit(1)
        .maybeSingle();
      const racedId = (raced.data as Record<string, unknown> | null)
        ?.candidate_id as string | undefined;
      return {
        ok: false,
        outcome: "conflict_rejected",
        reason: "conflict_rejected",
        candidate_id: racedId,
        existing_id: racedId,
        candidate: raced.data ? rowToRecord(raced.data as Record<string, unknown>) : undefined,
      };
    }
    return {
      ok: false,
      outcome: "rejected",
      reason: "generic_error",
    };
  }

  return {
    ok: true,
    outcome: "created",
    candidate_id: data.candidate_id,
    candidate: rowToRecord(data),
  };
}

export async function getCandidate(
  candidateId: string,
): Promise<{ ok: boolean; candidate?: CandidateRecord }> {
  const client = requireClient();
  if (!client) {
    return { ok: false };
  }
  const { data } = await client
    .from(CANDIDATES_TABLE)
    .select("*")
    .eq("candidate_id", candidateId)
    .limit(1)
    .maybeSingle();
  if (!data) return { ok: false };
  return { ok: true, candidate: rowToRecord(data) };
}

export async function listCandidates(
  params: ListCandidatesParams = {},
): Promise<ListCandidatesResult> {
  const client = requireClient();
  if (!client) {
    return { candidates: [], total: 0 };
  }
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  let query = client.from(CANDIDATES_TABLE).select("*", { count: "exact" });
  if (params.status) query = query.eq("status", params.status);
  if (params.funnel_stage) query = query.eq("funnel_stage", params.funnel_stage);
  if (params.marketplace) query = query.eq("marketplace", params.marketplace);

  const { data, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const rows = (data as Array<Record<string, unknown>> | null) ?? [];
  return {
    candidates: rows.map(rowToRecord),
    total: typeof count === "number" ? count : rows.length,
  };
}

// Transições permitidas (espelho do CHECK + guardas de negócio):
// DISCOVERED → REVIEWING → APPROVED/REJECTED/INCONCLUSIVE/WITHDRAWN
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  DISCOVERED: new Set(["REVIEWING"]),
  REVIEWING: new Set(["APPROVED", "REJECTED", "INCONCLUSIVE", "WITHDRAWN", "REVIEWING"]),
  APPROVED: new Set(["APPROVED"]),
  REJECTED: new Set(["REJECTED"]),
  INCONCLUSIVE: new Set(["INCONCLUSIVE"]),
  WITHDRAWN: new Set(["WITHDRAWN"]),
};

export async function startReview(candidateId: string): Promise<{
  ok: boolean;
  reason?: VerdictRejectionReason | CandidateRejectionReason;
  candidate?: CandidateRecord;
}> {
  const client = requireClient();
  if (!client) {
    return { ok: false, reason: "missing_supabase" };
  }
  const { data, error } = await client
    .from(CANDIDATES_TABLE)
    .update({ status: "REVIEWING", funnel_stage: "AWAITING_REVIEW", updated_at: new Date().toISOString() })
    .eq("candidate_id", candidateId)
    .eq("status", "DISCOVERED")
    .select()
    .single();
  if (error || !data) {
    if (!error && !data) return { ok: false, reason: "candidate_not_found" };
    return { ok: false, reason: error?.code === "PGRST116" ? "candidate_not_found" : "generic_error" };
  }
  return { ok: true, candidate: rowToRecord(data) };
}

/**
 * Registra um veredito de curadoria. Guardas:
 * - status atual deve permitir a transição (enum fechado);
 * - REJECTED/INCONCLUSIVE exigem rejection_reason não vazio;
 * - APPROVED → status APPROVED + funnel_stage REVIEWED.
 */
export async function recordVerdict(params: {
  candidate_id: string;
  status: string;
  rejection_reason?: string;
  review_notes?: string;
  reviewed_by?: string;
}): Promise<VerdictResult> {
  const client = requireClient();
  const verdict = params.status;
  if (!STORED_STATUSES.has(verdict)) {
    return { ok: false, outcome: "rejected", reason: "invalid_verdict_value" };
  }

  const current = await client
    .from(CANDIDATES_TABLE)
    .select("status, funnel_stage")
    .eq("candidate_id", params.candidate_id)
    .limit(1)
    .maybeSingle();

  if (!client) {
    return { ok: false, outcome: "rejected" as const };
  }
  if (!current.data) {
    return { ok: false, outcome: "rejected", reason: "candidate_not_found" };
  }

  const currentStatus = String(current.data.status);
  if (!TRANSITIONS[currentStatus]?.has(verdict)) {
    return { ok: false, outcome: "rejected", reason: "invalid_transition" };
  }

  const needsReason = verdict === "REJECTED" || verdict === "INCONCLUSIVE";
  const reasonText = sanitizeCandidateText(String(params.rejection_reason ?? ""));
  if (needsReason && !reasonText) {
    return { ok: false, outcome: "rejected", reason: "missing_rejection_reason" };
  }

  const nextStage =
    verdict === "APPROVED" ? "REVIEWED" : "FUNNEL_END";

  const payload: Record<string, unknown> = {
    status: verdict,
    funnel_stage: nextStage,
    review_notes: sanitizeCandidateText(String(params.review_notes ?? "")),
    reviewed_at: new Date().toISOString(),
    reviewed_by: params.reviewed_by
      ? sanitizeCandidateText(String(params.reviewed_by))
      : null,
    updated_at: new Date().toISOString(),
  };
  if (needsReason) payload.rejection_reason = reasonText;

  const { data, error } = await client
    .from(CANDIDATES_TABLE)
    .update(payload)
    .eq("candidate_id", params.candidate_id)
    .select()
    .single();

  if (error || !data) {
    return { ok: false, outcome: "rejected" };
  }
  return { ok: true, outcome: "verdict_recorded", candidate: rowToRecord(data) };
}

/**
 * Promove o candidato: apenas REGISTRA o vínculo promoted_product_id
 * (registro, nunca migração de identidade). A criação do produto
 * canônico é OUTRA entidade e OUTRO fluxo (N3/N5) — jamais aqui.
 */
export async function promoteToProduct(params: {
  candidate_id: string;
  promoted_product_id: string;
}): Promise<{
  ok: boolean;
  reason?: CandidateRejectionReason | VerdictRejectionReason;
  candidate?: CandidateRecord;
}> {
  const client = requireClient();
  if (!client) {
    return { ok: false, reason: "missing_supabase" as CandidateRejectionReason };
  }
  if (!params.promoted_product_id) {
    return { ok: false, reason: "invalid_id" as CandidateRejectionReason };
  }

  const current = await client
    .from(CANDIDATES_TABLE)
    .select("status")
    .eq("candidate_id", params.candidate_id)
    .limit(1)
    .maybeSingle();

  if (!current.data) {
    return { ok: false, reason: "candidate_not_found" as VerdictRejectionReason };
  }
  if (String(current.data.status) !== "APPROVED") {
    return { ok: false, reason: "invalid_transition" as VerdictRejectionReason };
  }

  const { data, error } = await client
    .from(CANDIDATES_TABLE)
    .update({
      promoted_product_id: sanitizeCandidateText(params.promoted_product_id),
      promoted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("candidate_id", params.candidate_id)
    .select()
    .single();

  if (error || !data) {
    return { ok: false, reason: "generic_error" as CandidateRejectionReason };
  }
  return { ok: true, candidate: rowToRecord(data) };
}

/**
 * Exclusivamente para limpeza de prova viva. NUNCA expor via rota.
 */
export async function deleteCandidateForProof(
  candidateId: string,
): Promise<{ ok: boolean; deleted: boolean }> {
  const client = requireClient();
  if (!client) {
    return { ok: false, deleted: false };
  }
  const { error } = await client
    .from(CANDIDATES_TABLE)
    .delete()
    .eq("candidate_id", candidateId);
  return { ok: !error, deleted: !error };
}
