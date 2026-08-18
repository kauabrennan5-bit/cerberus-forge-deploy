// ============================================================================
// Shopee Affiliate Provider — adapter entre o cliente oficial Shopee BR
// e a autoridade N8 (AffiliateLinkAcquirer / AffiliateApiSource).
//
// GOVERNANÇA (invariantes absolutos):
//   1. "API respondeu produto" != "affiliate link adquirido". O adapter
//      mapeia explicitamente: link_acquired → SUCCESS (com a validação de
//      host do N8); not_eligible → IDENTITY_UNCERTAIN (link público sem
//      link oficial de afiliado — jamais derivado); not_found →
//      RESOLUTION_FAILED (produto não localizado na fonte oficial);
//      auth/rate/transient/permanent/invalid → RESOLUTION_FAILED.
//   2. DISCOVERY != AFFILIATE ACQUISITION. RESEARCH != AFFILIATE ACQUISITION.
//   3. AFFILIATE ACQUISITION != PUBLICATION. Este módulo não grava nada.
//   4. Secret nunca aparece em logs, erros, responses ou metadata.
//   5. Retry interno limitado e SOMENTE para transitórios catalogados
//      (RATE_LIMITED/TIMEOUT/NETWORK_ERROR); máx 1 retry adicional; demais
//      erros nunca são retentados.
//   6. Catálogo de erros interno (shopeeClientContracts):
//      SHOPEE_NOT_CONFIGURED | AUTH_ERROR | FORBIDDEN | RATE_LIMITED |
//      TIMEOUT | NETWORK_ERROR | GRAPHQL_ERROR | INVALID_RESPONSE |
//      NOT_FOUND | NOT_ELIGIBLE | UNKNOWN_ERROR.
// ============================================================================

import {
  type AffiliateApiSource,
  type OfficialGenerateRequest,
  type OfficialGenerateResponse,
} from "./acquisitionService";
// (Nenhum import adicional de acquisitionService — o fail-closed de host
//  whitelist/identidade é aplicado pelo acquireAffiliateLink da autoridade N8.)
// (Imports N8: acquisitionService para OfficialGenerate* e AffiliateApiSource;
//  shopeeApiClient/shopeeClientContracts para o transporte oficial.)
import { createShopeeApiClient, type ShopeeApiClient } from "./shopeeApiClient";
import {
  extractShopeeIdentifiers,
  type ShopeeErrorKind,
} from "./shopeeClientContracts";

/** Injetável para testes — construtor do cliente. */
export type ShopeeClientFactory = (options: {
  appId: string;
  secret: string;
  baseUrl?: string;
  timeoutMs?: number;
  transport?: import("./shopeeApiClient").ShopeeHttpTransport;
  clock?: () => number;
}) => ShopeeApiClient;

export interface ShopeeProviderOptions {
  readonly appId: string;
  readonly secret: string;
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Fábrica injetável (teste). */
  readonly clientFactory?: ShopeeClientFactory;
  /** Clock injetável (teste). */
  readonly clock?: () => number;
}

/** Tempo máximo de espera entre tentativas de retry (backoff estático curto). */
const SHOPEE_RETRY_DELAY_MS = 1_500;

/** Máximo de tentativas totais (1 inicial + 1 retry) — nunca agressivo. */
const SHOPEE_MAX_ATTEMPTS = 2;

/**
 * Provider/adapter oficial Shopee BR para o N8.
 *
 * O adapter constrói um AffiliateApiSource (fonte oficial injetável) a
 * partir do cliente isolado, preservando TODO o fail-closed do
 * acquireAffiliateLink (host whitelist, identidade confirmada/incerta,
 * AUTH_REQUIRED sem credenciais).
 *
 * Sem credenciais não vazias, JAMAIS é construído — a rota /acquire
 * continua AUTH_REQUIRED.
 */
export function createShopeeAffiliateProvider(options: ShopeeProviderOptions) {
  if (!options.appId || !options.secret) {
    throw new Error("shopee_provider_credentials_missing:appId_e_secret_sao_obrigatorios");
  }

  const client = (options.clientFactory ?? createShopeeApiClient)({
    appId: options.appId,
    secret: options.secret,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    clock: options.clock,
  });

  async function generateWithRetry(
    request: OfficialGenerateRequest,
    attempt = 1,
  ): Promise<OfficialGenerateResponse> {
    try {
      return await generateOnce(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      // Retry somente para transitórios catalogados (lista fechada).
      const isTransient = message.startsWith("shopee_client_error:SHOPEE_RATE_LIMITED") ||
        message.startsWith("shopee_client_error:SHOPEE_TIMEOUT") ||
        message.startsWith("shopee_client_error:SHOPEE_NETWORK_ERROR");
      if (isTransient && attempt < SHOPEE_MAX_ATTEMPTS) {
        await sleep(SHOPEE_RETRY_DELAY_MS);
        return generateWithRetry(request, attempt + 1);
      }
      throw err;
    }
  }

  async function generateOnce(request: OfficialGenerateRequest): Promise<OfficialGenerateResponse> {
    // Identificadores: explícitos na referência (productId/candidateId como
    // itemId) ou extraídos de forma estrita da publicUrl — nunca presumidos.
    const wantItemId = typeof request.reference.productId === "string" && request.reference.productId.length > 0
      ? request.reference.productId
      : null;
    const identifiers = extractShopeeIdentifiers(request.reference.publicUrl);
    const itemId = wantItemId ?? identifiers.itemId ?? null;
    const shopId = identifiers.shopId ?? null;
    // Sem identificadores válidos → não é possível localizar o produto na
    // fonte oficial (fail-closed; jamais consultar "a vitrine" como se fosse
    // o produto do candidato).
    if (!itemId || !shopId) {
      throw new Error("shopee_client_error:SHOPEE_NOT_FOUND:no_valid_identifiers");
    }
    // D-SHOPEE-1 (2026-08-18): resolução direcionada oficial —
    // productOfferV2(itemId, shopId, limit:1) é consultada com os
    // identificadores como ARGUMENTOS oficiais da API (match exato de
    // identificadores oficiais → IDENTITY_CONFIRMED).
    const result = await client.acquireAffiliateLink({ shopId, itemId });
    switch (result.status) {
      case "link_acquired": {
        // A URL oficial é preservada exatamente como veio (sem normalização).
        if (!result.affiliateUrl) {
          throw new Error("shopee_client_error:SHOPEE_INVALID_RESPONSE:no_affiliate_url");
        }
        return {
          affiliateUrl: result.affiliateUrl,
          listingId: result.itemId,
          sellerId: result.shopId,
          titleSnapshot: result.name,
          raw: result.raw,
        };
      }
      case "not_eligible": {
        // A fonte oficial reconhece o produto mas NÃO devolveu link de
        // afiliado (produto não elegível para o programa). Fail-closed:
        // nenhuma URL pública pode substituir o link oficial.
        throw new Error("shopee_client_error:SHOPEE_NOT_ELIGIBLE:offer_without_official_affiliate_link");
      }
      case "not_found": {
        // Fallback direcionado oficial (D-SHOPEE-1): a listagem de ofertas
        // pode não conter o produto (não elegível a afiliado ou indisponível
        // na listagem), mas a mutation oficial generateShortLink gera o link
        // de afiliado da URL específica do produto — ainda com tracking
        // oficial (utm_medium=affiliates) e sem derivar/heurística.
        if (request.reference.publicUrl) {
          const shortLink = await client.generateShortLink({
            originUrl: request.reference.publicUrl,
            subIds: request.reference.productId ? [`p${request.reference.productId.slice(0, 24)}`] : undefined,
          });
          if (shortLink.status === "link_acquired" && shortLink.shortLink) {
            return {
              affiliateUrl: shortLink.shortLink,
              listingId: itemId,
              sellerId: shopId,
              titleSnapshot: null,
              raw: null,
            };
          }
          if (shortLink.status === "invalid_url") {
            throw new Error("shopee_client_error:SHOPEE_INVALID_RESPONSE:public_url_rejected_by_official_shortlink");
          }
          if (shortLink.status === "transient") {
            throw new Error("shopee_client_error:SHOPEE_TRANSIENT:official_shortlink_transient");
          }
        }
        throw new Error("shopee_client_error:SHOPEE_NOT_FOUND:product_not_in_official_offers");
      }
      case "auth_error": {
        throw new Error(`shopee_client_error:SHOPEE_AUTH_ERROR:${shopeeErrorDetail(result.error?.kind)}`);
      }
      case "rate_limited": {
        throw new Error("shopee_client_error:SHOPEE_RATE_LIMITED:official_429");
      }
      case "transient": {
        throw new Error(`shopee_client_error:SHOPEE_TRANSIENT:${shopeeErrorDetail(result.error?.kind)}`);
      }
      case "permanent":
      case "invalid_response":
      case "error":
      default: {
        throw new Error(`shopee_client_error:SHOPEE_PERMANENT:${shopeeErrorDetail(result.error?.kind)}`);
      }
    }
  }

  function shopeeErrorDetail(kind: ShopeeErrorKind | undefined): string {
    return typeof kind === "string" ? kind : "unknown";
  }

  return {
    providerId: options.providerId,
    /**
     * AffiliateApiSource oficial — injetável na autoridade N8
     * (setAffiliateApiSource no bootstrap). O acquireAffiliateLink do N8
     * aplica por cima: host whitelist, identidade confirmada/incerta,
     * AUTH_REQUIRED quando a fonte é nula, e gravação apenas pelo contrato
     * N6 (DRAFT/UNVALIDATED).
     */
    apiSource(): AffiliateApiSource {
      return {
        providerId: options.providerId,
        async generateLink(request: OfficialGenerateRequest): Promise<OfficialGenerateResponse> {
          return generateWithRetry(request);
        },
      };
    },
  };
}

export type ShopeeAffiliateProvider = ReturnType<typeof createShopeeAffiliateProvider>;

// ---------------------------------------------------------------------------
// Helpers internos (sem dependência circular com acquisitionService).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
