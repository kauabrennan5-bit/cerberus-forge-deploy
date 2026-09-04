import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";
import { checkGeminiVisualProviderHealth, checkOpenAIVisualProviderHealth } from "./aiProviderHealth";
import { getTelegramWebhookDiagnostics } from "./telegramDiagnostics";
import { inspectShopeeProviderEnv } from "./shopeeProviderRuntime";
import type { ComponentObservation, OperationalStatus } from "./operatorAutonomy";
import { isPublicCatalogEligibleDbRow, PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION } from "./publicCatalogEligibility";

export const DEFAULT_PUBLIC_SITE_URL = "https://cerberus-design-static.onrender.com";
export const DEFAULT_PUBLIC_BACKEND_URL = "https://cerberus-forge-deploy-backend.onrender.com";
export const DEFAULT_PUBLIC_CATALOG_URL = "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products";
const DEFAULT_TIMEOUT_MS = 12_000;

export type OperatorHealthComponentName =
  | "Site"
  | "Backend"
  | "Produtos/API"
  | "Catálogo/Projection"
  | "Supabase"
  | "Telegram"
  | "Shopee"
  | "Gemini"
  | "OpenAI"
  | "Newsletter";

export type OperatorHealthObservation = ComponentObservation & {
  name: OperatorHealthComponentName;
  httpStatus?: number;
  diagnostic: Record<string, unknown>;
};

export type OperatorHealthChecksResult = {
  checkedAt: string;
  publicSiteUrl: string;
  publicBackendUrl: string;
  catalogProjectionUrl: string;
  observations: OperatorHealthObservation[];
};

type HealthOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  supabaseClient?: SupabaseClient;
  telegramCheck?: typeof getTelegramWebhookDiagnostics;
  openaiCheck?: typeof checkOpenAIVisualProviderHealth;
  geminiCheck?: typeof checkGeminiVisualProviderHealth;
  timeoutMs?: number;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveOperatorHealthUrls(env: NodeJS.ProcessEnv = process.env) {
  const publicSiteUrl = normalizeBaseUrl(String(env.PUBLIC_SITE_URL || DEFAULT_PUBLIC_SITE_URL).trim());
  const publicBackendUrl = normalizeBaseUrl(String(env.PUBLIC_BACKEND_URL || DEFAULT_PUBLIC_BACKEND_URL).trim());
  const catalogProjectionUrl = String(env.PUBLIC_CATALOG_URL || env.PUBLIC_CATALOG_API_URL || DEFAULT_PUBLIC_CATALOG_URL).trim();
  return { publicSiteUrl, publicBackendUrl, catalogProjectionUrl };
}

function observation(input: {
  name: OperatorHealthComponentName;
  status: OperationalStatus;
  startedAt: number;
  error?: string;
  httpStatus?: number;
  diagnostic?: Record<string, unknown>;
}): OperatorHealthObservation {
  return {
    name: input.name,
    status: input.status,
    timestamp: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    error: input.error,
    httpStatus: input.httpStatus,
    diagnostic: input.diagnostic || {},
  };
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json,text/html;q=0.9,*/*;q=0.5", "User-Agent": "CerberusOperator/2.0" },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProductsPayload(payload: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(payload)) return payload.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.products)) return record.products.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
    if (Array.isArray(record.data)) return record.data.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
  }
  return null;
}

function productId(row: Record<string, unknown>): string {
  return String(row.id || row.product_id || "").trim();
}

function productIsPublic(row: Record<string, unknown>): boolean {
  const status = String(row.status || "published");
  const active = row.ativo === undefined ? row.active !== false : row.ativo !== false;
  return status === "published" && active;
}

function statusForAi(value: string): OperationalStatus {
  if (value === "healthy") return "HEALTHY";
  if (["disabled", "not_configured", "rate_limited", "timeout", "provider_unavailable", "model_unavailable"].includes(value)) return "DEGRADED";
  return "DOWN";
}

async function checkSite(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<OperatorHealthObservation> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    const status: OperationalStatus = response.ok ? "HEALTHY" : response.status >= 500 ? "DOWN" : "DEGRADED";
    return observation({ name: "Site", status, startedAt, httpStatus: response.status, error: response.ok ? undefined : `HTTP_${response.status}`, diagnostic: { urlRole: "public_frontend", expected: "HTTP 2xx", contentType: response.headers.get("content-type") } });
  } catch (error) {
    return observation({ name: "Site", status: "DOWN", startedAt, error: error instanceof Error && error.name === "AbortError" ? "SITE_TIMEOUT" : "SITE_FETCH_FAILED", diagnostic: { urlRole: "public_frontend" } });
  }
}

async function checkBackend(fetchImpl: typeof fetch, baseUrl: string, timeoutMs: number): Promise<OperatorHealthObservation> {
  const startedAt = Date.now();
  const url = `${baseUrl}/health`;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    let payload: Record<string, unknown> | null = null;
    try { payload = await response.json() as Record<string, unknown>; } catch { payload = null; }
    const status: OperationalStatus = response.ok ? "HEALTHY" : response.status >= 500 ? "DOWN" : "DEGRADED";
    return observation({ name: "Backend", status, startedAt, httpStatus: response.status, error: response.ok ? undefined : `HTTP_${response.status}`, diagnostic: { urlRole: "backend_health", sha: payload?.sha || payload?.commit || payload?.gitCommit || null } });
  } catch (error) {
    return observation({ name: "Backend", status: "DOWN", startedAt, error: error instanceof Error && error.name === "AbortError" ? "BACKEND_TIMEOUT" : "BACKEND_FETCH_FAILED", diagnostic: { urlRole: "backend_health" } });
  }
}

async function checkProductsApi(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<{ observation: OperatorHealthObservation; products: Array<Record<string, unknown>> | null }> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
    let payload: unknown = null;
    try { payload = await response.json(); } catch { payload = null; }
    const products = normalizeProductsPayload(payload);
    const valid = response.ok && products !== null;
    return {
      observation: observation({ name: "Produtos/API", status: valid ? "HEALTHY" : response.ok ? "DEGRADED" : "DOWN", startedAt, httpStatus: response.status, error: valid ? undefined : response.ok ? "PRODUCTS_COLLECTION_INVALID" : `HTTP_${response.status}`, diagnostic: { urlRole: "public_edge_products_api", collectionSize: products?.length ?? null } }),
      products,
    };
  } catch (error) {
    return { observation: observation({ name: "Produtos/API", status: "DOWN", startedAt, error: error instanceof Error && error.name === "AbortError" ? "PRODUCTS_API_TIMEOUT" : "PRODUCTS_API_FETCH_FAILED", diagnostic: { urlRole: "public_edge_products_api" } }), products: null };
  }
}

async function readSupabaseProducts(client: SupabaseClient): Promise<{ rows: Array<Record<string, unknown>>; observation: OperatorHealthObservation }> {
  const startedAt = Date.now();
  const { data, error } = await client.from("products").select("id,status,ativo,categoria,display_title,display_title_status,image_editorial_status,image_curation");
  if (error) return { rows: [], observation: observation({ name: "Supabase", status: "DOWN", startedAt, error: "SUPABASE_READ_FAILED", diagnostic: { code: error.code || null } }) };
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  return { rows, observation: observation({ name: "Supabase", status: "HEALTHY", startedAt, diagnostic: { readOnly: true, productsRead: rows.length } }) };
}

async function checkCatalogProjection(input: {
  fetchImpl: typeof fetch;
  url: string;
  timeoutMs: number;
  supabaseRows: Array<Record<string, unknown>> | null;
}): Promise<OperatorHealthObservation> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(input.fetchImpl, input.url, input.timeoutMs);
    let payload: unknown = null;
    try { payload = await response.json(); } catch { payload = null; }
    const projected = normalizeProductsPayload(payload);
    if (!response.ok || !projected) {
      return observation({ name: "Catálogo/Projection", status: response.ok ? "DEGRADED" : "DOWN", startedAt, httpStatus: response.status, error: response.ok ? "CATALOG_PROJECTION_INVALID" : `HTTP_${response.status}`, diagnostic: { urlRole: "public_catalog_projection" } });
    }
    if (!input.supabaseRows) {
      return observation({ name: "Catálogo/Projection", status: "UNKNOWN", startedAt, httpStatus: response.status, error: "SUPABASE_COMPARISON_UNAVAILABLE", diagnostic: { projectedCount: projected.length, urlRole: "public_catalog_projection" } });
    }
    const expectedIds = input.supabaseRows.filter(isPublicCatalogEligibleDbRow).map(productId).filter(Boolean).sort();
    const projectedIds = projected.filter(productIsPublic).map(productId).filter(Boolean).sort();
    const missing = expectedIds.filter(id => !projectedIds.includes(id));
    const extra = projectedIds.filter(id => !expectedIds.includes(id));
    const coherent = missing.length === 0 && extra.length === 0;
    return observation({
      name: "Catálogo/Projection",
      status: coherent ? "HEALTHY" : "DEGRADED",
      startedAt,
      httpStatus: response.status,
      error: coherent ? undefined : "CATALOG_PROJECTION_DIVERGENCE",
      diagnostic: { urlRole: "public_catalog_projection", eligibilityContract: PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, expectedCount: expectedIds.length, projectedCount: projectedIds.length, missingCount: missing.length, extraCount: extra.length, missingIds: missing.slice(0, 20), extraIds: extra.slice(0, 20) },
    });
  } catch (error) {
    return observation({ name: "Catálogo/Projection", status: "DOWN", startedAt, error: error instanceof Error && error.name === "AbortError" ? "CATALOG_TIMEOUT" : "CATALOG_FETCH_FAILED", diagnostic: { urlRole: "public_catalog_projection" } });
  }
}

async function checkTelegram(check: typeof getTelegramWebhookDiagnostics): Promise<OperatorHealthObservation> {
  const startedAt = Date.now();
  const diag = await check();
  const status: OperationalStatus = diag.status === "healthy" ? "HEALTHY" : diag.status === "degraded" ? "DEGRADED" : "DOWN";
  return observation({ name: "Telegram", status, startedAt, httpStatus: diag.httpStatus, error: diag.errorCode, diagnostic: { apiHealthy: diag.apiHealthy, webhookConfigured: diag.webhookConfigured, webhookMatchesExpectedUrl: diag.webhookMatchesExpectedUrl, backendReady: diag.backendReady, pendingUpdates: diag.pendingUpdates ?? null, failedMethod: diag.failedMethod ?? null, tokenFingerprint: diag.tokenFingerprint ?? null } });
}

function checkShopee(env: NodeJS.ProcessEnv): OperatorHealthObservation {
  const startedAt = Date.now();
  const diag = inspectShopeeProviderEnv(env);
  const ready = diag.credentialsConfigured && diag.baseUrlStructurallyValid;
  return observation({ name: "Shopee", status: ready ? "HEALTHY" : "DEGRADED", startedAt, error: ready ? undefined : "SHOPEE_PROVIDER_NOT_CONFIGURED", diagnostic: { adapter: diag.adapter, credentialsConfigured: diag.credentialsConfigured, appIdConfigured: diag.appIdConfigured, appSecretConfigured: diag.appSecretConfigured, baseUrlStructurallyValid: diag.baseUrlStructurallyValid, baseUrlHost: diag.baseUrlHost, readinessOnly: true, publicationExecuted: false } });
}

function checkNewsletter(env: NodeJS.ProcessEnv): OperatorHealthObservation {
  const startedAt = Date.now();
  const apiConfigured = Boolean(String(env.BREVO_API_KEY || "").trim());
  const weeklyEnabled = String(env.NEWSLETTER_WEEKLY_ENABLED || "false").trim().toLowerCase() === "true";
  return observation({ name: "Newsletter", status: apiConfigured ? "HEALTHY" : "DEGRADED", startedAt, error: apiConfigured ? undefined : "NEWSLETTER_PROVIDER_NOT_CONFIGURED", diagnostic: { provider: "brevo", apiConfigured, weeklyEnabled, readOnly: true, campaignCreated: false, emailSent: false, consentChanged: false } });
}

export async function runOperatorHealthChecksV2(options: HealthOptions = {}): Promise<OperatorHealthChecksResult> {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const urls = resolveOperatorHealthUrls(env);
  const checkedAt = new Date().toISOString();
  const observations: OperatorHealthObservation[] = [];

  // Components are measured independently. A Site failure cannot change the
  // Backend/API/Catalog observation, and a Catalog failure cannot synthesize a Site incident.
  const [site, backend, productsResult] = await Promise.all([
    checkSite(fetchImpl, urls.publicSiteUrl, timeoutMs),
    checkBackend(fetchImpl, urls.publicBackendUrl, timeoutMs),
    checkProductsApi(fetchImpl, urls.catalogProjectionUrl, timeoutMs),
  ]);
  observations.push(site, backend, productsResult.observation);

  let supabaseRows: Array<Record<string, unknown>> | null = null;
  try {
    const db = await readSupabaseProducts(options.supabaseClient || requireSupabase());
    supabaseRows = db.rows;
    observations.push(db.observation);
  } catch {
    observations.push(observation({ name: "Supabase", status: "DOWN", startedAt: Date.now(), error: "SUPABASE_NOT_CONFIGURED", diagnostic: { readOnly: true } }));
  }

  observations.push(await checkCatalogProjection({ fetchImpl, url: urls.catalogProjectionUrl, timeoutMs, supabaseRows }));

  const [telegram, openai, gemini] = await Promise.all([
    checkTelegram(options.telegramCheck || getTelegramWebhookDiagnostics).catch(() => observation({ name: "Telegram", status: "DOWN", startedAt: Date.now(), error: "TELEGRAM_PROVIDER_UNAVAILABLE", diagnostic: {} })),
    (options.openaiCheck || checkOpenAIVisualProviderHealth)({ env }).catch(() => null),
    (options.geminiCheck || checkGeminiVisualProviderHealth)({ env }).catch(() => null),
  ]);
  observations.push(telegram);
  observations.push(checkShopee(env));

  const openaiStarted = Date.now();
  observations.push(openai
    ? observation({ name: "OpenAI", status: statusForAi(openai.status), startedAt: openaiStarted - openai.latencyMs, httpStatus: openai.httpStatus ?? undefined, error: openai.status === "healthy" ? undefined : openai.errorCode || openai.status, diagnostic: { configured: openai.configured, enabled: openai.enabled, model: openai.model, fallbackModel: openai.fallbackModel, effectiveModel: openai.effectiveModel, status: openai.status, errorCode: openai.errorCode, errorParam: openai.errorParam } })
    : observation({ name: "OpenAI", status: "DOWN", startedAt: openaiStarted, error: "OPENAI_PROVIDER_HEALTH_FAILED", diagnostic: {} }));

  const geminiStarted = Date.now();
  observations.push(gemini
    ? observation({ name: "Gemini", status: statusForAi(gemini.status), startedAt: geminiStarted - gemini.latencyMs, httpStatus: gemini.httpStatus ?? undefined, error: gemini.status === "healthy" ? undefined : gemini.errorCode || gemini.status, diagnostic: { configured: gemini.configured, enabled: gemini.enabled, model: gemini.model, fallbackModel: gemini.fallbackModel, effectiveModel: gemini.effectiveModel, status: gemini.status, errorCode: gemini.errorCode, errorParam: gemini.errorParam } })
    : observation({ name: "Gemini", status: "DOWN", startedAt: geminiStarted, error: "GEMINI_PROVIDER_HEALTH_FAILED", diagnostic: {} }));
  observations.push(checkNewsletter(env));

  return { checkedAt, ...urls, observations };
}

export const operatorHealthChecksV2Internals = {
  normalizeBaseUrl,
  normalizeProductsPayload,
  productId,
  productIsPublic,
  statusForAi,
  observation,
  checkSite,
  checkBackend,
  checkProductsApi,
  checkCatalogProjection,
  checkNewsletter,
};
