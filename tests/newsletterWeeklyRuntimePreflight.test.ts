import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWeeklyRuntimePreflight,
  parseSingleTestEmail,
} from "../server/services/newsletterWeeklyRuntimePreflight";
import { renderWeeklyRuntimePreflight } from "../server/services/telegramPanel";
import {
  canonicalTelegramCommand,
  isKnownTelegramCommand,
  parseTelegramCommand,
} from "../server/services/telegramCommands";
import {
  handleTelegramWebhookUpdate,
  setTestTelegramSenders,
} from "../server/services/telegramBot";

const readyEnv = (): NodeJS.ProcessEnv => ({
  NEWSLETTER_WEEKLY_ENABLED: "false",
  NEWSLETTER_TEST_EMAIL: "qa@example.com",
  BREVO_API_KEY: "secret-api-key-that-must-never-render",
  NEWSLETTER_SENDER_EMAIL: "newsletter@cerberusfinds.com",
  NEWSLETTER_SENDER_NAME: "Cerberus Finds",
  NEWSLETTER_REPLY_TO_EMAIL: "reply@cerberusfinds.com",
});

test("weekly flag ausente e false permanecem fail-closed; somente true habilita no fallback legado", async () => {
  const missing = await evaluateWeeklyRuntimePreflight({ env: { ...readyEnv(), NEWSLETTER_WEEKLY_ENABLED: undefined }, countEligibleSubscribers: async () => 4 });
  const disabled = await evaluateWeeklyRuntimePreflight({ env: readyEnv(), countEligibleSubscribers: async () => 4 });
  const enabled = await evaluateWeeklyRuntimePreflight({ env: { ...readyEnv(), NEWSLETTER_WEEKLY_ENABLED: "true" }, countEligibleSubscribers: async () => 4 });
  assert.equal(missing.weeklyProductionEnabled, false);
  assert.equal(disabled.weeklyProductionEnabled, false);
  assert.equal(enabled.weeklyProductionEnabled, true);
  assert.equal(enabled.readyForTest, false);
  assert.equal(enabled.productionAudienceReady, false);
});

test("NEWSLETTER_TEST_EMAIL ausente, inválido, múltiplo e válido único", () => {
  assert.deepEqual(parseSingleTestEmail(undefined), { configured: false, valid: false, normalized: "", masked: null });
  assert.equal(parseSingleTestEmail("not-an-email").valid, false);
  assert.equal(parseSingleTestEmail("one@example.com,two@example.com").valid, false);
  assert.equal(parseSingleTestEmail("one@example.com;two@example.com").valid, false);
  const single = parseSingleTestEmail("qa@example.com");
  assert.equal(single.configured, true);
  assert.equal(single.valid, true);
  assert.equal(single.masked, "q***@example.com");
});

test("preflight de teste é read-only e usa apenas contador injetado", async () => {
  let reads = 0;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("UNEXPECTED_NETWORK"); }) as typeof fetch;
  try {
    const result = await evaluateWeeklyRuntimePreflight({
      env: readyEnv(),
      countEligibleSubscribers: async () => { reads += 1; return 4; },
    });
    assert.equal(result.readyForTest, true);
    assert.equal(result.brevoApiKeyPresent, true);
    assert.equal(result.brevoMarketingProviderReady, true);
    assert.equal(result.eligibleSubscribers, 4);
    assert.equal(reads, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight de produção só fica pronto com lista e sync exatamente iguais ao consentimento local", async () => {
  const result = await evaluateWeeklyRuntimePreflight({
    env: { ...readyEnv(), NEWSLETTER_WEEKLY_ENABLED: "false" },
    countEligibleSubscribers: async () => 4,
    productionConfigLoader: async () => ({
      weeklyEnabled: true,
      brevoListId: 42,
      contactSyncVerifiedAt: "2026-08-29T22:00:00.000Z",
      lastSyncAt: "2026-08-29T22:00:00.000Z",
      lastSyncStatus: "ready",
      eligibleSubscribersCount: 4,
      brevoMembersCount: 4,
      updatedAt: "2026-08-29T22:00:00.000Z",
    }),
  });
  assert.equal(result.weeklyProductionEnabled, true);
  assert.equal(result.productionListConfigured, true);
  assert.equal(result.productionSyncVerified, true);
  assert.equal(result.productionAudienceReady, true);
  assert.equal(result.productionBrevoMembers, 4);
  assert.equal(result.readyForTest, false);

  const rendered = renderWeeklyRuntimePreflight(result);
  assert.match(rendered, /ATIVADA E PRONTA ✅/);
  assert.match(rendered, /Criação automática de rascunho: <b>ATIVA ✅<\/b>/);
  assert.match(rendered, /Envio geral: <b>EXIGE APROVAÇÃO HUMANA ✅<\/b>/);
  assert.doesNotMatch(rendered, /NÃO BLOQUEADO/);
});

test("preflight de produção detecta drift de audiência e fica bloqueado", async () => {
  const result = await evaluateWeeklyRuntimePreflight({
    env: readyEnv(),
    countEligibleSubscribers: async () => 4,
    productionConfigLoader: async () => ({
      weeklyEnabled: true,
      brevoListId: 42,
      contactSyncVerifiedAt: "2026-08-29T22:00:00.000Z",
      lastSyncAt: "2026-08-29T22:00:00.000Z",
      lastSyncStatus: "ready",
      eligibleSubscribersCount: 4,
      brevoMembersCount: 3,
      updatedAt: "2026-08-29T22:00:00.000Z",
    }),
  });
  assert.equal(result.productionAudienceReady, false);
  assert.match(renderWeeklyRuntimePreflight(result), /ATIVADA, MAS BLOQUEADA ⚠️/);
});

test("Telegram preflight não renderiza email completo nem API key", async () => {
  const env = readyEnv();
  const result = await evaluateWeeklyRuntimePreflight({ env, countEligibleSubscribers: async () => 4 });
  const rendered = renderWeeklyRuntimePreflight(result);
  assert.match(rendered, /DESATIVADA/);
  assert.match(rendered, /q\*\*\*@example\.com/);
  assert.doesNotMatch(rendered, /qa@example\.com/);
  assert.doesNotMatch(rendered, /secret-api-key-that-must-never-render/);
});

test("/weekly-preflight é comando conhecido e roteia para status read-only", () => {
  const parsed = parseTelegramCommand("/weekly-preflight");
  assert.ok(parsed);
  assert.equal(isKnownTelegramCommand(parsed.name), true);
  assert.equal(canonicalTelegramCommand(parsed.name), "status");
});

test("/weekly-test é comando conhecido e permanece separado de produção", () => {
  const parsed = parseTelegramCommand("/weekly-test");
  assert.ok(parsed);
  assert.equal(isKnownTelegramCommand(parsed.name), true);
  assert.equal(canonicalTelegramCommand(parsed.name), "weekly-test");
});

test("usuário Telegram não autorizado é rejeitado antes de /weekly-test", async () => {
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "999";
  const messages: string[] = [];
  setTestTelegramSenders(async (_chatId, value) => { messages.push(String(value)); return { ok: true }; }, null);
  try {
    await handleTelegramWebhookUpdate({
      update_id: 987654322,
      message: { message_id: 2, from: { id: 123 }, chat: { id: 123 }, text: "/weekly-test" },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Acesso Negado/);
    assert.doesNotMatch(messages[0], /WEEKLY-TEST JÁ PREPARADA|RASCUNHO SEMANAL/);
  } finally {
    setTestTelegramSenders(null, null);
    if (previousAllowed === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("usuário Telegram não autorizado é rejeitado antes do preflight", async () => {
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "999";
  const messages: string[] = [];
  setTestTelegramSenders(async (_chatId, text) => { messages.push(String(text)); return { ok: true }; }, null);
  try {
    await handleTelegramWebhookUpdate({
      update_id: 987654321,
      message: { message_id: 1, from: { id: 123 }, chat: { id: 123 }, text: "/weekly-preflight" },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Acesso Negado/);
    assert.doesNotMatch(messages[0], /Cerberus Weekly/);
  } finally {
    setTestTelegramSenders(null, null);
    if (previousAllowed === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});
