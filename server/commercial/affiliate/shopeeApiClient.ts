// ============================================================================
// Cliente isolado da API oficial Shopee Afiliados BR (fail-closed)
//
// Responsabilidades:
//   - construir requisição GraphQL oficial;
//   - autenticar/assinar conforme contrato oficial (SHA256 header);
//   - aplicar timeout determinístico;
//   - interpretar HTTP errors e GraphQL errors;
//   - normalizar erros externos para o catálogo interno (SHOPEE_*);
//   - NÃO vazar secrets (nunca em logs, erros, headers logados ou
//     payloads registrados);
//   - permitir injeção/mock do transporte HTTP nos testes.
//
// NÃO cria products, não promove candidates, não publica, não altera
// affiliate_links diretamente (essa autoridade é do N8) e não toca
// job_queue/scheduler/agentes.
// ============================================================================

import { createHash } from "node:crypto";
import {
  ShopeeClientError,
  type ShopeeOperation,
  SHOPEE_DEFAULT_TIMEOUT_MS,
  type ShopeeAffiliateAcquisitionResult,
  type ShopeeProductLookupResult,
} from "./shopeeClientContracts";

/** Endpoint oficial da Plataforma Aberta de Afiliados Shopee Brasil. */
export const SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL = "https://open-api.affiliate.shopee.com.br/graphql";

/**
 * Contrato oficial do header de autorização da plataforma de afiliados BR:
 *   Authorization: SHA256 Credential={appId}, Timestamp={ts}, Signature={sig}
 *   sig = SHA256(Credential + Timestamp + Payload + Secret)
 *   ts = Unix seconds (janela ~5 minutos)
 *   Payload = corpo JSON real, serializado exatamente como enviado
 */
function buildAuthorizationHeader(payload: string, appId: string, secret: string, timestamp: string): string {
  const signatureInput = [appId, timestamp, payload, secret].join("");
  const signature = createHash("sha256").update(signatureInput).digest("hex");
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

/** Transport HTTP injetável (default: fetch global). */
export type ShopeeHttpTransport = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** window de AbortController — usado pelo timeout externo. */
  signal: AbortSignal;
}) => Promise<Response>;

export interface ShopeeApiClientOptions {
  /** App ID oficial (process.env — nunca armazenar). */
  readonly appId: string;
  /** App Secret oficial (process.env — nunca armazenar/logar). */
  readonly secret: string;
  /** Base URL oficial (default BR). */
  readonly baseUrl?: string;
  /** Timeout em ms (default SHOPEE_DEFAULT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
  /** Transport injetável para testes. */
  readonly transport?: ShopeeHttpTransport;
  /** Clock injetável para testes de assinatura (default: Date.now). */
  readonly clock?: () => number;
}

/**
 * Cliente da API oficial — construído SOMENTE com credenciais não vazias
 * (a ausência de env mantém AUTH_REQUIRED na autoridade N8).
 */
export function createShopeeApiClient(options: ShopeeApiClientOptions) {
  if (!options.appId || !options.secret) {
    throw new ShopeeClientError("SHOPEE_NOT_CONFIGURED", "credentials_missing");
  }
  const baseUrl = (options.baseUrl ?? SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? SHOPEE_DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? fetch;
  const clock = options.clock ?? (() => Date.now());

  /**
   * POST GraphQL assinado. Falha fechada para qualquer desvio do contrato:
   *   HTTP não-2xx / GraphQL errors / payload fora do envelope → erro
   *   catalogado (jamais URL derivada, jamais exceção não catalogada).
   */
  async function signedGraphqlPost(body: { query: string; variables: Record<string, unknown> }): Promise<{ json: unknown; httpStatus: number }> {
    const payload = JSON.stringify(body);
    // Timestamp em segundos Unix (janela oficial ~5 minutos).
    const timestamp = Math.floor(clock() / 1000).toString();
    let authorization: string;
    try {
      authorization = buildAuthorizationHeader(payload, options.appId, options.secret, timestamp);
    } catch {
      // Assinatura nunca falha com inputs válidos; falha aqui = BUG → permanent.
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "signature_build_failed");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await transport(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
          },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        // Falha de transporte (DNS/TLS/conexão/abort de timeout).
        if (controller.signal.aborted) {
          throw new ShopeeClientError("SHOPEE_TIMEOUT", "transport_timed_out");
        }
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", "transport_failed");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) {
        throw new ShopeeClientError("SHOPEE_AUTH_ERROR", "http_401", response.status);
      }
      if (response.status === 403) {
        throw new ShopeeClientError("SHOPEE_FORBIDDEN", "http_403", response.status);
      }
      if (!response.ok) {
        // 429 = rate limit oficial (transitório); demais 4xx/5xx = permanente.
        if (response.status === 429) {
          throw new ShopeeClientError("SHOPEE_RATE_LIMITED", "http_429", response.status);
        }
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", `http_${response.status}`, response.status);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "body_not_json", response.status);
      }
      if (!json || typeof json !== "object") {
        throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object", response.status);
      }
      const data = json as Record<string, unknown>;
      // Erros oficiais da Shopee (HTTP 200 + payload de erro) — catalogados
      // por código oficial; jamais viram sucesso.
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw shopeeGraphqlErrorsToError(data.errors, response.status);
      }
      return { json, httpStatus: response.status };
    } catch (err) {
      if (err instanceof ShopeeClientError) throw err;
      // Qualquer exceção não catalogada = FAIL-CLOSED (unknown).
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected");
    }
  }

  /**
   * Mapeia códigos oficiais da plataforma de afiliados para o catálogo:
   *   10020 = Invalid Signature → AUTH_ERROR (permanente)
   *   10030 = rate limit       → RATE_LIMITED (transitório)
   *   demais                    → GRAPHQL_ERROR (permanente, fail-closed)
   */
  function shopeeGraphqlErrorsToError(errors: unknown[], httpStatus: number | null = null): ShopeeClientError {
    const first = errors[0] as Record<string, unknown> | undefined;
    const extensions = first?.extensions as Record<string, unknown> | undefined;

    // A Shopee entrega o código oficial em extensions.code (ex: 10010, 10020).
    // Algumas implementações podem colocar no nível raiz; tentamos ambos.
    const code = typeof extensions?.code === "number" ? extensions.code
      : typeof extensions?.code === "string" ? extensions.code
        : typeof first?.code === "number" ? first.code
          : typeof first?.code === "string" ? first.code
            : "unknown";

    const kind: ReturnType<typeof kindFromCode> = kindFromCode(code);
    return new ShopeeClientError(kind, `code_${code}`, httpStatus);
  }

  function kindFromCode(code: number | string): import("./shopeeClientContracts").ShopeeErrorKind {
    if (code === 10020) return "SHOPEE_AUTH_ERROR";
    if (code === 10030 || code === "10030") return "SHOPEE_RATE_LIMITED";
    if (code === 10010 || code === "10010") return "SHOPEE_FORBIDDEN";
    return "SHOPEE_GRAPHQL_ERROR";
  }

  /**
   * Corpo GraphQL oficial de oferta de produto.
   * D-SHOPEE-1 (2026-08-18): quando shopId/itemId são fornecidos, a
   * consulta passa-os como ARGUMENTOS oficiais de productOfferV2
   * (itemId: Int64, shopId: Int64 — confirmados por introspection da
   * API real). Isso é a resolução DIRECIONADA do produto específico.
   * Sem identificadores, usa a listagem geral (limit alto) e o match
   * continua exato em extractOfferNodes/matchNode (fail-closed).
   * Valores numéricos são interpolados SOMENTE após validação estrita
   * de dígitos (jamais strings não validadas entram na query).
   */
  function offerQueryBody(params: { shopId?: string | null; itemId?: string | null }): { query: string; variables: Record<string, unknown> } {
    const num = (v: string | null | undefined): string | null =>
      v && /^\d+$/.test(v) ? v : null;
    const args = [
      num(params.itemId) ? `itemId: ${num(params.itemId)}` : null,
      num(params.shopId) ? `shopId: ${num(params.shopId)}` : null,
      "limit: 1",
    ].filter(Boolean).join(", ");
    return {
      query: `{ productOfferV2(${args}) { nodes { itemId shopId productName price productLink offerLink } } }`,
      variables: {},
    };
  }

  /**
   * Consulta oficial por produto (listagem) — resultado estável interno.
   * Encontrar o item na resposta EXIGE match estrito de shop_id/item_id
   * quando fornecidos; caso contrário o primeiro nó NÃO é presumido
   * como o produto procurado (fail-closed → not_found).
   */
  async function lookupProduct(params: { shopId?: string | null; itemId?: string | null }): Promise<ShopeeProductLookupResult> {
    try {
      const response = await signedGraphqlPost(offerQueryBody(params));
      return parseProductLookup(response.json, params.shopId ?? null, params.itemId ?? null, response.httpStatus);
    } catch (err) {
      if (err instanceof ShopeeClientError) {
        return { status: "error", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus: err.httpStatus, raw: null, error: err };
      }
      return { status: "error", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus: null, raw: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
    }
  }

  /**
   * Aquisição de link de afiliado via API oficial — o item retornado pela
   * fonte contém offerLink oficial de afiliado (quando elegível).
   * Sem elegibilidade explícita → not_eligible (jamais URL derivada).
   */
  const MAX_ATTEMPTS = 2;
  const RETRY_BACKOFF_MS = 1500;
  async function acquireAffiliateLink(params: { shopId?: string | null; itemId?: string | null }): Promise<ShopeeAffiliateAcquisitionResult> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await signedGraphqlPost(offerQueryBody(params));
        return parseAffiliateAcquisition(response.json, params.shopId ?? null, params.itemId ?? null);
      } catch (err) {
        lastError = err;
        if (!(err instanceof ShopeeClientError)) {
          return { status: "error", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
        }
        // Permanentes e definitivamente catalogados nunca retentam (fail-closed).
        const transient = err.kind === "SHOPEE_RATE_LIMITED" || err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR";
        if (!transient || attempt >= MAX_ATTEMPTS) {
          return mapKindToStatus(err);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
    // Inacessível: última tentativa falhou; retorna o último erro mapeado.
    if (lastError instanceof ShopeeClientError) return mapKindToStatus(lastError);
    return { status: "error", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
  }

  function parseProductLookup(json: unknown, wantShop: string | null, wantItem: string | null, httpStatus: number | null): ShopeeProductLookupResult {
    const nodes = extractOfferNodes(json);
    if (nodes.length === 0) {
      return { status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus, raw: json, error: null };
    }
    // Match estrito — o primeiro nó só vale se coincide com o identificador
    // procurado; se não há identificadores, a fonte não localizou o produto
    // com precisão → fail-closed (not_found, sem presumir).
    const node = matchNode(nodes, wantShop, wantItem);
    if (!node) {
      return { status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus, raw: json, error: null };
    }
    return {
      status: "found",
      shopId: node.shopId,
      itemId: node.itemId,
      name: node.name,
      priceMinorUnits: node.price,
      productLink: node.productLink,
      httpStatus,
      raw: json,
      error: null,
    };
  }

  function parseAffiliateAcquisition(json: unknown, wantShop: string | null, wantItem: string | null): ShopeeAffiliateAcquisitionResult {
    const nodes = extractOfferNodes(json);
    if (nodes.length === 0) {
      return { status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: json, error: null };
    }
    const node = matchNode(nodes, wantShop, wantItem);
    if (!node) {
      return { status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: json, error: null };
    }
    // Elegibilidade explícita: a fonte oficial devolve o link de afiliado
    // no campo offerLink do nó. Sem ele → não elegível (jamais derivar).
    const url = node.offerLink;
    if (!url || typeof url !== "string") {
      return { status: "not_eligible", affiliateUrl: null, productLink: node.productLink, shopId: node.shopId, itemId: node.itemId, name: node.name, price: node.price, raw: json, error: null };
    }
    return {
      status: "link_acquired",
      affiliateUrl: url,
      productLink: node.productLink,
      shopId: node.shopId,
      itemId: node.itemId,
      name: node.name,
      price: node.price,
      raw: json,
      error: null,
    };
  }

  /**
   * Mutation oficial `generateShortLink(input: { originUrl: String!,
   * subIds: [String] })` — gera o link curto de afiliado da URL
   * específica (produto/loja/oferta) com tracking oficial (utm_content).
   * D-SHOPEE-1 (2026-08-18): provada contra a API real.
   *   - subIds: 0–5 itens, alfanuméricos, máx 40 chars (erro oficial
   *     11001 invalid sub id fora do formato).
   *   - Sem erro de validação e sem erro GraphQL: link_acquired.
   *   - Erro de validação oficial: never_viral/invalid_url → invalid_url.
   *   - Qualquer outro erro → fail-closed (mapKindToStatus).
   */
  interface GenerateShortLinkResult {
    readonly status: "link_acquired" | "invalid_url" | "auth_error" | "rate_limited" | "transient" | "permanent";
    readonly shortLink: string | null;
    readonly longLink: string | null;
    readonly error: ShopeeClientError | null;
  }

  /** Formato oficial de sub id (1–5 itens, alfanumérico, máx 40 chars). */
  function isValidSubId(s: string): boolean {
    return s.length > 0 && s.length <= 40 && /^[a-zA-Z0-9]+$/.test(s);
  }

  async function generateShortLink(params: {
    originUrl: string;
    subIds?: ReadonlyArray<string>;
  }): Promise<GenerateShortLinkResult> {
    let originUrl = "";
    try {
      const parsed = new URL(params.originUrl);
      if (parsed.protocol !== "https:") {
        return { status: "invalid_url", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "non_https_url") };
      }
      originUrl = parsed.toString();
    } catch {
      return { status: "invalid_url", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "url_parse_failed") };
    }
    const subIds = (params.subIds ?? [])
      .filter((s) => typeof s === "string" && isValidSubId(s))
      .slice(0, 5);
    const payloadJson = JSON.stringify({
      query: `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${JSON.stringify(subIds)} }) { shortLink longLink } }`,
      variables: {},
    });
    try {
      const json = await signedGraphqlPostRaw(payloadJson);
      if (!json || typeof json !== "object") {
        return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object") };
      }
      const data = (json as Record<string, unknown>).data;
      const gql = data && typeof data === "object"
        ? (data as Record<string, unknown>).generateShortLink
        : null;
      if (!gql || typeof gql !== "object") {
        return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_shortlink_envelope") };
      }
      const shortLink = typeof (gql as Record<string, unknown>).shortLink === "string" ? (gql as Record<string, unknown>).shortLink as string : null;
      const longLink = typeof (gql as Record<string, unknown>).longLink === "string" ? (gql as Record<string, unknown>).longLink as string : null;
      if (!shortLink) {
        // Sem shortLink oficial → não confirmado (jamais derivar URL).
        return { status: "permanent", shortLink: null, longLink, error: new ShopeeClientError("SHOPEE_NOT_ELIGIBLE", "no_official_short_link") };
      }
      return { status: "link_acquired", shortLink, longLink, error: null };
    } catch (err) {
      if (!(err instanceof ShopeeClientError)) {
        return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
      }
      // Validação oficial de URL (parametro oficial): erro catalogado como
      // invalid_url em vez de permanente — a entrada era rejeitada pela
      // plataforma, não houve falha de transporte/auth.
      if (err.detail && (err.detail.includes("url") || err.detail.includes("Url"))) {
        return { status: "invalid_url", shortLink: null, longLink: null, error: err };
      }
      if (err.kind === "SHOPEE_AUTH_ERROR") return { status: "auth_error", shortLink: null, longLink: null, error: err };
      if (err.kind === "SHOPEE_RATE_LIMITED") return { status: "rate_limited", shortLink: null, longLink: null, error: err };
      if (err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR") return { status: "transient", shortLink: null, longLink: null, error: err };
      return { status: "permanent", shortLink: null, longLink: null, error: err };
    }
  }

  /** POST GraphQL assinado com payload pronto (exigido pela assinatura oficial). */
  async function signedGraphqlPostRaw(payload: string): Promise<unknown> {
    const timestamp = Math.floor(clock() / 1000).toString();
    let authorization: string;
    try {
      authorization = buildAuthorizationHeader(payload, options.appId, options.secret, timestamp);
    } catch {
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "signature_build_failed");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await transport(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authorization },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ShopeeClientError("SHOPEE_TIMEOUT", "transport_timed_out");
        }
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", "transport_failed");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) throw new ShopeeClientError("SHOPEE_AUTH_ERROR", "http_401");
      if (response.status === 403) throw new ShopeeClientError("SHOPEE_FORBIDDEN", "http_403");
      if (!response.ok) {
        if (response.status === 429) throw new ShopeeClientError("SHOPEE_RATE_LIMITED", "http_429");
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", `http_${response.status}`, response.status);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "body_not_json", response.status);
      }
      if (!json || typeof json !== "object") {
        throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object", response.status);
      }
      const data = json as Record<string, unknown>;
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw shopeeGraphqlErrorsToError(data.errors, response.status);
      }
      return json;
    } catch (err) {
      if (err instanceof ShopeeClientError) throw err;
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected");
    }
  }

  /**
   * Descobre, por introspecção autenticada e somente-leitura, quais campos o
   * tipo real de productOfferV2 permite retornar. Não altera a consulta de
   * descoberta/aquisição e não registra payloads, credenciais ou valores.
   */
  async function inspectPromotionFields(): Promise<{
    ok: boolean;
    nodeType: string | null;
    fields: string[];
    reason: string | null;
  }> {
    try {
      const typeResponse = await signedGraphqlPost({
        query: "{ productOfferV2(itemId: 46816332146, shopId: 852965232, limit: 1) { nodes { __typename } } }",
        variables: {},
      });
      const root = typeResponse.json as { data?: { productOfferV2?: { nodes?: Array<{ __typename?: unknown }> } } };
      const nodeType = root.data?.productOfferV2?.nodes?.[0]?.__typename;
      if (typeof nodeType !== "string" || nodeType.length === 0) {
        return { ok: false, nodeType: null, fields: [], reason: "node_type_unavailable" };
      }
      const schemaResponse = await signedGraphqlPost({
        query: `query { __type(name: ${JSON.stringify(nodeType)}) { fields { name } } }`,
        variables: {},
      });
      const schema = schemaResponse.json as { data?: { __type?: { fields?: Array<{ name?: unknown }> } } };
      const fields = (schema.data?.__type?.fields ?? [])
        .map((field) => field.name)
        .filter((name): name is string => typeof name === "string")
        .sort();
      return fields.length > 0
        ? { ok: true, nodeType, fields, reason: null }
        : { ok: false, nodeType, fields: [], reason: "fields_unavailable" };
    } catch (err) {
      const reason = err instanceof ShopeeClientError ? err.kind : "unexpected";
      return { ok: false, nodeType: null, fields: [], reason };
    }
  }

  function mapKindToStatus(err: ShopeeClientError): ShopeeAffiliateAcquisitionResult {
    if (err.kind === "SHOPEE_AUTH_ERROR" || err.kind === "SHOPEE_FORBIDDEN") {
      return { status: "auth_error", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    }
    if (err.kind === "SHOPEE_RATE_LIMITED") {
      return { status: "rate_limited", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    }
    if (err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR") {
      return { status: "transient", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    }
    // GRAPHQL_ERROR / INVALID_RESPONSE / NOT_CONFIGURED / UNKNOWN → permanent.
    return { status: "permanent", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
  }

  // -------------------------------------------------------------------------
  // Busca oficial por palavra-chave (descoberta autorizada do modo /shopee
  // por termo). A operação pública da plataforma de afiliados BR é
  // `productOfferV2`, com keyword/listType/sortType/page/limit e nós de
  // produtos. A consulta de item específico também usa productOfferV2, mas
  // exige match estrito em acquireAffiliateLink antes de criar qualquer card.
  // GOVERNANÇA: descoberta != aquisição — a presença do item na busca NÃO
  // significa link de afiliado adquirido; a aquisição continua via
  // acquireAffiliateLink por item (fail-closed, nada derivado).
  // -------------------------------------------------------------------------

  /** Limite seguro da palavra-chave oficial (evita query inválida/10010). */
  const SH_KEYWORD_MAX_LENGTH = 60;

  /** Keywords oficiais: alfanumérico + espaço/hífen/acento; vazio → invalid. */
  function sanitizeSearchKeyword(raw: string): string | null {
    const trimmed = raw.trim().slice(0, SH_KEYWORD_MAX_LENGTH);
    if (trimmed.length === 0) return null;
    if (!/^[a-zA-Z0-9À-ÿ .\-]+$/.test(trimmed)) return null;
    return trimmed.replace(/\s{2,}/g, " ");
  }

  /** Item estável da busca oficial (tipos internos — sem vazamento GraphQL). */
  interface SearchItem {
    readonly shopId: string | null;
    readonly itemId: string | null;
    readonly name: string | null;
    readonly price: number | null;
    readonly productLink: string | null;
    readonly offerLink: string | null;
  }

  /** Resultado estável da busca por termo — DISCOVERY, nunca aquisição. */
  interface SearchOffersResult {
    /** true quando a fonte oficial respondeu com estrutura utilizável (pode
     *  ter 0 itens — resposta vazia é uma descoberta legítima, não erro). */
    readonly ok: boolean;
    /** Motivo quando ok=false (catálogo fechado, fail-closed): erro de rede,
     *  auth, rate limit, operação indisponível ou keyword inválida. */
    readonly reason?: string;
    readonly items: ReadonlyArray<SearchItem>;
    /** Status HTTP observado; null quando não houve resposta utilizável. */
    readonly httpStatus: number | null;
    /** Erro catalogado somente quando ok=false (falha de cliente/transporte). */
    readonly error: ShopeeClientError | null;
  }

  /** Limite mínimo da busca por termo (a página pública não é fonte). */
  const SEARCH_MIN_LIMIT = 1;
  /** Limite máximo da busca por termo — mesmo teto do orquestrador. */
  const SEARCH_MAX_LIMIT = 10;

  /**
   * Consulta oficial de busca por palavra-chave. Fail-closed: erro de
   * transporte/auth → ok=false (jamais transformar em sucesso);
   * resposta sem nós → ok=true, items=[] (descoberta vazia, lote fecha
   * fail-closed no orquestrador sem inventar itens).
   * 
   */
  async function searchOffers(params: { query: string; limit?: number }): Promise<SearchOffersResult> {
    const keyword = sanitizeSearchKeyword(params.query);
    if (!keyword) {
      return {
        ok: false,
        reason: "invalid_keyword",
        items: [],
        httpStatus: null,
        error: new ShopeeClientError("SHOPEE_GRAPHQL_ERROR", "invalid_search_keyword"),
      };
    }
    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      Math.max(SEARCH_MIN_LIMIT, Math.floor(params.limit ?? 5) || SEARCH_MIN_LIMIT),
    );
    try {
      const response = await signedGraphqlPost({
        query: `{ productOfferV2(keyword: ${JSON.stringify(keyword)}, listType: 0, sortType: 1, page: 1, limit: ${limit}) { nodes { itemId shopId productName price productLink offerLink } } }`,
        variables: {},
      });
      return parseSearchResponse(response.json, response.httpStatus);
    } catch (err) {
      if (err instanceof ShopeeClientError) {
        return {
          ok: false,
          reason: err.kind,
          items: [],
          httpStatus: err.httpStatus,
          error: err,
        };
      }
      return {
        ok: false,
        reason: "SHOPEE_UNKNOWN_ERROR",
        items: [],
        httpStatus: null,
        error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected"),
      };
    }
  }

  /**
   * Parse da resposta de busca oficial — mesmo contrato de nós da oferta
   * productOfferV2 — extração local, determinística, sem presumir que o
   * resultado de discovery por si só autoriza o link de afiliado.
   */
  function parseSearchResponse(json: unknown, httpStatus: number | null): SearchOffersResult {
    if (!json || typeof json !== "object") {
      return { ok: false, reason: "SHOPEE_INVALID_RESPONSE", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object") };
    }
    const data = (json as Record<string, unknown>)?.data;
    if (!data || typeof data !== "object") {
      return { ok: false, reason: "SHOPEE_INVALID_RESPONSE", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_data_envelope") };
    }
    const search = (data as Record<string, unknown>).productOfferV2;
    if (!search || typeof search !== "object" || !Array.isArray((search as Record<string, unknown>).nodes)) {
      return { ok: false, reason: "search_operation_unavailable", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_GRAPHQL_ERROR", "no_search_nodes") };
    }
    const nodes = (search as Record<string, unknown>).nodes as unknown[];
    const items: SearchItem[] = [];
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      items.push({
        shopId: typeof obj.shopId === "number" ? String(obj.shopId) : typeof obj.shopId === "string" ? obj.shopId : null,
        itemId: typeof obj.itemId === "number" ? String(obj.itemId) : typeof obj.itemId === "string" ? obj.itemId : null,
        name:
          typeof obj.productName === "string" && obj.productName.length > 0
            ? obj.productName
            : typeof obj.name === "string" && obj.name.length > 0
              ? obj.name
              : null,
        price: parseShopeePriceString(obj.price),
        productLink: typeof obj.productLink === "string" ? obj.productLink : null,
        offerLink: typeof obj.offerLink === "string" ? obj.offerLink : null,
      });
    }
    return { ok: true, items, httpStatus, error: null };
  }

  return {
    lookupProduct,
    acquireAffiliateLink,
    generateShortLink,
    searchOffers,
    inspectPromotionFields,
  };
}

/** Nó de oferta normalizado (tipos internos estáveis). */
interface OfferNode {
  shopId: string | null;
  itemId: string | null;
  name: string | null;
  price: number | null;
  productLink: string | null;
  offerLink: string | null;
}

/**
 * D-SHOPEE-1 (Fase 17/14, 2026-08-20): a API oficial retorna
 * `price` como STRING(non-empty) — provado em chamada real no runtime
 * (PHASE14_SCHEMA_PROBE_20260820). A documentação oficial NÃO
 * especifica moeda/escala (BLOCKED — CONTRACT UNSPECIFIED, Fase 19),
 * portanto esta normalização é puramente de FORMA (string → número
 * decimal puro), SEM inventar unidade, moeda, locale ou escala:
 *   - aceita APENAS dígitos opcionais + ponto decimal + dígitos (ex.:
 *     "129.90", "0.5", "3"); sem separador de milhar, sem vírgula
 *     decimal, sem símbolo, sem espaço;
 *   - rejeita: strings vazias, NaN, Infinity, exponenciais, vírgulas,
 *     moedas embutidas, sinais (+/-) e qualquer outra forma ambígua → null;
 *   - price já number passa inalterado; price ausente/não-string → null.
 * Resultado null = dimensão PRICE permanece UNKNOWN no Evidence Bridge
 * (fail-closed: nunca promover valor ambíguo).
 */
export function parseShopeePriceString(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Forma estrita: opcionalmente dígitos, opcional parte decimal com ponto.
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Fase 23 (2026-08-20): exportado para consumo read-only de rotas que
 * precisam dos campos oficiais do nó de oferta (ex.: preview Telegram).
 * Cada campo segue a normalização fail-closed existente; o price continua
 * com escala NÃO verificada (parseShopeePriceString, Fase 19).
 */
export function extractOfferNodes(json: unknown): OfferNode[] {
  if (!json || typeof json !== "object") {
    throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object");
  }
  const data = (json as Record<string, unknown>)?.data;
  if (!data || typeof data !== "object") {
    throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_data_envelope");
  }
  const payload = data as Record<string, unknown>;
  const offer = payload?.productOfferV2;
  if (!offer || typeof offer !== "object" || !Array.isArray((offer as Record<string, unknown>).nodes)) {
    throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_offer_nodes");
  }
  const nodes = (offer as Record<string, unknown>).nodes as unknown[];
  return nodes
    .filter((n) => n && typeof n === "object")
    .map((n) => {
        const obj = n as Record<string, unknown>;
        // productName e name são ambos aceitos pela query oficial;
        // o cliente usa o primeiro valor textual disponível (sem
        // presumir — se nenhum existir, name=null).
        const name =
          typeof obj.productName === "string" && obj.productName.length > 0
            ? obj.productName
            : typeof obj.name === "string" && obj.name.length > 0
              ? obj.name
              : null;
        return {
          shopId: typeof obj.shopId === "number" ? String(obj.shopId) : typeof obj.shopId === "string" ? obj.shopId : null,
          itemId: typeof obj.itemId === "number" ? String(obj.itemId) : typeof obj.itemId === "string" ? obj.itemId : null,
          name,
          price: parseShopeePriceString(obj.price),
          productLink: typeof obj.productLink === "string" ? obj.productLink : null,
          offerLink: typeof obj.offerLink === "string" ? obj.offerLink : null,
        };
      });
  }

/**
 * Match estrito do nó ao produto procurado. Sem identificadores requeridos
 * → null (jamais presumir o primeiro nó como o produto alvo).
 */
function matchNode(nodes: OfferNode[], wantShop: string | null, wantItem: string | null): OfferNode | null {
  const required = (wantShop && wantShop.trim().length > 0) || (wantItem && wantItem.trim().length > 0);
  if (!required) return null;
  return nodes.find((n) => {
    const shopOk = !wantShop || n.shopId === wantShop;
    const itemOk = !wantItem || n.itemId === wantItem;
    return shopOk && itemOk;
  }) ?? null;
}

export type ShopeeApiClient = ReturnType<typeof createShopeeApiClient>;
