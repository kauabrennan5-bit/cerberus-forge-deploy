import { createHash } from "node:crypto";

const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

export type TelegramProviderErrorCode =
  | "TELEGRAM_AUTH_ERROR"
  | "TELEGRAM_WEBHOOK_MISMATCH"
  | "TELEGRAM_PROVIDER_UNAVAILABLE"
  | "TELEGRAM_TIMEOUT"
  | "TELEGRAM_BACKEND_NOT_READY";

export class TelegramProviderError extends Error {
  readonly code: TelegramProviderErrorCode;
  readonly method: string;
  readonly httpStatus: number | null;
  readonly tokenFingerprint: string | null;

  constructor(input: {
    code: TelegramProviderErrorCode;
    method: string;
    httpStatus?: number | null;
    tokenFingerprint?: string | null;
  }) {
    super(input.code);
    this.name = "TelegramProviderError";
    this.code = input.code;
    this.method = input.method;
    this.httpStatus = input.httpStatus ?? null;
    this.tokenFingerprint = input.tokenFingerprint ?? null;
  }
}

export function getTelegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

function getTelegramApiBase(): string {
  return `https://api.telegram.org/bot${getTelegramBotToken()}`;
}

export function telegramTokenFingerprint(token = getTelegramBotToken()): string | null {
  const value = String(token || "").trim();
  if (!value) return null;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function classifyTelegramHttpFailure(status: number, description?: unknown): TelegramProviderErrorCode {
  const message = String(description || "").toLowerCase();
  if (status === 401 || status === 403 || message.includes("unauthorized")) return "TELEGRAM_AUTH_ERROR";
  return "TELEGRAM_PROVIDER_UNAVAILABLE";
}

function safeRuntimeInstance(): string | null {
  const value = process.env.RENDER_INSTANCE_ID
    || process.env.RENDER_SERVICE_ID
    || process.env.RENDER_EXTERNAL_HOSTNAME
    || process.env.HOSTNAME
    || "";
  const normalized = String(value).replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120);
  return normalized || null;
}

function logTelegramFailure(input: {
  method: string;
  code: TelegramProviderErrorCode;
  httpStatus?: number | null;
}): void {
  console.warn("[Telegram API] provider_failure", {
    operation: "telegram_bot_api",
    method: input.method,
    errorCode: input.code,
    httpStatus: input.httpStatus ?? null,
    timestamp: new Date().toISOString(),
    renderSha: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || null,
    runtimeInstance: safeRuntimeInstance(),
    tokenFingerprint: telegramTokenFingerprint(),
  });
}

/**
 * Cliente HTTP mínimo da Bot API.
 * Não conhece comandos, catálogo, reviews ou regras comerciais.
 * Falhas são registradas somente com fingerprint SHA-256 não reversível do token.
 */
export async function telegramApiFetch(
  method: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getTelegramApiBase()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      let description: unknown;
      try {
        const clone = response.clone();
        const body = await clone.json() as { description?: unknown };
        description = body?.description;
      } catch {
        description = undefined;
      }
      logTelegramFailure({
        method,
        code: classifyTelegramHttpFailure(response.status, description),
        httpStatus: response.status,
      });
    }
    return response;
  } catch (error) {
    const code: TelegramProviderErrorCode = error instanceof Error && error.name === "AbortError"
      ? "TELEGRAM_TIMEOUT"
      : "TELEGRAM_PROVIDER_UNAVAILABLE";
    logTelegramFailure({ method, code, httpStatus: null });
    throw new TelegramProviderError({
      code,
      method,
      httpStatus: null,
      tokenFingerprint: telegramTokenFingerprint(),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const telegramApiClientInternals = {
  TELEGRAM_REQUEST_TIMEOUT_MS,
  safeRuntimeInstance,
  logTelegramFailure,
};
