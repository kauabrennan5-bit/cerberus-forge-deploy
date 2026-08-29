import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { createCampaignDraft, transitionCampaign, type EmailCampaign } from "../server/services/newsletterCampaignState";
import {
  createWeeklyBrevoMarketingProvider,
  getWeeklyBrevoErrorDetails,
  type WeeklyBrevoMarketingProvider,
} from "../server/services/newsletterWeeklyBrevoProvider";
import {
  getWeeklyMarketingTestSendError,
  retryWeeklyMarketingTest,
} from "../server/services/newsletterWeeklyDelivery";
import { redeliverLatestWeeklyTestDraftCard } from "../server/services/newsletterWeeklyCampaign";
import {
  campaignKeyboard,
  handleNewsletterCampaignCallback,
  syncCampaignTelegramState,
} from "../server/services/newsletterCampaignTelegram";

const HTML = '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a></body></html>';

function approvedWeeklyTest(providerId = "88"): EmailCampaign {
  const draft = createCampaignDraft(
    null,
    "123",
    { subject: "Weekly recovery", html: HTML, text: "Cancelar: {{ unsubscribe }}", offerUrl: "" },
    new Date("2026-08-29T18:00:00Z"),
    "11111111-1111-4111-8111-111111111111",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    "weekly-test:2026-08-29:abc",
  );
  const approved = transitionCampaign(
    transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }),
    { type: "approve", actorTelegramId: "123" },
    new Date("2026-08-29T18:01:00Z"),
  );
  return { ...approved, testProviderMessageId: providerId || null };
}

function testProduct(id: string): Product {
  return {
    id,
    ref: `REF-${id.toUpperCase()}`,
    produto: `Produto ${id}`,
    displayTitle: `Produto ${id}`,
    categoria: "Iluminação",
    preco: 10,
    imagens: [`https://cdn.example.com/${id}.jpg`],
    imageEditorialStatus: "clean",
    link: `https://market.example.com/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    descricao: `Descrição ${id}`,
    createdAt: "2026-08-29T17:00:00Z",
  } as Product;
}

function memoryStore(initial: EmailCampaign) {
  let campaign = structuredClone(initial);
  let card: any = { campaignId: campaign.id, chatId: "123", messageId: 10, updatedAt: "2026-08-29T18:02:00Z" };
  const counters = {
    createCampaign: 0,
    createEligibleRecipients: 0,
    readSubscriber: 0,
    saveCard: 0,
  };
  const store: any = {
    async createCampaign(value: EmailCampaign) { counters.createCampaign += 1; campaign = structuredClone(value); return structuredClone(campaign); },
    async createCampaignProducts() {},
    async listCampaignProducts() { return structuredClone(campaign.collectionProducts); },
    async getCampaign(id: string) { return id === campaign.id ? structuredClone(campaign) : null; },
    async listRecentCampaigns() { return [structuredClone(campaign)]; },
    async findOperationalCollectionByEditionKey() { return structuredClone(campaign); },
    async getCampaignTelegramCard(id: string) { return id === campaign.id ? structuredClone(card) : null; },
    async saveCampaignTelegramCard(id: string, chatId: string, messageId: number) {
      counters.saveCard += 1;
      card = { campaignId: id, chatId: String(chatId), messageId, updatedAt: new Date().toISOString() };
    },
    async updateCampaign(value: EmailCampaign) { campaign = structuredClone(value); return structuredClone(campaign); },
    async createEligibleRecipients() { counters.createEligibleRecipients += 1; throw new Error("REAL_RECIPIENTS_FORBIDDEN"); },
    async claimRecipient() { return null; },
    async readSubscriber() { counters.readSubscriber += 1; return null; },
    async prepareUnsubscribeToken() { throw new Error("UNEXPECTED_UNSUBSCRIBE_TOKEN"); },
    async markRecipientSent() { return null; },
    async markRecipientSkipped() { return null; },
    async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; },
    async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; },
    async listSendingCampaigns() { return []; },
  };
  return { store, counters, read: () => structuredClone(campaign), readCard: () => structuredClone(card) };
}

function mockProvider(options: { failure?: Error } = {}) {
  const calls = { create: 0, sendTest: 0, sendNow: 0, emails: [] as string[][], ids: [] as string[] };
  const provider: WeeklyBrevoMarketingProvider = {
    async createCampaign() {
      calls.create += 1;
      return { status: "succeeded", brevoCampaignId: "999", operation: "create", providerRef: "999", providerReference: "999" };
    },
    async sendTest(id, emails) {
      calls.sendTest += 1;
      calls.ids.push(id);
      calls.emails.push([...emails]);
      if (options.failure) throw options.failure;
      return { status: "succeeded", brevoCampaignId: id, operation: "send_test", providerRef: id, providerReference: id };
    },
    async sendNow(id) {
      calls.sendNow += 1;
      return { status: "succeeded", brevoCampaignId: id, operation: "send_now", providerRef: id, providerReference: id };
    },
  };
  return { provider, calls };
}

for (const status of [400, 401, 403, 429, 500]) {
  test(`SENDTEST_HTTP_ERROR preserva HTTP ${status} e código seguro`, async () => {
    const provider = createWeeklyBrevoMarketingProvider({
      apiKey: "test-key",
      senderEmail: "newsletter@cerberus.example.com",
      fetchImpl: async () => new Response(JSON.stringify({ code: "provider_safe_code", message: "ignored" }), {
        status,
        statusText: status === 429 ? "Too Many Requests" : "Provider Error",
        headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(
      provider.sendTest("88", ["only-test@example.com"]),
      error => {
        const details = getWeeklyBrevoErrorDetails(error);
        assert.equal(details?.provider, "BREVO");
        assert.equal(details?.operation, "send_test");
        assert.equal(details?.kind, "http");
        assert.equal(details?.status, status);
        assert.equal(details?.providerCode, "provider_safe_code");
        assert.equal(details?.sendTestResult, "failed");
        assert.equal((error as any).code, status >= 500 ? "WEEKLY_BREVO_HTTP_5XX" : `WEEKLY_BREVO_HTTP_${status}`);
        return true;
      },
    );
  });
}

test("SENDTEST_TIMEOUT é distinguido e resultado fica UNKNOWN", async () => {
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; },
  });
  await assert.rejects(provider.sendTest("88", ["only-test@example.com"]), error => {
    const details = getWeeklyBrevoErrorDetails(error);
    assert.equal(details?.kind, "timeout");
    assert.equal(details?.sendTestResult, "unknown");
    assert.equal((error as any).code, "WEEKLY_BREVO_TIMEOUT");
    return true;
  });
});

test("SENDTEST_NETWORK_ERROR é distinguido e resultado fica UNKNOWN", async () => {
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => { throw new TypeError("socket closed"); },
  });
  await assert.rejects(provider.sendTest("88", ["only-test@example.com"]), error => {
    const details = getWeeklyBrevoErrorDetails(error);
    assert.equal(details?.kind, "network");
    assert.equal(details?.sendTestResult, "unknown");
    assert.equal((error as any).code, "WEEKLY_BREVO_NETWORK_ERROR");
    return true;
  });
});

test("INVALID_RESPONSE em create é estruturado sem inventar HTTP", async () => {
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => new Response("not-json", { status: 201 }),
  });
  await assert.rejects(provider.createCampaign({ campaignId: "x", name: "x", subject: "x", htmlContent: HTML }), error => {
    const details = getWeeklyBrevoErrorDetails(error);
    assert.equal(details?.operation, "create");
    assert.equal(details?.kind, "invalid_response");
    assert.equal(details?.status, undefined);
    assert.equal((error as any).code, "WEEKLY_BREVO_INVALID_RESPONSE");
    return true;
  });
});

test("APPROVED_RECOVERY recupera provider existente com botão retry e zero criação", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  let text = "";
  let markup: any = null;
  const result = await redeliverLatestWeeklyTestDraftCard({
    chatId: "123",
    store: memory.store,
    telegramSender: async (_chat, value, keyboard) => {
      text = value;
      markup = keyboard;
      return { ok: true, result: { message_id: 44 } };
    },
  });
  assert.equal(result.status, "delivered");
  assert.equal(memory.counters.createCampaign, 0);
  assert.match(text, /ENVIO DE TESTE NÃO CONFIRMADO/);
  assert.match(text, /Brevo Campaign: <b>criada/);
  assert.match(String(markup.inline_keyboard[0][0].callback_data), /^campaign_weekly_retry_test:/);
  assert.match(String(markup.inline_keyboard[0][0].text), /Tentar envio de teste novamente/);
});

test("RETRY_REUSES_PROVIDER_ID e sucesso marca test_sent sem create/sendNow/recipients", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  const mock = mockProvider();
  const result = await retryWeeklyMarketingTest(memory.read(), "123", {
    store: memory.store,
    provider: mock.provider,
    env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
  });
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(result.providerCampaignId, "88");
  assert.equal(result.providerCampaignCreatedThisAttempt, false);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 1);
  assert.equal(mock.calls.sendNow, 0);
  assert.deepEqual(mock.calls.ids, ["88"]);
  assert.deepEqual(mock.calls.emails, [["only-test@example.com"]]);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
  assert.equal(memory.read().testProviderMessageId, "88");
});

test("RETRY_FAILURE preserva approved e provider ID, não cria campanha e não chama sendNow", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  const providerError = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => new Response(JSON.stringify({ code: "rate_limit" }), { status: 429 }),
  });
  await assert.rejects(
    retryWeeklyMarketingTest(memory.read(), "123", {
      store: memory.store,
      provider: providerError,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
    }),
    error => {
      const failure = getWeeklyMarketingTestSendError(error);
      assert.equal(failure?.providerCampaignId, "88");
      assert.equal(failure?.providerCampaignCreatedThisAttempt, false);
      assert.equal(failure?.sendTestSucceeded, false);
      assert.equal(failure?.safeCode, "WEEKLY_BREVO_HTTP_429");
      return true;
    },
  );
  assert.equal(memory.read().status, "approved");
  assert.equal(memory.read().testProviderMessageId, "88");
  assert.equal(memory.counters.createCampaign, 0);
  assert.equal(memory.counters.createEligibleRecipients, 0);
});

test("RETRY sem provider ref falha fechado e não usa create como fallback", async () => {
  const memory = memoryStore(approvedWeeklyTest(""));
  const mock = mockProvider();
  await assert.rejects(
    retryWeeklyMarketingTest(memory.read(), "123", {
      store: memory.store,
      provider: mock.provider,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
    }),
    /WEEKLY_MARKETING_TEST_PROVIDER_REFERENCE_REQUIRED/,
  );
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 0);
  assert.equal(mock.calls.sendNow, 0);
});

test("RETRY_CALLBACK responde antes do provider e reutiliza a mesma campanha", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  const order: string[] = [];
  const mock = mockProvider();
  const provider: WeeklyBrevoMarketingProvider = {
    ...mock.provider,
    async sendTest(id, emails) {
      order.push("provider");
      return mock.provider.sendTest(id, emails);
    },
  };
  await handleNewsletterCampaignCallback(
    `campaign_weekly_retry_test:${memory.read().id}`,
    "callback-1",
    "123",
    "123",
    10,
    {
      store: memory.store,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
      weeklyProvider: provider,
      answerCallbackQuery: async () => { order.push("answer"); },
      editTelegramMessageText: async () => ({ ok: true }),
      editTelegramMessageReplyMarkup: async () => ({ ok: true }),
      sendTelegramMessage: async () => ({ ok: true, result: { message_id: 11 } }),
      productLoader: async id => testProduct(id),
    },
  );
  assert.deepEqual(order.slice(0, 2), ["answer", "provider"]);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 1);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(memory.read().status, "test_sent");
});

test("RETRY_CALLBACK failure mostra código seguro e mantém botão retry", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => new Response(JSON.stringify({ code: "rate_limit" }), { status: 429 }),
  });
  const messages: Array<{ text: string; markup: any }> = [];
  await handleNewsletterCampaignCallback(
    `campaign_weekly_retry_test:${memory.read().id}`,
    "callback-2",
    "123",
    "123",
    10,
    {
      store: memory.store,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
      weeklyProvider: provider,
      answerCallbackQuery: async () => undefined,
      editTelegramMessageText: async () => ({ ok: true }),
      editTelegramMessageReplyMarkup: async () => ({ ok: true }),
      sendTelegramMessage: async (_chat, text, markup) => {
        messages.push({ text, markup });
        return { ok: true, result: { message_id: 12 } };
      },
      productLoader: async id => testProduct(id),
    },
  );
  assert.equal(memory.read().status, "approved");
  assert.equal(memory.read().testProviderMessageId, "88");
  assert.match(messages.at(-1)?.text || "", /WEEKLY_BREVO_HTTP_429/);
  assert.match(String(messages.at(-1)?.markup?.inline_keyboard?.[0]?.[0]?.callback_data), /^campaign_weekly_retry_test:/);
});

test("DUPLICATE_CALLBACK após sucesso não chama sendTest novamente", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  const mock = mockProvider();
  const deps: any = {
    store: memory.store,
    env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
    weeklyProvider: mock.provider,
    answerCallbackQuery: async () => undefined,
    editTelegramMessageText: async () => ({ ok: true }),
    editTelegramMessageReplyMarkup: async () => ({ ok: true }),
    sendTelegramMessage: async () => ({ ok: true, result: { message_id: 13 } }),
    productLoader: async (id: string) => testProduct(id),
  };
  const data = `campaign_weekly_retry_test:${memory.read().id}`;
  await handleNewsletterCampaignCallback(data, "same-callback", "123", "123", 10, deps);
  await handleNewsletterCampaignCallback(data, "same-callback", "123", "123", 10, deps);
  assert.equal(mock.calls.sendTest, 1);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendNow, 0);
});

test("MESSAGE_NOT_MODIFIED é tratado como sincronizado e não gera card sem ação", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  let markupCalls = 0;
  let sentMessages = 0;
  const result = await syncCampaignTelegramState(memory.read().id, {
    store: memory.store,
    editTelegramMessageText: async () => ({ ok: false, description: "Bad Request: message is not modified" }),
    editTelegramMessageReplyMarkup: async () => { markupCalls += 1; return { ok: false, description: "Bad Request: message is not modified" }; },
    sendTelegramMessage: async () => { sentMessages += 1; return { ok: true, result: { message_id: 99 } }; },
    productLoader: async id => testProduct(id),
  });
  assert.equal(result.outcome, "already_synchronized");
  assert.equal(markupCalls, 1);
  assert.equal(sentMessages, 0);
  assert.equal(memory.read().status, "approved");
  assert.equal(memory.read().testProviderMessageId, "88");
});

test("MISSING_RETRY_KEYBOARD_RECONCILIATION restaura reply_markup mesmo com texto já igual", async () => {
  const memory = memoryStore(approvedWeeklyTest("88"));
  let restoredMarkup: any = null;
  const result = await syncCampaignTelegramState(memory.read().id, {
    store: memory.store,
    editTelegramMessageText: async () => ({ ok: false, description: "Bad Request: message is not modified" }),
    editTelegramMessageReplyMarkup: async (_chat, _message, markup) => { restoredMarkup = markup; return { ok: true }; },
    sendTelegramMessage: async () => ({ ok: true, result: { message_id: 99 } }),
    productLoader: async id => testProduct(id),
  });
  assert.equal(result.outcome, "already_synchronized");
  assert.match(String(restoredMarkup.inline_keyboard[0][0].callback_data), /^campaign_weekly_retry_test:/);
  assert.match(String(restoredMarkup.inline_keyboard[0][0].text), /Tentar envio de teste novamente/);
});

test("KEYBOARD semanal approved com provider ref nunca oferece envio geral", () => {
  const keyboard = campaignKeyboard(approvedWeeklyTest("88"));
  const flattened = JSON.stringify(keyboard);
  assert.match(flattened, /campaign_weekly_retry_test/);
  assert.doesNotMatch(flattened, /campaign_start|campaign_confirm_general/);
});
