import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BACKEND_WEBHOOK = "https://cerberus-forge-deploy-backend.onrender.com/api/telegram/webhook";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function forwardTelegramUpdate(body: string, secretHeader: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(BACKEND_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": secretHeader,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error(`[telegram-gateway] backend_forward_failed status=${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.name : "forward_error";
    console.error(`[telegram-gateway] backend_forward_error type=${message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  // Telegram supplies this header when setWebhook uses secret_token. The gateway
  // never needs to know the secret value: it preserves the header and the canonical
  // backend remains the final fail-closed verifier.
  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!secretHeader || secretHeader.length > 256) {
    return json({ ok: false, error: "TELEGRAM_SECRET_HEADER_REQUIRED" }, 403);
  }

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ ok: false, error: "CONTENT_TYPE_REQUIRED" }, 415);
  }

  const body = await req.text();
  if (!body || body.length > 1_000_000) return json({ ok: false, error: "INVALID_BODY" }, 400);
  try { JSON.parse(body); } catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }

  EdgeRuntime.waitUntil(forwardTelegramUpdate(body, secretHeader));
  // Acknowledge Telegram immediately. Processing remains governed by the backend.
  return json({ ok: true, accepted: true, gateway: "supabase-edge" }, 200);
});
