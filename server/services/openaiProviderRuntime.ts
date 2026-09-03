import { createHash } from "node:crypto";

export type OpenAIProviderErrorCode =
  | "OPENAI_RATE_LIMITED"
  | "OPENAI_QUOTA_EXHAUSTED"
  | "OPENAI_AUTH_ERROR"
  | "OPENAI_MODEL_UNAVAILABLE"
  | "OPENAI_TIMEOUT"
  | "OPENAI_PROVIDER_UNAVAILABLE"
  | "OPENAI_INVALID_RESPONSE";

export type OpenAIProviderErrorDetails = {
  code: OpenAIProviderErrorCode;
  httpStatus: number | null;
  errorCode: string | null;
  errorParam: string | null;
  retryAfterMs: number | null;
  retryable: boolean;
};

export class OpenAIProviderRuntimeError extends Error {
  readonly code: OpenAIProviderErrorCode;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly errorParam: string | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(details: OpenAIProviderErrorDetails) {
    super(details.code);
    this.name = "OpenAIProviderRuntimeError";
    this.code = details.code;
    this.httpStatus = details.httpStatus;
    this.errorCode = details.errorCode;
    this.errorParam = details.errorParam;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = details.retryable;
  }
}

export type OpenAIResponsesCallOptions = {
  apiKey: string;
  request: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrency?: number;
  dedupeKey?: string;
  delayImpl?: (ms: number) => Promise<void>;
  jitterImpl?: (maxExclusive: number) => number;
  nowImpl?: () => number;
  endpoint?: string;
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

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
const QUOTA_CIRCUIT_COOLDOWN_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 10_000;

const singleFlight = new Map<string, Promise<unknown>>();
let activeRequests = 0;
const waiters: Array<() => void> = [];
let configuredConcurrency = DEFAULT_MAX_CONCURRENCY;
let circuitOpenUntil = 0;
let circuitReason: OpenAIProviderErrorCode | null = null;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function safeErrorScalar(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maxLength) return null;
  return /^[a-zA-Z0-9_.\[\]-]+$/.test(normalized) ? normalized.toLowerCase() : null;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_BACKOFF_MS, Math.ceil(seconds * 1_000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(MAX_BACKOFF_MS, Math.max(0, timestamp - now));
}

function classifyHttpFailure(input: {
  httpStatus: number;
  errorCode: string | null;
  errorParam: string | null;
  retryAfterMs: number | null;
}): OpenAIProviderRuntimeError {
  const { httpStatus, errorCode, errorParam, retryAfterMs } = input;
  if (httpStatus === 401 || httpStatus === 403) {
    return new OpenAIProviderRuntimeError({ code: "OPENAI_AUTH_ERROR", httpStatus, errorCode, errorParam, retryAfterMs, retryable: false });
  }
  if (httpStatus === 404) {
    return new OpenAIProviderRuntimeError({ code: "OPENAI_MODEL_UNAVAILABLE", httpStatus, errorCode, errorParam, retryAfterMs, retryable: false });
  }
  if (httpStatus === 408) {
    return new OpenAIProviderRuntimeError({ code: "OPENAI_TIMEOUT", httpStatus, errorCode, errorParam, retryAfterMs, retryable: true });
  }
  if (httpStatus === 429) {
    const quota = Boolean(errorCode && QUOTA_ERROR_CODES.has(errorCode));
    return new OpenAIProviderRuntimeError({
      code: quota ? "OPENAI_QUOTA_EXHAUSTED" : "OPENAI_RATE_LIMITED",
      httpStatus,
      errorCode,
      errorParam,
      retryAfterMs,
      retryable: !quota,
    });
  }
  if (httpStatus >= 500) {
    return new OpenAIProviderRuntimeError({ code: "OPENAI_PROVIDER_UNAVAILABLE", httpStatus, errorCode, errorParam, retryAfterMs, retryable: true });
  }
  return new OpenAIProviderRuntimeError({ code: "OPENAI_INVALID_RESPONSE", httpStatus, errorCode, errorParam, retryAfterMs, retryable: false });
}

async function parseFailure(response: Response, now: number): Promise<OpenAIProviderRuntimeError> {
  let errorCode: string | null = null;
  let errorParam: string | null = null;
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown; param?: unknown } };
    errorCode = safeErrorScalar(parsed?.error?.code, 80) || safeErrorScalar(parsed?.error?.type, 80);
    errorParam = safeErrorScalar(parsed?.error?.param, 120);
  } catch {
    // HTTP status is sufficient to classify safely. Provider payloads are never logged here.
  }
  return classifyHttpFailure({
    httpStatus: response.status,
    errorCode,
    errorParam,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now),
  });
}

function requestFingerprint(request: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function acquireSlot(limit: number): Promise<void> {
  configuredConcurrency = Math.max(1, limit);
  if (activeRequests < configuredConcurrency) {
    activeRequests += 1;
    return;
  }
  await new Promise<void>(resolve => waiters.push(resolve));
  activeRequests += 1;
}

function releaseSlot(): void {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiters.shift();
  if (next) next();
}

function openCircuit(reason: OpenAIProviderErrorCode, now: number): void {
  const cooldown = reason === "OPENAI_QUOTA_EXHAUSTED" ? QUOTA_CIRCUIT_COOLDOWN_MS : DEFAULT_CIRCUIT_COOLDOWN_MS;
  circuitOpenUntil = Math.max(circuitOpenUntil, now + cooldown);
  circuitReason = reason;
}

function circuitError(now: number): OpenAIProviderRuntimeError | null {
  if (circuitOpenUntil <= now) {
    circuitOpenUntil = 0;
    circuitReason = null;
    return null;
  }
  return new OpenAIProviderRuntimeError({
    code: circuitReason || "OPENAI_PROVIDER_UNAVAILABLE",
    httpStatus: null,
    errorCode: circuitReason === "OPENAI_QUOTA_EXHAUSTED" ? "quota_exhausted" : "circuit_open",
    errorParam: null,
    retryAfterMs: circuitOpenUntil - now,
    retryable: false,
  });
}

function retryDelayMs(error: OpenAIProviderRuntimeError, retryIndex: number, jitterImpl: (maxExclusive: number) => number): number {
  if (error.retryAfterMs !== null) return error.retryAfterMs;
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.max(0, retryIndex - 1)));
  const jitter = Math.max(0, Math.min(500, Math.floor(jitterImpl(501))));
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

async function executeCall(options: OpenAIResponsesCallOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl || fetch;
  const nowImpl = options.nowImpl || Date.now;
  const delayImpl = options.delayImpl || delay;
  const jitterImpl = options.jitterImpl || (max => Math.floor(Math.random() * Math.max(1, max)));
  const timeoutMs = positiveInt(options.timeoutMs ?? process.env.OPENAI_PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120_000);
  const maxRetries = positiveInt(options.maxRetries ?? process.env.OPENAI_PROVIDER_MAX_RETRIES, DEFAULT_MAX_RETRIES, 6);
  const maxConcurrency = positiveInt(options.maxConcurrency ?? process.env.OPENAI_PROVIDER_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 16);
  const endpoint = options.endpoint || "https://api.openai.com/v1/responses";

  const open = circuitError(nowImpl());
  if (open) throw open;

  await acquireSlot(maxConcurrency);
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const beforeAttemptCircuit = circuitError(nowImpl());
      if (beforeAttemptCircuit) throw beforeAttemptCircuit;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure: OpenAIProviderRuntimeError | null = null;
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "CerberusFinds/1.0",
          },
          body: JSON.stringify(options.request),
          signal: controller.signal,
        });
        if (!response.ok) {
          failure = await parseFailure(response, nowImpl());
        } else {
          try {
            return await response.json();
          } catch {
            throw new OpenAIProviderRuntimeError({
              code: "OPENAI_INVALID_RESPONSE",
              httpStatus: response.status,
              errorCode: "invalid_json",
              errorParam: null,
              retryAfterMs: null,
              retryable: false,
            });
          }
        }
      } catch (error) {
        if (error instanceof OpenAIProviderRuntimeError) failure = error;
        else if (error instanceof Error && error.name === "AbortError") {
          failure = new OpenAIProviderRuntimeError({ code: "OPENAI_TIMEOUT", httpStatus: null, errorCode: "timeout", errorParam: null, retryAfterMs: null, retryable: true });
        } else {
          failure = new OpenAIProviderRuntimeError({ code: "OPENAI_PROVIDER_UNAVAILABLE", httpStatus: null, errorCode: "network_error", errorParam: null, retryAfterMs: null, retryable: true });
        }
      } finally {
        clearTimeout(timer);
      }

      if (!failure) throw new OpenAIProviderRuntimeError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: null, errorCode: "unknown", errorParam: null, retryAfterMs: null, retryable: false });
      if (failure.code === "OPENAI_QUOTA_EXHAUSTED") {
        openCircuit(failure.code, nowImpl());
        throw failure;
      }
      if (!failure.retryable) {
        if (["OPENAI_AUTH_ERROR", "OPENAI_MODEL_UNAVAILABLE"].includes(failure.code)) openCircuit(failure.code, nowImpl());
        throw failure;
      }
      if (attempt >= maxRetries) {
        openCircuit(failure.code, nowImpl());
        throw failure;
      }
      await delayImpl(retryDelayMs(failure, attempt + 1, jitterImpl));
    }
    throw new OpenAIProviderRuntimeError({ code: "OPENAI_PROVIDER_UNAVAILABLE", httpStatus: null, errorCode: "retry_exhausted", errorParam: null, retryAfterMs: null, retryable: false });
  } finally {
    releaseSlot();
  }
}

export async function callOpenAIResponses(options: OpenAIResponsesCallOptions): Promise<unknown> {
  if (!options.apiKey.trim()) {
    throw new OpenAIProviderRuntimeError({ code: "OPENAI_AUTH_ERROR", httpStatus: null, errorCode: "not_configured", errorParam: null, retryAfterMs: null, retryable: false });
  }
  const key = options.dedupeKey || requestFingerprint(options.request);
  const existing = singleFlight.get(key);
  if (existing) return existing;
  const promise = executeCall(options).finally(() => singleFlight.delete(key));
  singleFlight.set(key, promise);
  return promise;
}

export function getOpenAIProviderRuntimeHealth(now = Date.now()) {
  const remainingMs = Math.max(0, circuitOpenUntil - now);
  return {
    status: remainingMs > 0 ? "circuit_open" as const : "ready" as const,
    circuitReason,
    circuitOpenUntil: remainingMs > 0 ? new Date(circuitOpenUntil).toISOString() : null,
    retryAfterMs: remainingMs || null,
    activeRequests,
    queuedRequests: waiters.length,
    singleFlightRequests: singleFlight.size,
    maxConcurrency: configuredConcurrency,
  };
}

export const openAIProviderRuntimeInternals = {
  QUOTA_ERROR_CODES,
  parseRetryAfter,
  classifyHttpFailure,
  requestFingerprint,
  retryDelayMs,
  resetForTests() {
    singleFlight.clear();
    waiters.splice(0, waiters.length);
    activeRequests = 0;
    configuredConcurrency = DEFAULT_MAX_CONCURRENCY;
    circuitOpenUntil = 0;
    circuitReason = null;
  },
};
