// ============================================================================
// Bloco N6 — Affiliate Economics + Link Resolution — Repository
//
// Persistência de Affiliate Provider Registry e Affiliate Link Records.
//
// Fronteiras (inalteráveis):
//   AFFILIATE LINK != PRODUCT FACT   — este módulo NUNCA altera
//   public.products, NUNCA altera public.candidates (exceto a coluna
//   opcional de target textual no link, que não promove nada) e NUNCA
//   cria produtos, vínculos de promoção, jobs, agentes ou publicações.
//   AFFILIATE LINK != AUTHORITY      — registrar/validar NUNCA executa
//   publicação; a execução é exclusiva do N5 (DECISION + Policy Engine +
//   ApprovalStore).
//   SEM PROVENIÊNCIA -> SEM AUTORIDADE — provenance fechada em
//   'admin:manual'; qualquer outro valor é rejeitado (fail-closed).
//   FAIL-CLOSED — estado desconhecido/inconclusivo nunca vira APPROVED.
//   SEM CREDENCIAIS NO BANCO — credential_ref é referência opaca; o
//   módulo não aceita nem persiste tokens, secrets ou API keys.
//
// Padrão injetável dos Blocos N1–N5/13+: cliente Supabase injetado via
// setAffiliateClientForTests (produção recebe o client do server.ts).
// Idempotência: digest UNIQUE (provider + alvo + url); replay idêntico
// retorna identical_duplicate; link mudado cria novo registro (preserva
// a proveniência histórica; nada é apagado silenciosamente).
// ============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  affiliateLinkDigest,
  AFFILIATE_MARKETPLACES,
  AFFILIATE_MARKETPLACE_HOSTS,
  type AffiliateLinkRecord,
  type AffiliateMarketplace,
  type AffiliateProviderRecord,
  type IdempotentWriteResult,
  type LinkMethod,
  type LinkProvenance,
  type LinkValidationOutcome,
  type RegisterLinkInput,
  type RegisterProviderInput,
} from "./contract";
import { sanitizeMetadata } from "../../repositories/policyJournalRepository";
import type {
  N17AcquisitionRecord,
  N17Repository,
  N17WriteOutcome,
} from "./n17Contract";

export const PROVIDERS_TABLE = "affiliate_providers" as const;
export const LINKS_TABLE = "affiliate_links" as const;
export const CONTRACT_VERSION = "1.0" as const;

// ---------------------------------------------------------------------------
// Client injetável (produção: injetado por server.ts; testes: fake)
// ---------------------------------------------------------------------------
let affiliateClient: SupabaseClient | null = null;

export function setAffiliateClient(client: SupabaseClient | null): void {
  affiliateClient = client;
}

/** Test-only: injeta cliente fake sem dependência de env do Supabase. */
export function setAffiliateClientForTests(client: SupabaseClient): void {
  setAffiliateClient(client);
}

function requireClient(): SupabaseClient {
  if (!affiliateClient) {
    throw new Error("Affiliate repository: Supabase client não injetado (fail-closed).");
  }
  return affiliateClient;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------
function safeString(value: unknown, maxLength = 1024): string {
  if (typeof value !== "string") return "";
  return value.slice(0, Math.min(value.length, maxLength));
}

/** Rejeita credenciais/secrets conhecidos dentro de metadata. */
function sanitizeInputMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeMetadata(value);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(sanitized)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("password") ||
      lower.includes("key") ||
      lower.includes("api_") ||
      lower.includes("credential")
    ) {
      // Metadado sensível declarado: não persistimos o valor (REDACTED).
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = val;
  }
  return out;
}

export function validateProviderId(providerId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(providerId);
}

export function validateLinkCandidateId(candidateId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(candidateId);
}

export function validateLinkProductId(productId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(productId);
}

// ---------------------------------------------------------------------------
// Affiliate Provider Registry
// ---------------------------------------------------------------------------
/**
 * Registra um Affiliate Provider (idempotente por idempotency_key + provider_id
 * determinístico = affprv-<provider_code>). Retorna created ou
 * identical_duplicate. Falha fail-closed quando o estado é desconhecido.
 */
export async function persistProvider(
  input: RegisterProviderInput,
  createdBy = "operator-admin"
): Promise<IdempotentWriteResult<AffiliateProviderRecord>> {
  const client = requireClient();

  if (!(AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(input.marketplace)) {
    return { ok: false, result: "failed", record: null, reason: "marketplace_invalid" };
  }
  if (!input.provider_code || !/^[\w-]{2,32}$/.test(input.provider_code)) {
    return { ok: false, result: "failed", record: null, reason: "provider_code_invalid" };
  }
  if (!input.name || input.name.trim().length < 2) {
    return { ok: false, result: "failed", record: null, reason: "name_invalid" };
  }
  if (input.status && !["ACTIVE", "INACTIVE", "PENDING_REVIEW", "WITHDRAWN"].includes(input.status)) {
    return { ok: false, result: "failed", record: null, reason: "status_invalid" };
  }
  if (input.resolution_method && input.resolution_method !== "MANUAL") {
    // v1: somente MANUAL implementado. IMPORT/PORTAL/API exigem autorização
    // contratual futura — rejeitar para não fingir capacidades.
    return { ok: false, result: "failed", record: null, reason: "resolution_method_not_supported" };
  }
  if (input.credential_ref && (input.credential_ref.includes(" ") || input.credential_ref.includes(":") === false || input.credential_ref.length > 120)) {
    return { ok: false, result: "failed", record: null, reason: "credential_ref_invalid" };
  }

  const provider_id = `affprv-${input.provider_code.toLowerCase()}`;
  const now = new Date().toISOString();
  const record: AffiliateProviderRecord = {
    provider_id,
    provider_code: safeString(input.provider_code, 32).trim(),
    name: safeString(input.name.trim(), 120),
    marketplace: input.marketplace,
    program_name: safeString(input.program_name ?? "", 160),
    status: input.status ?? "PENDING_REVIEW",
    resolution_method: input.resolution_method ?? "MANUAL",
    ownership: "owner-human",
    provenance: "admin:manual",
    credential_ref: safeString(input.credential_ref ?? "", 120),
    terms_url: safeString(input.terms_url ?? "", 512),
    notes: safeString(input.notes ?? "", 2000),
    contract_version: CONTRACT_VERSION,
    idempotency_key: input.idempotency_key ?? null,
    metadata: sanitizeInputMetadata(input.metadata ?? {}),
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };

  const insert = client.from(PROVIDERS_TABLE).insert(record as unknown as Record<string, unknown>).single();
  const { data, error } = await insert;
  if (error) {
    if (/duplicate|23505/i.test(error.message)) {
      const { data: existing } = await client
        .from(PROVIDERS_TABLE)
        .select("*")
        .eq("provider_id", provider_id)
        .single();
      return { ok: true, result: "identical_duplicate", record: existing as AffiliateProviderRecord | null };
    }
    return { ok: false, result: "failed", record: null, reason: "store_error", };
  }
  return { ok: true, result: "created", record: data as AffiliateProviderRecord };
}

export async function getProvider(providerId: string): Promise<AffiliateProviderRecord | null> {
  const client = requireClient();
  const { data, error } = await client
    .from(PROVIDERS_TABLE)
    .select("*")
    .eq("provider_id", providerId)
    .single();
  if (error || !data) return null;
  return data as AffiliateProviderRecord;
}

export async function listProviders(opts?: { status?: string }): Promise<AffiliateProviderRecord[]> {
  const client = requireClient();
  let query = client.from(PROVIDERS_TABLE).select("*");
  if (opts?.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) return [];
  return (data as AffiliateProviderRecord[]) ?? [];
}

// ---------------------------------------------------------------------------
// Affiliate Link Records
// ---------------------------------------------------------------------------
/**
 * Valida o input de um link (fail-closed): URL sintática, proveniência
 * fechada, alvo único, provider existente e status ACTIVE, domínio
 * compatível com o marketplace. NÃO executa checagem viva — a validação
 * estrutural é determinística e segura localmente; a checagem viva (fetch)
 * vive no affiliateValidator (fetchShared do N2, reutilizado).
 */
export async function validateLinkInput(input: RegisterLinkInput): Promise<{
  ok: boolean;
  reason?: string;
  provider?: AffiliateProviderRecord;
}> {
  // P1: proveniência fechada — qualquer outra origem é rejeitada.
  if (input.provenance !== undefined && input.provenance !== "admin:manual") {
    return { ok: false, reason: "provenance_not_allowed" };
  }

  // P2: alvo único (candidato XOR produto) — texto referencial; sem FK.
  const hasCandidate = typeof input.candidate_id === "string" && input.candidate_id.length > 0;
  const hasProduct = typeof input.product_id === "string" && input.product_id.length > 0;
  if (hasCandidate && hasProduct) {
    return { ok: false, reason: "dual_target" };
  }
  if (!hasCandidate && !hasProduct) {
    return { ok: false, reason: "no_target" };
  }
  if (hasCandidate && !validateLinkCandidateId(input.candidate_id!)) {
    return { ok: false, reason: "candidate_id_invalid" };
  }
  if (hasProduct && !validateLinkProductId(input.product_id!)) {
    return { ok: false, reason: "product_id_invalid" };
  }

  // P3: marketplace fechado do N2.
  if (!(AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(input.marketplace)) {
    return { ok: false, reason: "marketplace_invalid" };
  }

  // P4: provider deve existir, estar ACTIVE e ter marketplace compatível.
  const provider = await getProvider(input.provider_id);
  if (!provider) return { ok: false, reason: "provider_not_found" };
  if (provider.status !== "ACTIVE") return { ok: false, reason: "provider_not_active" };
  if (provider.marketplace !== input.marketplace) {
    return { ok: false, reason: "provider_marketplace_mismatch" };
  }
  if (provider.resolution_method !== "MANUAL") {
    return { ok: false, reason: "provider_resolution_not_manual" };
  }

  // P5: URL sintaticamente válida (http/https, hostname real, sem localhost).
  let parsed: URL;
  try {
    parsed = new URL(input.affiliate_url);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // Defesa em profundidade: localhost, loopback, redes privadas/link-local.
  // Regex cobre os octetos completos (127.0.0.1, 10.x.y.z, 192.168.x.y, 169.254.x.y).
  if (/^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|\[::ffff:127\.\d+\])$/.test(host)) {
    return { ok: false, reason: "unsafe_host" };
  }
  if (!input.affiliate_url || input.affiliate_url.trim().length < 12) {
    return { ok: false, reason: "url_too_short" };
  }

  // P6: domínio compatível com o marketplace (catálogo fechado do N2).
  const allowedHosts = AFFILIATE_MARKETPLACE_HOSTS[input.marketplace];
  const domainOk = allowedHosts.some(domain => host === domain || host.endsWith("." + domain));
  if (!domainOk) {
    return { ok: false, reason: "domain_not_allowed" };
  }

  // P7: caminho não vazio (sem homepage genérica — mesma regra dos products).
  const path = parsed.pathname.trim();
  if ((path === "" || path === "/") && !parsed.search) {
    return { ok: false, reason: "url_generic_homepage" };
  }

  return { ok: true, provider };
}

/**
 * Registra um Affiliate Link Record (idempotente por digest).
 * Estado inicial: DRAFT + UNVALIDATED (falha fechada: NUNCA é criado como
 * VALID). Replay idêntico → identical_duplicate; URL/destino alterado →
 * novo digest → novo registro (histórico preservado).
 */
export async function persistLink(
  input: RegisterLinkInput,
  createdBy = "operator-admin"
): Promise<IdempotentWriteResult<AffiliateLinkRecord>> {
  const pre = await validateLinkInput(input);
  if (!pre.ok) return { ok: false, result: "failed", record: null, reason: pre.reason };

  const client = requireClient();
  const targetCandidate = typeof input.candidate_id === "string" && input.candidate_id.length > 0
    ? input.candidate_id
    : null;
  const targetProduct = typeof input.product_id === "string" && input.product_id.length > 0
    ? input.product_id
    : null;

  const digest = affiliateLinkDigest({
    provider_id: input.provider_id,
    candidate_id: targetCandidate,
    product_id: targetProduct,
    affiliate_url: input.affiliate_url,
  });

  const link_id = `afflnk-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const now = new Date().toISOString();
  const record: AffiliateLinkRecord = {
    link_id,
    candidate_id: targetCandidate,
    product_id: targetProduct,
    marketplace: input.marketplace,
    provider_id: input.provider_id,
    affiliate_url: input.affiliate_url,
    provenance: "admin:manual",
    status: "DRAFT",
    validation_state: "UNVALIDATED",
    validation_result: {},
    digest,
    observed_at: now,
    expires_at: input.expires_at ?? null,
    notes: safeString(input.notes ?? "", 2000),
    contract_version: CONTRACT_VERSION,
    idempotency_key: input.idempotency_key ?? null,
    metadata: sanitizeInputMetadata(input.metadata ?? {}),
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await client
    .from(LINKS_TABLE)
    .insert(record as unknown as Record<string, unknown>)
    .single();
  if (error) {
    if (/duplicate|23505/i.test(error.message)) {
      const { data: existing } = await client
        .from(LINKS_TABLE)
        .select("*")
        .eq("digest", digest)
        .single();
      return { ok: true, result: "identical_duplicate", record: existing as AffiliateLinkRecord | null };
    }
    return { ok: false, result: "failed", record: null, reason: "store_error" };
  }
  return { ok: true, result: "created", record: data as AffiliateLinkRecord };
}

/** Registra o resultado de uma validação sobre o link (append-only de rastro). */
export async function recordLinkValidation(
  linkId: string,
  outcome: LinkValidationOutcome,
  updatedBy = "operator-admin"
): Promise<{ ok: boolean; record: AffiliateLinkRecord | null; reason?: string }> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .update({
      validation_state: outcome.validation_state,
      validation_result: outcome,
      status:
        outcome.validation_state === "VALID" ? "VALID" :
        outcome.validation_state === "INVALID" ? "INVALID" :
        "DRAFT",
      updated_at: new Date().toISOString(),
    })
    .eq("link_id", linkId)
    .single();
  if (error) return { ok: false, record: null, reason: "store_error" };
  return { ok: true, record: data as AffiliateLinkRecord };
}

export async function getLink(linkId: string): Promise<AffiliateLinkRecord | null> {
  const client = requireClient();
  const { data, error } = await client.from(LINKS_TABLE).select("*").eq("link_id", linkId).single();
  if (error || !data) return null;
  return data as AffiliateLinkRecord;
}

export async function listLinksByCandidate(candidateId: string): Promise<AffiliateLinkRecord[]> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data as AffiliateLinkRecord[]) ?? [];
}

export async function listLinksByProduct(productId: string): Promise<AffiliateLinkRecord[]> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .select("*")
    .eq("product_id", productId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data as AffiliateLinkRecord[]) ?? [];
}

export async function listLinksByProvider(providerId: string): Promise<AffiliateLinkRecord[]> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .select("*")
    .eq("provider_id", providerId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data as AffiliateLinkRecord[]) ?? [];
}

/** Revoga um link pela autoridade humana (histórico preservado; nunca apaga). */
export async function revokeLink(
  linkId: string,
  revokedBy = "operator-admin"
): Promise<{ ok: boolean; record: AffiliateLinkRecord | null; reason?: string }> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .update({
      status: "REVOKED",
      updated_at: new Date().toISOString(),
      notes: "Revogado por autoridade humana.",
    })
    .eq("link_id", linkId)
    .single();
  if (error) return { ok: false, record: null, reason: "store_error" };
  return { ok: true, record: data as AffiliateLinkRecord };
}

/** Admin-only: exclui registros de uma prova controlada (cleanup). */
export async function deleteProviderForProof(providerId: string): Promise<number> {
  const client = requireClient();
  const { count } = await client.from(LINKS_TABLE).delete().eq("provider_id", providerId);
  const { count: pc } = await client.from(PROVIDERS_TABLE).delete().eq("provider_id", providerId);
  return (count ?? 0) + (pc ?? 0);
}

/** Admin-only: exclui links de uma prova controlada (cleanup). */
export async function deleteLinksForProof(linkIds: ReadonlyArray<string>): Promise<number> {
  const client = requireClient();
  const { count } = await client.from(LINKS_TABLE).delete().in("link_id", linkIds);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// N17 API Acquisition Adapter
// ---------------------------------------------------------------------------
//
// This adapter is deliberately separate from persistLink()/validateLinkInput().
// The existing manual path remains admin:manual + MANUAL. N17 can persist only
// a confirmed N8 result with official-provider provenance and method API.

const N17_PROVENANCE = "n17:api" as const;
const N17_METHOD: LinkMethod = "API";
const N17_CREATED_BY = "n17-orchestrator" as const;

type N17Row = Record<string, unknown>;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validUtc(value: unknown): value is string {
  if (!nonEmpty(value) || !value.endsWith("Z")) return false;
  return Number.isFinite(new Date(value).getTime());
}

function validOfficialUrl(value: unknown, marketplace: AffiliateMarketplace): value is string {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return AFFILIATE_MARKETPLACE_HOSTS[marketplace].some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

function n17Metadata(record: N17AcquisitionRecord): Record<string, unknown> {
  return sanitizeInputMetadata({
    n17_contract_version: "n17-acquisition-v1",
    source_operation: record.provenance.source_operation,
    source_url_origin: record.provenance.source_url_origin,
    acquired_at: record.acquired_at,
  });
}

function validN17Record(record: N17AcquisitionRecord): string | null {
  if (!nonEmpty(record.affiliate_link_id)) return "affiliate_link_id_missing";
  if (!nonEmpty(record.candidate_id) || !validateLinkCandidateId(record.candidate_id)) {
    return "candidate_id_invalid";
  }
  // affiliate_links retains the N6 candidate XOR product invariant. N17
  // acquisitions are candidate-targeted; source product identity is listing_id.
  if (record.product_id !== null) return "n17_product_target_conflicts_with_candidate_target";
  if (!(AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(record.marketplace)) {
    return "marketplace_invalid";
  }
  if (!nonEmpty(record.provider_id)) return "provider_id_missing";
  if (!validOfficialUrl(record.affiliate_url, record.marketplace)) return "affiliate_url_not_official";
  if (!nonEmpty(record.acquisition_ref)) return "acquisition_ref_missing";
  if (!nonEmpty(record.authorization_ref)) return "authorization_ref_missing";
  if (!nonEmpty(record.idempotency_key)) return "idempotency_key_missing";
  if (!/^sha256:[0-9a-f]{64}$/.test(record.response_digest)) return "response_digest_invalid";
  if (record.method !== N17_METHOD) return "method_not_api";
  if (record.provenance.provider !== record.provider_id) return "provenance_provider_mismatch";
  if (record.provenance.marketplace !== record.marketplace) return "provenance_marketplace_mismatch";
  if (record.provenance.method !== N17_METHOD) return "provenance_method_not_api";
  if (record.provenance.source_url_origin !== "official_provider") return "provenance_origin_not_official";
  if (!nonEmpty(record.provenance.source_operation)) return "source_operation_missing";
  if (!nonEmpty(record.identity.listing_id)) return "listing_id_missing";
  if (!nonEmpty(record.identity.seller_id)) return "seller_id_missing";
  if (!nonEmpty(record.identity.title_snapshot)) return "title_snapshot_missing";
  if (!validOfficialUrl(record.identity.canonical_url, record.marketplace)) {
    return "canonical_url_not_official";
  }
  if (!validUtc(record.acquired_at)) return "acquired_at_invalid";
  if (!validUtc(record.observed_at)) return "observed_at_invalid";
  return null;
}

function readMetadata(row: N17Row): Record<string, unknown> | null {
  if (!row.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata)) return null;
  return row.metadata as Record<string, unknown>;
}

function n17RecordFromRow(row: N17Row): N17AcquisitionRecord | null {
  const marketplace = row.marketplace;
  if (marketplace !== "MercadoLivre" && marketplace !== "Shopee") return null;
  const metadata = readMetadata(row);
  if (!metadata) return null;
  const record: N17AcquisitionRecord = {
    affiliate_link_id: typeof row.link_id === "string" ? row.link_id : "",
    candidate_id: typeof row.candidate_id === "string" ? row.candidate_id : "",
    product_id: typeof row.product_id === "string" ? row.product_id : null,
    marketplace,
    provider_id: typeof row.provider_id === "string" ? row.provider_id : "",
    affiliate_url: typeof row.affiliate_url === "string" ? row.affiliate_url : "",
    short_url: null,
    identity: {
      listing_id: typeof row.listing_id === "string" ? row.listing_id : "",
      seller_id: typeof row.seller_id === "string" ? row.seller_id : "",
      title_snapshot: typeof row.title_snapshot === "string" ? row.title_snapshot : "",
      canonical_url: typeof row.canonical_url === "string" ? row.canonical_url : "",
    },
    acquisition_ref: typeof row.acquisition_ref === "string" ? row.acquisition_ref : "",
    authorization_ref: typeof row.authorization_ref === "string" ? row.authorization_ref : "",
    assessment_id: typeof row.assessment_id === "string" ? row.assessment_id : null,
    idempotency_key: typeof row.idempotency_key_n17 === "string" ? row.idempotency_key_n17 : "",
    method: row.method === N17_METHOD ? N17_METHOD : "MANUAL",
    acquired_at: typeof metadata.acquired_at === "string" ? metadata.acquired_at : "",
    observed_at: typeof row.observed_at === "string" ? row.observed_at : "",
    response_digest: typeof row.response_digest_n17 === "string" ? row.response_digest_n17 : "",
    provenance: {
      provider: typeof row.provider_id === "string" ? row.provider_id : "",
      marketplace,
      method: row.method === N17_METHOD ? N17_METHOD : "MANUAL",
      source_operation: typeof metadata.source_operation === "string" ? metadata.source_operation : "",
      source_url_origin: metadata.source_url_origin === "official_provider" ? "official_provider" : "operator_manual",
    },
  };
  const validationReason = validN17Record(record);
  return validationReason ? null : record;
}

function canonicalN17Record(record: N17AcquisitionRecord): Record<string, unknown> {
  return {
    affiliate_link_id: record.affiliate_link_id,
    candidate_id: record.candidate_id,
    product_id: record.product_id,
    marketplace: record.marketplace,
    provider_id: record.provider_id,
    affiliate_url: record.affiliate_url,
    short_url: record.short_url,
    identity: {
      listing_id: record.identity.listing_id,
      seller_id: record.identity.seller_id,
      title_snapshot: record.identity.title_snapshot,
      canonical_url: record.identity.canonical_url,
    },
    acquisition_ref: record.acquisition_ref,
    authorization_ref: record.authorization_ref,
    assessment_id: record.assessment_id,
    idempotency_key: record.idempotency_key,
    method: record.method,
    acquired_at: record.acquired_at,
    observed_at: record.observed_at,
    response_digest: record.response_digest,
    provenance: {
      provider: record.provenance.provider,
      marketplace: record.provenance.marketplace,
      method: record.provenance.method,
      source_operation: record.provenance.source_operation,
      source_url_origin: record.provenance.source_url_origin,
    },
  };
}

function n17RecordsIdentical(left: N17AcquisitionRecord, right: N17AcquisitionRecord): boolean {
  return JSON.stringify(canonicalN17Record(left)) === JSON.stringify(canonicalN17Record(right));
}

async function findN17RowBy(column: string, value: string): Promise<N17Row | null> {
  const client = requireClient();
  const { data, error } = await client
    .from(LINKS_TABLE)
    .select("*")
    .eq(column, value)
    .single();
  if (error || !data || typeof data !== "object") return null;
  return data as N17Row;
}

/** Busca somente a chave de idempotência própria do N17. */
export async function findN17ByIdempotencyKey(key: string): Promise<N17AcquisitionRecord | null> {
  if (!nonEmpty(key)) return null;
  const row = await findN17RowBy("idempotency_key_n17", key);
  return row ? n17RecordFromRow(row) : null;
}

/**
 * Persiste uma aquisição API já confirmada pelo N8.
 *
 * O método nunca chama provider, transporte, GraphQL ou N8. Ele somente
 * registra o resultado confirmado e diferencia replay idêntico de conflito.
 */
export async function persistN17Acquisition(record: N17AcquisitionRecord): Promise<{
  outcome: N17WriteOutcome;
  record: N17AcquisitionRecord | null;
  reason?: string;
}> {
  const invalid = validN17Record(record);
  if (invalid) return { outcome: "failed", record: null, reason: invalid };

  const client = requireClient();
  const now = new Date().toISOString();
  const digest = affiliateLinkDigest({
    provider_id: record.provider_id,
    candidate_id: record.candidate_id,
    product_id: null,
    affiliate_url: record.affiliate_url,
  });
  const row: N17Row = {
    link_id: record.affiliate_link_id,
    candidate_id: record.candidate_id,
    product_id: null,
    marketplace: record.marketplace,
    provider_id: record.provider_id,
    affiliate_url: record.affiliate_url,
    provenance: N17_PROVENANCE,
    status: "DRAFT",
    validation_state: "UNVALIDATED",
    validation_result: {},
    digest,
    observed_at: record.observed_at,
    expires_at: null,
    notes: "N17 acquisition confirmed by N8; publication remains governed by N15/N16.",
    contract_version: "n17-acquisition-v1",
    idempotency_key: null,
    metadata: n17Metadata(record),
    created_by: N17_CREATED_BY,
    created_at: now,
    updated_at: now,
    acquisition_ref: record.acquisition_ref,
    authorization_ref: record.authorization_ref,
    assessment_id: record.assessment_id,
    idempotency_key_n17: record.idempotency_key,
    response_digest_n17: record.response_digest,
    listing_id: record.identity.listing_id,
    seller_id: record.identity.seller_id,
    title_snapshot: record.identity.title_snapshot,
    canonical_url: record.identity.canonical_url,
    method: N17_METHOD,
  };

  const { data, error } = await client.from(LINKS_TABLE).insert(row).single();
  if (!error && data && typeof data === "object") {
    const persisted = n17RecordFromRow(data as N17Row);
    return persisted
      ? { outcome: "created", record: persisted }
      : { outcome: "failed", record: null, reason: "stored_n17_record_invalid" };
  }
  if (!error || !/duplicate|23505/i.test(error.message)) {
    return { outcome: "failed", record: null, reason: "store_error" };
  }

  const existingByKey = await findN17RowBy("idempotency_key_n17", record.idempotency_key);
  const existingN17 = existingByKey ? n17RecordFromRow(existingByKey) : null;
  if (existingN17) {
    return n17RecordsIdentical(existingN17, record)
      ? { outcome: "identical_duplicate", record: existingN17 }
      : { outcome: "conflict", record: null, reason: "idempotency_key_conflict" };
  }

  const existingByDigest = await findN17RowBy("digest", digest);
  if (existingByDigest) {
    return { outcome: "conflict", record: null, reason: "affiliate_link_digest_conflict" };
  }
  return { outcome: "failed", record: null, reason: "duplicate_without_resolvable_record" };
}

/** Adapter injetável usado pelo acquireN17 na composição real do backend. */
export const n17AffiliateRepository: N17Repository = {
  findByIdempotencyKey: findN17ByIdempotencyKey,
  persist: persistN17Acquisition,
};
