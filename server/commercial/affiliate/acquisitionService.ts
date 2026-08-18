// ============================================================================
// Bloco N8 — AffiliateLinkAcquirer — SERVICE DE AQUISIÇÃO (fail-closed)
//
// PROPÓSITO:
//   Obter o affiliate URL EXATO do mecanismo oficial do provider, sem
//   jamais derivá-lo, adulterá-lo ou presumi-lo a partir de URL pública.
//
// PATCH DE CONTRATO (pós-revisão Fase 3):
//   SUCCESS é reservado exclusivamente para identidade CONFIRMADA
//   (listing_id + seller_id + título oficial). Identidade incerta
//   retorna o estado explícito IDENTITY_UNCERTAIN — que preserva a
//   evidência e a proveniência, mas JAMAIS é tratado como aquisição
//   confirmada nem é elegível para publicação. CONFIRMED != UNCERTAIN != FAILED.
//
// GOVERNANÇA (invariantes absolutos):
//   1. ACQUISITION != REGISTRATION: este serviço NUNCA grava no banco.
//      O registro continua exclusivo das rotas N6 (persistLink), que
//      fixam provenance "admin:manual" (provenance "admin:acquired"
//      exigirá migration autorizada futura — ACQUISITION_CONTRACT_VERSION
//      já declara a intenção para auditoria).
//   2. AFFILIATE URL != PRODUCT URL: o serviço jamais retorna/admite URL
//      pública como affiliate URL. Qualquer valor que não passe pelo
//      host-whitelist oficial é REJECTED (PRODUCT_NOT_ELIGIBLE ou
//      RESOLUTION_FAILED).
//   3. FAIL-CLOSED: qualquer falha de configuração, rede, assinatura ou
//      contrato de resposta → RESOLUTION_FAILED (nunca URL derivada).
//   4. NO HALLUCINATION: endpoint, credenciais ou queries JAMAIS são
//      inventados. Sem credencial/base-url oficial configurada, a API
//      é inatingível por design (AUTH_REQUIRED), e nenhum endpoint
//      alternativo é tentado.
//   5. MEMORY != AUTHORITY: o resultado deste serviço é uma Aquisição
//      candidata, não uma autoridade. A publicação continua exclusiva
//      do N5 (DECISION + Policy Engine + ApprovalStore + resolver N7).
//
// MERCADO LIVRE (3C): sem API oficial documentada (NOT_AVAILABLE_
// VIA_DOCUMENTED_API — escopos OAuth fechados, read/write/offline_access
// apenas). Aquisição programática = NOT_SUPPORTED. O caminho ML segue
// exclusivamente MANUAL assistido (rota N6 POST /links ou /acquire com
// affiliate_url explícito do operador).
//
// SHOPEE (3B): credencial oficial (AppID + Senha) confirmada na conta
// de afiliado (Fase 3A). Especificação GraphQL oficial confirmada
// (texto do portal). Endpoint BR exato = NEEDS_VERIFICATION — por isso
// a camada de API é ABSTRATA e injetável: o operador configura
// SHOPEE_AFFILIATE_API_BASE_URL (vazio por padrão). Configurado, a
// primeira chamada real só ocorre por rota administrativa autenticada
// e audita toda resposta contra o contrato (RESOLUTION_FAILED se
// fora do contrato).
// ============================================================================

import { createHash } from "crypto";
import {
  AFFILIATE_MARKETPLACES,
  AFFILIATE_MARKETPLACE_HOSTS,
  type AffiliateMarketplace,
  type AffiliateProviderRecord,
} from "./contract";
import {
  AFFILIATE_ACQUISITION_CONTRACT_VERSION,
  type AcquireResult,
  type ProductReference,
  type ProductIdentity,
  type ProviderContext,
  type AcquisitionMethod,
  isAcquireSuccess,
} from "./acquisitionContract";

export const AFFILIATE_ACQUIRER_CONTRACT_VERSION = AFFILIATE_ACQUISITION_CONTRACT_VERSION;

// ---------------------------------------------------------------------------
// Camada de API externa — ABSTRATA e injetável (fail-closed por design).
// ---------------------------------------------------------------------------

/** Requisição de geração de link enviada à API oficial (GraphQL). */
export interface OfficialGenerateRequest {
  readonly providerContext: ProviderContext;
  readonly reference: ProductReference;
  /** sub_id oficial de rastreamento (Shopee). Configurável; default do provider. */
  readonly subId: string;
}

/** Resposta esperada do contrato oficial (campo do produto de link). */
export interface OfficialGenerateResponse {
  /** URL de afiliado retornada EXATAMENTE como veio do mecanismo oficial. */
  readonly affiliateUrl: string;
  /** listing_id oficial (se o mecanismo o retornou). */
  readonly listingId: string | null;
  /** seller_id oficial (se o mecanismo o retornou). */
  readonly sellerId: string | null;
  /** Título confirmado pela fonte oficial (se disponível). */
  readonly titleSnapshot: string | null;
  /** Resposta bruta do mecanismo (para auditoria). */
  readonly raw: unknown;
}

/** Contrato da API oficial (interface mínima — implementação injetável). */
export interface AffiliateApiSource {
  /** Nome do provider ao qual a fonte pertence. */
  readonly providerId: string;
  /** Chamada real ao mecanismo oficial. Jamais retorna URL derivada. */
  generateLink(request: OfficialGenerateRequest): Promise<OfficialGenerateResponse>;
}

/**
 * Injetar fonte real para produção — a implementação oficial Shopee BR
 * vive em shopeeAffiliateProvider.ts (D-SHOPEE-1: resolução direcionada
 * via productOfferV2(itemId, shopId) + fallback oficial generateShortLink).
 * A fonte é injetada uma única vez no bootstrap (server.ts) com
 * credenciais de variáveis de ambiente (jamais no código). Este módulo
 * NÃO implementa transporte de API (fonte legada createShopeeApiSource
 * removida — o transporte vive no cliente isolado shopeeApiClient.ts).
 */
let apiSource: AffiliateApiSource | null = null;

export function setAffiliateApiSource(source: AffiliateApiSource | null): void {
  apiSource = source;
}

/** Test-only: reset da fonte injetada. */
export function resetAffiliateApiSource(): void {
  apiSource = null;
}

/** Test-only: obtenção da fonte atual. */
export function getAffiliateApiSource(): AffiliateApiSource | null {
  return apiSource;
}

/** Endpoint oficial da API Open de Afiliados Shopee Brasil (padrão). */
export const SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL = "https://open-api.affiliate.shopee.com.br/graphql";
// NOTA: a query oficial de ofertas vive agora no cliente isolado
// shopeeApiClient.ts (D-SHOPEE-1: productOfferV2 com itemId/shopId como
// argumentos oficiais confirmados por introspection da API real).


export interface AcquireOptions {
  /** Provider N6 de origem (somente leitura). */
  readonly provider: AffiliateProviderRecord;
  /** Referência do produto. */
  readonly reference: ProductReference;
  /**
   * AFILIADO MANUAL ASSISTIDO (3D fallback universal): o operador já
   * possui o link oficial (gerado pela UI do portal ou Gerador de Links)
   * e o submete para validação/registro idempotente. JAMAIS é derivado.
   */
  readonly operatorProvidedUrl?: string | null;
  /** Fonte de API real (injetada; se ausente → AUTH_REQUIRED/API indisponível). */
  readonly apiSource?: AffiliateApiSource | null;
}

/**
 * acquireAffiliateLink — núcleo fail-closed do N8.
 *
 * Caminho 1 (API oficial): provider com credenciais + apiSource injetada
 *   → chama o mecanismo oficial → valida host → SUCCESS.
 * Caminho 2 (manual assistido): operatorProvidedUrl → valida host/whitelist
 *   → SUCCESS (com método MANUAL, proveniência de auditoria "admin:acquired"
 *   no metadata, registro via N6 como de costume).
 * Caminho 3 (recusas fechadas): sem credenciais → AUTH_REQUIRED; provider
 *   inativo → PROVIDER_NOT_ACTIVE; marketplace sem suporte → NOT_SUPPORTED;
 *   URL oficial ausente/inválida → RESOLUTION_FAILED.
 */
export async function acquireAffiliateLink(options: AcquireOptions): Promise<AcquireResult> {
  const provider = options.provider;

  // 1. Provider ativo (fail-closed).
  if (provider.status !== "ACTIVE") {
    return { kind: "PROVIDER_NOT_ACTIVE", providerId: provider.provider_id };
  }
  if (!(AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(provider.marketplace)) {
    return { kind: "RESOLUTION_FAILED", reason: "provider_marketplace_unsupported" };
  }

  // 2. Marketplace sem mecanismo programático oficial (ML — 3C).
  if (provider.marketplace === "MercadoLivre") {
    // ML mantém apenas o caminho manual assistido.
    if (typeof options.operatorProvidedUrl === "string" && options.operatorProvidedUrl.length > 0) {
      return validateManualUrl({ provider, reference: options.reference, url: options.operatorProvidedUrl });
    }
    return { kind: "NOT_SUPPORTED", marketplace: "MercadoLivre" };
  }

  // 3. Caminho API (Shopee) — se a fonte real foi injetada.
  const injectedApiSource = options.apiSource ?? apiSource;
  if (injectedApiSource !== null) {
    if (injectedApiSource.providerId !== provider.provider_id) {
      return { kind: "RESOLUTION_FAILED", reason: "api_source_provider_mismatch" };
    }
    try {
      const response = await injectedApiSource.generateLink({
        providerContext: {
          providerId: provider.provider_id,
          marketplace: provider.marketplace as ProductIdentity["marketplace"],
          active: provider.status === "ACTIVE",
          credentials: { present: Boolean(provider.credential_ref), expired: false },
        },
        reference: options.reference,
        subId: (provider.metadata as Record<string, unknown>)?.sub_id as string | undefined ?? "",
      });
      // Validação de host da URL oficial: a URL devolvida pelo mecanismo
      // DEVE apontar para um host oficial do marketplace (whitelist N6).
      // PATCH DE CONTRATO: usar a checagem de host pura — validateManualUrl
      // não pode ser usado aqui, pois ele força o estado MANUAL/UNCERTAIN
      // com rationale de caminho manual assistido (que não se aplica à
      // fonte oficial).
      const expectedHosts = AFFILIATE_MARKETPLACE_HOSTS[provider.marketplace] as ReadonlyArray<string>;
      const officialHost = officialHostOf(response.affiliateUrl);
      if (!officialHost || !expectedHosts.includes(officialHost)) {
        return {
          kind: "RESOLUTION_FAILED",
          reason: `official_url_host_not_in_whitelist:url=${response.affiliateUrl};hosts_aceitos=${expectedHosts.join(",")}`,
        };
      }
      const identity = buildIdentity({
        marketplace: provider.marketplace as ProductIdentity["marketplace"],
        listingId: response.listingId,
        sellerId: response.sellerId,
        titleSnapshot: response.titleSnapshot,
        canonicalUrl: options.reference.publicUrl,
      });
      const confidence = identityConfidenceOf(identity, options.reference);
      const acquisitionRef = `acq-${createHash("sha256").update([provider.provider_id, response.affiliateUrl].join(":")).digest("hex").slice(0, 16)}`;
      if (confidence === "PRODUCT_IDENTITY_UNCERTAIN") {
        // PATCH DE CONTRATO: identidade NÃO confirmada → nunca é SUCCESS
        // confirmado. O link fica com estado explícito IDENTITY_UNCERTAIN
        // (evidência preservada + rationale rastreável), jamais elegível
        // para publicação baseada apenas nessa identidade (fail-closed).
        return {
          kind: "IDENTITY_UNCERTAIN",
          affiliateUrl: response.affiliateUrl,
          identity,
          identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN",
          rationale: `identidade_nao_confirmada_pela_fonte_oficial:listing_id=${listingStatus(response.listingId)};seller_id=${listingStatus(response.sellerId)};title_snapshot=${listingStatus(response.titleSnapshot)};aquisicao_ainda_valida_para_validacao_n6_mas_jamais_para_publicacao_como_identidade_confirmada`,
          method: "API" as const,
          acquisitionRef,
          rawResponse: response.raw,
          acquiredAt: Date.now(),
        };
      }
      return {
        kind: "SUCCESS",
        affiliateUrl: response.affiliateUrl,
        identity,
        identityConfidence: "PRODUCT_IDENTITY_CONFIRMED",
        method: "API" as const,
        acquisitionRef,
        rawResponse: response.raw,
        acquiredAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      // PATCH DE CONTRATO (fonte oficial Shopee): quando a plataforma de
      // afiliados localiza o produto mas NÃO devolve um link oficial de
      // afiliado (offerLink ausente), o produto é reconhecido porém não
      // elegível para aquisição — incerteza explícita de elegibilidade
      // da fonte oficial (jamais SUCCESS, jamais URL derivada). Qualquer
      // outro erro segue fail-closed (RESOLUTION_FAILED).
      if (typeof message === "string" && message.startsWith("shopee_client_error:SHOPEE_NOT_ELIGIBLE")) {
        return {
          kind: "IDENTITY_UNCERTAIN",
          affiliateUrl: null,
          identity: null,
          identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN",
          rationale: "fonte_oficial_reconhece_o_produto_mas_not_eligible_para_aquisicao_oficial_sem_offerLink_oficial;produtos_sem_link_oficial_nunca_sao_promovidos;fail_closed_sem_url_derivada",
          method: "API" as const,
          acquisitionRef: null,
          rawResponse: null,
          acquiredAt: Date.now(),
        };
      }
      return { kind: "RESOLUTION_FAILED", reason: `official_api_error:${message}` };
    }
  }

  // 4. Sem fonte real → credenciais ausentes/inconfiguradas (fail-closed).
  //    JAMAIS tenta endpoint inventado.
  if (typeof options.operatorProvidedUrl === "string" && options.operatorProvidedUrl.length > 0) {
    return validateManualUrl({ provider, reference: options.reference, url: options.operatorProvidedUrl });
  }
  return {
    kind: "AUTH_REQUIRED",
    reason: "official_credentials_not_configured:operator_deve_configurar_SHOPEE_AFFILIATE_API_BASE_URL_e_credenciais_oficiais",
  };
}

function buildIdentity(params: {
  marketplace: ProductIdentity["marketplace"];
  listingId: string | null;
  sellerId: string | null;
  titleSnapshot: string | null;
  canonicalUrl: string;
}): ProductIdentity {
  return {
    marketplace: params.marketplace,
    listingId: params.listingId,
    canonicalUrl: params.canonicalUrl,
    sellerId: params.sellerId,
    titleSnapshot: params.titleSnapshot ?? "",
  };
}

function listingStatus(value: string | null): "presente" | "ausente" {
  return typeof value === "string" && value.trim().length > 0 ? "presente" : "ausente";
}

function identityConfidenceOf(identity: ProductIdentity, reference: ProductReference): "PRODUCT_IDENTITY_CONFIRMED" | "PRODUCT_IDENTITY_UNCERTAIN" {
  // Identidade confirmada exige listing_id oficial + seller_id + snapshot
  // de título da fonte oficial — sem isso, o link nunca é tratado como
  // identidade do produto (PRODUCT_IDENTITY_UNCERTAIN).
  const listingOk = typeof identity.listingId === "string" && identity.listingId.length > 0;
  const sellerOk = typeof identity.sellerId === "string" && identity.sellerId.length > 0;
  const titleOk = typeof identity.titleSnapshot === "string" && identity.titleSnapshot.trim().length > 0;
  if (listingOk && sellerOk && titleOk) return "PRODUCT_IDENTITY_CONFIRMED";
  return "PRODUCT_IDENTITY_UNCERTAIN";
}

/**
 * Validação fail-closed do URL fornecido manualmente pelo operador (3D).
 * Regras:
 *   - deve ser URL absoluta e analisável;
 *   - deve conter host oficial do marketplace do provider (whitelist);
 *   - nunca é "normalizado" (a URL exata fornecida é o que será registrado);
 *   - o host final observado deve ser o mesmo host oficial declarado.
 */
/**
 * Determina o host oficial final esperado a partir da URL de afiliado
 * (versão interna — o fail-closed de host da fonte oficial usa a whitelist
 * do provider do N6). Não exportada: a fonte oficial vive em
 * shopeeAffiliateProvider/shopeeApiClient (D-SHOPEE-1).
 */
function officialHostOf(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allHosts = (AFFILIATE_MARKETPLACES as ReadonlyArray<string>).flatMap(
      (mp) => AFFILIATE_MARKETPLACE_HOSTS[mp as AffiliateMarketplace] as ReadonlyArray<string>,
    );
    return allHosts.find((host) => hostname === host || hostname.endsWith(`.${host}`)) ?? null;
  } catch {
    return null;
  }
}

export function validateManualUrl(params: {
  provider: AffiliateProviderRecord;
  reference: ProductReference;
  url: string;
}): AcquireResult {
  const { provider, reference, url } = params;
  const expectedHosts = AFFILIATE_MARKETPLACE_HOSTS[provider.marketplace] as ReadonlyArray<string>;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const matched = expectedHosts.find((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (!matched) {
      return {
        kind: "RESOLUTION_FAILED",
        reason: `url_host_not_official:host=${hostname};hosts_aceitos=${expectedHosts.join(",")}`,
      };
    }
    const identity: ProductIdentity = {
      marketplace: provider.marketplace as ProductIdentity["marketplace"],
      listingId: null,
      canonicalUrl: reference.publicUrl,
      sellerId: null,
      titleSnapshot: "",
    };
    // PATCH DE CONTRATO: caminho manual assistido (3D) não tem mecanismo
    // oficial que confirme listing/seller/título → identidade SEMPRE incerta
    // → estado explícito IDENTITY_UNCERTAIN (nunca SUCCESS confirmado).
    // O link obtido pode seguir para validação N6, mas JAMAIS habilita
    // publicação com identidade confirmada (fail-closed).
    return {
      kind: "IDENTITY_UNCERTAIN",
      affiliateUrl: url,
      identity,
      identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN",
      rationale: `identidade_nao_confirmada:caminho_manual_assistido_nao_dispoem_de_mecanismo_oficial_para_confirmar_listing_id_seller_id_ou_titulo;apenas_validacao_n6_e_resolucao_n7_nao_alteram_esta_decisao_de_aquisicao`,
      method: "MANUAL" as const,
      acquisitionRef: `acq-${createHash("sha256").update([provider.provider_id, url].join(":")).digest("hex").slice(0, 16)}`,
      rawResponse: null,
      acquiredAt: Date.now(),
    };
  } catch {
    return { kind: "RESOLUTION_FAILED", reason: "url_invalid:nao_analisavel" };
  }
}
