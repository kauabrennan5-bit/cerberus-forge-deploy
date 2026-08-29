import test from "node:test";
import assert from "node:assert/strict";
import {
  createWeeklyBrevoMarketingProvider,
  type WeeklyBrevoMarketingProvider,
} from "../server/services/newsletterWeeklyBrevoProvider";
import {
  sendWeeklyMarketingNow,
  sendWeeklyMarketingTest,
} from "../server/services/newsletterWeeklyDelivery";
import { createBrevoNewsletterProvider } from "../server/services/newsletterProvider";
import { createCampaignDraft, transitionCampaign, type EmailCampaign } from "../server/services/newsletterCampaignState";
import type { NewsletterCampaignStore } from "../server/repositories/newsletterCampaignRepository";

const HTML = '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a><a href="https://cerberus.example.com/go/REF-A">Oferta</a></body></html>';

function response(status: number, body = ""): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json" } });
}

function baseCampaign(editionKey = "weekly-test:2026-08-29:abc"): EmailCampaign {
  const draft = createCampaignDraft(
    null,
    "123",
    { subject: "Achados", html: HTML, text: "Cancelar: {{ unsubscribe }}", offerUrl: "" },
    new Date("2026-08-29T03:00:00Z"),
    "11111111-1111-4111-8111-111111111111",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    editionKey,
  );
  return transitionCampaign(
    transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }),
    { type: "approve", actorTelegramId: "123" },
  );
}

function memoryStore(initial: EmailCampaign) {
  let campaign = structuredClone(initial);
  const counters = {
    createEligibleRecipients: 0,
    readSubscriber: 0,
  };
  const store: NewsletterCampaignStore = {
    async createCampaign(value) { campaign = structuredClone(value); return structuredClone(campaign); },
    async createCampaignProducts() {},
    async listCampaignProducts() { return []; },
    async getCampaign(id) { return id === campaign.id ? structuredClone(campaign) : null; },
    async listRecentCampaigns() { return []; },
    async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; },
    async saveCampaignTelegramCard() {},
    async updateCampaign(value) { campaign = structuredClone(value); return structuredClone(campaign); },
    async createEligibleRecipients() { counters.createEligibleRecipients += 1; return 0; },
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
  return { store, counters, read: () => structuredClone(campaign) };
}

function mockWeeklyProvider(options: {
  failTestOnce?: boolean;
  createId?: string;
} = {}) {
  let failTest = options.failTestOnce === true;
  const calls = { create: 0, sendTest: 0, sendNow: 0, testEmails: [] as string[][], creates: [] as any[] };
  const provider: WeeklyBrevoMarketingProvider = {
    async createCampaign(input) {
      calls.create += 1;
      calls.creates.push(structuredClone(input));
      const id = options.createId || "77";
      return { status: "succeeded", brevoCampaignId: id, operation: "create", providerRef: id, providerReference: id };
    },
    async sendTest(id, emailTo) {
      calls.sendTest += 1;
      calls.testEmails.push([...emailTo]);
      if (failTest) {
        failTest = false;
        throw new Error("TEST_PROVIDER_FAILURE");
      }
      return { status: "succeeded", brevoCampaignId: id, operation: "send_test", providerRef: id, providerReference: id };
    },
    async sendNow(id) {
      calls.sendNow += 1;
      return { status: "succeeded", brevoCampaignId: id, operation: "send_now", providerRef: id, providerReference: id };
    },
  };
  return { provider, calls };
}

test("Brevo weekly create usa /v3/emailCampaigns e preserva htmlContent/unsubscribe", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    senderName: "Cerberus Finds",
    replyToEmail: "reply@cerberus.example.com",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
      return response(201, JSON.stringify({ id: 123 }));
    },
  });
  const result = await provider.createCampaign({
    campaignId: "cerberus-1",
    name: "Cerberus weekly",
    subject: "Achados",
    htmlContent: HTML,
    previewText: "Preheader",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.brevo.com/v3/emailCampaigns");
  assert.equal(calls[0].body.htmlContent, HTML);
  assert.equal(calls[0].body.previewText, "Preheader");
  assert.equal(calls[0].body.replyTo, "reply@cerberus.example.com");
  assert.equal(calls[0].body.recipients, undefined);
  assert.match(calls[0].body.htmlContent, /href=["']\{\{\s*unsubscribe\s*\}\}["']/i);
  assert.equal(result.brevoCampaignId, "123");
});

test("Brevo weekly sendTest usa endpoint oficial e exatamente um emailTo", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body || "{}")) });
      return response(204);
    },
  });
  await provider.sendTest("123", ["test@example.com"]);
  assert.equal(calls[0].url, "https://api.brevo.com/v3/emailCampaigns/123/sendTest");
  assert.deepEqual(calls[0].body, { emailTo: ["test@example.com"] });
});

test("Brevo weekly sendTest vazio falha fechado e não chama fetch", async () => {
  let fetchCalls = 0;
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => { fetchCalls += 1; return response(204); },
  });
  await assert.rejects(provider.sendTest("123", []), /exatamente um NEWSLETTER_TEST_EMAIL/i);
  assert.equal(fetchCalls, 0);
});

test("Brevo weekly sendNow usa /v3/emailCampaigns/:id/sendNow", async () => {
  let seen = "";
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async input => { seen = String(input); return response(204); },
  });
  await provider.sendNow("456");
  assert.equal(seen, "https://api.brevo.com/v3/emailCampaigns/456/sendNow");
});

test("weekly-test usa somente NEWSLETTER_TEST_EMAIL, zero subscribers/recipients e nunca sendNow", async () => {
  const campaign = baseCampaign();
  const memory = memoryStore(campaign);
  const mock = mockWeeklyProvider();
  const result = await sendWeeklyMarketingTest(campaign, "123", {
    store: memory.store,
    provider: mock.provider,
    env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
  });
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendTest, 1);
  assert.equal(mock.calls.sendNow, 0);
  assert.deepEqual(mock.calls.testEmails, [["only-test@example.com"]]);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("retry após create reutiliza Brevo campaign id e não cria segunda campanha", async () => {
  const campaign = baseCampaign();
  const memory = memoryStore(campaign);
  const mock = mockWeeklyProvider({ failTestOnce: true, createId: "88" });
  await assert.rejects(
    sendWeeklyMarketingTest(campaign, "123", {
      store: memory.store,
      provider: mock.provider,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
    }),
    /TEST_PROVIDER_FAILURE/,
  );
  const afterFailure = memory.read();
  assert.equal(afterFailure.status, "approved");
  assert.equal(afterFailure.testProviderMessageId, "88");
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendTest, 1);

  const retried = await sendWeeklyMarketingTest(afterFailure, "123", {
    store: memory.store,
    provider: mock.provider,
    env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
  });
  assert.equal(retried.campaign.status, "test_sent");
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendTest, 2);
});

test("callback lógico duplicado após test_sent não recria nem reenvia", async () => {
  const campaign = baseCampaign();
  const memory = memoryStore(campaign);
  const mock = mockWeeklyProvider();
  const first = await sendWeeklyMarketingTest(campaign, "123", {
    store: memory.store,
    provider: mock.provider,
    env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
  });
  await assert.rejects(
    sendWeeklyMarketingTest(first.campaign, "123", {
      store: memory.store,
      provider: mock.provider,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
    }),
    /CAMPAIGN_TEST_ALREADY_SENT/,
  );
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendTest, 1);
});

test("produção semanal bloqueia sem listId/sync e não toca subscribers", async () => {
  const approved = baseCampaign("weekly:2026-08-29:abc");
  const confirmed = transitionCampaign(approved, { type: "confirm_general_send", actorTelegramId: "123" });
  const memory = memoryStore(confirmed);
  const mock = mockWeeklyProvider();
  await assert.rejects(
    sendWeeklyMarketingNow(confirmed, "123", {
      store: memory.store,
      provider: mock.provider,
      env: { NEWSLETTER_WEEKLY_ENABLED: "true" },
    }),
    /RECIPIENT_STRATEGY_UNVERIFIED/,
  );
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("produção weekly mock usa listId verificado e sendNow sem recipients Supabase", async () => {
  const approved = baseCampaign("weekly:2026-08-29:abc");
  const confirmed = transitionCampaign(approved, { type: "confirm_general_send", actorTelegramId: "123" });
  const memory = memoryStore(confirmed);
  const mock = mockWeeklyProvider({ createId: "99" });
  const sending = await sendWeeklyMarketingNow(confirmed, "123", {
    store: memory.store,
    provider: mock.provider,
    env: {
      NEWSLETTER_WEEKLY_ENABLED: "true",
      BREVO_NEWSLETTER_LIST_ID: "42",
      BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED: "true",
    },
  });
  assert.equal(sending.status, "sending");
  assert.equal(mock.calls.create, 1);
  assert.deepEqual(mock.calls.creates[0].listIds, [42]);
  assert.equal(mock.calls.sendNow, 1);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("provider transacional legado continua usando /v3/smtp/email", async () => {
  let seen = "";
  const provider = createBrevoNewsletterProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async input => {
      seen = String(input);
      return response(201, JSON.stringify({ messageId: "legacy-1" }));
    },
  });
  await provider.sendCampaign({
    campaignId: "legacy-campaign",
    recipientId: "legacy-recipient",
    subscriberEmail: "recipient@example.com",
    subject: "Legacy",
    htmlContent: "<p>Legacy</p>",
    textContent: "Legacy",
    idempotencyKey: "legacy-key",
  });
  assert.equal(seen, "https://api.brevo.com/v3/smtp/email");
});
