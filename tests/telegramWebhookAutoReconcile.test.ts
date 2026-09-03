import assert from "node:assert/strict";
import test from "node:test";
import { reconcileTelegramWebhookConfiguration } from "../server/services/telegramDiagnostics";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("free runtime reconcilia webhook do Telegram sem expor nem trocar o secret", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const previousUrl = process.env.TELEGRAM_WEBHOOK_URL;
  const previousAuto = process.env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK;
  const previousFetch = globalThis.fetch;
  const secret = "gateway-secret-for-test-only";
  const expectedUrl = "https://edge.example.test/functions/v1/telegram";
  let infoCalls = 0;
  let setWebhookBody: any = null;

  process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
  process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  process.env.TELEGRAM_WEBHOOK_URL = expectedUrl;
  process.env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK = "true";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/getWebhookInfo")) {
      infoCalls += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: { url: infoCalls === 1 ? "https://old.example.test/api/telegram/webhook" : expectedUrl },
      }), { status: 200 });
    }
    if (url.endsWith("/setWebhook")) {
      setWebhookBody = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    throw new Error("unexpected Telegram method");
  }) as typeof fetch;

  try {
    const result = await reconcileTelegramWebhookConfiguration();
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.reason, "updated");
    assert.equal(result.expectedWebhookUrl, expectedUrl);
    assert.equal(setWebhookBody?.url, expectedUrl);
    assert.equal(setWebhookBody?.secret_token, secret);
    assert.equal(setWebhookBody?.drop_pending_updates, false);
    assert.equal(infoCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("TELEGRAM_BOT_TOKEN", previousToken);
    restoreEnv("TELEGRAM_WEBHOOK_SECRET", previousSecret);
    restoreEnv("TELEGRAM_WEBHOOK_URL", previousUrl);
    restoreEnv("TELEGRAM_AUTO_CONFIGURE_WEBHOOK", previousAuto);
  }
});

test("free runtime não altera webhook se o secret obrigatório estiver ausente", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const previousUrl = process.env.TELEGRAM_WEBHOOK_URL;
  const previousAuto = process.env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK;
  const previousFetch = globalThis.fetch;
  let fetched = false;

  process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_WEBHOOK_URL = "https://edge.example.test/functions/v1/telegram";
  process.env.TELEGRAM_AUTO_CONFIGURE_WEBHOOK = "true";
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("should not fetch");
  }) as typeof fetch;

  try {
    const result = await reconcileTelegramWebhookConfiguration();
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "secret_missing");
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("TELEGRAM_BOT_TOKEN", previousToken);
    restoreEnv("TELEGRAM_WEBHOOK_SECRET", previousSecret);
    restoreEnv("TELEGRAM_WEBHOOK_URL", previousUrl);
    restoreEnv("TELEGRAM_AUTO_CONFIGURE_WEBHOOK", previousAuto);
  }
});
