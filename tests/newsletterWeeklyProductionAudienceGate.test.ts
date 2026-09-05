import test from "node:test";
import assert from "node:assert/strict";
import { createCampaignDraft, transitionCampaign, type EmailCampaign } from "../server/services/newsletterCampaignState";
import { sendWeeklyMarketingNow } from "../server/services/newsletterWeeklyDelivery";
import type { WeeklyBrevoMarketingProvider } from "../server/services/newsletterWeeklyBrevoProvider";

const HTML = '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a></body></html>';

function productionCampaign(): EmailCampaign {
  const draft = createCampaignDraft(
    null,
    "123",
    { subject: "Weekly production", html: HTML, text: "Cancelar: {{ unsubscribe }}", offerUrl: "" },
    new Date("2026-08-29T18:00:00Z"),
    "33333333-3333-4333-8333-333333333333",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    "weekly:2026-08-29:production-audience",
  );
  const approved = transitionCampaign(
    transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }),
    { type: "approve", actorTelegramId: "123" },
    new Date("2026-08-29T18:01:00Z"),
  );
  return transitionCampaign(
    approved,
    { type: "confirm_general_send", actorTelegramId: "123" },
    new Date("2026-08-29T18:02:00Z"),
  );
}

function memoryStore(initial: EmailCampaign, order?: string[]) {
  let campaign = structuredClone(initial);
  let recipientCreates = 0;
  return {
    store: {
      async getCampaign(id: string) { return id === campaign.id ? structuredClone(campaign) : null; },
      async updateCampaign(value: EmailCampaign) {
        if (value.status === "sending" && campaign.status !== "sending") order?.push("persist:sending");
        campaign = structuredClone(value);
        return structuredClone(campaign);
      },
      async createEligibleRecipients() { recipientCreates += 1; return 0; },
    } as any,
    readRecipientCreates: () => recipientCreates,
  };
}

function provider(order: string[]) {
  const calls = { create: 0, sendNow: 0, sendTest: 0, listIds: [] as number[], subject: "" };
  const value: WeeklyBrevoMarketingProvider = {
    async createCampaign(input) {
      calls.create += 1;
      calls.listIds = [...(input.listIds || [])];
      calls.subject = input.subject;
      order.push("create");
      return { status: "succeeded", brevoCampaignId: "123", operation: "create", providerRef: "123", providerReference: "123" };
    },
    async sendTest() {
      calls.sendTest += 1;
      throw new Error("SEND_TEST_FORBIDDEN");
    },
    async sendNow(id) {
      calls.sendNow += 1;
      order.push("sendNow");
      return { status: "succeeded", brevoCampaignId: id, operation: "send_now", providerRef: id, providerReference: id };
    },
  };
  return { value, calls };
}

test("produção persiste sending antes de sendNow e preserva o assunto editorial de produção", async () => {
  const campaign = productionCampaign();
  const order: string[] = [];
  const memory = memoryStore(campaign, order);
  const mock = provider(order);
  const result = await sendWeeklyMarketingNow(campaign, "123", {
    store: memory.store,
    provider: mock.value,
    env: {},
    now: new Date("2026-08-29T18:03:00Z"),
    productionEnabledCheck: async () => true,
    productionAudienceSync: async () => {
      order.push("sync");
      return { listId: 77, eligibleSubscribers: 4, brevoMembers: 4 };
    },
  });
  assert.deepEqual(order, ["sync", "create", "persist:sending", "sendNow"]);
  assert.deepEqual(mock.calls.listIds, [77]);
  assert.equal(mock.calls.subject, "Weekly production");
  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendNow, 1);
  assert.equal(mock.calls.sendTest, 0);
  assert.equal(memory.readRecipientCreates(), 0);
  assert.equal(result.status, "sending");
});

test("produção bloqueia audience mismatch antes de create/sendNow", async () => {
  const campaign = productionCampaign();
  const order: string[] = [];
  const memory = memoryStore(campaign, order);
  const mock = provider(order);
  await assert.rejects(
    sendWeeklyMarketingNow(campaign, "123", {
      store: memory.store,
      provider: mock.value,
      env: {},
      now: new Date("2026-08-29T18:03:00Z"),
      productionEnabledCheck: async () => true,
      productionAudienceSync: async () => {
        order.push("sync");
        return { listId: 77, eligibleSubscribers: 4, brevoMembers: 3 };
      },
    }),
    /RECIPIENT_STRATEGY_UNVERIFIED/,
  );
  assert.deepEqual(order, ["sync"]);
  assert.equal(mock.calls.create, 0);
  assert.equal(mock.calls.sendNow, 0);
  assert.equal(memory.readRecipientCreates(), 0);
});

test("replay da mesma campanha não chama sendNow uma segunda vez", async () => {
  const campaign = productionCampaign();
  const order: string[] = [];
  const memory = memoryStore(campaign, order);
  const mock = provider(order);
  const options = {
    store: memory.store,
    provider: mock.value,
    env: {},
    now: new Date("2026-08-29T18:03:00Z"),
    productionEnabledCheck: async () => true,
    productionAudienceSync: async () => {
      order.push("sync");
      return { listId: 77, eligibleSubscribers: 4, brevoMembers: 4 };
    },
  };

  await sendWeeklyMarketingNow(campaign, "123", options);
  await assert.rejects(
    sendWeeklyMarketingNow(campaign, "123", options),
    /WEEKLY_MARKETING_PRODUCTION_APPROVAL_REQUIRED/,
  );

  assert.equal(mock.calls.create, 1);
  assert.equal(mock.calls.sendNow, 1);
  assert.equal(order.filter(step => step === "sendNow").length, 1);
});
