// ============================================================================
// Integração oficial Shopee Afiliados BR — contratos internos (fail-closed)
//
// PROPÓSITO: tipos internos ESTÁVEIS entre o cliente da API oficial da
// Shopee e a autoridade N8 (AffiliateLinkAcquirer). Os tipos GraphQL da
// Shopee NUNCA vazam para fora desta camada.
//
// GOVERNANÇA (invariantes absolutos):
//   1. DISCOVERY != AFFILIATE ACQUISITION. RESEARCH != AFFILIATE ACQUISITION.
//   2. AFFILIATE ACQUISITION != PUBLICATION.
//   3. Nenhuma mutation em products, candidates, affiliate_links,
//      job_queue, scheduler ou agentes por esta camada.
//   4. "API respondeu produto" != "affiliate link adquirido". Estados
//      distintos e rastreáveis (found / eligible / link_acquired /
//      not_eligible / not_found / auth_error / rate_limited /
//      transient / permanent / invalid_response).
//   5. Erro desconhecido = FAIL-CLOSED. Nunca transformar erro externo
//      em sucesso.
//   6. Secret nunca aparece em logs, erros, respostas ou testes.
// ============================================================================

/**
 * Catálogo fechado de erros internos do cliente Shopee.
 * Adaptado ao padrão de catálogo do projeto (mesmo espírito dos
 * discovery/acquisition error reasons). Erro não mapeado → UNKNOWN_ERROR
 * (fail-closed).
 */
export const SHOPEE_ERROR_KINDS = [
  "SHOPEE_NOT_CONFIGURED",
  "SHOPEE_AUTH_ERROR",
  "SHOPEE_FORBIDDEN",
  "SHOPEE_RATE_LIMITED",
  "SHOPEE_TIMEOUT",
  "SHOPEE_NETWORK_ERROR",
  "SHOPEE_GRAPHQL_ERROR",
  "SHOPEE_INVALID_RESPONSE",
  "SHOPEE_NOT_FOUND",
  "SHOPEE_NOT_ELIGIBLE",
  "SHOPEE_UNKNOWN_ERROR",
] as const;
export type ShopeeErrorKind = (typeof SHOPEE_ERROR_KINDS)[number];

export function isShopeeErrorKind(value: unknown): value is ShopeeErrorKind {
  return typeof value === "string" && (SHOPEE_ERROR_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Erros transitórios permitidos a retry (lista fechada). Qualquer outro
 * errorKind é permanente — retry agressivo é proibido.
 */
export const SHOPEE_TRANSIENT_KINDS = [
  "SHOPEE_RATE_LIMITED",
  "SHOPEE_TIMEOUT",
  "SHOPEE_NETWORK_ERROR",
] as const;
export type ShopeeTransientErrorKind = (typeof SHOPEE_TRANSIENT_KINDS)[number];

export function isShopeeTransientError(kind: ShopeeErrorKind): kind is ShopeeTransientErrorKind {
  return (SHOPEE_TRANSIENT_KINDS as ReadonlyArray<string>).includes(kind);
}

/**
 * Catálogo fechado de operações oficiais da API de Afiliados BR.
 * Apenas operações documentadas no contrato da plataforma de afiliados.
 * NÃO inventar operações. Adicionar somente com documento oficial.
 */
export const SHOPEE_OPERATIONS = [
  "productOfferV2",
  "productOfferSearch",
  "productOfferDirect",
  "generateShortLink",
] as const;
export type ShopeeOperation = (typeof SHOPEE_OPERATIONS)[number];

/** Limite padrão de requisições concorrentes (sem retry agressivo). */
export const SHOPEE_DEFAULT_TIMEOUT_MS = 10_000;

/** Janela oficial de validade da assinatura (timestamp em segundos). */
export const SHOPEE_SIGNATURE_VALID_WINDOW_SECONDS = 5 * 60;

/**
 * Requisição interna estável para o cliente (produto a consultar).
 * Não espalha tipos GraphQL da Shopee.
 */
export interface ShopeeProductLookupRequest {
  /** shop_id da fonte (item de Shopee). */
  readonly shopId?: string | null;
  /** item_id da fonte (item de Shopee). */
  readonly itemId?: string | null;
  /** URL pública do produto (usável para extrair shop/item quando
   *  shopId/itemId ausentes — extração estrita, nunca presumida). */
  readonly publicUrl?: string | null;
}

/**
 * Prova oficial da resolução direcionada (D-SHOPEE-1, 2026-08-18):
 * introspection real da API BR confirmou que productOfferV2 aceita
 * os argumentos oficiais itemId (Int64) e shopId (Int64). A consulta
 * `productOfferV2(itemId, shopId, limit: 1)` retorna o nó exato com
 * identificadores oficiais — correspondência returned == requested
 * estabelece IDENTITY_CONFIRMED. Tupla ausente/não elegível retorna
 * nodes vazio (IDENTITY_UNCERTAIN, fail-closed).
 *
 * generateShortLink(input: { originUrl: String!, subIds: [String] })
 * → { shortLink, longLink } (mutation oficial do BR): gera link curto
 * de afiliado da URL específica de produto/loja/oferta (subIds máx 5,
 * alfanuméricos, máx 40 chars; fora disso → erro oficial 11001).
 */

/**
 * Resultado estável de uma consulta por produto (NÃO é link de afiliado).
 * Estado "found" significa: a fonte oficial reconheceu o produto —
 * o link de afiliado segue outro caminho (eligibilidade/acquisition).
 */
export interface ShopeeProductLookupResult {
  readonly status: "found" | "not_found" | "not_eligible" | "error";
  readonly shopId: string | null;
  readonly itemId: string | null;
  readonly name: string | null;
  readonly priceMinorUnits: number | null;
  readonly productLink: string | null;
  /** Status HTTP observado; null quando não houve resposta HTTP utilizável. */
  readonly httpStatus: number | null;
  readonly raw: unknown;
  /** Error somente quando status === "error" — sempre com kind catalogado. */
  readonly error: ShopeeClientError | null;
}

/**
 * Resultado estável de aquisição de link de afiliado via API oficial.
 * link_acquired exige URL oficial + elegibilidade explícita da fonte.
 */
export interface ShopeeAffiliateAcquisitionResult {
  readonly status:
    | "link_acquired"
    | "not_eligible"
    | "not_found"
    | "auth_error"
    | "rate_limited"
    | "transient"
    | "permanent"
    | "invalid_response"
    | "error";
  readonly affiliateUrl: string | null;
  readonly productLink: string | null;
  readonly shopId: string | null;
  readonly itemId: string | null;
  readonly name: string | null;
  readonly raw: unknown;
  readonly error: ShopeeClientError | null;
}

/**
 * Erro catalogado do cliente — SEM valores de secret.
 * A mensagem é segura para log/transporte: jamais contém headers,
 * credenciais ou payloads com valores sensíveis.
 */
export class ShopeeClientError extends Error {
  constructor(
    readonly kind: ShopeeErrorKind,
    readonly detail?: string,
    readonly httpStatus: number | null = null,
  ) {
    // Mensagem determinística e sem valores sensíveis (fail-closed).
    super(`shopee_client_error:${kind}${detail ? `:${detail}` : ""}`);
    this.name = "ShopeeClientError";
  }
}

/**
 * Extrai (shop_id, item_id) de uma URL pública Shopee de forma estrita:
 * aceita apenas os padrões oficiais de listing de produto.
 * Qualquer outra forma → null (nunca derivada de heurística fraca).
 */
export function extractShopeeIdentifiers(publicUrl: string): { shopId: string | null; itemId: string | null } {
  const out = { shopId: null as string | null, itemId: null as string | null };
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return out;
  }
  const host = parsed.hostname.toLowerCase();
  const hosts = ["shopee.com.br", "shopee.com", "shope.ee"];
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return out;
  }
  // Padrão oficial: /Produto-i.{shopId}.{itemId} e variantes por locale.
  const pathMatch = /-i\.(\d{1,20})\.(\d{1,20})(?:[/?#]|$)/.exec(parsed.pathname);
  if (pathMatch) {
    out.shopId = pathMatch[1];
    out.itemId = pathMatch[2];
    return out;
  }
  // Padrão oficial 2: query shop_id/item_id (produto compartilhado).
  out.shopId = parsed.searchParams.get("shop_id") ?? null;
  out.itemId = parsed.searchParams.get("item_id") ?? null;
  if (out.shopId && out.itemId) return out;
  // Padrão oficial 3: /product/{shopId}/{itemId} (share URL).
  const productMatch = /^\/product\/(\d{1,20})\/(\d{1,20})(?:[/?#]|$)/.exec(parsed.pathname);
  if (productMatch) {
    out.shopId = productMatch[1];
    out.itemId = productMatch[2];
    return out;
  }
  return out;
}
