import { randomUUID } from "node:crypto";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import type { ShopeeErrorKind } from "../commercial/affiliate/shopeeClientContracts";

export const SHOPEE_PROVIDER_ERROR_CODES = [
  "SHOPEE_PROVIDER_NOT_CONFIGURED",
  "SHOPEE_PROVIDER_AUTH_FAILED",
  "SHOPEE_PROVIDER_FORBIDDEN",
  "SHOPEE_PROVIDER_RATE_LIMITED",
  "SHOPEE_PROVIDER_TIMEOUT",
  "SHOPEE_PROVIDER_UNAVAILABLE",
  "SHOPEE_PROVIDER_RESPONSE_INVALID",
] as const;

export type ShopeeProviderErrorCode = (typeof SHOPEE_PROVIDER_ERROR_CODES)[number];

export class ShopeeProviderRuntimeError extends Error {
  constructor(
    readonly code: ShopeeProviderErrorCode,
    readonly providerReason: string,
    readonly transient: boolean,
  ) {
    super(code);
    this.name = "ShopeeProviderRuntimeError";
  }
}

export type ShopeeProviderEnvStatus = {
  provider: "shopee_affiliate_api";
  adapter: "ShopeeApiClient";
  credentialsConfigured: boolean;
  appIdConfigured: boolean;
  appSecretConfigured: boolean;
  baseUrlConfigured: boolean;
  baseUrlStructurallyValid: boolean;
  baseUrlHost: string | null;
  timeoutMs: number;
  searchPageLimit: number;
  searchMaxPage: number;
  retryAttempts: number;
};

const DEFAULT_BASE_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const DEFAULT_TIMEOUT_MS = 10_000;
const SEARCH_PAGE_LIMIT = 10;
const SEARCH_MAX_PAGE = 10;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BACKOFF_MS = 750;

function envValue(env: NodeJS.ProcessEnv, primary: string, legacy: string): string {
  return String(env[primary] || env[legacy] || "").trim();
}

export function inspectShopeeProviderEnv(env: NodeJS.ProcessEnv = process.env): ShopeeProviderEnvStatus {
  const appId = envValue(env, "SHOPEE_APP_ID", "SHOPEE_AFFILIATE_APP_ID");
  const secret = envValue(env, "SHOPEE_APP_SECRET", "SHOPEE_AFFILIATE_APP_SECRET");
  const rawBase = String(env.SHOPEE_AFFILIATE_API_BASE_URL || "").trim();
  const effectiveBase = rawBase || DEFAULT_BASE_URL;
  let baseUrlHost: string | null = null;
  let baseUrlStructurallyValid = false;
  try {
    const parsed = new URL(effectiveBase);
    baseUrlHost = parsed.hostname;
    baseUrlStructurallyValid = parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    baseUrlStructurallyValid = false;
  }
  return {
    provider: "shopee_affiliate_api",
    adapter: "ShopeeApiClient",
    credentialsConfigured: Boolean(appId && secret),
    appIdConfigured: Boolean(appId),
    appSecretConfigured: Boolean(secret),
    baseUrlConfigured: Boolean(rawBase),
    baseUrlStructurallyValid,
    baseUrlHost,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    searchPageLimit: SEARCH_PAGE_LIMIT,
    searchMaxPage: SEARCH_MAX_PAGE,
    retryAttempts: DEFAULT_RETRY_ATTEMPTS,
  };
}

export function buildConfiguredShopeeClient(env: NodeJS.ProcessEnv = process.env): ShopeeApiClient {
  const status = inspectShopeeProviderEnv(env);
  if (!status.credentialsConfigured || !status.baseUrlStructurallyValid) {
    throw new ShopeeProviderRuntimeError(
      "SHOPEE_PROVIDER_NOT_CONFIGURED",
      !status.credentialsConfigured ? "credentials_missing" : "base_url_invalid",
      false,
    );
  }
  const appId = envValue(env, "SHOPEE_APP_ID", "SHOPEE_AFFILIATE_APP_ID");
  const secret = envValue(env, "SHOPEE_APP_SECRET", "SHOPEE_AFFILIATE_APP_SECRET");
  return createShopeeApiClient({
    appId,
    secret,
    baseUrl: String(env.SHOPEE_AFFILIATE_API_BASE_URL || "").trim() || undefined,
  });
}

export function mapShopeeErrorKindToProviderCode(kind: ShopeeErrorKind | string | null | undefined): ShopeeProviderErrorCode {
  if (kind === "SHOPEE_NOT_CONFIGURED") return "SHOPEE_PROVIDER_NOT_CONFIGURED";
  if (kind === "SHOPEE_AUTH_ERROR") return "SHOPEE_PROVIDER_AUTH_FAILED";
  if (kind === "SHOPEE_FORBIDDEN") return "SHOPEE_PROVIDER_FORBIDDEN";
  if (kind === "SHOPEE_RATE_LIMITED") return "SHOPEE_PROVIDER_RATE_LIMITED";
  if (kind === "SHOPEE_TIMEOUT") return "SHOPEE_PROVIDER_TIMEOUT";
  if (kind === "SHOPEE_INVALID_RESPONSE" || kind === "SHOPEE_GRAPHQL_ERROR") return "SHOPEE_PROVIDER_RESPONSE_INVALID";
  return "SHOPEE_PROVIDER_UNAVAILABLE";
}

export function providerErrorFromSearchResult(result: Awaited<ReturnType<ShopeeApiClient["searchOffers"]>>): ShopeeProviderRuntimeError {
  const kind = result.error?.kind || result.reason || "SHOPEE_UNKNOWN_ERROR";
  const code = mapShopeeErrorKindToProviderCode(kind);
  return new ShopeeProviderRuntimeError(
    code,
    typeof result.reason === "string" ? result.reason : String(kind),
    code === "SHOPEE_PROVIDER_RATE_LIMITED" || code === "SHOPEE_PROVIDER_TIMEOUT" || code === "SHOPEE_PROVIDER_UNAVAILABLE",
  );
}

export function providerErrorFromAcquisitionStatus(status: string, errorKind?: string | null): ShopeeProviderRuntimeError | null {
  if (status === "auth_error") {
    const code = errorKind === "SHOPEE_FORBIDDEN" ? "SHOPEE_PROVIDER_FORBIDDEN" : "SHOPEE_PROVIDER_AUTH_FAILED";
    return new ShopeeProviderRuntimeError(code, errorKind || status, false);
  }
  if (status === "rate_limited") return new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_RATE_LIMITED", errorKind || status, true);
  if (status === "transient") {
    const code = errorKind === "SHOPEE_TIMEOUT" ? "SHOPEE_PROVIDER_TIMEOUT" : "SHOPEE_PROVIDER_UNAVAILABLE";
    return new ShopeeProviderRuntimeError(code, errorKind || status, true);
  }
  if (status === "invalid_response" || (status === "permanent" && errorKind === "SHOPEE_INVALID_RESPONSE")) {
    return new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_RESPONSE_INVALID", errorKind || status, false);
  }
  return null;
}

export async function searchShopeeOffersWithRetry(input: {
  client: ShopeeApiClient;
  query: string;
  limit?: number;
  page?: number;
  attempts?: number;
  backoffMs?: number;
}): Promise<Awaited<ReturnType<ShopeeApiClient["searchOffers"]>>> {
  const attempts = Math.max(1, Math.min(3, Math.floor(input.attempts ?? DEFAULT_RETRY_ATTEMPTS)));
  const backoffMs = Math.max(0, Math.floor(input.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS));
  let last: Awaited<ReturnType<ShopeeApiClient["searchOffers"]>> | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await input.client.searchOffers({
      query: input.query,
      limit: Math.min(SEARCH_PAGE_LIMIT, Math.max(1, Math.floor(input.limit ?? SEARCH_PAGE_LIMIT))),
      page: Math.min(SEARCH_MAX_PAGE, Math.max(1, Math.floor(input.page ?? 1))),
    });
    if (result.ok) return result;
    last = result;
    const failure = providerErrorFromSearchResult(result);
    if (!failure.transient || attempt >= attempts) throw failure;
    if (backoffMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs * attempt));
  }
  throw last ? providerErrorFromSearchResult(last) : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "search_failed", true);
}

export function validateOfficialProductLink(productLink: unknown, shopId: unknown, itemId: unknown): productLink is string {
  if (typeof productLink !== "string" || !/^https:\/\//i.test(productLink)) return false;
  const shop = typeof shopId === "string" ? shopId : String(shopId ?? "");
  const item = typeof itemId === "string" ? itemId : String(itemId ?? "");
  if (!/^\d+$/.test(shop) || !/^\d+$/.test(item)) return false;
  const identity = extractShopeeIdentity(productLink);
  return identity.shopId === shop && identity.itemId === item;
}

export function maskShopeeReference(shopId: string | null | undefined, itemId: string | null | undefined): string {
  const mask = (value: string | null | undefined) => {
    const text = String(value || "");
    if (text.length <= 4) return text ? "••••" : "?";
    return `••••${text.slice(-4)}`;
  };
  return `${mask(shopId)}/${mask(itemId)}`;
}

export function newShopeeCorrelationId(prefix = "shp"): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function safeShopeeLog(event: string, fields: Record<string, unknown>): void {
  const sanitized: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (/secret|token|authorization|cookie|email|url|payload|header/i.test(key)) continue;
    sanitized[key] = typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, 160) : value;
  }
  console.info(JSON.stringify(sanitized));
}