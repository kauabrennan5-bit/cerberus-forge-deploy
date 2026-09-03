import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getExpectedTelegramWebhookUrl,
  getTelegramWebhookDiagnostics,
  markTelegramBackendReady,
} from "../server/services/telegramDiagnostics";
import { telegramTokenFingerprint } from "../server/services/telegramApiClient";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

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
    assert.equal(diagnostics.status, "degraded");
    assert.equal(diagnostics.errorCode, "TELEGRAM_PROVIDER_UNAVAILABLE");
    assert.match(diagnostics.webhookLastError || "", /temporary error/);
    assert.doesNotMatch(diagnostics.webhookLastError || "", /secret-value/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /123456789:/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("TELEGRAM_BOT_TOKEN", previousToken);
    restoreEnv("PUBLIC_BACKEND_URL", previousBackend);
    restoreEnv("TELEGRAM_WEBHOOK_URL", previousWebhook);
    restoreEnv("TELEGRAM_ALLOWED_USER_IDS", previousWhitelist);
    restoreEnv("TELEGRAM_WEBHOOK_SECRET", previousSecret);
  }
});

test("Telegram Unauthorized is classified with safe fingerprint and never logs readable token", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousBackend = process.env.PUBLIC_BACKEND_URL;
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const rawToken = "987654321:this-is-a-secret-telegram-token-value";
  const warnings: unknown[][] = [];
  process.env.TELEGRAM_BOT_TOKEN = rawToken;
  process.env.PUBLIC_BACKEND_URL = "https://backend.example.test";
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true, result: { url: "https://backend.example.test/api/telegram/webhook" } }), { status: 200 });
  }) as typeof fetch;

  try {
    const diagnostics = await getTelegramWebhookDiagnostics();
    assert.equal(diagnostics.apiHealthy, false);
    assert.equal(diagnostics.status, "down");
    assert.equal(diagnostics.errorCode, "TELEGRAM_AUTH_ERROR");
    assert.equal(diagnostics.httpStatus, 401);
    assert.equal(diagnostics.failedMethod, "getMe");
    assert.equal(diagnostics.tokenFingerprint, telegramTokenFingerprint(rawToken));
    assert.equal(diagnostics.tokenFingerprint?.length, 12);
    const serialized = JSON.stringify({ diagnostics, warnings });
    assert.doesNotMatch(serialized, new RegExp(rawToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /987654321:/);
    assert.match(serialized, /TELEGRAM_AUTH_ERROR/);
  } finally {
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
    restoreEnv("TELEGRAM_BOT_TOKEN", previousToken);
    restoreEnv("PUBLIC_BACKEND_URL", previousBackend);
  }
});

test("webhook mismatch is distinct from Telegram auth/provider failures", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousBackend = process.env.PUBLIC_BACKEND_URL;
  const previousFetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
  process.env.PUBLIC_BACKEND_URL = "https://canonical.example.test";
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: { url: "https://old.example.test/api/telegram/webhook" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const diagnostics = await getTelegramWebhookDiagnostics();
    assert.equal(diagnostics.apiHealthy, true);
    assert.equal(diagnostics.webhookMatchesExpectedUrl, false);
    assert.equal(diagnostics.errorCode, "TELEGRAM_WEBHOOK_MISMATCH");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("TELEGRAM_BOT_TOKEN", previousToken);
    restoreEnv("PUBLIC_BACKEND_URL", previousBackend);
  }
});

test("boot do Telegram é independente do Operator e setWebhook usa URL canônica", () => {
  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const telegramCoreSource = readFileSync(new URL("../server/services/telegramBotCore.ts", import.meta.url), "utf8");
  const telegramExtensionSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
  const telegramSource = `${telegramCoreSource}\n${telegramExtensionSource}`;
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
  assert.match(stateSource, /recoverAbandonedAutonomousCuratorRuns/);
  assert.match(stateSource, /SAFE_MODE/);
});
