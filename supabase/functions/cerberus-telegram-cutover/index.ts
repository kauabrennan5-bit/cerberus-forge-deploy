import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TARGET = "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-telegram-gateway/webhook";

function text(value: unknown, max = 2048): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function botToken(): string { return text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 256); }
function webhookSecret(): string { return text(Deno.env.get("TELEGRAM_WEBHOOK_SECRET"), 256); }

async function authorized(req: Request): Promise<boolean> {
  const supplied = text(req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""), 256);
  return equalSecret(botToken(), supplied);
}

async function telegram(method: string, payload?: Record<string, unknown>): Promise<any> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN_MISSING");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? "POST" : "GET",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) throw new Error(`TELEGRAM_${method.toUpperCase()}_${response.status}`);
  return body.result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return json({
      status: "ok",
      service: "cerberus-telegram-cutover",
      target: TARGET,
      botConfigured: Boolean(botToken()),
      webhookSecretConfigured: Boolean(webhookSecret()),
      auth: "telegram-bot-token",
    });
  }
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  if (!await authorized(req)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

  const token = botToken(), secret = webhookSecret();
  if (!token || !secret) return json({ ok: false, error: "TELEGRAM_CONFIG_MISSING" }, 503);

  try {
    await telegram("setWebhook", {
      url: TARGET,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    const info = await telegram("getWebhookInfo");
    if (text(info?.url) !== TARGET) throw new Error("WEBHOOK_TARGET_MISMATCH");
    return json({
      ok: true,
      target: TARGET,
      pendingUpdateCount: Number(info?.pending_update_count || 0),
      lastErrorDate: Number(info?.last_error_date || 0),
      hasCustomCertificate: info?.has_custom_certificate === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TELEGRAM_CUTOVER_FAILED";
    console.error(`[telegram-cutover] ${message.slice(0, 160)}`);
    return json({ ok: false, error: "TELEGRAM_CUTOVER_FAILED" }, 502);
  }
});
