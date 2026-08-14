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
}

const TELEGRAM_API_TIMEOUT_MS = 15_000;
const DEFAULT_BACKEND_URL = "https://cerberus-forge-deploy-backend.onrender.com";
let telegramBackendReady = false;
let lastTelegramBootstrapAt: string | undefined;

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

async function telegramGet(method: string, timeoutMs = TELEGRAM_API_TIMEOUT_MS): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN não configurado.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      signal: controller.signal,
      headers: { "User-Agent": "cerberus-telegram-diagnostics" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      const error = new Error(sanitizeTelegramText(payload?.description) || `Telegram API HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getTelegramWebhookDiagnostics(): Promise<TelegramWebhookDiagnostics> {
  const now = new Date().toISOString();
  const tokenConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  const whitelistValue = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
  const whitelistConfigured = whitelistValue.split(",").map(value => value.trim()).filter(Boolean).length > 0;
  const effectiveWhitelistConfigured = whitelistConfigured || Boolean("1976526372");
  const expectedWebhookUrl = getExpectedTelegramWebhookUrl();
  const base: TelegramWebhookDiagnostics = {
    configured: tokenConfigured,
    tokenConfigured,
    whitelistConfigured,
    effectiveWhitelistConfigured,
    webhookConfigured: false,
    webhookMatchesExpectedUrl: null,
    expectedWebhookUrl,
    apiHealthy: false,
    backendReady: telegramBackendReady,
    secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET?.trim()),
    lastWebhookCheck: now,
  };

  if (!tokenConfigured) {
    return { ...base, webhookLastError: "Token do Telegram não configurado." };
  }

  try {
    const [bot, webhook] = await Promise.all([
      telegramGet("getMe"),
      telegramGet("getWebhookInfo"),
    ]);
    const webhookUrl = typeof webhook?.url === "string" && webhook.url ? normalizeUrl(webhook.url) : undefined;
    const lastError = sanitizeTelegramText(webhook?.last_error_message);
    return {
      ...base,
      configured: Boolean(bot),
      apiHealthy: Boolean(bot),
      webhookConfigured: Boolean(webhookUrl),
      webhookMatchesExpectedUrl: webhookUrl ? webhookUrl === expectedWebhookUrl : false,
      webhookUrl,
      webhookLastError: lastError,
      pendingUpdates: typeof webhook?.pending_update_count === "number" ? webhook.pending_update_count : undefined,
      allowedUpdates: Array.isArray(webhook?.allowed_updates) ? webhook.allowed_updates.map(String) : undefined,
    };
  } catch (error: any) {
    return {
      ...base,
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
