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

function buildAuthorizationHeader(payload: string, appId: string, secret: string, timestamp: string): string {
  const signatureInput = [appId, timestamp, payload, secret].join("");
  const signature = createHash("sha256").update(signatureInput).digest("hex");
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

export type ShopeeHttpTransport = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<Response>;

export interface ShopeeApiClientOptions {
  readonly appId: string;
  readonly secret: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly transport?: ShopeeHttpTransport;
  readonly clock?: () => number;
}

export function createShopeeApiClient(options: ShopeeApiClientOptions) {
  if (!options.appId || !options.secret) {
    throw new ShopeeClientError("SHOPEE_NOT_CONFIGURED", "credentials_missing");
  }
  const baseUrl = (options.baseUrl ?? SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? SHOPEE_DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? fetch;
  const clock = options.clock ?? (() => Date.now());

  async function signedGraphqlPost(body: { query: string; variables: Record<string, unknown> }): Promise<{ json: unknown; httpStatus: number }> {
    const payload = JSON.stringify(body);
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
      } catch {
        if (controller.signal.aborted) throw new ShopeeClientError("SHOPEE_TIMEOUT", "transport_timed_out");
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", "transport_failed");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401) throw new ShopeeClientError("SHOPEE_AUTH_ERROR", "http_401", response.status);
      if (response.status === 403) throw new ShopeeClientError("SHOPEE_FORBIDDEN", "http_403", response.status);
      if (!response.ok) {
        if (response.status === 429) throw new ShopeeClientError("SHOPEE_RATE_LIMITED", "http_429", response.status);
        throw new ShopeeClientError("SHOPEE_NETWORK_ERROR", `http_${response.status}`, response.status);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "body_not_json", response.status);
      }
      if (!json || typeof json !== "object") throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object", response.status);
      const data = json as Record<string, unknown>;
      if (Array.isArray(data.errors) && data.errors.length > 0) throw shopeeGraphqlErrorsToError(data.errors, response.status);
      return { json, httpStatus: response.status };
    } catch (err) {
      if (err instanceof ShopeeClientError) throw err;
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected");
    }
  }

  function shopeeGraphqlErrorsToError(errors: unknown[], httpStatus: number | null = null): ShopeeClientError {
    const first = errors[0] as Record<string, unknown> | undefined;
    const extensions = first?.extensions as Record<string, unknown> | undefined;
    const code = typeof extensions?.code === "number" ? extensions.code
      : typeof extensions?.code === "string" ? extensions.code
        : typeof first?.code === "number" ? first.code
          : typeof first?.code === "string" ? first.code
            : "unknown";
    return new ShopeeClientError(kindFromCode(code), `code_${code}`, httpStatus);
  }

  function kindFromCode(code: number | string): import("./shopeeClientContracts").ShopeeErrorKind {
    if (code === 10020 || code === "10020") return "SHOPEE_AUTH_ERROR";
    if (code === 10030 || code === "10030") return "SHOPEE_RATE_LIMITED";
    if (code === 10010 || code === "10010") return "SHOPEE_FORBIDDEN";
    return "SHOPEE_GRAPHQL_ERROR";
  }

  function offerQueryBody(params: { shopId?: string | null; itemId?: string | null }): { query: string; variables: Record<string, unknown> } {
    const num = (v: string | null | undefined): string | null => v && /^\d+$/.test(v) ? v : null;
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
        const transient = err.kind === "SHOPEE_RATE_LIMITED" || err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR";
        if (!transient || attempt >= MAX_ATTEMPTS) return mapKindToStatus(err);
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
    if (lastError instanceof ShopeeClientError) return mapKindToStatus(lastError);
    return { status: "error", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
  }

  function parseProductLookup(json: unknown, wantShop: string | null, wantItem: string | null, httpStatus: number | null): ShopeeProductLookupResult {
    const nodes = extractOfferNodes(json);
    if (nodes.length === 0) return { status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus, raw: json, error: null };
    const node = matchNode(nodes, wantShop, wantItem);
    if (!node) return { status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, httpStatus, raw: json, error: null };
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
    if (nodes.length === 0) return { status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: json, error: null };
    const node = matchNode(nodes, wantShop, wantItem);
    if (!node) return { status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: json, error: null };
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

  interface GenerateShortLinkResult {
    readonly status: "link_acquired" | "invalid_url" | "auth_error" | "rate_limited" | "transient" | "permanent";
    readonly shortLink: string | null;
    readonly longLink: string | null;
    readonly error: ShopeeClientError | null;
  }

  function isValidSubId(s: string): boolean {
    return s.length > 0 && s.length <= 40 && /^[a-zA-Z0-9]+$/.test(s);
  }

  async function generateShortLink(params: { originUrl: string; subIds?: ReadonlyArray<string> }): Promise<GenerateShortLinkResult> {
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
    const subIds = (params.subIds ?? []).filter((s) => typeof s === "string" && isValidSubId(s)).slice(0, 5);
    const payloadJson = JSON.stringify({
      query: `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${JSON.stringify(subIds)} }) { shortLink longLink } }`,
      variables: {},
    });
    try {
      const json = await signedGraphqlPostRaw(payloadJson);
      if (!json || typeof json !== "object") return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object") };
      const data = (json as Record<string, unknown>).data;
      const gql = data && typeof data === "object" ? (data as Record<string, unknown>).generateShortLink : null;
      if (!gql || typeof gql !== "object") return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_shortlink_envelope") };
      const shortLink = typeof (gql as Record<string, unknown>).shortLink === "string" ? (gql as Record<string, unknown>).shortLink as string : null;
      const longLink = typeof (gql as Record<string, unknown>).longLink === "string" ? (gql as Record<string, unknown>).longLink as string : null;
      if (!shortLink) return { status: "permanent", shortLink: null, longLink, error: new ShopeeClientError("SHOPEE_NOT_ELIGIBLE", "no_official_short_link") };
      return { status: "link_acquired", shortLink, longLink, error: null };
    } catch (err) {
      if (!(err instanceof ShopeeClientError)) return { status: "permanent", shortLink: null, longLink: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected") };
      if (err.detail && (err.detail.includes("url") || err.detail.includes("Url"))) return { status: "invalid_url", shortLink: null, longLink: null, error: err };
      if (err.kind === "SHOPEE_AUTH_ERROR") return { status: "auth_error", shortLink: null, longLink: null, error: err };
      if (err.kind === "SHOPEE_RATE_LIMITED") return { status: "rate_limited", shortLink: null, longLink: null, error: err };
      if (err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR") return { status: "transient", shortLink: null, longLink: null, error: err };
      return { status: "permanent", shortLink: null, longLink: null, error: err };
    }
  }

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
      } catch {
        if (controller.signal.aborted) throw new ShopeeClientError("SHOPEE_TIMEOUT", "transport_timed_out");
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
      if (!json || typeof json !== "object") throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object", response.status);
      const data = json as Record<string, unknown>;
      if (Array.isArray(data.errors) && data.errors.length > 0) throw shopeeGraphqlErrorsToError(data.errors, response.status);
      return json;
    } catch (err) {
      if (err instanceof ShopeeClientError) throw err;
      throw new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected");
    }
  }

  async function inspectPromotionFields(): Promise<{ ok: boolean; nodeType: string | null; fields: string[]; reason: string | null }> {
    try {
      const typeResponse = await signedGraphqlPost({
        query: "{ productOfferV2(itemId: 46816332146, shopId: 852965232, limit: 1) { nodes { __typename } } }",
        variables: {},
      });
      const root = typeResponse.json as { data?: { productOfferV2?: { nodes?: Array<{ __typename?: unknown }> } } };
      const nodeType = root.data?.productOfferV2?.nodes?.[0]?.__typename;
      if (typeof nodeType !== "string" || nodeType.length === 0) return { ok: false, nodeType: null, fields: [], reason: "node_type_unavailable" };
      const schemaResponse = await signedGraphqlPost({ query: `query { __type(name: ${JSON.stringify(nodeType)}) { fields { name } } }`, variables: {} });
      const schema = schemaResponse.json as { data?: { __type?: { fields?: Array<{ name?: unknown }> } } };
      const fields = (schema.data?.__type?.fields ?? []).map((field) => field.name).filter((name): name is string => typeof name === "string").sort();
      return fields.length > 0 ? { ok: true, nodeType, fields, reason: null } : { ok: false, nodeType, fields: [], reason: "fields_unavailable" };
    } catch (err) {
      return { ok: false, nodeType: null, fields: [], reason: err instanceof ShopeeClientError ? err.kind : "unexpected" };
    }
  }

  async function inspectPromotionOffer(params: { shopId: string; itemId: string }): Promise<{
    ok: boolean;
    values: { price: string | number | null; priceMin: string | number | null; priceMax: string | number | null; priceDiscountRate: string | number | null } | null;
    reason: string | null;
  }> {
    if (!/^\d+$/.test(params.shopId) || !/^\d+$/.test(params.itemId)) return { ok: false, values: null, reason: "invalid_identity" };
    try {
      const response = await signedGraphqlPost({
        query: `{ productOfferV2(itemId: ${params.itemId}, shopId: ${params.shopId}, limit: 1) { nodes { itemId shopId price priceMin priceMax priceDiscountRate } } }`,
        variables: {},
      });
      const root = response.json as { data?: { productOfferV2?: { nodes?: Array<Record<string, unknown>> } } };
      const node = root.data?.productOfferV2?.nodes?.find((candidate) => String(candidate.itemId) === params.itemId && String(candidate.shopId) === params.shopId);
      if (!node) return { ok: false, values: null, reason: "exact_offer_not_found" };
      const scalar = (value: unknown): string | number | null => typeof value === "string" || typeof value === "number" ? value : null;
      return {
        ok: true,
        values: {
          price: scalar(node.price),
          priceMin: scalar(node.priceMin),
          priceMax: scalar(node.priceMax),
          priceDiscountRate: scalar(node.priceDiscountRate),
        },
        reason: null,
      };
    } catch (err) {
      return { ok: false, values: null, reason: err instanceof ShopeeClientError ? err.kind : "unexpected" };
    }
  }

  function mapKindToStatus(err: ShopeeClientError): ShopeeAffiliateAcquisitionResult {
    if (err.kind === "SHOPEE_AUTH_ERROR" || err.kind === "SHOPEE_FORBIDDEN") return { status: "auth_error", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    if (err.kind === "SHOPEE_RATE_LIMITED") return { status: "rate_limited", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    if (err.kind === "SHOPEE_TIMEOUT" || err.kind === "SHOPEE_NETWORK_ERROR") return { status: "transient", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
    return { status: "permanent", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, raw: null, error: err };
  }

  const SH_KEYWORD_MAX_LENGTH = 60;
  function sanitizeSearchKeyword(raw: string): string | null {
    const trimmed = raw.trim().slice(0, SH_KEYWORD_MAX_LENGTH);
    if (trimmed.length === 0) return null;
    if (!/^[a-zA-Z0-9À-ÿ .\-]+$/.test(trimmed)) return null;
    return trimmed.replace(/\s{2,}/g, " ");
  }

  interface SearchItem {
    readonly shopId: string | null;
    readonly itemId: string | null;
    readonly name: string | null;
    readonly price: number | null;
    readonly productLink: string | null;
    readonly offerLink: string | null;
    /** Imagem principal retornada pela mesma fonte oficial de discovery. */
    readonly imageUrl: string | null;
  }

  interface SearchOffersResult {
    readonly ok: boolean;
    readonly reason?: string;
    readonly items: ReadonlyArray<SearchItem>;
    readonly httpStatus: number | null;
    readonly error: ShopeeClientError | null;
    readonly page: number;
  }

  const SEARCH_MIN_LIMIT = 1;
  const SEARCH_MAX_LIMIT = 10;
  const SEARCH_MAX_PAGE = 10;

  async function searchOffers(params: { query: string; limit?: number; page?: number }): Promise<SearchOffersResult> {
    const keyword = sanitizeSearchKeyword(params.query);
    const page = Math.min(SEARCH_MAX_PAGE, Math.max(1, Math.floor(params.page ?? 1) || 1));
    if (!keyword) {
      return {
        ok: false,
        reason: "invalid_keyword",
        items: [],
        httpStatus: null,
        error: new ShopeeClientError("SHOPEE_GRAPHQL_ERROR", "invalid_search_keyword"),
        page,
      };
    }
    const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(SEARCH_MIN_LIMIT, Math.floor(params.limit ?? 5) || SEARCH_MIN_LIMIT));
    try {
      const response = await signedGraphqlPost({
        query: `{ productOfferV2(keyword: ${JSON.stringify(keyword)}, listType: 0, sortType: 1, page: ${page}, limit: ${limit}) { nodes { itemId shopId productName price productLink offerLink imageUrl } } }`,
        variables: {},
      });
      return parseSearchResponse(response.json, response.httpStatus, page);
    } catch (err) {
      if (err instanceof ShopeeClientError) {
        return { ok: false, reason: err.kind, items: [], httpStatus: err.httpStatus, error: err, page };
      }
      return { ok: false, reason: "SHOPEE_UNKNOWN_ERROR", items: [], httpStatus: null, error: new ShopeeClientError("SHOPEE_UNKNOWN_ERROR", "unexpected"), page };
    }
  }

  function parseSearchResponse(json: unknown, httpStatus: number | null, page = 1): SearchOffersResult {
    if (!json || typeof json !== "object") return { ok: false, reason: "SHOPEE_INVALID_RESPONSE", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object"), page };
    const data = (json as Record<string, unknown>)?.data;
    if (!data || typeof data !== "object") return { ok: false, reason: "SHOPEE_INVALID_RESPONSE", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_data_envelope"), page };
    const search = (data as Record<string, unknown>).productOfferV2;
    if (!search || typeof search !== "object" || !Array.isArray((search as Record<string, unknown>).nodes)) {
      return { ok: false, reason: "search_operation_unavailable", items: [], httpStatus, error: new ShopeeClientError("SHOPEE_GRAPHQL_ERROR", "no_search_nodes"), page };
    }
    const items: SearchItem[] = [];
    for (const raw of (search as Record<string, unknown>).nodes as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      items.push({
        shopId: typeof obj.shopId === "number" ? String(obj.shopId) : typeof obj.shopId === "string" ? obj.shopId : null,
        itemId: typeof obj.itemId === "number" ? String(obj.itemId) : typeof obj.itemId === "string" ? obj.itemId : null,
        name: typeof obj.productName === "string" && obj.productName.length > 0 ? obj.productName : typeof obj.name === "string" && obj.name.length > 0 ? obj.name : null,
        price: parseShopeePriceString(obj.price),
        productLink: typeof obj.productLink === "string" ? obj.productLink : null,
        offerLink: typeof obj.offerLink === "string" ? obj.offerLink : null,
        imageUrl: typeof obj.imageUrl === "string" && /^https:\/\//i.test(obj.imageUrl) ? obj.imageUrl : null,
      });
    }
    return { ok: true, items, httpStatus, error: null, page };
  }

  return {
    lookupProduct,
    acquireAffiliateLink,
    generateShortLink,
    searchOffers,
    inspectPromotionFields,
    inspectPromotionOffer,
  };
}

interface OfferNode {
  shopId: string | null;
  itemId: string | null;
  name: string | null;
  price: number | null;
  productLink: string | null;
  offerLink: string | null;
}

export function parseShopeePriceString(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

export function extractOfferNodes(json: unknown): OfferNode[] {
  if (!json || typeof json !== "object") throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_object");
  const data = (json as Record<string, unknown>)?.data;
  if (!data || typeof data !== "object") throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_data_envelope");
  const offer = (data as Record<string, unknown>)?.productOfferV2;
  if (!offer || typeof offer !== "object" || !Array.isArray((offer as Record<string, unknown>).nodes)) {
    throw new ShopeeClientError("SHOPEE_INVALID_RESPONSE", "no_offer_nodes");
  }
  return ((offer as Record<string, unknown>).nodes as unknown[])
    .filter((node) => node && typeof node === "object")
    .map((node) => {
      const obj = node as Record<string, unknown>;
      const name = typeof obj.productName === "string" && obj.productName.length > 0
        ? obj.productName
        : typeof obj.name === "string" && obj.name.length > 0 ? obj.name : null;
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

function matchNode(nodes: OfferNode[], wantShop: string | null, wantItem: string | null): OfferNode | null {
  const required = (wantShop && wantShop.trim().length > 0) || (wantItem && wantItem.trim().length > 0);
  if (!required) return null;
  return nodes.find((node) => (!wantShop || node.shopId === wantShop) && (!wantItem || node.itemId === wantItem)) ?? null;
}

export type ShopeeApiClient = ReturnType<typeof createShopeeApiClient>;
