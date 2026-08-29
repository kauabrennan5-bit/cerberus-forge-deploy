import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import {
  redeliverLatestWeeklyTestDraftCard,
  runWeeklyDraftCycle,
} from "../server/services/newsletterWeeklyCampaign";
import { executeWeeklyTestCommand } from "../server/services/telegramBot";
import { isWeeklyDraftDiagnosticError } from "../server/services/newsletterWeeklyDiagnostics";

function product(id: string): Product {
  return {
    id,
    ref: `REF-${id}`,
    produto: `Produto ${id}`,
    displayTitle: `Peça ${id}`,
    categoria: "Iluminação",
    preco: 10,
    imagens: [`https://cdn.example.com/${id}.jpg`],
    imageEditorialStatus: "clean",
    link: `https://market.example.com/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    descricao: `Descrição ${id}`,
    createdAt: "2026-08-29T02:00:00Z",
  } as Product;
}

function memoryStore() {
  const campaigns = new Map<string, any>();
  const campaignProducts = new Map<string, any[]>();
  const cards = new Map<string, any>();
  let createCampaignCalls = 0;
  let recipientsCreated = 0;
  let subscriberReads = 0;

  return {
    campaigns,
    cards,
    get createCampaignCalls() { return createCampaignCalls; },
    get recipientsCreated() { return recipientsCreated; },
    get subscriberReads() { return subscriberReads; },
    async createCampaign(campaign: any) {
      createCampaignCalls += 1;
      campaigns.set(campaign.id, structuredClone(campaign));
      return structuredClone(campaign);
    },
    async createCampaignProducts(campaignId: string, links: any[]) {
      campaignProducts.set(campaignId, structuredClone(links));
    },
    async listCampaignProducts(campaignId: string) {
      return structuredClone(campaignProducts.get(campaignId) || []);
    },
    async getCampaign(campaignId: string) {
      return structuredClone(campaigns.get(campaignId) || null);
    },
    async listRecentCampaigns() {
      return [...campaigns.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map(value => structuredClone(value));
    },
    async findOperationalCollectionByEditionKey(editionKey: string) {
      const campaign = [...campaigns.values()].find(value =>
        value.editionKey === editionKey && value.status !== "cancelled",
      );
      return structuredClone(campaign || null);
    },
    async getCampaignTelegramCard(campaignId: string) {
      return structuredClone(cards.get(campaignId) || null);
    },
    async saveCampaignTelegramCard(campaignId: string, chatId: string | number, messageId: number) {
      cards.set(campaignId, { campaignId, chatId: String(chatId), messageId });
    },
    async updateCampaign(campaign: any) {
      campaigns.set(campaign.id, structuredClone(campaign));
      return structuredClone(campaign);
    },
    async createEligibleRecipients() {
      recipientsCreated += 1;
      throw new Error("RECIPIENT_CREATION_FORBIDDEN");
    },
    async claimRecipient() { return null; },
    async readSubscriber() { subscriberReads += 1; return null; },
    async prepareUnsubscribeToken() { throw new Error("UNSUBSCRIBE_TOKEN_FORBIDDEN"); },
    async markRecipientSent() { return null; },
    async markRecipientSkipped() { return null; },
    async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; },
    async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; },
    async listSendingCampaigns() { return []; },
  } as any;
}

const commandChatId = "123456";
const env = {
  TELEGRAM_ADMIN_CHAT_ID: "invalid-configured-target",
  TELEGRAM_ALLOWED_USER_IDS: commandChatId,
  NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com",
};
const products = [product("a"), product("b"), product("c"), product("d")];
const copy = {
  subject: "Achados & Design <Seguro>",
  previewText: "Curadoria semanal segura.",
  heroHeadline: "Forma",
  heroBody: "Texto editorial seguro.",
  secondaryCaptions: { b: "B", c: "C", d: "D" },
};
const institutionalLoader = async () => ({
  privacyUrl: "https://cerberus.example.com/privacy",
  termsUrl: "https://cerberus.example.com/terms",
  socialLinks: [],
});

async function createPendingDraftAfterTelegramFailure(store: ReturnType<typeof memoryStore>) {
  await assert.rejects(
    runWeeklyDraftCycle({
      store,
      testMode: true,
      env,
      telegramChatId: commandChatId,
      productsLoader: async () => products,
      clickCountLoader: async () => new Map(),
      copyGenerator: async () => copy,
      institutionalLoader,
      telegramSender: async () => ({ ok: false, failureReason: "transport detail" }),
      now: new Date("2026-08-29T16:14:00Z"),
    }),
    error => {
      assert.ok(isWeeklyDraftDiagnosticError(error));
      assert.equal(error.diagnostic.stage, "TELEGRAM_DELIVERY");
      assert.equal(error.diagnostic.reason, "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED");
      return true;
    },
  );
  const campaign = [...store.campaigns.values()][0];
  assert.ok(campaign);
  assert.equal(campaign.status, "pending_approval");
  return campaign;
}

test("weekly-test manual usa o chat autorizado que invocou o comando", async () => {
  const store = memoryStore();
  const chats: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    testMode: true,
    env,
    telegramChatId: commandChatId,
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => copy,
    institutionalLoader,
    telegramSender: async chatId => {
      chats.push(String(chatId));
      return { ok: true, result: { message_id: 77 } };
    },
    now: new Date("2026-08-29T16:14:00Z"),
  });

  assert.equal(result.status, "created");
  assert.deepEqual(chats, [commandChatId]);
  assert.notEqual(commandChatId, env.TELEGRAM_ADMIN_CHAT_ID);
  assert.equal(store.createCampaignCalls, 1);
  assert.equal(store.recipientsCreated, 0);
  assert.equal(store.subscriberReads, 0);
});

test("segunda tentativa reexibe o mesmo pending weekly-test antes de iniciar outro ciclo", async () => {
  const store = memoryStore();
  const pending = await createPendingDraftAfterTelegramFailure(store);
  let recoveryCalls = 0;
  let draftCycleCalls = 0;
  let sentText = "";
  let sentMarkup: any = null;
  let brevoCreateCalls = 0;
  let brevoSendTestCalls = 0;
  let brevoSendNowCalls = 0;

  await executeWeeklyTestCommand(commandChatId, {
    recoverDraftCard: async ({ chatId }) => {
      recoveryCalls += 1;
      return redeliverLatestWeeklyTestDraftCard({
        store,
        chatId,
        telegramSender: async (target, text, markup) => {
          assert.equal(String(target), commandChatId);
          sentText = text;
          sentMarkup = markup;
          return { ok: true, result: { message_id: 88 } };
        },
      });
    },
    runDraftCycle: async () => {
      draftCycleCalls += 1;
      throw new Error("SECOND_DRAFT_FORBIDDEN");
    },
    sendMessage: async () => ({ ok: true }),
  });

  const after = [...store.campaigns.values()][0];
  assert.equal(recoveryCalls, 1);
  assert.equal(draftCycleCalls, 0);
  assert.equal(store.createCampaignCalls, 1);
  assert.equal(store.campaigns.size, 1);
  assert.equal(after.id, pending.id);
  assert.equal(after.status, "pending_approval");
  assert.match(sentText, /Rascunho existente recuperado sem recriar campanha/);
  assert.match(sentText, /Achados &amp; Design &lt;Seguro&gt;/);
  assert.equal(sentMarkup.inline_keyboard[0][0].text, "✅ Aprovar teste");
  assert.equal(sentMarkup.inline_keyboard[0][0].callback_data, `campaign_weekly_approve:${pending.id}`);
  assert.equal(sentMarkup.inline_keyboard[1][0].text, "❌ Cancelar");
  assert.equal(sentMarkup.inline_keyboard[1][0].callback_data, `campaign_cancel:${pending.id}`);
  assert.equal(store.cards.get(pending.id).messageId, 88);
  assert.equal(store.recipientsCreated, 0);
  assert.equal(store.subscriberReads, 0);
  assert.equal(brevoCreateCalls, 0);
  assert.equal(brevoSendTestCalls, 0);
  assert.equal(brevoSendNowCalls, 0);
});

test("falha no retry Telegram preserva o draft e nunca cai para criação", async () => {
  const store = memoryStore();
  const pending = await createPendingDraftAfterTelegramFailure(store);
  let draftCycleCalls = 0;
  const fallbackMessages: string[] = [];

  await executeWeeklyTestCommand(commandChatId, {
    recoverDraftCard: ({ chatId }) => redeliverLatestWeeklyTestDraftCard({
      store,
      chatId,
      telegramSender: async () => ({ ok: false, failureReason: "retry transport detail" }),
    }),
    runDraftCycle: async () => {
      draftCycleCalls += 1;
      throw new Error("SECOND_DRAFT_FORBIDDEN");
    },
    sendMessage: async (_chatId, text) => {
      fallbackMessages.push(text);
      return { ok: true };
    },
  });

  const after = [...store.campaigns.values()][0];
  assert.equal(draftCycleCalls, 0);
  assert.equal(store.createCampaignCalls, 1);
  assert.equal(store.campaigns.size, 1);
  assert.equal(after.id, pending.id);
  assert.equal(after.status, "pending_approval");
  assert.match(fallbackMessages[0], /rascunho existente foi preservado/i);
  assert.equal(store.recipientsCreated, 0);
  assert.equal(store.subscriberReads, 0);
});

test("falha ao consultar recovery permanece fail-closed e não cria draft", async () => {
  let draftCycleCalls = 0;
  const messages: string[] = [];
  await executeWeeklyTestCommand(commandChatId, {
    recoverDraftCard: async () => { throw new Error("database detail"); },
    runDraftCycle: async () => {
      draftCycleCalls += 1;
      throw new Error("SECOND_DRAFT_FORBIDDEN");
    },
    sendMessage: async (_chatId, text) => {
      messages.push(text);
      return { ok: true };
    },
  });
  assert.equal(draftCycleCalls, 0);
  assert.match(messages[0], /UNKNOWN_INTERNAL/);
  assert.doesNotMatch(messages[0], /database detail/);
});

test("recovery sem pending weekly-test não chama Telegram", async () => {
  const store = memoryStore();
  let telegramCalls = 0;
  const result = await redeliverLatestWeeklyTestDraftCard({
    store,
    chatId: commandChatId,
    telegramSender: async () => {
      telegramCalls += 1;
      return { ok: true };
    },
  });
  assert.deepEqual(result, { status: "not_found" });
  assert.equal(telegramCalls, 0);
  assert.equal(store.createCampaignCalls, 0);
  assert.equal(store.recipientsCreated, 0);
});
