import test from "node:test";
import assert from "node:assert/strict";
import {
  createCampaignDraft,
  transitionCampaign,
  type EmailCampaign,
} from "../server/services/newsletterCampaignState";
import {
  retryWeeklyMarketingTest,
} from "../server/services/newsletterWeeklyDelivery";
import type { WeeklyBrevoMarketingProvider } from "../server/services/newsletterWeeklyBrevoProvider";

const HTML = '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a></body></html>';

function approvedWeeklyTest(): EmailCampaign {
  const draft = createCampaignDraft(
    null,
    "123",
    { subject: "Weekly self-heal", html: HTML, text: "Cancelar: {{ unsubscribe }}", offerUrl: "" },
    new Date("2026-08-29T18:00:00Z"),
    "22222222-2222-4222-8222-222222222222",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    "weekly-test:2026-08-29:self-heal",
  );
  const approved = transitionCampaign(
    transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }),
    { type: "approve", actorTelegramId: "123" },
    new Date("2026-08-29T18:01:00Z"),
  );
  return { ...approved, testProviderMessageId: "88" };
}

function memoryStore(initial: EmailCampaign) {
  let campaign = structuredClone(initial);
  return {
    store: {
      async getCampaign(id: string) {
        return id === campaign.id ? structuredClone(campaign) : null;
      },
      async updateCampaign(value: EmailCampaign) {
        campaign = structuredClone(value);
        return structuredClone(campaign);
      },
    } as any,
    read: () => structuredClone(campaign),
  };
}

function providerWithOrder(order: string[]) {
  const calls = { create: 0, sendTest: 0, sendNow: 0 };
  const provider: WeeklyBrevoMarketingProvider = {
    async createCampaign() {
      calls.create += 1;
      throw new Error("CREATE_CAMPAIGN_FORBIDDEN");
    },
    async sendTest(id, emails) {
      calls.sendTest += 1;
      order.push("sendTest");
      assert.equal(id, "88");
      assert.deepEqual(emails, ["only-test@example.com"]);
      return {
        status: "succeeded",
        brevoCampaignId: id,
        operation: "send_test",
        providerRef: id,
        providerReference: id,
      };
    },
    async sendNow() {
      calls.sendNow += 1;
      throw new Error("SEND_NOW_FORBIDDEN");
    },
  };
  return { provider, calls };
}

test("weekly retry prepara o único destinatário antes de um único sendTest e reutiliza a campanha Brevo", async () => {
  const memory = memoryStore(approvedWeeklyTest());
  const order: string[] = [];
  const mock = providerWithOrder(order);
  let ensureCalls = 0;

  const result = await retryWeeklyMarketingTest(memory.read(), "123", {
    store: memory.store,
    env: {
      NEWSLETTER_TEST_EMAIL: "only-test@example.com",
      NEWSLETTER_WEEKLY_ENABLED: "false",
    },
    provider: mock.provider,
    ensureTestRecipient: async () => {
      ensureCalls += 1;
      order.push("ensure");
      return { provider: "BREVO", state: "ready", associated: true, blacklisted: false };
    },
  });

  assert.deepEqual(order, ["ensure", "sendTest"]);
  assert.equal(ensureCalls, 1);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 1);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(result.providerCampaignId, "88");
  assert.equal(result.providerCampaignCreatedThisAttempt, false);
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(memory.read().testProviderMessageId, "88");
});

test("falha no preparo do destinatário bloqueia sendTest e preserva a campanha approved", async () => {
  const memory = memoryStore(approvedWeeklyTest());
  const order: string[] = [];
  const mock = providerWithOrder(order);

  await assert.rejects(
    retryWeeklyMarketingTest(memory.read(), "123", {
      store: memory.store,
      env: {
        NEWSLETTER_TEST_EMAIL: "only-test@example.com",
        NEWSLETTER_WEEKLY_ENABLED: "false",
      },
      provider: mock.provider,
      ensureTestRecipient: async () => {
        order.push("ensure");
        throw new Error("WEEKLY_BREVO_TEST_RECIPIENT_BLACKLISTED");
      },
    }),
    /WEEKLY_BREVO_TEST_RECIPIENT_BLACKLISTED/,
  );

  assert.deepEqual(order, ["ensure"]);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 0);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(memory.read().status, "approved");
  assert.equal(memory.read().testProviderMessageId, "88");
});

test("recipient self-heal não roda se houver qualquer recipient real na campanha", async () => {
  const unsafe = approvedWeeklyTest();
  unsafe.counts = { total: 1, success: 0, failed: 0, skipped: 0 };
  const memory = memoryStore(unsafe);
  const order: string[] = [];
  const mock = providerWithOrder(order);
  let ensureCalls = 0;

  await assert.rejects(
    retryWeeklyMarketingTest(memory.read(), "123", {
      store: memory.store,
      env: { NEWSLETTER_TEST_EMAIL: "only-test@example.com" },
      provider: mock.provider,
      ensureTestRecipient: async () => { ensureCalls += 1; },
    }),
    /WEEKLY_MARKETING_TEST_REAL_RECIPIENTS_FORBIDDEN/,
  );

  assert.equal(ensureCalls, 0);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendTest, 0);
  assert.equal(mock.calls.sendNow, 0);
});
