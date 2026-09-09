import { GoogleGenAI, Type } from "@google/genai";
import {
  callOpenAIHealthProbe,
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

export type OpenAICanaryResult = {
  status: "ok" | "failed" | "not_run";
  model: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorParam: string | null;
};

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
  /** Diagnóstico estável do Operator; presente no provider OpenAI. */
  state?: OpenAIHealthState;
  /** Probes independentes para não confundir falha de feature com indisponibilidade. */
  canaries?: {
    connectivity: OpenAICanaryResult;
    structuredOutput: OpenAICanaryResult;
    vision: OpenAICanaryResult;
  };
};

type OpenAICall = typeof callOpenAIResponses;
type GeminiGenerate = (input: { model: string; request: Record<string, unknown> }) => Promise<{ text?: string | null }>;

// Fixture 128x128 válida com contraste/formas suficientes para um canary de
// visão realista. O antigo pixel 1x1 fazia o probe testar um payload artificial.
const VISION_CANARY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAALVBMVEX18ej08Oby7eLt5djl2cbax6+vn4+di3qFc2NsWEhiTT1bRjbc0MDHuqrg0bwpDizMAAADu0lEQVR42u2Y27bqIAxFowSqLfL/n3uAAg3YS1Lr9jwQx2ghhJXJpVgF+LXdbuA//prK0Xb8cHX87cfWAf4TgLv/3O73ey5mq/33Df9H8XD/sXWADtABOkAH6AARQDVO5a2Ui+u9M3Xm4lr8nj5Qh2oCVCkrVXzVlcZlTx1/pA/+qlJ86roIKUXGoqqkqo3L/jb+SB8WXhKgGuElZZOuBUi1Kn5fH8pU1SMk9Xr1yEQrKkwXoF7tfX1QcptlUZvh8Ryn8fkYjMYTOtHOAHizZpxqG439OwAzrZv5G4Ct9OcQxACvad9eXwYYpiMbvgmAz8P80/QUPREiAGSkDyYhkADgyAQYBQQSgAcz/zQ9vgJwtP/PPQt8AO4GEG4DPoARAbBPJD6AKP80XQ6ghQD6agDZCvDXgA3AfwZn4z6JbADuIZRtFAEgYrkqWlpcwvz1LtzRjwBIIut69pydAVRH+tCMt5AmX2pDFO8BLAl39aG453DM9Zw4E4ifgjLYff0AoEiAyvUCm8LF50BJs68PMQFiNU3tRMWSEABzvwN9yCNc6KinTIN0DYwiuff0oTTlYJx3ac0crtIJaFJv6MOyzxHJTNGOSUgyBaaZ6m19aMeKdNBlCmNF9EbUzuCWPqDA+O+EfBMBWCaA/RYAWtbvAkl+IQAi45eRTFAKgIe/DYV6YoD9x9GI1U4AoDWXpT8H4E2v/EOiTymdBAjz8DJ5Rw7mJdr51wAESwCfSHSADtABOsDvAeIZmg9Su5youWiJL8RV8e8AVtTft4GNETnMvgm0pSq+ANiantvf36HtmOu2Qn1vaWfAkjGz+2PcA23owmgtbSu1xUcBLJl0bv8MECrO5fzOvS9IDKhWNcbnt2BLZCX9MW7CuRi72XD3pTnWS6HLIsE/pyDxBABdkHZO1N+3gYvFlNhadMkiaSrbVIx3Gl8Agj9mdKL+4SmoA9yGEQF6pwC7ttHfX6F1OnK3K+VyD5cEsNKfXovAGgS4T4wAnLUOwAfQhvPLdLan0ZcDiP+muxhAmp9NwASQ/ksYjLcKTIDjvwXOTgETgL//yE68EuBEfubT2QE6QAcA7dKJVQ4u7W0J0B8CvJ+HtT64VA233NCU9ScHkV709Zo+1AEUZvGf+S6apmEFQLtWH2gaOjnUf/7LqB7Gmn4EmHl0mSbdAPiWk1/Hpf+mPuhqfUhQ7pDaxS8kZE2rxW30IU8NWZ8aoLQPgleyQS9WbcBdgLZTA/CddtA/tg7QATpAB+gAHaADdIAO0AE6wD+4f4Px97pV8AAAAABJRU5ErkJggg==";
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

function normalizeOpenAIError(error: unknown): OpenAIProviderError {
  if (error instanceof OpenAIProviderError) return error;
  if (error instanceof Error && error.message === "OPENAI_PROVIDER_HEALTH_EMPTY_OUTPUT") {
    return new OpenAIProviderError({
      code: "OPENAI_INVALID_RESPONSE",
      httpStatus: 200,
      errorCode: "health_output_invalid",
      retryable: false,
    });
  }
  return new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", errorCode: "health_check_failed", retryable: false });
}

function canaryFailure(error: OpenAIProviderError, model: string | null): OpenAICanaryResult {
  return {
    status: "failed",
    model,
    httpStatus: error.httpStatus,
    errorCode: error.errorCode || error.code,
    errorParam: error.errorParam,
  };
}

function canaryOk(model: string): OpenAICanaryResult {
  return { status: "ok", model, httpStatus: 200, errorCode: null, errorParam: null };
}

function canaryNotRun(): OpenAICanaryResult {
  return { status: "not_run", model: null, httpStatus: null, errorCode: null, errorParam: null };
}

function isBadHealthPayload(error: OpenAIProviderError): boolean {
  if (error.code !== "OPENAI_INVALID_RESPONSE") return false;
  return error.httpStatus === 400
    || error.errorParam === "input"
    || ["invalid_value", "invalid_request_error", "health_payload_invalid", "health_output_invalid"].includes(String(error.errorCode || ""));
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
  if (!apiKey) return {
    ...baseHealth({ provider: "OpenAI", configured: false, enabled, model, fallbackModel, status: "not_configured", checkedAt, latencyMs: now() - start, diagnostic: "OPENAI_CONFIG_MISSING" }),
    state: "OPENAI_CONFIG_MISSING",
    canaries: { connectivity: canaryNotRun(), structuredOutput: canaryNotRun(), vision: canaryNotRun() },
  };

  const call: OpenAICall = options.call || (input => callOpenAIHealthProbe(input));
  const timeoutMs = positiveInt(env.OPENAI_PROVIDER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  let lastError: OpenAIProviderError | null = null;
  let effectiveModel: string | null = null;
  let fallbackUsed = false;
  let connectivity: OpenAICanaryResult = canaryNotRun();

  // A. Conectividade: somente texto, sem JSON Schema e sem imagem.
  for (const candidateModel of [model, fallbackModel].filter((item): item is string => Boolean(item))) {
    try {
      const payload = await call({
        apiKey,
        timeoutMs,
        maxAttempts: 1,
        singleFlightKey: `openai-provider-connectivity:${candidateModel}`,
        request: {
          model: candidateModel,
          store: false,
          max_output_tokens: 64,
          input: "Reply with OK.",
        },
      });
      if (!extractOpenAIOutputText(payload)) {
        throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "health_output_invalid", retryable: false });
      }
      effectiveModel = candidateModel;
      fallbackUsed = candidateModel !== model;
      connectivity = canaryOk(candidateModel);
      break;
    } catch (error) {
      lastError = normalizeOpenAIError(error);
      connectivity = canaryFailure(lastError, candidateModel);
      // Fallback só é uma evidência útil quando a falha é específica do modelo.
      if (candidateModel === model && fallbackModel && lastError.code === "OPENAI_MODEL_UNAVAILABLE") continue;
      break;
    }
  }

  if (!effectiveModel) {
    const failure = lastError || new OpenAIProviderError({ code: "OPENAI_PROVIDER_UNAVAILABLE", retryable: false });
    const state: OpenAIHealthState = isBadHealthPayload(failure) ? "OPENAI_BAD_HEALTH_PAYLOAD" : "OPENAI_PROVIDER_DOWN";
    return putCache(key, {
      provider: "OpenAI", configured: true, enabled, model, fallbackModel, effectiveModel: null,
      status: mapOpenAIStatus(failure.code), httpStatus: failure.httpStatus,
      errorCode: failure.errorCode || failure.code, errorParam: failure.errorParam,
      latencyMs: now() - start, checkedAt, diagnostic: state, state,
      canaries: { connectivity, structuredOutput: canaryNotRun(), vision: canaryNotRun() },
    }, start);
  }

  // B. Structured output: isolado para que erro de schema não derrube provider.
  let structuredOutput: OpenAICanaryResult;
  try {
    const payload = await call({
      apiKey, timeoutMs, maxAttempts: 1,
      singleFlightKey: `openai-provider-structured:${effectiveModel}`,
      request: {
        model: effectiveModel, store: false, max_output_tokens: 128,
        input: "Return an object with ok set to true.",
        text: { format: { type: "json_schema", name: "cerberus_health", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
      },
    });
    if (!isHealthyPayload(parseOpenAIOutput(payload))) {
      throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "health_output_invalid", retryable: false });
    }
    structuredOutput = canaryOk(effectiveModel);
  } catch (error) {
    structuredOutput = canaryFailure(normalizeOpenAIError(error), effectiveModel);
  }

  // C. Visão: fixture PNG real e request textual simples, sem structured output.
  let vision: OpenAICanaryResult = canaryNotRun();
  if (enabled) {
    try {
      const payload = await call({
        apiKey, timeoutMs, maxAttempts: 1,
        singleFlightKey: `openai-provider-vision:${effectiveModel}`,
        request: {
          model: effectiveModel, store: false, max_output_tokens: 64,
          input: [{ role: "user", content: [
            { type: "input_text", text: "Reply with OK if the image is readable." },
            { type: "input_image", image_url: `data:image/png;base64,${VISION_CANARY_PNG_BASE64}`, detail: "low" },
          ] }],
        },
      });
      if (!extractOpenAIOutputText(payload)) {
        throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 200, errorCode: "health_output_invalid", retryable: false });
      }
      vision = canaryOk(effectiveModel);
    } catch (error) {
      vision = canaryFailure(normalizeOpenAIError(error), effectiveModel);
    }
  }

  const state: OpenAIHealthState = structuredOutput.status === "failed"
    ? "OPENAI_STRUCTURED_OUTPUT_FAILED"
    : vision.status === "failed"
      ? "OPENAI_VISION_CANARY_FAILED"
      : fallbackUsed
        ? "OPENAI_PRIMARY_DOWN_FALLBACK_OK"
        : "OPENAI_OK";
  const featureFailure = structuredOutput.status === "failed" ? structuredOutput : vision.status === "failed" ? vision : null;
  return putCache(key, {
    provider: "OpenAI", configured: true, enabled, model, fallbackModel, effectiveModel,
    status: featureFailure ? "invalid_response" : "healthy",
    httpStatus: featureFailure?.httpStatus ?? 200,
    errorCode: featureFailure?.errorCode ?? null,
    errorParam: featureFailure?.errorParam ?? null,
    latencyMs: now() - start, checkedAt, diagnostic: state, state,
    canaries: { connectivity, structuredOutput, vision },
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
              { inlineData: { mimeType: "image/png", data: VISION_CANARY_PNG_BASE64 } },
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
  VISION_CANARY_PNG_BASE64,
  enabledUnlessFalse,
  safeModel,
  classifyGeminiFailure,
  parseOpenAIOutput,
  extractOpenAIOutputText,
  isBadHealthPayload,
  isHealthyPayload,
  resetCache: () => cache.clear(),
};
