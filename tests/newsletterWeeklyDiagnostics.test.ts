import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { runWeeklyDraftCycle } from "../server/services/newsletterWeeklyCampaign";
import { formatWeeklyDraftDiagnosticTelegram, isWeeklyDraftDiagnosticError } from "../server/services/newsletterWeeklyDiagnostics";
import { IMAGE_REVIEW_VERSION, DISPLAY_TITLE_REVIEW_VERSION, imageUrlFingerprint } from "../server/services/productEditorialReview";

function product(id: string, createdAt = "2026-08-29T02:00:00Z"): Product {
  const image = `https://cdn.example.com/${id}.jpg`;
  return {
    id, ref: `REF-${id}`, produto: `Produto bruto ${id}`, rawTitle: `Produto bruto ${id}`, displayTitle: `Peça curada série ${id}xx`, displayTitleStatus: "ready", displayTitleReviewedAt: createdAt, displayTitleReviewModel: "test", displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION, categoria: "Iluminação", preco: 10,
    imagens: [image], imageEditorialStatus: "clean", imageCuration: { status: "ready", rawImageUrls: [image], primaryImageUrl: image, galleryImageUrls: [], assessments: [{ url: image, decision: "clean", confidence: "HIGH", reason: "fixture" }] }, imageReviewedAt: createdAt, imageReviewModel: "test", imageReviewVersion: IMAGE_REVIEW_VERSION, imageReviewFingerprint: imageUrlFingerprint(image), link: `https://market.example.com/${id}`,
    ativo: true, destaque: false, status: "published", descricao: `Descrição ${id}`, createdAt,
  } as Product;
}

function store() {
  const campaigns = new Map<string, any>();
  return {
    campaigns,
    async createCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createCampaignProducts() {},
    async listCampaignProducts() { return []; },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return []; },
    async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; },
    async saveCampaignTelegramCard() {},
    async updateCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createEligibleRecipients() { throw new Error("REAL_RECIPIENTS_MUST_NOT_BE_CREATED"); },
    async claimRecipient() { return null; }, async readSubscriber() { return null; }, async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; }, async markRecipientSkipped() { return null; }, async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; }, async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; }, async listSendingCampaigns() { return []; },
  } as any;
}

const env = { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" };
const copy = { subject: "Achados", previewText: "Preview", heroHeadline: "Forma", heroBody: "Texto editorial seguro.", secondaryCaptions: { b: "B", c: "C", d: "D" } };
const products = [product("a"), product("b"), product("c")];
const institutionalLoader = async () => ({ privacyUrl: "https://cerberus.example.com/privacy", termsUrl: "https://cerberus.example.com/terms", socialLinks: [] });

function expectDiagnostic(stage: string, reason: string) {
  return (error: unknown) => {
    assert.ok(isWeeklyDraftDiagnosticError(error));
    assert.equal(error.diagnostic.stage, stage);
    assert.equal(error.diagnostic.reason, reason);
    return true;
  };
}

test("CONFIG_MISSING é classificado sem criar draft", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store: s, testMode: true, env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123" } }), expectDiagnostic("RUNTIME_CONFIG", "PUBLIC_URL_MISSING"));
  assert.equal(s.campaigns.size, 0);
});

test("SUPABASE_ERROR é classificado sem criar draft", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store: s, testMode: true, env, productsLoader: async () => { throw new Error("secret database detail"); } }), expectDiagnostic("SUPABASE_READ", "SUPABASE_READ_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("NO_NEW_PRODUCTS permanece skip explícito", async () => {
  const s = store(); const messages: string[] = [];
  const result = await runWeeklyDraftCycle({ store: s, testMode: true, env, now: new Date("2026-08-29T03:00:00Z"), productsLoader: async () => [product("old", "2026-06-01T00:00:00Z")], telegramSender: async (_c,t) => { messages.push(t); return { ok:true }; } });
  assert.equal(result.status, "skipped"); assert.match(messages[0], /NO_NEW_PRODUCTS/); assert.equal(s.campaigns.size, 0);
});

test("INSUFFICIENT_PRODUCTS permanece skip explícito", async () => {
  const s = store(); const messages: string[] = [];
  const result = await runWeeklyDraftCycle({ store: s, testMode: true, env, now: new Date("2026-08-29T03:00:00Z"), productsLoader: async () => products.slice(0,2), telegramSender: async (_c,t) => { messages.push(t); return { ok:true }; } });
  assert.equal(result.status, "skipped"); assert.match(messages[0], /INSUFFICIENT_PRODUCTS/); assert.equal(s.campaigns.size, 0);
});

test("GEMINI_REQUEST_FAILED é sanitizado", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>{ throw new Error("raw secret from upstream"); } }), expectDiagnostic("GEMINI", "GEMINI_REQUEST_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("GEMINI_OUTPUT_REJECTED é classificado", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>{ throw new Error("WEEKLY_COPY_INCOMPLETE"); } }), expectDiagnostic("GEMINI", "GEMINI_OUTPUT_REJECTED"));
  assert.equal(s.campaigns.size, 0);
});

test("DRAFT_PERSIST_ERROR é classificado sem recipients", async () => {
  const s = store(); s.createCampaign = async () => { throw new Error("insert detail secret"); };
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader }), expectDiagnostic("DRAFT_PERSIST", "DRAFT_INSERT_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("TELEGRAM_ERROR_AFTER_DRAFT preserva pending_approval", async () => {
  const s = store(); let captured: any;
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader, telegramSender:async()=>({ok:false,failureReason:"transport secret"}) }), error => { captured=error; return expectDiagnostic("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED")(error); });
  assert.equal(captured.diagnostic.draftCreated, true); assert.ok(captured.diagnostic.campaignId); assert.equal(s.campaigns.size, 1);
  assert.equal([...s.campaigns.values()][0].status, "pending_approval");
});


test("TELEGRAM_ERROR_AFTER_DRAFT reutiliza draft operacional equivalente na nova tentativa", async () => {
  const s = store();
  let createCount = 0;
  const originalCreate = s.createCampaign.bind(s);
  s.createCampaign = async (campaign: any) => { createCount += 1; return originalCreate(campaign); };

  await assert.rejects(
    runWeeklyDraftCycle({
      store:s,
      testMode:true,
      env,
      productsLoader:async()=>products,
      clickCountLoader:async()=>new Map(),
      copyGenerator:async()=>copy,
      institutionalLoader,
      telegramSender:async()=>({ok:false,failureReason:"transport secret"}),
    }),
    expectDiagnostic("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED"),
  );
  assert.equal(createCount, 1);
  const existing = [...s.campaigns.values()][0];
  assert.ok(existing);
  assert.equal(existing.status, "pending_approval");
  s.findOperationalCollectionByEditionKey = async () => structuredClone(existing);

  const retry = await runWeeklyDraftCycle({
    store:s,
    testMode:true,
    env,
    productsLoader:async()=>products,
    clickCountLoader:async()=>new Map(),
    copyGenerator:async()=>copy,
    institutionalLoader,
    telegramSender:async()=>{ throw new Error("must not send a second card for duplicate draft"); },
  });
  assert.deepEqual(retry, { status: "skipped", reason: "duplicate", newProductCount: 3 });
  assert.equal(createCount, 1);
  assert.equal(s.campaigns.size, 1);
});

test("SUCCESS_DRAFT mantém pending_approval e zero recipients", async () => {
  const s = store();
  const result = await runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader, telegramSender:async()=>({ok:true,result:{message_id:44}}) });
  assert.equal(result.status, "created"); if (result.status === "created") assert.equal(result.campaign.status, "pending_approval");
  assert.equal(s.campaigns.size, 1);
});

test("SECRET_REDACTION não inclui secrets nem email completo", () => {
  const secrets = ["brevo-secret", "gemini-secret", "supabase-secret", "telegram-secret", "full@example.com", "Authorization: Bearer abc"];
  const text = formatWeeklyDraftDiagnosticTelegram({ attemptId:"abc", stage:"SUPABASE_READ", reason:"SUPABASE_READ_FAILED", activeProductCount:4, newProductCount:3, eligibleProductCount:3 });
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.equal(text.includes("stack"), false);
});
