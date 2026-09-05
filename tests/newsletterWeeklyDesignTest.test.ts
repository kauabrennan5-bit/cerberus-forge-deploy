import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { runWeeklyDraftCycle } from "../server/services/newsletterWeeklyCampaign";
import { confirmGeneralSend, startGeneralSend } from "../server/services/newsletterCampaignService";
import { selectWeeklyDesignTestProducts } from "../server/services/newsletterWeeklyDesignTest";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageUrlFingerprint,
} from "../server/services/productEditorialReview";

const NOW = new Date("2026-08-30T21:30:00Z");

function baseProduct(id: string, createdAt: string): Product {
  return {
    id,
    ref: `REF-${id.toUpperCase()}`,
    produto: `Título marketplace cru ${id}`,
    rawTitle: `Título marketplace cru ${id}`,
    categoria: id === "a" ? "Iluminação" : id === "b" ? "Cozinha & Mesa" : "Beleza & Bem-estar",
    preco: 100 + id.charCodeAt(0),
    imagens: [`https://cdn.example.com/${id}.jpg`],
    link: `https://market.example.com/product/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    createdAt,
  };
}

function reviewedProduct(id: string, createdAt: string): Product {
  const product = baseProduct(id, createdAt);
  const image = product.imagens[0];
  return {
    ...product,
    displayTitle: `Peça editorial ${id.toUpperCase()}`,
    displayTitleStatus: "reviewed",
    displayTitleReviewedAt: createdAt,
    displayTitleReviewModel: "fixture-title-review",
    displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION,
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [image],
      primaryImageUrl: image,
      galleryImageUrls: [],
      assessments: [{ url: image, decision: "clean", confidence: "HIGH", reason: "fixture" }],
    },
    imageReviewedAt: createdAt,
    imageReviewModel: "fixture-image-review",
    imageReviewVersion: IMAGE_REVIEW_VERSION,
    imageReviewFingerprint: imageUrlFingerprint(image),
  };
}

function memoryStore() {
  const campaigns = new Map<string, any>();
  let recipientCalls = 0;
  return {
    campaigns,
    get recipientCalls() { return recipientCalls; },
    async createCampaign(campaign: any) { campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); },
    async createCampaignProducts() {},
    async listCampaignProducts() { return []; },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return []; },
    async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; },
    async saveCampaignTelegramCard() {},
    async updateCampaign(campaign: any) { campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); },
    async createEligibleRecipients() { recipientCalls += 1; throw new Error("DESIGN_TEST_RECIPIENTS_FORBIDDEN"); },
    async claimRecipient() { return null; },
    async readSubscriber() { return null; },
    async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; },
    async markRecipientSkipped() { return null; },
    async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; },
    async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; },
    async listSendingCampaigns() { return []; },
  } as any;
}

const env = {
  TELEGRAM_ADMIN_CHAT_ID: "123",
  TELEGRAM_ALLOWED_USER_IDS: "123",
  NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com",
  NEWSLETTER_PREVIEW_SIGNING_SECRET: "design-test-preview-secret-at-least-24-chars",
};

test("design-test projeta exatamente oito cards sem alterar os produtos canônicos", () => {
  const products = [
    reviewedProduct("a", "2026-08-30T20:00:00Z"),
    reviewedProduct("b", "2026-08-30T19:00:00Z"),
    baseProduct("c", "2026-08-30T18:00:00Z"),
    baseProduct("d", "2026-08-30T17:00:00Z"),
    baseProduct("e", "2026-08-30T16:00:00Z"),
    baseProduct("f", "2026-08-30T15:00:00Z"),
    baseProduct("g", "2026-08-30T14:00:00Z"),
    baseProduct("h", "2026-08-30T13:00:00Z"),
  ];
  const before = structuredClone(products);
  const selection = selectWeeklyDesignTestProducts(products, NOW);

  assert.equal(selection.products.length, 8);
  assert.deepEqual(selection.products.map(product => product.id), ["a", "b", "c", "d", "e", "f", "g", "h"]);
  const projected = selection.products[2];
  assert.equal(projected.displayTitle, "Seleção Cerberus 3");
  assert.equal(projected.imageCuration?.status, "ready");
  assert.equal(projected.displayTitleReviewModel, "weekly-design-test-exception");
  assert.deepEqual(products, before);
});

test("design-test cria weekly-test sanitizada, não usa Gemini e não cria recipients", async () => {
  const store = memoryStore();
  let copyGeneratorCalls = 0;
  const products = [
    reviewedProduct("a", "2026-08-30T20:00:00Z"),
    reviewedProduct("b", "2026-08-30T19:00:00Z"),
    baseProduct("c", "2026-08-30T18:00:00Z"),
    baseProduct("d", "2026-08-30T17:00:00Z"),
    baseProduct("e", "2026-08-30T16:00:00Z"),
    baseProduct("f", "2026-08-30T15:00:00Z"),
    baseProduct("g", "2026-08-30T14:00:00Z"),
    baseProduct("h", "2026-08-30T13:00:00Z"),
  ];
  const result = await runWeeklyDraftCycle({
    store,
    designTestMode: true,
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => {
      copyGeneratorCalls += 1;
      throw new Error("GEMINI_MUST_NOT_RUN_FOR_DESIGN_TEST");
    },
    institutionalLoader: async () => ({ socialLinks: [] }) as any,
    telegramSender: async () => ({ ok: true, result: { message_id: 91 } }),
    now: NOW,
    env,
  });

  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.match(String(result.campaign.editionKey), /^weekly-test:design:/);
  assert.equal(result.campaign.subject, "[Teste controlado] Novidades da semana — Edição 2026-08-30 · 8 novos achados");
  assert.match(result.campaign.bodyHtml, /Seleção Cerberus 3/);
  assert.doesNotMatch(result.campaign.bodyHtml, /Título marketplace cru c/);
  assert.equal((result.campaign.bodyHtml.match(/cerberus-logo-user-tight\.png/g) || []).length, 1);
  assert.match(result.campaign.bodyHtml, /class="email-masthead-logo"[^>]+width="96" height="70"/);
  assert.doesNotMatch(result.campaign.bodyHtml, /email-masthead-logo-print/);
  assert.doesNotMatch(result.campaign.bodyHtml, /class="email-masthead-image"/);
  assert.match(result.campaign.bodyHtml, />08<\/font>/);
  assert.match(result.campaign.bodyHtml, /UM OLHAR ATENTO PARA O QUE ENTRA\./);
  assert.equal((result.campaign.bodyHtml.match(/class="editorial-block editorial-micro"/g) || []).length, 3);
  assert.equal((result.campaign.bodyHtml.match(/class="editorial-grid-cell email-collection-grid-cell"/g) || []).length, 4);
  assert.equal((result.campaign.bodyHtml.match(/class="editorial-block editorial-horizontal"/g) || []).length, 1);
  assert.equal((result.campaign.bodyHtml.match(/class="editorial-block editorial-compact"/g) || []).length, 2);
  assert.equal(result.campaign.counts.total, 0);
  assert.equal(copyGeneratorCalls, 0);
  await assert.rejects(
    confirmGeneralSend(result.campaign, "123", { store }),
    /WEEKLY_MARKETING_TEST_GENERAL_SEND_FORBIDDEN/,
  );
  await assert.rejects(
    startGeneralSend(result.campaign, "123", { store }),
    /WEEKLY_MARKETING_TEST_GENERAL_SEND_FORBIDDEN/,
  );
  assert.equal(store.recipientCalls, 0);
});

test("weekly-test normal continua bloqueada com somente dois produtos editorialmente aptos", async () => {
  const store = memoryStore();
  const messages: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    testMode: true,
    productsLoader: async () => [
      reviewedProduct("a", "2026-08-30T20:00:00Z"),
      reviewedProduct("b", "2026-08-30T19:00:00Z"),
      baseProduct("c", "2026-08-30T18:00:00Z"),
    ],
    telegramSender: async (_chat, text) => { messages.push(text); return { ok: true, result: { message_id: 92 } }; },
    now: NOW,
    env,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "insufficient_new_products");
  assert.match(messages[0], /elegíveis: 2/);
  assert.equal(store.campaigns.size, 0);
  assert.equal(store.recipientCalls, 0);
});

test("design-test falha fechada quando não existem oito produtos tecnicamente renderizáveis", async () => {
  const store = memoryStore();
  const result = await runWeeklyDraftCycle({
    store,
    designTestMode: true,
    productsLoader: async () => [
      reviewedProduct("a", "2026-08-30T20:00:00Z"),
      reviewedProduct("b", "2026-08-30T19:00:00Z"),
    ],
    telegramSender: async () => ({ ok: true, result: { message_id: 93 } }),
    now: NOW,
    env,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no_new_products");
  assert.equal(store.campaigns.size, 0);
});
