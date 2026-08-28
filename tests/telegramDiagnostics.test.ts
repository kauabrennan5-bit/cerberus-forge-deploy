import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getExpectedTelegramWebhookUrl,
  getTelegramWebhookDiagnostics,
  markTelegramBackendReady,
} from "../server/services/telegramDiagnostics";

test("diagnóstico do Telegram compara webhook canônico sem expor token", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousBackend = process.env.PUBLIC_BACKEND_URL;
  const previousWebhook = process.env.TELEGRAM_WEBHOOK_URL;
  const previousWhitelist = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const previousFetch = globalThis.fetch;

  process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
  process.env.PUBLIC_BACKEND_URL = "https://backend.example.test";
  delete process.env.TELEGRAM_WEBHOOK_URL;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "888111222";
  process.env.TELEGRAM_WEBHOOK_SECRET = "secret-value";
  markTelegramBackendReady();

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "test_bot" } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ok: true,
      result: {
        url: "https://backend.example.test/api/telegram/webhook",
        pending_update_count: 2,
        last_error_message: "temporary error with token=secret-value",
        allowed_updates: ["message", "callback_query"],
      },
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const diagnostics = await getTelegramWebhookDiagnostics();
    assert.equal(getExpectedTelegramWebhookUrl(), "https://backend.example.test/api/telegram/webhook");
    assert.equal(diagnostics.apiHealthy, true);
    assert.equal(diagnostics.webhookConfigured, true);
    assert.equal(diagnostics.webhookMatchesExpectedUrl, true);
    assert.equal(diagnostics.pendingUpdates, 2);
    assert.equal(diagnostics.backendReady, true);
    assert.equal(diagnostics.secretConfigured, true);
    assert.match(diagnostics.webhookLastError || "", /temporary error/);
    assert.doesNotMatch(diagnostics.webhookLastError || "", /secret-value/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /123456789/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousBackend === undefined) delete process.env.PUBLIC_BACKEND_URL; else process.env.PUBLIC_BACKEND_URL = previousBackend;
    if (previousWebhook === undefined) delete process.env.TELEGRAM_WEBHOOK_URL; else process.env.TELEGRAM_WEBHOOK_URL = previousWebhook;
    if (previousWhitelist === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = previousWhitelist;
    if (previousSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET; else process.env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
  }
});

test("boot do Telegram é independente do Operator e setWebhook usa URL canônica", () => {
  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const telegramSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../server/services/operatorStateStore.ts", import.meta.url), "utf8");

  const listenBlockStart = serverSource.indexOf('app.listen(PORT, "0.0.0.0", () => {');
  const listenBlockEnd = serverSource.indexOf("  });\n}", listenBlockStart);
  const listenBlock = serverSource.slice(listenBlockStart, listenBlockEnd);

  assert.ok(listenBlockStart >= 0 && listenBlockEnd > listenBlockStart);
  assert.ok(listenBlock.indexOf("startTelegramPolling()") < listenBlock.indexOf("initializeOperatorState()"));
  assert.match(listenBlock, /startOperatorScheduler\(\)/);
  assert.match(serverSource, /getExpectedTelegramWebhookUrl/);
  assert.match(serverSource, /method: "POST"/);
  assert.match(serverSource, /secret_token: webhookSecret/);
  assert.match(telegramSource, /markTelegramBackendReady\(\)/);
  assert.match(stateSource, /OPERATOR_STATE_TIMEOUT_MS = 15_000/);
  assert.match(stateSource, /SAFE_MODE/);
});
