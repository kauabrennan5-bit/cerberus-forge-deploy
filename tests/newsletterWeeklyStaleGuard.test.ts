import test from "node:test";
import assert from "node:assert/strict";
import type { NewsletterCampaignStore } from "../server/repositories/newsletterCampaignRepository";
import { createCampaignDraft, transitionCampaign, type EmailCampaign } from "../server/services/newsletterCampaignState";
import { createWeeklyBrevoMarketingProvider, type WeeklyBrevoMarketingProvider } from "../server/services/newsletterWeeklyBrevoProvider";
import { sendWeeklyMarketingNow, sendWeeklyMarketingTest } from "../server/services/newsletterWeeklyDelivery";

const HTML = '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a></body></html>';

function approvedCampaign(editionKey: string, approvedAt: Date): EmailCampaign {
  const createdAt = new Date(approvedAt.getTime() - 60_000);
  const draft = createCampaignDraft(
    null,
    "123",
    { subject: "Achados", html: HTML, text: "Cancelar: {{ unsubscribe }}", offerUrl: "" },
    createdAt,
    "22222222-2222-4222-8222-222222222222",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    editionKey,
  );
  const pending = transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }, approvedAt);
  return transitionCampaign(pending, { type: "approve", actorTelegramId: "123" }, approvedAt);
}

function productionCampaign(approvedAt: Date): EmailCampaign {
  const approved = approvedCampaign("weekly:2026-08-29:stale-guard", approvedAt);
  return transitionCampaign(approved, { type: "confirm_general_send", actorTelegramId: "123" }, approvedAt);
}

function memoryStore(initial: EmailCampaign) {
  let campaign = structuredClone(initial);
  const counters = { createEligibleRecipients: 0, readSubscriber: 0 };
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
  return { store, counters };
}

function mockProvider() {
  const calls = { create: 0, sendTest: 0, sendNow: 0 };
  const provider: WeeklyBrevoMarketingProvider = {
    async createCampaign() {
      calls.create += 1;
      return { status: "succeeded", brevoCampaignId: "91", operation: "create", providerRef: "91", providerReference: "91" };
    },
    async sendTest(id) {
      calls.sendTest += 1;
      return { status: "succeeded", brevoCampaignId: id, operation: "send_test", providerRef: id, providerReference: id };
    },
    async sendNow(id) {
      calls.sendNow += 1;
      return { status: "succeeded", brevoCampaignId: id, operation: "send_now", providerRef: id, providerReference: id };
    },
  };
  return { provider, calls };
}

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NEWSLETTER_WEEKLY_ENABLED: "true",
    BREVO_NEWSLETTER_LIST_ID: "42",
    BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED: "true",
    NEWSLETTER_WEEKLY_APPROVAL_TTL_HOURS: "24",
  };
}

test("weekly-test bloqueia NEWSLETTER_TEST_EMAIL inválido antes do provider/fetch", async () => {
  const campaign = approvedCampaign("weekly-test:2026-08-29:invalid-email", new Date("2026-08-29T03:00:00Z"));
  const memory = memoryStore(campaign);
  let fetchCalls = 0;
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => { fetchCalls += 1; return new Response(null, { status: 204 }); },
  });
  await assert.rejects(
    sendWeeklyMarketingTest(campaign, "123", {
      store: memory.store,
      provider,
      env: { NEWSLETTER_TEST_EMAIL: "not-an-email" },
    }),
    /NEWSLETTER_TEST_EMAIL_MISSING/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("weekly-test bloqueia múltiplos NEWSLETTER_TEST_EMAIL antes do provider/fetch", async () => {
  const campaign = approvedCampaign("weekly-test:2026-08-29:multiple-email", new Date("2026-08-29T03:00:00Z"));
  const memory = memoryStore(campaign);
  let fetchCalls = 0;
  const provider = createWeeklyBrevoMarketingProvider({
    apiKey: "test-key",
    senderEmail: "newsletter@cerberus.example.com",
    fetchImpl: async () => { fetchCalls += 1; return new Response(null, { status: 204 }); },
  });
  await assert.rejects(
    sendWeeklyMarketingTest(campaign, "123", {
      store: memory.store,
      provider,
      env: { NEWSLETTER_TEST_EMAIL: "one@example.com,two@example.com" },
    }),
    /NEWSLETTER_TEST_EMAIL_MISSING/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("weekly production com aprovação exatamente em 24h bloqueia antes de create/sendNow", async () => {
  const now = new Date("2026-08-29T03:00:00Z");
  const campaign = productionCampaign(new Date("2026-08-28T03:00:00Z"));
  const memory = memoryStore(campaign);
  const mock = mockProvider();
  await assert.rejects(
    sendWeeklyMarketingNow(campaign, "123", {
      store: memory.store,
      provider: mock.provider,
      env: validProductionEnv(),
      now,
    }),
    /WEEKLY_MARKETING_PRODUCTION_STALE/,
  );
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});

test("weekly production com aprovação em 23h59m59s permanece válida", async () => {
  const now = new Date("2026-08-29T03:00:00Z");
  const campaign = productionCampaign(new Date("2026-08-28T03:00:01Z"));
  const memory = memoryStore(campaign);
  const mock = mockProvider();
  const sending = await sendWeeklyMarketingNow(campaign, "123", {
    store: memory.store,
    provider: mock.provider,
    env: validProductionEnv(),
    now,
  });
  assert.equal(sending.status, "sending");
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendNow, 1);
  assert.equal(memory.counters.createEligibleRecipients, 0);
  assert.equal(memory.counters.readSubscriber, 0);
});
