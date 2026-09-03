import {
  classifyTelegramHttpFailure,
  getTelegramBotToken,
  telegramApiFetch,
  TelegramProviderError,
  type TelegramProviderErrorCode,
  telegramTokenFingerprint,
} from "./telegramApiClient";

export interface TelegramWebhookDiagnostics {
  configured: boolean;
  tokenConfigured: boolean;
  whitelistConfigured: boolean;
  effectiveWhitelistConfigured: boolean;
  webhookConfigured: boolean;
  webhookMatchesExpectedUrl: boolean | null;
  webhookUrl?: string;
  expectedWebhookUrl: string;
  webhookLastError?: string;
  pendingUpdates?: number;
  allowedUpdates?: string[];
  apiHealthy: boolean;
  backendReady: boolean;
  secretConfigured: boolean;
  lastWebhookCheck: string;
  status: "healthy" | "degraded" | "down";
  errorCode?: TelegramProviderErrorCode;
  httpStatus?: number;
  failedMethod?: string;
  tokenFingerprint?: string;
}

export type TelegramWebhookReconcileResult = {
  ok: boolean;
  changed: boolean;
  expectedWebhookUrl: string;
  reason: "disabled" | "token_missing" | "secret_missing" | "already_configured" | "updated" | "provider_error";
};

const DEFAULT_BACKEND_URL = "https://cerberus-forge-deploy-backend.onrender.com";
let telegramBackendReady = false;
let lastTelegramBootstrapAt: string | undefined;
let webhookReconcileScheduled = false;

function sanitizeTelegramText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/(secret_token|token|password|api[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getExpectedTelegramWebhookUrl(): string {
  const configured = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (configured) return normalizeUrl(configured);
  const backend = (process.env.PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).trim();
  return `${normalizeUrl(backend)}/api/telegram/webhook`;
}

export function markTelegramBackendReady(): void {
  telegramBackendReady = true;
  lastTelegramBootstrapAt = new Date().toISOString();
}

export function getTelegramBootstrapStatus(): { ready: boolean; initializedAt?: string } {
  return { ready: telegramBackendReady, initializedAt: lastTelegramBootstrapAt };
}

type TelegramMethodFailure = Error & {
  status?: number;
  code?: TelegramProviderErrorCode;
  method?: string;
};

async function telegramGet(method: string): Promise<any> {
  if (!getTelegramBotToken()) {
    const error = new Error("TELEGRAM_BOT_TOKEN não configurado.") as TelegramMethodFailure;
    error.code = "TELEGRAM_AUTH_ERROR";
    error.method = method;
    throw error;
  }
  try {
    const response = await telegramApiFetch(method, {});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      const error = new Error(
        sanitizeTelegramText(payload?.description) || `Telegram API HTTP ${response.status}`,
      ) as TelegramMethodFailure;
      error.status = response.status;
      error.code = classifyTelegramHttpFailure(response.status, payload?.description);
      error.method = method;
      throw error;
    }
    return payload.result;
  } catch (error) {
    if (error instanceof TelegramProviderError) {
      const wrapped = new Error(error.code) as TelegramMethodFailure;
      wrapped.status = error.httpStatus ?? undefined;
      wrapped.code = error.code;
      wrapped.method = error.method || method;
      throw wrapped;
    }
    throw error;
  }
}

async function telegramSetWebhook(url: string, secretToken: string): Promise<void> {
  try {
    const response = await telegramApiFetch("setWebhook", {
      url,
      secret_token: secretToken,
      drop_pending_updates: false,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(
        sanitizeTelegramText(payload?.description) || `Telegram API HTTP ${response.status}`,
      ) as TelegramMethodFailure;
      error.status = response.status;
      error.code = classifyTelegramHttpFailure(response.status, payload?.description);
      error.method = "setWebhook";
      throw error;
    }
  } catch (error) {
    if (error instanceof TelegramProviderError) {
      const wrapped = new Error(error.code) as TelegramMethodFailure;
      wrapped.status = error.httpStatus ?? undefined;
      wrapped.code = error.code;
      wrapped.method = error.method || "setWebhook";
      throw wrapped;
    }
    throw error;
  }
}

function failureFields(error: unknown): Pick<TelegramWebhookDiagnostics, "errorCode" | "httpStatus" | "failedMethod" | "tokenFingerprint"> {
  const record = error && typeof error === "object" ? error as TelegramMethodFailure : undefined;
  const fingerprint = telegramTokenFingerprint();
  return {
    errorCode: record?.code || "TELEGRAM_PROVIDER_UNAVAILABLE",
    httpStatus: typeof record?.status === "number" ? record.status : undefined,
    failedMethod: record?.method,
    tokenFingerprint: fingerprint || undefined,
  };
}

export async function reconcileTelegramWebhookConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramWebhookReconcileResult> {
  const expectedWebhookUrl = getExpectedTelegramWebhookUrl();
  if (env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK !== "true") {
    return { ok: true, changed: false, expectedWebhookUrl, reason: "disabled" };
  }
  if (!getTelegramBotToken()) {
    return { ok: false, changed: false, expectedWebhookUrl, reason: "token_missing" };
  }
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || "";
  if (!secret) {
    console.warn("[Telegram] webhook_reconcile_blocked reason=secret_missing");
    return { ok: false, changed: false, expectedWebhookUrl, reason: "secret_missing" };
  }
  if (!/^https:\/\//i.test(expectedWebhookUrl)) {
    console.warn("[Telegram] webhook_reconcile_blocked reason=invalid_https_url");
    return { ok: false, changed: false, expectedWebhookUrl, reason: "provider_error" };
  }

  try {
    const current = await telegramGet("getWebhookInfo");
    const currentUrl = typeof current?.url === "string" && current.url ? normalizeUrl(current.url) : "";
    if (currentUrl === expectedWebhookUrl) {
      console.info("[Telegram] webhook_reconcile status=already_configured");
      return { ok: true, changed: false, expectedWebhookUrl, reason: "already_configured" };
    }

    await telegramSetWebhook(expectedWebhookUrl, secret);
    const verified = await telegramGet("getWebhookInfo");
    const verifiedUrl = typeof verified?.url === "string" && verified.url ? normalizeUrl(verified.url) : "";
    if (verifiedUrl !== expectedWebhookUrl) {
      console.warn("[Telegram] webhook_reconcile status=verification_mismatch");
      return { ok: false, changed: true, expectedWebhookUrl, reason: "provider_error" };
    }
    console.info("[Telegram] webhook_reconcile status=updated");
    return { ok: true, changed: true, expectedWebhookUrl, reason: "updated" };
  } catch (error) {
    const failure = failureFields(error);
    console.warn(`[Telegram] webhook_reconcile status=provider_error code=${failure.errorCode || "unknown"} method=${failure.failedMethod || "unknown"}`);
    return { ok: false, changed: false, expectedWebhookUrl, reason: "provider_error" };
  }
}

export async function getTelegramWebhookDiagnostics(): Promise<TelegramWebhookDiagnostics> {
  const now = new Date().toISOString();
  const tokenConfigured = Boolean(getTelegramBotToken());
  const whitelistValue = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
  const whitelistConfigured = whitelistValue.split(",").map(value => value.trim()).filter(Boolean).length > 0;
  const expectedWebhookUrl = getExpectedTelegramWebhookUrl();
  const tokenFingerprint = telegramTokenFingerprint() || undefined;
  const base: TelegramWebhookDiagnostics = {
    configured: tokenConfigured,
    tokenConfigured,
    whitelistConfigured,
    effectiveWhitelistConfigured: whitelistConfigured,
    webhookConfigured: false,
    webhookMatchesExpectedUrl: null,
    expectedWebhookUrl,
    apiHealthy: false,
    backendReady: telegramBackendReady,
    secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
    lastWebhookCheck: now,
    status: "down",
    tokenFingerprint,
  };

  if (!tokenConfigured) {
    return {
      ...base,
      errorCode: "TELEGRAM_AUTH_ERROR",
      webhookLastError: "Token do Telegram não configurado.",
    };
  }

  try {
    const [bot, webhook] = await Promise.all([
      telegramGet("getMe"),
      telegramGet("getWebhookInfo"),
    ]);
    const webhookUrl = typeof webhook?.url === "string" && webhook.url ? normalizeUrl(webhook.url) : undefined;
    const lastError = sanitizeTelegramText(webhook?.last_error_message);
    const webhookConfigured = Boolean(webhookUrl);
    const webhookMatchesExpectedUrl = webhookUrl ? webhookUrl === expectedWebhookUrl : false;
    const apiHealthy = Boolean(bot);
    let errorCode: TelegramProviderErrorCode | undefined;
    if (!webhookConfigured || !webhookMatchesExpectedUrl) errorCode = "TELEGRAM_WEBHOOK_MISMATCH";
    else if (!telegramBackendReady) errorCode = "TELEGRAM_BACKEND_NOT_READY";
    else if (lastError) errorCode = "TELEGRAM_PROVIDER_UNAVAILABLE";
    const healthy = apiHealthy && webhookConfigured && webhookMatchesExpectedUrl && telegramBackendReady && !lastError;
    return {
      ...base,
      configured: Boolean(bot),
      apiHealthy,
      webhookConfigured,
      webhookMatchesExpectedUrl,
      webhookUrl,
      webhookLastError: lastError,
      pendingUpdates: typeof webhook?.pending_update_count === "number" ? webhook.pending_update_count : undefined,
      allowedUpdates: Array.isArray(webhook?.allowed_updates) ? webhook.allowed_updates.map(String) : undefined,
      status: healthy ? "healthy" : apiHealthy ? "degraded" : "down",
      errorCode,
      httpStatus: 200,
    };
  } catch (error: any) {
    return {
      ...base,
      ...failureFields(error),
      status: "down",
      webhookLastError: sanitizeTelegramText(error?.message || error),
    };
  }
}

export function getTelegramWebhookStatusSnapshot(): Pick<TelegramWebhookDiagnostics, "backendReady" | "secretConfigured"> {
  return {
    backendReady: telegramBackendReady,
    secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
  };
}

function scheduleTelegramWebhookReconciliation(): void {
  if (webhookReconcileScheduled) return;
  if (process.env.NODE_ENV !== "production" || process.env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK !== "true") return;
  webhookReconcileScheduled = true;
  const timer = setTimeout(() => {
    void reconcileTelegramWebhookConfiguration().catch(() => undefined);
  }, 1_500);
  timer.unref?.();
}

scheduleTelegramWebhookReconciliation();

export const telegramDiagnosticsInternals = {
  sanitizeTelegramText,
  normalizeUrl,
  failureFields,
};
