// ============================================================================
// Bloco N6 — Affiliate Economics + Link Resolution — Contrato v1.0
import { createHash } from "node:crypto";
//
// Fronteiras de governança (inalteráveis nesta fase):
//   AFFILIATE LINK != PRODUCT FACT
//     O link nunca promove candidato, nunca cria produto canônico e nunca
//     autoriza publicação por si só.
//   AFFILIATE LINK != AUTHORITY
//     Registrar/validar um link NÃO executa publicação. A publicação segue
//     exclusivamente o fluxo do N5: DECISION + Policy Engine + ApprovalStore.
//   MEMORY != AUTHORITY
//     Proveniência fechada; o sistema JAMAIS deriva affiliate_url de uma URL
//     comum de marketplace, listing_key, slug, domínio ou heurística.
//   FAIL-CLOSED
//     Estado desconhecido ou inconclusivo NUNCA vira APPROVED/VALID.
//
// Catálogos fechados (CHECKs espelhados na migration):
//   ProviderStatus:    ACTIVE | INACTIVE | PENDING_REVIEW | WITHDRAWN
//   ResolutionMethod:  MANUAL (único implementado v1) | IMPORT | PORTAL | API
//   Ownership:         owner-human (sempre; adesão a programa é humana)
//   Provenance:        admin:manual | n17:api (N17 API acquisition path)
//   LinkStatus:        DRAFT | VALID | EXPIRED | INVALID | REVOKED
//   ValidationState:   UNVALIDATED | VALID | INVALID | INCONCLUSIVE |
//                      PENDING_EXTERNAL
//   Marketplace:       MercadoLivre | Shopee (catálogo fechado do N2)
// ============================================================================

/**
 * Marketplace fechado do N6 — espelha MarketplaceSource do N2:
 * MercadoLivre | Shopee. Não inventar novos marketplaces sem autorização.
 */
export const AFFILIATE_MARKETPLACES = ["MercadoLivre", "Shopee"] as const;
export type AffiliateMarketplace = (typeof AFFILIATE_MARKETPLACES)[number];

export function isAffiliateMarketplace(value: unknown): value is AffiliateMarketplace {
  return typeof value === "string" && (AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(value);
}

/** Domínios permitidos por marketplace (mesmo catálogo do N2). */
export const AFFILIATE_MARKETPLACE_HOSTS: Record<AffiliateMarketplace, ReadonlyArray<string>> = {
  MercadoLivre: ["mercadolivre.com.br", "mercadolibre.com", "meli.la"],
  Shopee: ["shopee.com.br", "shopee.com", "shope.ee"],
} as const;

export const PROVIDER_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "PENDING_REVIEW",
  "WITHDRAWN",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const RESOLUTION_METHODS = ["MANUAL", "IMPORT", "PORTAL", "API"] as const;
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

export const OWNERSHIPS = ["owner-human"] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

export const LINK_PROVENANCES = ["admin:manual", "n17:api"] as const;
export type LinkProvenance = (typeof LINK_PROVENANCES)[number];

/** Método persistido; nullable em AffiliateLinkRecord para legacy rows. */
export const LINK_METHODS = ["MANUAL", "API"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];

export const LINK_STATUSES = ["DRAFT", "VALID", "EXPIRED", "INVALID", "REVOKED"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const VALIDATION_STATES = [
  "UNVALIDATED",
  "VALID",
  "INVALID",
  "INCONCLUSIVE",
  "PENDING_EXTERNAL",
] as const;
export type ValidationState = (typeof VALIDATION_STATES)[number];

/** Registro persistido de um Affiliate Provider. */
export interface AffiliateProviderRecord {
  provider_id: string;
  provider_code: string;
  name: string;
  marketplace: AffiliateMarketplace;
  program_name: string;
  status: ProviderStatus;
  resolution_method: ResolutionMethod;
  ownership: Ownership;
  provenance: LinkProvenance;
  credential_ref: string;
  terms_url: string;
  notes: string;
  contract_version: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Registro persistido de um Affiliate Link. */
export interface AffiliateLinkRecord {
  link_id: string;
  candidate_id: string | null;
  product_id: string | null;
  marketplace: AffiliateMarketplace;
  provider_id: string;
  affiliate_url: string;
  provenance: LinkProvenance;
  status: LinkStatus;
  validation_state: ValidationState;
  validation_result: Record<string, unknown>;
  digest: string;
  observed_at: string;
  expires_at: string | null;
  notes: string;
  contract_version: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** N17 API acquisition fields; nullable/optional for legacy manual links. */
  acquisition_ref?: string | null;
  authorization_ref?: string | null;
  assessment_id?: string | null;
  idempotency_key_n17?: string | null;
  response_digest_n17?: string | null;
  listing_id?: string | null;
  seller_id?: string | null;
  title_snapshot?: string | null;
  canonical_url?: string | null;
  method?: LinkMethod | null;
}

// ---------------------------------------------------------------------------
// Resultados de operações do repositório/serviço
// ---------------------------------------------------------------------------
export interface IdempotentWriteResult<T> {
  ok: boolean;
  result: "created" | "identical_duplicate" | "modified" | "failed";
  record: T | null;
  reason?: string;
}

/** Requisição para registrar um provider (input de rota). */
export interface RegisterProviderInput {
  provider_code: string;
  name: string;
  marketplace: AffiliateMarketplace;
  program_name?: string;
  status?: ProviderStatus;
  resolution_method?: ResolutionMethod;
  credential_ref?: string;
  terms_url?: string;
  notes?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

/** Requisição para registrar um link de afiliado (input de rota). */
export interface RegisterLinkInput {
  candidate_id?: string | null;
  product_id?: string | null;
  marketplace: AffiliateMarketplace;
  provider_id: string;
  affiliate_url: string;
  provenance?: LinkProvenance;
  expires_at?: string | null;
  notes?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}

/** Resultado detalhado da validação de um link. */
export interface LinkValidationOutcome {
  validation_state: ValidationState;
  checks: ReadonlyArray<{
    check: string;
    ok: boolean;
    reason?: string;
  }>;
  /** Final host observado quando a checagem viva foi executada. */
  final_host?: string | null;
}

/**
 * affiliateLinkDigest — digest idempotente do link:
 * sha256(provider_id:target:affiliate_url). Target = candidate_id ou
 * product_id (um e somente um). Reproduzido na migration e no repository.
 */
export function affiliateLinkDigest(params: {
  provider_id: string;
  candidate_id?: string | null;
  product_id?: string | null;
  affiliate_url: string;
}): string {
  const target = params.candidate_id ?? params.product_id ?? "";
  const payload = [params.provider_id, target, params.affiliate_url].join(":");
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
