import { createHash } from "node:crypto";

export type OpenAIProviderFailureCode =
  | "OPENAI_RATE_LIMITED"
  | "OPENAI_QUOTA_EXHAUSTED"
  | "OPENAI_AUTH_ERROR"
  | "OPENAI_MODEL_UNAVAILABLE"
  | "OPENAI_TIMEOUT"
  | "OPENAI_PROVIDER_UNAVAILABLE"
  | "OPENAI_INVALID_RESPONSE";

export type OpenAIProviderHealthStatus =
  | "ok"
  | "not_configured"
  | "disabled"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_error"
  | "model_unavailable"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response";

export class OpenAIProviderError extends Error {
  readonly code: OpenAIProviderFailureCode;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly errorParam: string | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(input: {
    code: OpenAIProviderFailureCode;
    httpStatus?: number | null;
    errorCode?: string | null;
    errorParam?: string | null;
    retryAfterMs?: number | null;
    retryable?: boolean;
  }) {
    super(input.code);
    this.name = "OpenAIProviderError";
    this.code = input.code;
    this.httpStatus = input.httpStatus ?? null;
    this.errorCode = input.errorCode ?? null;
    this.errorParam = input.errorParam ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.retryable = input.retryable === true;
  }
}

type DelayImpl = (ms: number) => Promise<void>;
type RuntimeOptions = {
  apiKey: string;
  request: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  delayImpl?: DelayImpl;
  randomImpl?: () => number;
  maxAttempts?: number;
  maxConcurrency?: number;
  singleFlightKey?: string;
  now?: () => number;
};

type CircuitState = {
  until: number;
  error: OpenAIProviderError;
};

type RuntimeHealth = {
  status: OpenAIProviderHealthStatus;
  httpStatus: number | null;
  errorCode: string | null;
  errorParam: string | null;
  updatedAt: string;
};

const QUOTA_ERROR_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "project_usage_limit_exceeded",
]);

const singleFlight = new Map<string, Promise<unknown>>();
const circuits = new Map<string, CircuitState>();
let activeCalls = 0;
const concurrencyWaiters: Array<() => void> = [];
let lastHealth: RuntimeHealth | null = null;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function safeErrorScalar(value: unknown, max = 80): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9_.-]+$/.test(normalized) && normalized.length <= max ? normalized : null;
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function parseErrorBody(value: string): { code: string | null; param: string | null } {
  try {
    const parsed = JSON.parse(value) as { error?: { code?: unknown; type?: unknown; param?: unknown } };
    return {
      code: safeErrorScalar(parsed?.error?.code) || safeErrorScalar(parsed?.error?.type),
      param: safeErrorScalar(parsed?.error?.param),
    };
  } catch {
    return { code: null, param: null };
  }
}

function classifyHttpFailure(input: {
  status: number;
  body: string;
  retryAfter: string | null;
  nowMs: number;
}): OpenAIProviderError {
  const parsed = parseErrorBody(input.body);
  const retryAfterMs = parseRetryAfter(input.retryAfter, input.nowMs);
  if (parsed.code && QUOTA_ERROR_CODES.has(parsed.code)) {
    return new OpenAIProviderError({
      code: "OPENAI_QUOTA_EXHAUSTED",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryAfterMs,
      retryable: false,
    });
  }
  if (input.status === 429) {
    return new OpenAIProviderError({
      code: "OPENAI_RATE_LIMITED",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryAfterMs,
      retryable: true,
    });
  }
  if (input.status === 401 || input.status === 403) {
    return new OpenAIProviderError({
      code: "OPENAI_AUTH_ERROR",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryable: false,
    });
  }
  if (input.status === 404) {
    return new OpenAIProviderError({
      code: "OPENAI_MODEL_UNAVAILABLE",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryable: false,
    });
  }
  if (input.status === 408) {
    return new OpenAIProviderError({
      code: "OPENAI_TIMEOUT",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryable: true,
    });
  }
  if (input.status >= 500) {
    return new OpenAIProviderError({
      code: "OPENAI_PROVIDER_UNAVAILABLE",
      httpStatus: input.status,
      errorCode: parsed.code,
      errorParam: parsed.param,
      retryable: true,
    });
  }
  return new OpenAIProviderError({
    code: "OPENAI_INVALID_RESPONSE",
    httpStatus: input.status,
    errorCode: parsed.code,
    errorParam: parsed.param,
    retryable: false,
  });
}

function healthStatus(error: OpenAIProviderError): OpenAIProviderHealthStatus {
  switch (error.code) {
    case "OPENAI_RATE_LIMITED": return "rate_limited";
    case "OPENAI_QUOTA_EXHAUSTED": return "quota_exhausted";
    case "OPENAI_AUTH_ERROR": return "auth_error";
    case "OPENAI_MODEL_UNAVAILABLE": return "model_unavailable";
    case "OPENAI_TIMEOUT": return "timeout";
    case "OPENAI_PROVIDER_UNAVAILABLE": return "provider_unavailable";
    default: return "invalid_response";
  }
}

function circuitDuration(error: OpenAIProviderError): number {
  if (error.code === "OPENAI_QUOTA_EXHAUSTED") return 10 * 60 * 1000;
  if (error.code === "OPENAI_AUTH_ERROR" || error.code === "OPENAI_MODEL_UNAVAILABLE") return 5 * 60 * 1000;
  if (error.code === "OPENAI_RATE_LIMITED") return Math.max(60_000, error.retryAfterMs || 0);
  if (error.code === "OPENAI_PROVIDER_UNAVAILABLE" || error.code === "OPENAI_TIMEOUT") return 30_000;
  return 15_000;
}

function circuitKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function requestKey(request: Record<string, unknown>, apiKey: string): string {
  return `${circuitKey(apiKey)}:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
}

async function defaultDelay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireConcurrency(limit: number): Promise<void> {
  if (activeCalls < limit) {
    activeCalls += 1;
    return;
  }
  await new Promise<void>(resolve => concurrencyWaiters.push(resolve));
  activeCalls += 1;
}

function releaseConcurrency(): void {
  activeCalls = Math.max(0, activeCalls - 1);
  concurrencyWaiters.shift()?.();
}

async function fetchOnce(input: RuntimeOptions, nowMs: number): Promise<unknown> {
  const fetchImpl = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "CerberusFinds/1.0",
      },
      body: JSON.stringify(input.request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw classifyHttpFailure({
        status: response.status,
        body,
        retryAfter: response.headers.get("retry-after"),
        nowMs,
      });
    }
    try {
      return await response.json();
    } catch {
      throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: response.status, retryable: false });
    }
  } catch (error) {
    if (error instanceof OpenAIProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new OpenAIProviderError({ code: "OPENAI_TIMEOUT", retryable: true });
    }
    throw new OpenAIProviderError({ code: "OPENAI_PROVIDER_UNAVAILABLE", retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function execute(input: RuntimeOptions): Promise<unknown> {
  const now = input.now || Date.now;
  const nowMs = now();
  const key = circuitKey(input.apiKey);
  const existingCircuit = circuits.get(key);
  if (existingCircuit && existingCircuit.until > nowMs) throw existingCircuit.error;
  if (existingCircuit) circuits.delete(key);

  const maxAttempts = positiveInt(input.maxAttempts, 4, 6);
  const concurrency = positiveInt(input.maxConcurrency ?? process.env.OPENAI_GLOBAL_MAX_CONCURRENCY, 2, 8);
  const delayImpl = input.delayImpl || defaultDelay;
  const randomImpl = input.randomImpl || Math.random;
  await acquireConcurrency(concurrency);
  try {
    let lastError: OpenAIProviderError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const payload = await fetchOnce(input, now());
        lastHealth = {
          status: "ok",
          httpStatus: 200,
          errorCode: null,
          errorParam: null,
          updatedAt: new Date(now()).toISOString(),
        };
        circuits.delete(key);
        return payload;
      } catch (error) {
        const providerError = error instanceof OpenAIProviderError
          ? error
          : new OpenAIProviderError({ code: "OPENAI_PROVIDER_UNAVAILABLE", retryable: true });
        lastError = providerError;
        lastHealth = {
          status: healthStatus(providerError),
          httpStatus: providerError.httpStatus,
          errorCode: providerError.errorCode,
          errorParam: providerError.errorParam,
          updatedAt: new Date(now()).toISOString(),
        };
        if (!providerError.retryable || attempt >= maxAttempts) break;
        const exponential = 1000 * 2 ** (attempt - 1);
        const jitter = Math.floor(exponential * 0.25 * Math.max(0, Math.min(1, randomImpl())));
        const waitMs = Math.max(providerError.retryAfterMs || 0, exponential + jitter);
        await delayImpl(waitMs);
      }
    }
    const finalError = lastError || new OpenAIProviderError({ code: "OPENAI_PROVIDER_UNAVAILABLE", retryable: false });
    circuits.set(key, { until: now() + circuitDuration(finalError), error: finalError });
    throw finalError;
  } finally {
    releaseConcurrency();
  }
}

export async function callOpenAIResponses(input: RuntimeOptions): Promise<unknown> {
  if (!String(input.apiKey || "").trim()) {
    throw new OpenAIProviderError({ code: "OPENAI_AUTH_ERROR", retryable: false });
  }
  const key = input.singleFlightKey || requestKey(input.request, input.apiKey);
  const existing = singleFlight.get(key);
  if (existing) return existing;
  const operation = execute(input).finally(() => {
    if (singleFlight.get(key) === operation) singleFlight.delete(key);
  });
  singleFlight.set(key, operation);
  return operation;
}

export function getOpenAIRuntimeHealth(): RuntimeHealth | null {
  return lastHealth ? { ...lastHealth } : null;
}

export const openAIProviderRuntimeInternals = {
  QUOTA_ERROR_CODES,
  safeErrorScalar,
  parseRetryAfter,
  parseErrorBody,
  classifyHttpFailure,
  healthStatus,
  circuitDuration,
  requestKey,
  reset: () => {
    singleFlight.clear();
    circuits.clear();
    activeCalls = 0;
    concurrencyWaiters.splice(0, concurrencyWaiters.length);
    lastHealth = null;
  },
};
