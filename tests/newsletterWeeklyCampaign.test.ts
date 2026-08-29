import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { buildWeeklyCopyPrompt, sanitizeWeeklyNewsletterCopy } from "../server/services/newsletterWeeklyCopy";
import { buildWeeklyGoUrl, renderWeeklyNewsletter, BREVO_NATIVE_UNSUBSCRIBE } from "../server/services/newsletterWeeklyTemplate";
import { runWeeklyDraftCycle } from "../server/services/newsletterWeeklyCampaign";

function product(id: string, ref: string, createdAt: string, price: number, clicks = 0): Product & { clicks?: number } {
  return {
    id, ref, produto: `Produto ${id}`, displayTitle: `Peça editorial ${id}`, categoria: "Iluminação", preco: price,
    imagens: [`https://cdn.example.com/${id}.jpg`], imageEditorialStatus: "clean", link: `https://market.example.com/${id}`,
    ativo: true, destaque: false, status: "published", descricao: `Descrição factual ${id}`, createdAt, clicks,
  };
}

function memoryStore() {
  const campaigns = new Map<string, any>();
  return {
    campaigns,
    async createCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createCampaignProducts() {}, async listCampaignProducts() { return []; },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return []; }, async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; }, async saveCampaignTelegramCard() {},
    async updateCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createEligibleRecipients() { throw new Error("REAL_RECIPIENTS_MUST_NOT_BE_CREATED_DURING_DRAFT"); },
    async claimRecipient() { return null; }, async readSubscriber() { return null; }, async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; }, async markRecipientSkipped() { return null; }, async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; }, async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; }, async listSendingCampaigns() { return []; },
  } as any;
}

const copy = { subject: "Achados da semana", previewText: "Uma curadoria curta para esta semana.", heroHeadline: "Forma que merece atenção", heroBody: "Uma peça de presença limpa, escolhida pela forma e pelo uso.", secondaryCaptions: { b: "Uma leitura compacta e direta.", c: "Geometria simples para o cotidiano.", d: "Uma peça discreta com desenho marcado." } };

test("prompt Gemini semanal não recebe preço, disponibilidade nem links", () => {
  const p = product("a", "REF-A", "2026-08-28T12:00:00Z", 987.65);
  const prompt = buildWeeklyCopyPrompt([p]);
  assert.doesNotMatch(prompt, /987[.,]65/);
  assert.doesNotMatch(prompt, /market\.example\.com/);
  assert.doesNotMatch(prompt, /\"preco\"|\"link\"|\"availability\"/i);
});

test("copy rejeita preço ou disponibilidade inventados", () => {
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30)];
  assert.throws(() => sanitizeWeeklyNewsletterCopy({ ...copy, heroBody: "Disponível agora por R$ 10" }, products), /COMMERCIAL_FACT_FORBIDDEN/);
});

test("template usa preço canônico, tabelas, bgcolor, /go/:ref e unsubscribe nativo Brevo", () => {
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30)];
  const rendered = renderWeeklyNewsletter(products, copy, { campaignId: "camp-1", publicBaseUrl: "https://cerberus.example.com", socialLinks: [] });
  assert.match(rendered.html, /<table\b/i);
  assert.match(rendered.html, /bgcolor="#0a0a0a"/i);
  assert.match(rendered.html, /#c0392b/i);
  assert.match(rendered.html, /R\$\s*10,00/);
  assert.match(rendered.html, /\/go\/REF-A/);
  assert.doesNotMatch(rendered.html, /market\.example\.com/);
  assert.match(rendered.html, new RegExp(BREVO_NATIVE_UNSUBSCRIBE.replace(/[{}]/g, "\\$&")));
  assert.doesNotMatch(rendered.html, /display\s*:\s*(flex|grid)/i);
});

test("URL semanal sempre usa redirect mascarado e campaign_id", () => {
  const url = buildWeeklyGoUrl("https://cerberus.example.com", product("a", "REF 21", "2026-08-28T12:00:00Z", 10), "campaign-xyz", 1);
  assert.match(url, /^https:\/\/cerberus\.example\.com\/go\/REF%2021\?/);
  assert.match(url, /campaign_id=campaign-xyz/);
});

test("sem produto novo pula ciclo, notifica e não cria campanha", async () => {
  const store = memoryStore();
  const messages: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => [product("a", "REF-A", "2026-08-20T12:00:00Z", 10)],
    lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    telegramSender: async (_chat, text) => { messages.push(text); return { ok: true, result: { message_id: 1 } }; },
    now: new Date("2026-08-28T15:00:00Z"),
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com", NEWSLETTER_WEEKLY_ENABLED: "true" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(store.campaigns.size, 0);
  assert.match(messages[0], /Sem produto genuinamente novo/i);
});

test("draft semanal exige 1 destaque + ao menos 2 secundários", async () => {
  const store = memoryStore();
  const messages: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20)],
    lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    telegramSender: async (_chat, text) => { messages.push(text); return { ok: true, result: { message_id: 1 } }; },
    now: new Date("2026-08-28T15:00:00Z"), env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com", NEWSLETTER_WEEKLY_ENABLED: "true" },
  });
  assert.equal(result.status, "skipped");
  assert.match(messages[0], /mínimo 3|pelo menos 2 secundários/i);
});

test("draft completo persiste pending_approval e nunca cria recipients antes do clique humano", async () => {
  const store = memoryStore();
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30), product("d", "REF-D", "2026-08-28T09:00:00Z", 40)];
  let markup: any = null;
  const result = await runWeeklyDraftCycle({
    store, productsLoader: async () => products, lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    clickCountLoader: async () => new Map([["a", 0], ["b", 4], ["c", 1], ["d", 0]]), copyGenerator: async () => copy,
    telegramSender: async (_chat, _text, m) => { markup = m; return { ok: true, result: { message_id: 77 } }; },
    now: new Date("2026-08-28T15:00:00Z"), env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com", NEWSLETTER_WEEKLY_ENABLED: "true" },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.campaign.status, "pending_approval");
  assert.match(String(markup.inline_keyboard[0][0].callback_data), /^campaign_weekly_approve:/);
  assert.equal(store.campaigns.size, 1);
});


test("produção semanal fica desabilitada por padrão e não toca dados", async () => {
  const store = memoryStore();
  let productsLoaded = false;
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => { productsLoaded = true; return []; },
    env: {},
  });
  assert.deepEqual(result, { status: "skipped", reason: "disabled", newProductCount: 0 });
  assert.equal(productsLoaded, false);
  assert.equal(store.campaigns.size, 0);
});

test("weekly-test independe do flag de produção e continua sem recipients reais", async () => {
  const store = memoryStore();
  const products = [
    product("a", "REF-A", "2026-08-28T12:00:00Z", 10),
    product("b", "REF-B", "2026-08-28T11:00:00Z", 20),
    product("c", "REF-C", "2026-08-28T10:00:00Z", 30),
  ];
  const result = await runWeeklyDraftCycle({
    store,
    testMode: true,
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => copy,
    telegramSender: async () => ({ ok: true, result: { message_id: 88 } }),
    now: new Date("2026-08-28T15:00:00Z"),
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.match(String(result.campaign.editionKey), /^weekly-test:/);
  assert.equal(result.campaign.status, "pending_approval");
  assert.equal(store.campaigns.size, 1);
});
