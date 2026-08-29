from pathlib import Path

CAMPAIGN = Path("server/services/newsletterWeeklyCampaign.ts")
BOT = Path("server/services/telegramBot.ts")
TEST = Path("tests/newsletterWeeklyTelegramRecovery.test.ts")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


campaign = CAMPAIGN.read_text(encoding="utf-8")

campaign = replace_once(
    campaign,
    '  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;\n  now?: Date;',
    '  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;\n  telegramChatId?: string | number;\n  now?: Date;',
    "WeeklyDraftDeps.telegramChatId",
)

campaign = replace_once(
    campaign,
    'function telegramPreview(campaign: EmailCampaign, products: readonly Product[], copy: WeeklyNewsletterCopy, clickCounts: Map<string, number>, testMode: boolean): string {',
    '''function escapeWeeklyTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function telegramPreview(campaign: EmailCampaign, products: readonly Product[], copy: WeeklyNewsletterCopy, clickCounts: Map<string, number>, testMode: boolean): string {''',
    "escape helper insertion",
)

campaign = replace_once(
    campaign,
    '    return `${index === 0 ? "⭐" : "•"} ${product.displayTitle || product.produto}\\n   R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")} · ${clicks} cliques · confiança ${confidence.confidence}`;',
    '    return `${index === 0 ? "⭐" : "•"} ${escapeWeeklyTelegramHtml(product.displayTitle || product.produto)}\\n   R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")} · ${clicks} cliques · confiança ${confidence.confidence}`;',
    "product title escaping",
)

campaign = replace_once(
    campaign,
    '    `<b>Assunto:</b> ${copy.subject}`,\n    `<b>Preview:</b> ${copy.previewText}`,',
    '    `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(copy.subject)}`,\n    `<b>Preview:</b> ${escapeWeeklyTelegramHtml(copy.previewText)}`,',
    "copy escaping",
)

campaign = replace_once(
    campaign,
    '    `<code>${campaign.id}</code>`,',
    '    `<code>${escapeWeeklyTelegramHtml(campaign.id)}</code>`,',
    "campaign id escaping",
)

notify_block = '''async function notify(sender: WeeklyDraftDeps["telegramSender"], chatId: string, text: string, markup?: unknown): Promise<TelegramDeliveryResult> {
  return (sender || sendTelegramMessage)(chatId, text, markup);
}

'''

recovery = '''async function notify(sender: WeeklyDraftDeps["telegramSender"], chatId: string, text: string, markup?: unknown): Promise<TelegramDeliveryResult> {
  return (sender || sendTelegramMessage)(chatId, text, markup);
}

export type WeeklyDraftCardRecoveryOutcome =
  | { status: "delivered"; campaign: EmailCampaign; messageId: number | null; productCount: number }
  | { status: "not_found" }
  | { status: "delivery_failed"; campaign: EmailCampaign; failureReason: string };

export type WeeklyDraftCardRecoveryDeps = {
  chatId: string | number;
  store?: NewsletterCampaignStore;
  productsLoader?: () => Promise<Product[]>;
  telegramSender?: WeeklyDraftDeps["telegramSender"];
};

export async function redeliverLatestWeeklyTestDraftCard(
  deps: WeeklyDraftCardRecoveryDeps,
): Promise<WeeklyDraftCardRecoveryOutcome> {
  const chatId = String(deps.chatId ?? "").trim();
  if (!chatId) return { status: "not_found" };

  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const recent = await store.listRecentCampaigns(20);
  const campaign = recent.find(item =>
    item.status === "pending_approval" &&
    Boolean(item.editionKey?.startsWith("weekly-test:")),
  );
  if (!campaign) return { status: "not_found" };

  const links = await store.listCampaignProducts(campaign.id);
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const productById = new Map(products.map(product => [product.id, product]));
  const selected = [...links]
    .sort((a, b) => a.position - b.position)
    .map(link => productById.get(link.productId))
    .filter((product): product is Product => Boolean(product));

  const productLines = selected.map((product, index) => {
    const canonicalPrice = product.ofertaPromocional?.source === "admin_confirmed" && product.ofertaPromocional.price > 0
      ? product.ofertaPromocional.price
      : product.preco;
    return `${index === 0 ? "⭐" : "•"} ${escapeWeeklyTelegramHtml(product.displayTitle || product.produto)}\\n   R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")}`;
  });

  const text = [
    "🧪 <b>RASCUNHO SEMANAL — LISTA DE TESTE</b>",
    "",
    "<i>Rascunho existente recuperado sem recriar campanha.</i>",
    "",
    `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(campaign.subject)}`,
    "",
    ...productLines,
    "",
    "Nenhum e-mail foi enviado ainda.",
    "Ao aprovar, somente o destino de teste configurado receberá a campanha.",
    `<code>${escapeWeeklyTelegramHtml(campaign.id)}</code>`,
  ].join("\\n");

  const delivery = await notify(deps.telegramSender, chatId, text, {
    inline_keyboard: [
      [{ text: "✅ Aprovar teste", callback_data: `campaign_weekly_approve:${campaign.id}` }],
      [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
    ],
  });

  if (!delivery.ok) {
    return {
      status: "delivery_failed",
      campaign,
      failureReason: delivery.failureReason || "telegram_delivery_failed",
    };
  }

  const messageId = Number(delivery.result?.message_id);
  const validMessageId = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
  if (validMessageId !== null) {
    await store.saveCampaignTelegramCard(campaign.id, chatId, validMessageId);
  }

  return { status: "delivered", campaign, messageId: validMessageId, productCount: selected.length };
}

'''

campaign = replace_once(campaign, notify_block, recovery, "recovery helper insertion")

campaign = replace_once(
    campaign,
    '    const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();',
    '    const chatId = String(deps.telegramChatId ?? env.TELEGRAM_ADMIN_CHAT_ID ?? "").trim();',
    "manual chat override",
)

CAMPAIGN.write_text(campaign, encoding="utf-8")

bot = BOT.read_text(encoding="utf-8")
bot = replace_once(
    bot,
    'import { runWeeklyDraftCycle } from "./newsletterWeeklyCampaign";',
    'import { redeliverLatestWeeklyTestDraftCard, runWeeklyDraftCycle } from "./newsletterWeeklyCampaign";',
    "telegramBot recovery import",
)
bot = replace_once(
    bot,
    '    const outcome = await runWeeklyDraftCycle({ testMode: true });',
    '    const outcome = await runWeeklyDraftCycle({ testMode: true, telegramChatId: chatId });',
    "telegramBot manual chat propagation",
)
bot = replace_once(
    bot,
    '    if (outcome.status === "skipped" && outcome.reason === "duplicate") {\n',
    '    if (outcome.status === "skipped" && outcome.reason === "duplicate") {\n      const recovery = await redeliverLatestWeeklyTestDraftCard({ chatId });\n      if (recovery.status === "delivered") return;\n',
    "telegramBot duplicate recovery",
)
BOT.write_text(bot, encoding="utf-8")

TEST.write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import {
  redeliverLatestWeeklyTestDraftCard,
  runWeeklyDraftCycle,
} from "../server/services/newsletterWeeklyCampaign";

function product(id: string, title = `Peça ${id}`): Product {
  return {
    id,
    ref: `REF-${id}`,
    produto: `Produto ${id}`,
    displayTitle: title,
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
  return {
    campaigns,
    cards,
    get createCampaignCalls() { return createCampaignCalls; },
    get recipientsCreated() { return recipientsCreated; },
    async createCampaign(c: any) { createCampaignCalls += 1; campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createCampaignProducts(id: string, links: any[]) { campaignProducts.set(id, structuredClone(links)); },
    async listCampaignProducts(id: string) { return structuredClone(campaignProducts.get(id) || []); },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return [...campaigns.values()].map(value => structuredClone(value)).reverse(); },
    async findOperationalCollectionByEditionKey(key: string) {
      return structuredClone([...campaigns.values()].find(value => value.editionKey === key && value.status !== "cancelled") || null);
    },
    async getCampaignTelegramCard(id: string) { return structuredClone(cards.get(id) || null); },
    async saveCampaignTelegramCard(id: string, chatId: string | number, messageId: number) {
      cards.set(id, { campaignId: id, chatId: String(chatId), messageId, updatedAt: new Date().toISOString() });
    },
    async updateCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createEligibleRecipients() { recipientsCreated += 1; throw new Error("RECIPIENT_CREATION_FORBIDDEN"); },
    async claimRecipient() { return null; }, async readSubscriber() { return null; }, async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; }, async markRecipientSkipped() { return null; }, async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; }, async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; }, async listSendingCampaigns() { return []; },
  } as any;
}

const env = {
  TELEGRAM_ADMIN_CHAT_ID: "999999",
  TELEGRAM_ALLOWED_USER_IDS: "123456",
  NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com",
};
const products = [product("a", "Peça <A> & Luz"), product("b"), product("c")];
const copy = {
  subject: "Achados & Design <Seguro>",
  previewText: "Vidro & madeira <curados>",
  heroHeadline: "Forma",
  heroBody: "Texto editorial seguro.",
  secondaryCaptions: { b: "B", c: "C", d: "D" },
};
const institutionalLoader = async () => ({
  privacyUrl: "https://cerberus.example.com/privacy",
  termsUrl: "https://cerberus.example.com/terms",
  socialLinks: [],
});

test("weekly-test manual entrega o card no chat que invocou o comando, não no TELEGRAM_ADMIN_CHAT_ID", async () => {
  const store = memoryStore();
  const chats: string[] = [];
  const texts: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    testMode: true,
    env,
    telegramChatId: "123456",
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => copy,
    institutionalLoader,
    telegramSender: async (chatId, text) => {
      chats.push(String(chatId));
      texts.push(text);
      return { ok: true, result: { message_id: 77 } };
    },
  });

  assert.equal(result.status, "created");
  assert.deepEqual(chats, ["123456"]);
  assert.equal(store.createCampaignCalls, 1);
  assert.equal(store.recipientsCreated, 0);
  assert.match(texts[0], /Peça &lt;A&gt; &amp; Luz/);
  assert.match(texts[0], /Achados &amp; Design &lt;Seguro&gt;/);
  assert.doesNotMatch(texts[0], /Peça <A> & Luz/);
});

test("recovery reexibe o mesmo pending weekly-test sem criar segundo draft ou recipients", async () => {
  const store = memoryStore();
  const first = await runWeeklyDraftCycle({
    store,
    testMode: true,
    env,
    telegramChatId: "123456",
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => copy,
    institutionalLoader,
    telegramSender: async () => ({ ok: false, failureReason: "chat not found" }),
  }).then(
    () => null,
    error => error,
  );

  assert.ok(first);
  assert.equal(store.createCampaignCalls, 1);
  const pending = [...store.campaigns.values()][0];
  assert.equal(pending.status, "pending_approval");

  let sentChat = "";
  let sentMarkup: any = null;
  let sentText = "";
  const recovery = await redeliverLatestWeeklyTestDraftCard({
    store,
    chatId: "123456",
    productsLoader: async () => products,
    telegramSender: async (chatId, text, markup) => {
      sentChat = String(chatId);
      sentText = text;
      sentMarkup = markup;
      return { ok: true, result: { message_id: 88 } };
    },
  });

  assert.equal(recovery.status, "delivered");
  if (recovery.status !== "delivered") throw new Error("recovery should deliver");
  assert.equal(recovery.campaign.id, pending.id);
  assert.equal(sentChat, "123456");
  assert.match(sentText, /Rascunho existente recuperado sem recriar campanha/);
  assert.match(sentText, /Peça &lt;A&gt; &amp; Luz/);
  assert.equal(sentMarkup.inline_keyboard[0][0].callback_data, `campaign_weekly_approve:${pending.id}`);
  assert.equal(sentMarkup.inline_keyboard[1][0].callback_data, `campaign_cancel:${pending.id}`);
  assert.equal(store.cards.get(pending.id).messageId, 88);
  assert.equal(store.createCampaignCalls, 1);
  assert.equal(store.campaigns.size, 1);
  assert.equal(store.recipientsCreated, 0);
});

test("recovery falha fechado quando não há pending weekly-test recuperável", async () => {
  const store = memoryStore();
  let telegramCalls = 0;
  const recovery = await redeliverLatestWeeklyTestDraftCard({
    store,
    chatId: "123456",
    productsLoader: async () => products,
    telegramSender: async () => { telegramCalls += 1; return { ok: true }; },
  });
  assert.deepEqual(recovery, { status: "not_found" });
  assert.equal(telegramCalls, 0);
  assert.equal(store.recipientsCreated, 0);
});
''', encoding="utf-8")

print("PATCH_APPLICATION=PASS")
print("MATERIALIZED_FILES=" + ";".join([str(CAMPAIGN), str(BOT), str(TEST)]))
