// ============================================================================
// Bloco N8 — AffiliateLinkAcquirer — CONTRATO CONCEITUAL (local, NÃO em uso)
//
// Propósito desta Fase 2:
//   (a) documentar o contrato de aquisição antes de qualquer implementação;
//   (b) permitir testes puramente locais de fail-closed (mocks; nada é
//       gravado, nenhuma API real é chamada, nenhum link é gerado).
//
// Este módulo NÃO é registrado em rotas, NÃO é injetado no executor N5,
// NÃO é consumido pelo resolver N7 e NÃO possui provider registrado.
// Até que uma migration autorizada introduza proveniência `admin:acquired`,
// qualquer link produzido por este contrato NUNCA seria aceito pelo
// sistema (validateAffiliateLink exige proveniência de catálogo fechado).
//
// Princípios preservados:
//   CANDIDATE != FACT CANÔNICO
//   AFFILIATE URL != PRODUCT URL
//   ACQUISITION != PUBLICATION
//   VALID != AUTHORITY
//   MEMORY != AUTHORITY
//   RESOLUTION != DECISION
// ============================================================================

export const AFFILIATE_ACQUISITION_CONTRACT_VERSION = "n8-acquire-v0" as const;

/** Métodos de aquisição oficiais (fechados — migration autorizada exigida). */
export type AcquisitionMethod = "MANUAL" | "API" | "IMPORT";

/** Proveniência proposta para o N8 (NÃO registrada no banco nesta fase). */
export const PROVENIENCE_ADMIN_ACQUIRED = "admin:acquired" as const;

/** Identidade do produto confirmada pelo mecanismo oficial. */
export interface ProductIdentity {
  readonly marketplace: "MercadoLivre" | "Shopee";
  /** listing_id oficial retornado pelo mecanismo oficial. */
  readonly listingId: string | null;
  /** URL canônica do produto na fonte oficial. */
  readonly canonicalUrl: string;
  /** seller_id oficial (se disponível). */
  readonly sellerId: string | null;
  /** snapshot do título na aquisição. */
  readonly titleSnapshot: string;
}

export type IdentityConfidence =
  | "PRODUCT_IDENTITY_CONFIRMED"
  | "PRODUCT_IDENTITY_UNCERTAIN";

/** Referência do produto solicitada na aquisição. */
export interface ProductReference {
  readonly marketplace: ProductIdentity["marketplace"];
  readonly productId?: string | null;
  readonly candidateId?: string | null;
  /** URL pública do produto (NUNCA é presumida como affiliate URL). */
  readonly publicUrl: string;
}

/** Contexto do provider N6 (somente leitura). */
export interface ProviderContext {
  readonly providerId: string;
  readonly marketplace: ProductIdentity["marketplace"];
  readonly active: boolean;
  /** credenciais oficiais necessárias para o mecanismo (AppId/Secret/Token). */
  readonly credentials: { readonly present: boolean; readonly expired: boolean };
}

/** Resultado de uma aquisição — catálogo fechado (fail-closed).
 *
 * DISTINÇÃO RASTREÁVEL (patch de contrato):
 *   SUCCESS              → link obtido de mecanismo governado COM
 *                          PRODUCT_IDENTITY_CONFIRMED. Único caminho que
 *                          pode, futuramente (via N6/N7/N5), chegar a
 *                          publicação — nunca por este módulo (N8 NÃO
 *                          publica).
 *   IDENTITY_UNCERTAIN   → link obtido (evidência/preservada), mas a
 *                          identidade NÃO foi confirmada (falta
 *                          listing_id/seller_id/título oficial). JAMAIS
 *                          é tratado como sucesso confirmado e NUNCA é
 *                          elegível para publicação apenas com essa
 *                          identidade. rationale obrigatório.
 *   AUTH_REQUIRED / NOT_SUPPORTED / MANUAL_REQUIRED / PRODUCT_NOT_ELIGIBLE /
 *   PROVIDER_NOT_ACTIVE / RESOLUTION_FAILED → falha fechada explícita;
 *   nenhum deles carrega affiliate URL elegível.
 * CONFIRMED != UNCERTAIN != FAILED.
 */
export type AcquireResult =
  | { readonly kind: "SUCCESS"; readonly affiliateUrl: string; readonly identity: ProductIdentity; readonly identityConfidence: Extract<IdentityConfidence, "PRODUCT_IDENTITY_CONFIRMED">; readonly method: "API" | "MANUAL"; readonly acquisitionRef: string; readonly rawResponse: unknown; readonly acquiredAt: number }
  | { readonly kind: "IDENTITY_UNCERTAIN"; readonly affiliateUrl: string; readonly identity: ProductIdentity; readonly identityConfidence: Extract<IdentityConfidence, "PRODUCT_IDENTITY_UNCERTAIN">; readonly rationale: string; readonly method: "API" | "MANUAL"; readonly acquisitionRef: string; readonly rawResponse: unknown; readonly acquiredAt: number }
  | { readonly kind: "AUTH_REQUIRED"; readonly reason: string }
  | { readonly kind: "NOT_SUPPORTED"; readonly marketplace: ProductIdentity["marketplace"] }
  | { readonly kind: "MANUAL_REQUIRED"; readonly reason: string }
  | { readonly kind: "PRODUCT_NOT_ELIGIBLE"; readonly reason: string }
  | { readonly kind: "PROVIDER_NOT_ACTIVE"; readonly providerId: string }
  | { readonly kind: "RESOLUTION_FAILED"; readonly reason: string };

export function isAcquireSuccess(result: AcquireResult): result is Extract<AcquireResult, { kind: "SUCCESS" }> {
  return result.kind === "SUCCESS";
}

/** Identidade incerta — NÃO é sucesso confirmado (fail-closed p/ publicação). */
export function isAcquireIdentityUncertain(result: AcquireResult): result is Extract<AcquireResult, { kind: "IDENTITY_UNCERTAIN" }> {
  return result.kind === "IDENTITY_UNCERTAIN";
}
