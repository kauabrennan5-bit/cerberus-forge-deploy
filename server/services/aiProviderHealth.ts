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

export type OpenAIHealthState =
  | "OPENAI_OK"
  | "OPENAI_PRIMARY_DOWN_FALLBACK_OK"
  | "OPENAI_VISION_CANARY_FAILED"
  | "OPENAI_STRUCTURED_OUTPUT_FAILED"
  | "OPENAI_PROVIDER_DOWN"
  | "OPENAI_CONFIG_MISSING"
  | "OPENAI_BAD_HEALTH_PAYLOAD";

export type AiProviderHealth = {
  provider: "OpenAI" | "Gemini";
  configured: boolean;
  enabled: boolean;
  model: string;
  fallbackModel: string | null;
  effectiveModel: string | null;
  status: AiProviderHealthStatus;
  state?: OpenAIHealthState;
  httpStatus: number | null;
  errorCode: string | null;
  errorParam: string | null;
  latencyMs: number;
  checkedAt: string;
  diagnostic: string;
  probes?: {
    connectivity: "ok" | "failed" | "not_run";
    structuredOutput: "ok" | "failed" | "not_run";
    vision: "ok" | "failed" | "not_run";
  };
};

type OpenAICall = typeof callOpenAIResponses;
type GeminiGenerate = (input: { model: string; request: Record<string, unknown> }) => Promise<{ text?: string | null }>;

const OPENAI_VISION_CANARY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADQElEQVR42u3bodXqQBRGUWClBDrAkA4iKAI6oA0qoBwMJSDSwSg6wI5H4FEJJPn2Vs/9zGUONxFvXWtdQaqNESAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABwDw1RjCs0+U59p+4XXfmbAOAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABEC40f8/QNu2UQPdH+9GOqxSig0AAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAGA6GiMYRH/Yfv5x/uHf6h4vkxfAVK7+v/60DASQde8tBAG4+haCl2C3f56f0AZw9a0CAbj6MvAI5Pb7/AJwe5zCI5BL43HIBnD7nUsAbonTCcD9cEYBuBlOKgB3wnkF4DY4tQDcA2cXgBtgAgLw3ZuDAEAAfvZMQwC+bzMRgG/aZAQAAvAjZz4CAAH4+TclAbj9ZiUAiA7Az7+J2QAgAEgLwPOPudkAEBmAn3/TswFAAJAWgOcfM7QBQAAgAAgKwAuASdoAIAAQAAgAMgLwBmyeNgAIAAQAAgABgABAACAABAACAAGAAEAAIAAQwEx1j5dv1zxtABAACAAEADEBeA82SRsABAACgLgAvAaYoQ0AAoDMADwFmZ4NAMEBWALmZgOAACAzAE9BJmYDQHAAloBZpW8ADZiSRyAIDsASMB8bAIIDsARMJn0DaMBM0h+BNGAa3gHwDuBnz89/8Bw2vnsTsAHcAGcXgAacWgAacF4BaMBJBaABZxSABpxOABpwrsVqjODLXekPW1ffBrAKnEIAGvD5PQJ5HHL1BSADV98jkCcin9AGsApcfQGkr4K/l+DeCyB0Ibj6ApjcQtgf3XsvwSAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAACAAGAAEAAIAAQAAgAlqwZ+w+UUqIGero8jdQGAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgAxrautZoCNgAIAAQAAgABgABAACAAEAAIAAQAAgABgABght7JDeT3EEaMFQAAAABJRU5ErkJggg==";
const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=";
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

function classifyGeminiFailure(error: unknown): { status: AiProviderHealthStatus; errorCode: string; httpStatus: number | null } {
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
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).ok === true);
}

function extractOpenAIOutputText(payload: unknown): string {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (typeof record.output_text === "string" && record.output_text.trim()) return record.output_text.trim();
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  }
  throw new Error("OPENAI_PROVIDER_HEALTH_EMPTY_OUTPUT");
}

function parseOpenAIOutput(payload: unknown): unknown {
  return JSON.parse(extractOpenAIOutputText(payload));
}

function baseHealth(input: {
  provider: "OpenAI" | "Gemini"; configured: boolean; enabled: boolean; model: string; fallbackModel: string | null;
  status: AiProviderHealthStatus; checkedAt: string; latencyMs: number; diagnostic: string; state?: OpenAIHealthState;
}): AiProviderHealth {
  return { ...input, effectiveModel: null, httpStatus: null, errorCode: null, errorParam: null };
}

function cacheKey(provider: string, model: string, fallback: string | null): string { return `${provider}:${model}:${fallback || "none"}`; }
function cached(key: string, nowMs: number): AiProviderHealth | null {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= nowMs) { if (entry) cache.delete(key); return null; }
  return { ...entry.value, diagnostic: `${entry.value.diagnostic}; cached=true` };
}
function putCache(key: string, value: AiProviderHealth, nowMs: number): AiProviderHealth { cache.set(key, { expiresAt: nowMs + CACHE_TTL_MS, value }); return value; }
function asOpenAIError(error: unknown): OpenAIProviderError {
  return error instanceof OpenAIProviderError ? error : new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", errorCode: "health_check_failed", retryable: false });
}
function badPayload(error: OpenAIProviderError): boolean {
  return error.code === "OPENAI_INVALID_RESPONSE" && (error.errorParam === "input" || /invalid[_-]?value|invalid[_-]?request/i.test(String(error.errorCode || "")));
}

async function runOpenAIConnectivityProbe(input: { call: OpenAICall; apiKey: string; model: string; timeoutMs: number }): Promise<void> {
  const payload = await input.call({ apiKey: input.apiKey, timeoutMs: input.timeoutMs, maxAttempts: 1, singleFlightKey: `openai-provider-health:text:${input.model}`, request: { model: input.model, store: false, max_output_tokens: 16, input: "Reply with exactly OK." } });
  if (!/ok/i.test(extractOpenAIOutputText(payload))) throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "connectivity_probe_invalid", retryable: false });
}

async function runOpenAIStructuredProbe(input: { call: OpenAICall; apiKey: string; model: string; timeoutMs: number }): Promise<void> {
  const payload = await input.call({
    apiKey: input.apiKey, timeoutMs: input.timeoutMs, maxAttempts: 1, singleFlightKey: `openai-provider-health:structured:${input.model}`,
    request: {
      model: input.model, store: false, max_output_tokens: 48, input: "Return a health object with ok=true.",
      text: { format: { type: "json_schema", name: "cerberus_openai_structured_health", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
    },
  });
  if (!isHealthyPayload(parseOpenAIOutput(payload))) throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "structured_probe_invalid", retryable: false });
}

async function runOpenAIVisionProbe(input: { call: OpenAICall; apiKey: string; model: string; timeoutMs: number }): Promise<void> {
  const payload = await input.call({
    apiKey: input.apiKey, timeoutMs: input.timeoutMs, maxAttempts: 1, singleFlightKey: `openai-provider-health:vision:${input.model}`,
    request: { model: input.model, store: false, max_output_tokens: 24, input: [{ role: "user", content: [
      { type: "input_text", text: "This is a health canary. Reply only with IMAGE_OK if the attached PNG is readable." },
      { type: "input_image", image_url: `data:image/png;base64,${OPENAI_VISION_CANARY_PNG_BASE64}`, detail: "low" },
    ] }] },
  });
  if (!/image_ok/i.test(extractOpenAIOutputText(payload))) throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "vision_probe_invalid", retryable: false });
}

export async function checkOpenAIVisualProviderHealth(options: { env?: NodeJS.ProcessEnv; call?: OpenAICall; now?: () => number; force?: boolean } = {}): Promise<AiProviderHealth> {
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
  const timeoutMs = positiveInt(env.OPENAI_PROVIDER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  if (!options.force) { const found = cached(key, start); if (found) return found; }
  if (!enabled) return baseHealth({ provider: "OpenAI", configured: Boolean(apiKey), enabled, model, fallbackModel, status: "disabled", checkedAt, latencyMs: now() - start, diagnostic: "OpenAI visual review disabled by configuration", state: "OPENAI_CONFIG_MISSING" });
  if (!apiKey) return baseHealth({ provider: "OpenAI", configured: false, enabled, model, fallbackModel, status: "not_configured", checkedAt, latencyMs: now() - start, diagnostic: "OPENAI_API_KEY not configured", state: "OPENAI_CONFIG_MISSING" });

  const call = options.call || callOpenAIResponses;
  let effectiveModel: string | null = null;
  let primaryFailure: OpenAIProviderError | null = null;
  try {
    await runOpenAIConnectivityProbe({ call, apiKey, model, timeoutMs });
    effectiveModel = model;
  } catch (error) {
    primaryFailure = asOpenAIError(error);
    if (badPayload(primaryFailure)) return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel: null, status: "invalid_response", state: "OPENAI_BAD_HEALTH_PAYLOAD", httpStatus: primaryFailure.httpStatus, errorCode: primaryFailure.errorCode || primaryFailure.code, errorParam: primaryFailure.errorParam, latencyMs: now() - start, checkedAt, diagnostic: "OpenAI connectivity probe payload rejected", probes: { connectivity: "failed", structuredOutput: "not_run", vision: "not_run" } }, start);
    if (fallbackModel && ["OPENAI_MODEL_UNAVAILABLE", "OPENAI_INVALID_RESPONSE"].includes(primaryFailure.code)) {
      try { await runOpenAIConnectivityProbe({ call, apiKey, model: fallbackModel, timeoutMs }); effectiveModel = fallbackModel; }
      catch (fallbackError) {
        const failure = asOpenAIError(fallbackError);
        return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel: null, status: mapOpenAIStatus(failure.code), state: badPayload(failure) ? "OPENAI_BAD_HEALTH_PAYLOAD" : "OPENAI_PROVIDER_DOWN", httpStatus: failure.httpStatus, errorCode: failure.errorCode || failure.code, errorParam: failure.errorParam, latencyMs: now() - start, checkedAt, diagnostic: `OpenAI primary and fallback connectivity failed: ${failure.code}`, probes: { connectivity: "failed", structuredOutput: "not_run", vision: "not_run" } }, start);
      }
    } else return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel: null, status: mapOpenAIStatus(primaryFailure.code), state: "OPENAI_PROVIDER_DOWN", httpStatus: primaryFailure.httpStatus, errorCode: primaryFailure.errorCode || primaryFailure.code, errorParam: primaryFailure.errorParam, latencyMs: now() - start, checkedAt, diagnostic: `OpenAI connectivity failed: ${primaryFailure.code}`, probes: { connectivity: "failed", structuredOutput: "not_run", vision: "not_run" } }, start);
  }

  if (!effectiveModel) return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel: null, status: "provider_unavailable", state: "OPENAI_PROVIDER_DOWN", httpStatus: null, errorCode: "OPENAI_PROVIDER_DOWN", errorParam: null, latencyMs: now() - start, checkedAt, diagnostic: "OpenAI connectivity did not resolve an effective model", probes: { connectivity: "failed", structuredOutput: "not_run", vision: "not_run" } }, start);

  try { await runOpenAIStructuredProbe({ call, apiKey, model: effectiveModel, timeoutMs }); }
  catch (error) {
    const failure = asOpenAIError(error);
    return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel, status: "invalid_response", state: badPayload(failure) ? "OPENAI_BAD_HEALTH_PAYLOAD" : "OPENAI_STRUCTURED_OUTPUT_FAILED", httpStatus: failure.httpStatus, errorCode: failure.errorCode || failure.code, errorParam: failure.errorParam, latencyMs: now() - start, checkedAt, diagnostic: `OpenAI text connectivity OK; structured-output canary failed: ${failure.code}`, probes: { connectivity: "ok", structuredOutput: "failed", vision: "not_run" } }, start);
  }

  try { await runOpenAIVisionProbe({ call, apiKey, model: effectiveModel, timeoutMs }); }
  catch (error) {
    const failure = asOpenAIError(error);
    return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel, status: "invalid_response", state: badPayload(failure) ? "OPENAI_BAD_HEALTH_PAYLOAD" : "OPENAI_VISION_CANARY_FAILED", httpStatus: failure.httpStatus, errorCode: failure.errorCode || failure.code, errorParam: failure.errorParam, latencyMs: now() - start, checkedAt, diagnostic: `OpenAI connectivity and structured output OK; vision canary failed: ${failure.code}`, probes: { connectivity: "ok", structuredOutput: "ok", vision: "failed" } }, start);
  }

  const fallbackUsed = effectiveModel !== model;
  return putCache(key, { provider: "OpenAI", configured: true, enabled: true, model, fallbackModel, effectiveModel, status: fallbackUsed ? "model_unavailable" : "healthy", state: fallbackUsed ? "OPENAI_PRIMARY_DOWN_FALLBACK_OK" : "OPENAI_OK", httpStatus: 200, errorCode: fallbackUsed ? primaryFailure?.errorCode || primaryFailure?.code || "OPENAI_PRIMARY_UNAVAILABLE" : null, errorParam: fallbackUsed ? primaryFailure?.errorParam || null : null, latencyMs: now() - start, checkedAt, diagnostic: fallbackUsed ? "OpenAI primary connectivity failed; fallback passed text, structured-output and vision canaries" : "OpenAI text, structured-output and vision canaries passed", probes: { connectivity: "ok", structuredOutput: "ok", vision: "ok" } }, start);
}

export async function checkGeminiVisualProviderHealth(options: { env?: NodeJS.ProcessEnv; generate?: GeminiGenerate; now?: () => number; force?: boolean } = {}): Promise<AiProviderHealth> {
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
  if (!options.force) { const found = cached(key, start); if (found) return found; }
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
        generate({ model: candidateModel, request: { contents: [{ role: "user", parts: [{ text: "Return ok=true after confirming this image input is readable." }, { inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG_BASE64 } }] }], config: { responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ["ok"] } } } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("GEMINI_PROVIDER_HEALTH_TIMEOUT")), positiveInt(env.GEMINI_PROVIDER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))),
      ]);
      const parsed = JSON.parse(String(response.text || "{}"));
      if (!isHealthyPayload(parsed)) throw new Error("GEMINI_INVALID_RESPONSE");
      return putCache(key, { provider: "Gemini", configured: true, enabled: true, model, fallbackModel, effectiveModel: candidateModel, status: "healthy", httpStatus: 200, errorCode: null, errorParam: null, latencyMs: now() - start, checkedAt, diagnostic: candidateModel === model ? "primary visual model healthy" : "fallback visual model healthy" }, start);
    } catch (error) {
      lastFailure = classifyGeminiFailure(error);
      if (!["model_unavailable", "invalid_response"].includes(lastFailure.status)) break;
    }
  }
  const failure = lastFailure || { status: "provider_unavailable" as const, errorCode: "GEMINI_PROVIDER_UNAVAILABLE", httpStatus: null };
  return putCache(key, { provider: "Gemini", configured: true, enabled: true, model, fallbackModel, effectiveModel: null, status: failure.status, httpStatus: failure.httpStatus, errorCode: failure.errorCode, errorParam: null, latencyMs: now() - start, checkedAt, diagnostic: `Gemini visual provider classified as ${failure.errorCode}` }, start);
}

export const aiProviderHealthInternals = {
  ONE_PIXEL_PNG_BASE64,
  OPENAI_VISION_CANARY_PNG_BASE64,
  enabledUnlessFalse,
  safeModel,
  classifyGeminiFailure,
  extractOpenAIOutputText,
  parseOpenAIOutput,
  isHealthyPayload,
  badPayload,
  runOpenAIConnectivityProbe,
  runOpenAIStructuredProbe,
  runOpenAIVisionProbe,
  resetCache: () => cache.clear(),
};