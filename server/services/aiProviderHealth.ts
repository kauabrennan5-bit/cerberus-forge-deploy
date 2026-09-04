import { GoogleGenAI, Type } from "@google/genai";
import {
  callOpenAIResponses,
  OpenAIProviderError,
  type OpenAIProviderFailureCode,
} from "./openAIProviderRuntime";

export type AiProviderHealthStatus =
  | "healthy"
  | "disabled"
  | "not_configured"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_error"
  | "model_unavailable"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response";

export type AiProviderHealth = {
  provider: "OpenAI" | "Gemini";
  configured: boolean;
  enabled: boolean;
  model: string;
  fallbackModel: string | null;
  effectiveModel: string | null;
  status: AiProviderHealthStatus;
  httpStatus: number | null;
  errorCode: string | null;
  errorParam: string | null;
  latencyMs: number;
  checkedAt: string;
  diagnostic: string;
};

type OpenAICall = typeof callOpenAIResponses;
type GeminiGenerate = (input: { model: string; request: Record<string, unknown> }) => Promise<{ text?: string | null }>;

// 64x64 RGB PNG. The previous 1x1 LA fixture could be rejected by provider-side
// image validation even though the Responses API request shape itself was valid.
const PROVIDER_HEALTH_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQ0AAAgEILV/2ItgCh9u0IBOUp9NPScgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbwH3PQNQliOz8AAAAABJRU5ErkJggg==";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_FALLBACK = "gemini-3.7-flash";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
const DEFAULT_OPENAI_FALLBACK = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { expiresAt: number; value: AiProviderHealth }>();

function enabledUnlessFalse(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

function safeModel(value: unknown, fallback: string): string {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 100);
  return normalized || fallback;
}

function positiveInt(value: unknown, fallback: number, max = 60_000): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function mapOpenAIStatus(code: OpenAIProviderFailureCode): AiProviderHealthStatus {
  switch (code) {
    case "OPENAI_RATE_LIMITED": return "rate_limited";
    case "OPENAI_QUOTA_EXHAUSTED": return "quota_exhausted";
    case "OPENAI_AUTH_ERROR": return "auth_error";
    case "OPENAI_MODEL_UNAVAILABLE": return "model_unavailable";
    case "OPENAI_TIMEOUT": return "timeout";
    case "OPENAI_PROVIDER_UNAVAILABLE": return "provider_unavailable";
    default: return "invalid_response";
  }
}

function classifyGeminiFailure(error: unknown): {
  status: AiProviderHealthStatus;
  errorCode: string;
  httpStatus: number | null;
} {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  const httpMatch = /\b(401|403|404|408|429|500|502|503|504)\b/.exec(message);
  const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
  if (/resource_exhausted|quota|insufficient|billing|credit/.test(message)) {
    return { status: /quota|billing|credit|insufficient/.test(message) ? "quota_exhausted" : "rate_limited", errorCode: "GEMINI_RESOURCE_EXHAUSTED", httpStatus: httpStatus ?? 429 };
  }
  if (httpStatus === 429 || /rate.?limit|too many requests/.test(message)) return { status: "rate_limited", errorCode: "GEMINI_RATE_LIMITED", httpStatus: httpStatus ?? 429 };
  if (httpStatus === 401 || httpStatus === 403 || /api.?key|permission|unauthenticated/.test(message)) return { status: "auth_error", errorCode: "GEMINI_AUTH_ERROR", httpStatus };
  if (httpStatus === 404 || /model.*not found|not_found/.test(message)) return { status: "model_unavailable", errorCode: "GEMINI_MODEL_UNAVAILABLE", httpStatus: httpStatus ?? 404 };
  if (httpStatus === 408 || /timeout|deadline/.test(message)) return { status: "timeout", errorCode: "GEMINI_TIMEOUT", httpStatus: httpStatus ?? 408 };
  if ((httpStatus !== null && httpStatus >= 500) || /unavailable|overloaded|network/.test(message)) return { status: "provider_unavailable", errorCode: "GEMINI_PROVIDER_UNAVAILABLE", httpStatus };
  return { status: "invalid_response", errorCode: "GEMINI_INVALID_RESPONSE", httpStatus };
}

function isHealthyPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).ok === true;
}

function parseOpenAIOutput(payload: unknown): unknown {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (typeof record.output_text === "string") return JSON.parse(record.output_text);
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) return JSON.parse(text);
    }
  }
  throw new Error("OPENAI_PROVIDER_HEALTH_EMPTY_OUTPUT");
}

function baseHealth(input: {
  provider: "OpenAI" | "Gemini";
  configured: boolean;
  enabled: boolean;
  model: string;
  fallbackModel: string | null;
  status: AiProviderHealthStatus;
  checkedAt: string;
  latencyMs: number;
  diagnostic: string;
}): AiProviderHealth {
  return {
    ...input,
    effectiveModel: null,
    httpStatus: null,
    errorCode: null,
    errorParam: null,
  };
}

function cacheKey(provider: string, model: string, fallback: string | null): string {
  return `${provider}:${model}:${fallback || "none"}`;
}

function cached(key: string, nowMs: number): AiProviderHealth | null {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= nowMs) {
    if (entry) cache.delete(key);
    return null;
  }
  return { ...entry.value, diagnostic: `${entry.value.diagnostic}; cached=true` };
}

function putCache(key: string, value: AiProviderHealth, nowMs: number): AiProviderHealth {
  cache.set(key, { expiresAt: nowMs + CACHE_TTL_MS, value });
  return value;
}

export async function checkOpenAIVisualProviderHealth(options: {
  env?: NodeJS.ProcessEnv;
  call?: OpenAICall;
  now?: () => number;
  force?: boolean;
} = {}): Promise<AiProviderHealth> {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const start = now();
  const checkedAt = new Date(start).toISOString();
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const enabled = enabledUnlessFalse(env.OPENAI_PRODUCT_IMAGE_REVIEW_ENABLED);
  const model = safeModel(env.OPENAI_PRODUCT_IMAGE_REVIEW_MODEL, DEFAULT_OPENAI_MODEL);
  const fallback = safeModel(env.OPENAI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL, DEFAULT_OPENAI_FALLBACK);
  const fallbackModel = fallback === model ? null : fallback;
  const key = cacheKey("openai", model, fallbackModel);
  if (!options.force) {
    const found = cached(key, start);
    if (found) return found;
  }
  if (!enabled) return baseHealth({ provider: "OpenAI", configured: Boolean(apiKey), enabled, model, fallbackModel, status: "disabled", checkedAt, latencyMs: now() - start, diagnostic: "OpenAI visual review disabled by configuration" });
  if (!apiKey) return baseHealth({ provider: "OpenAI", configured: false, enabled, model, fallbackModel, status: "not_configured", checkedAt, latencyMs: now() - start, diagnostic: "OPENAI_API_KEY not configured" });

  const call = options.call || callOpenAIResponses;
  let lastError: OpenAIProviderError | null = null;
  for (const candidateModel of [model, fallbackModel].filter((item): item is string => Boolean(item))) {
    try {
      const payload = await call({
        apiKey,
        timeoutMs: positiveInt(env.OPENAI_PROVIDER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        maxAttempts: 1,
        singleFlightKey: `openai-provider-health:${candidateModel}`,
        request: {
          model: candidateModel,
          store: false,
          max_output_tokens: 80,
          input: [{ role: "user", content: [
            { type: "input_text", text: "Return ok=true after confirming this image input is readable." },
            { type: "input_image", image_url: `data:image/png;base64,${PROVIDER_HEALTH_PNG_BASE64}`, detail: "low" },
          ] }],
          text: { format: { type: "json_schema", name: "cerberus_openai_provider_health", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
        },
      });
      if (!isHealthyPayload(parseOpenAIOutput(payload))) throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "health_schema_invalid", retryable: false });
      return putCache(key, {
        provider: "OpenAI",
        configured: true,
        enabled: true,
        model,
        fallbackModel,
        effectiveModel: candidateModel,
        status: "healthy",
        httpStatus: 200,
        errorCode: null,
        errorParam: null,
        latencyMs: now() - start,
        checkedAt,
        diagnostic: candidateModel === model ? "primary visual model healthy" : "fallback visual model healthy",
      }, start);
    } catch (error) {
      lastError = error instanceof OpenAIProviderError
        ? error
        : new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", errorCode: "health_check_failed", retryable: false });
      if (!["OPENAI_MODEL_UNAVAILABLE", "OPENAI_INVALID_RESPONSE"].includes(lastError.code)) break;
    }
  }
  const failure = lastError || new OpenAIProviderError({ code: "OPENAI_PROVIDER_UNAVAILABLE", retryable: false });
  return putCache(key, {
    provider: "OpenAI",
    configured: true,
    enabled: true,
    model,
    fallbackModel,
    effectiveModel: null,
    status: mapOpenAIStatus(failure.code),
    httpStatus: failure.httpStatus,
    errorCode: failure.errorCode || failure.code,
    errorParam: failure.errorParam,
    latencyMs: now() - start,
    checkedAt,
    diagnostic: `OpenAI visual provider classified as ${failure.code}`,
  }, start);
}

export async function checkGeminiVisualProviderHealth(options: {
  env?: NodeJS.ProcessEnv;
  generate?: GeminiGenerate;
  now?: () => number;
  force?: boolean;
} = {}): Promise<AiProviderHealth> {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const start = now();
  const checkedAt = new Date(start).toISOString();
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  const enabled = enabledUnlessFalse(env.GEMINI_PRODUCT_IMAGE_REVIEW_ENABLED);
  const model = safeModel(env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL, DEFAULT_GEMINI_MODEL);
  const fallback = safeModel(env.GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL, DEFAULT_GEMINI_FALLBACK);
  const fallbackModel = fallback === model ? null : fallback;
  const key = cacheKey("gemini", model, fallbackModel);
  if (!options.force) {
    const found = cached(key, start);
    if (found) return found;
  }
  if (!enabled) return baseHealth({ provider: "Gemini", configured: Boolean(apiKey), enabled, model, fallbackModel, status: "disabled", checkedAt, latencyMs: now() - start, diagnostic: "Gemini visual review disabled by configuration" });
  if (!apiKey) return baseHealth({ provider: "Gemini", configured: false, enabled, model, fallbackModel, status: "not_configured", checkedAt, latencyMs: now() - start, diagnostic: "GEMINI_API_KEY not configured" });

  const generate: GeminiGenerate = options.generate || (async ({ model: candidateModel, request }) => {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
    return ai.models.generateContent({ ...request, model: candidateModel } as any) as Promise<{ text?: string | null }>;
  });
  let lastFailure: ReturnType<typeof classifyGeminiFailure> | null = null;
  for (const candidateModel of [model, fallbackModel].filter((item): item is string => Boolean(item))) {
    try {
      const response = await Promise.race([
        generate({
          model: candidateModel,
          request: {
            contents: [{ role: "user", parts: [
              { text: "Return ok=true after confirming this image input is readable." },
              { inlineData: { mimeType: "image/png", data: PROVIDER_HEALTH_PNG_BASE64 } },
            ] }],
            config: {
              responseMimeType: "application/json",
              responseSchema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ["ok"] },
            },
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("GEMINI_PROVIDER_HEALTH_TIMEOUT")), positiveInt(env.GEMINI_PROVIDER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))),
      ]);
      const parsed = JSON.parse(String(response.text || "{}"));
      if (!isHealthyPayload(parsed)) throw new Error("GEMINI_INVALID_RESPONSE");
      return putCache(key, {
        provider: "Gemini",
        configured: true,
        enabled: true,
        model,
        fallbackModel,
        effectiveModel: candidateModel,
        status: "healthy",
        httpStatus: 200,
        errorCode: null,
        errorParam: null,
        latencyMs: now() - start,
        checkedAt,
        diagnostic: candidateModel === model ? "primary visual model healthy" : "fallback visual model healthy",
      }, start);
    } catch (error) {
      lastFailure = classifyGeminiFailure(error);
      if (!["model_unavailable", "invalid_response"].includes(lastFailure.status)) break;
    }
  }
  const failure = lastFailure || { status: "provider_unavailable" as const, errorCode: "GEMINI_PROVIDER_UNAVAILABLE", httpStatus: null };
  return putCache(key, {
    provider: "Gemini",
    configured: true,
    enabled: true,
    model,
    fallbackModel,
    effectiveModel: null,
    status: failure.status,
    httpStatus: failure.httpStatus,
    errorCode: failure.errorCode,
    errorParam: null,
    latencyMs: now() - start,
    checkedAt,
    diagnostic: `Gemini visual provider classified as ${failure.errorCode}`,
  }, start);
}

export const aiProviderHealthInternals = {
  PROVIDER_HEALTH_PNG_BASE64,
  enabledUnlessFalse,
  safeModel,
  classifyGeminiFailure,
  parseOpenAIOutput,
  isHealthyPayload,
  resetCache: () => cache.clear(),
};