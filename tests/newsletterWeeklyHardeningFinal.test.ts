import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { composeWeeklyEdition, buildWeeklyEditorialSnapshot, compareWeeklyEditorialSnapshot, evaluateWeeklyProductEligibility, rankWeeklyCandidates, weeklyFreshnessMs } from "../server/services/newsletterWeeklyEditorial";
import { DISPLAY_TITLE_REVIEW_VERSION, IMAGE_REVIEW_VERSION, imageUrlFingerprint, isImageReviewCurrent } from "../server/services/productEditorialReview";
import { normalizePromotionOffer, validPromotionAt } from "../server/services/promotionOffer";
import { runWeeklyProductionPreflight } from "../server/services/newsletterWeeklyPreflight";
import { loadLastSuccessfulWeeklySentAt } from "../server/services/newsletterWeeklyCampaign";
import { createCampaignDraft, transitionCampaign } from "../server/services/newsletterCampaignState";
import { campaignKeyboard, handleNewsletterCampaignCallback } from "../server/services/newsletterCampaignTelegram";
import { runWeeklyEditorialBackfill } from "../server/services/newsletterWeeklyEditorialBackfill";

const NOW = new Date("2026-08-30T12:00:00Z");

function product(id: string, category = "Iluminação", overrides: Partial<Product> = {}): Product {
  const image = `https://cdn.example.com/${id}.jpg`;
  return {
    id,
    ref: `REF-${id}`,
    produto: `Marketplace oferta produto bruto ${id}`,
    rawTitle: `Marketplace oferta produto bruto ${id}`,
    displayTitle: `Peça curada modelo ${id}xx`,
    displayTitleStatus: "ready",
    displayTitleReviewedAt: "2026-08-29T12:00:00Z",
    displayTitleReviewModel: "gemini-test",
    displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION,
    categoria: category,
    preco: 100,
    imagens: [image],
    imageEditorialStatus: "clean",
    imageCuration: { status: "ready", rawImageUrls: [image], primaryImageUrl: image, galleryImageUrls: [], assessments: [{ url: image, decision: "clean", confidence: "HIGH", reason: "produto sem overlays" }] },
    imageReviewedAt: "2026-08-29T12:00:00Z",
    imageReviewModel: "gemini-image-test",
    imageReviewVersion: IMAGE_REVIEW_VERSION,
    imageReviewFingerprint: imageUrlFingerprint(image),
    link: `https://market.example.com/item/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    descricao: `Descrição factual ${id}`,
    createdAt: "2026-08-29T12:00:00Z",
    ...overrides,
  };
}

test("imagem sem prova persistida e imagem não clean bloqueiam weekly", () => {
  const missing = product("missing", "Iluminação", { imageEditorialStatus: "unreviewed", imageCuration: undefined });
  const promotional = product("promo", "Iluminação", { imageEditorialStatus: "review_required", imageCuration: { status: "review_required", rawImageUrls: ["https://cdn.example.com/promo.jpg"], galleryImageUrls: [], assessments: [{ url: "https://cdn.example.com/promo.jpg", decision: "promotional", confidence: "HIGH", reason: "texto" }], reason: "no_commercial_image" } });
  assert.equal(evaluateWeeklyProductEligibility(missing, NOW).eligible, false);
  assert.equal(evaluateWeeklyProductEligibility(promotional, NOW).eligible, false);
});

test("troca da imagem principal invalida fingerprint editorial", () => {
  const original = product("image-change");
  const changed = structuredClone(original);
  changed.imageCuration!.primaryImageUrl = "https://cdn.example.com/new.jpg";
  changed.imagens = ["https://cdn.example.com/new.jpg"];
  assert.equal(isImageReviewCurrent(changed), false);
  assert.equal(evaluateWeeklyProductEligibility(changed, NOW).eligible, false);

  const detached = product("detached-image", "Iluminação", {
    imagens: ["https://cdn.example.com/replacement.jpg"],
  });
  assert.equal(isImageReviewCurrent(detached), false, "imagem aprovada precisa continuar no conjunto canônico");

  const staleVersion = product("stale-image-version", "Iluminação", { imageReviewVersion: "weekly-image-review-v0" });
  assert.equal(isImageReviewCurrent(staleVersion), false, "versão visual antiga exige nova revisão");
});

test("display_title ausente ou raw marketplace fallback é proibido", () => {
  const missing = product("no-title", "Iluminação", { displayTitle: undefined, displayTitleStatus: "review_required" });
  const raw = product("raw-title", "Iluminação", { displayTitle: "Oferta imperdível Shopee", displayTitleStatus: "ready" });
  const verbatim = product("verbatim", "Iluminação", {
    produto: "Luminária de Mesa Cônica",
    rawTitle: "Luminária de Mesa Cônica",
    displayTitle: "Luminária de Mesa Cônica",
  });
  assert.equal(evaluateWeeklyProductEligibility(missing, NOW).eligible, false);
  assert.equal(evaluateWeeklyProductEligibility(raw, NOW).eligible, false);
  assert.equal(evaluateWeeklyProductEligibility(verbatim, NOW).eligible, false);
});

test("backfill legado persiste prova Gemini e falha fechado sem usar raw_title", async () => {
  const legacy = product("legacy", "Iluminação", {
    displayTitle: undefined,
    displayTitleStatus: "unreviewed",
    displayTitleReviewedAt: undefined,
    displayTitleReviewModel: undefined,
    displayTitleReviewVersion: undefined,
    imageEditorialStatus: "unreviewed",
    imageCuration: undefined,
    imageReviewedAt: undefined,
    imageReviewModel: undefined,
    imageReviewVersion: undefined,
    imageReviewFingerprint: undefined,
  });
  const image = legacy.imagens[0];
  const curation: any = {
    status: "ready",
    rawImageUrls: [image],
    primaryImageUrl: image,
    galleryImageUrls: [],
    assessments: [{ url: image, decision: "clean", confidence: "HIGH", reason: "produto isolado" }],
  };
  const updates: Record<string, unknown>[] = [];
  const result = await runWeeklyEditorialBackfill({
    execute: true,
    now: NOW,
    env: {},
    productsLoader: async () => [legacy],
    titleGenerator: async () => "Luminária Cônica de Mesa",
    imageReviewer: async () => curation,
    productUpdater: async (_id, patch) => { updates.push(patch); },
  });
  assert.equal(result.updated, 1);
  assert.equal(updates[0].display_title_status, "ready");
  assert.equal(updates[0].display_title_review_model, "gemini-3.6-flash");
  assert.equal(updates[0].image_editorial_status, "clean");
  assert.equal(updates[0].image_review_fingerprint, imageUrlFingerprint(image));

  const failed: Record<string, unknown>[] = [];
  await runWeeklyEditorialBackfill({
    execute: true,
    now: NOW,
    env: {},
    productsLoader: async () => [legacy],
    titleGenerator: async () => legacy.rawTitle || legacy.produto,
    imageReviewer: async () => curation,
    productUpdater: async (_id, patch) => { failed.push(patch); },
  });
  assert.equal(failed[0].display_title_status, "review_required");
  assert.equal("display_title" in failed[0], false, "raw title nunca é persistido como fallback editorial");

  const imageFailed: Record<string, unknown>[] = [];
  await runWeeklyEditorialBackfill({
    execute: true,
    now: NOW,
    env: {},
    productsLoader: async () => [legacy],
    titleGenerator: async () => "Luminária Cônica de Mesa",
    imageReviewer: async () => { throw new Error("PROVIDER_UNAVAILABLE"); },
    productUpdater: async (_id, patch) => { imageFailed.push(patch); },
  });
  assert.equal(imageFailed[0].image_editorial_status, "review_required");
  assert.equal((imageFailed[0].image_curation as any).reason, "image_review_unavailable");
});

test("quatro produtos fortes da categoria do hero formam edição temática", () => {
  const items = [product("lamp-one"), product("lamp-two"), product("lamp-three"), product("lamp-four")];
  const composition = composeWeeklyEdition(rankWeeklyCandidates(items, new Map([["lamp-one", 10]]), NOW));
  assert.equal(composition.mode, "thematic");
  assert.equal(composition.products.length, 4);
  assert.equal(composition.products[0].id, "lamp-one");
});

test("quatro categorias formam edição diversificada e preservam hero", () => {
  const items = [product("hero", "Iluminação"), product("chair", "Móveis"), product("glass", "Cozinha & Mesa"), product("art", "Decoração")];
  const composition = composeWeeklyEdition(rankWeeklyCandidates(items, new Map([["hero", 10]]), NOW));
  assert.equal(composition.mode, "diversified");
  assert.equal(composition.categories.length, 4);
  assert.equal(composition.products[0].id, "hero");
});

test("três de uma categoria e três categorias diferentes têm composição determinística", () => {
  const items = [product("hero", "Iluminação"), product("lamp-two"), product("chair", "Móveis"), product("lamp-three"), product("glass", "Cozinha & Mesa"), product("art", "Decoração")];
  const first = composeWeeklyEdition(rankWeeklyCandidates(items, new Map([["hero", 10]]), NOW));
  const second = composeWeeklyEdition(rankWeeklyCandidates([...items].reverse(), new Map([["hero", 10]]), NOW));
  assert.equal(first.mode, "diversified");
  assert.deepEqual(first.products.map(item => item.id), second.products.map(item => item.id));
  assert.ok(first.products.filter(item => item.categoria === "Iluminação").length <= 2);
});

test("produtos quase duplicados são suprimidos editorialmente", () => {
  const a = product("dup-a", "Iluminação", { displayTitle: "Luminária Bauhaus de Mesa Preta" });
  const b = product("dup-b", "Iluminação", { displayTitle: "Luminária Bauhaus de Mesa Preta Grande" });
  const composition = composeWeeklyEdition([a, b, product("other-one", "Móveis"), product("other-two", "Decoração")]);
  assert.ok(composition.duplicateProductIds.includes("dup-b"));
  assert.equal(composition.products.some(item => item.id === "dup-b"), false);
});

test("promoção expirada não substitui preço nem cria freshness", () => {
  const offer = normalizePromotionOffer({ price: 70, condition: "pix", benefits: [], source: "admin_confirmed", confirmedAt: NOW.getTime() - 48 * 3_600_000, expiresAt: NOW.getTime() - 24 * 3_600_000 });
  const item = product("expired", "Iluminação", { ofertaPromocional: offer || undefined, createdAt: "2026-08-01T00:00:00Z" });
  assert.equal(validPromotionAt(item.ofertaPromocional, NOW), undefined);
  assert.equal(weeklyFreshnessMs(item, NOW), Date.parse("2026-08-01T00:00:00Z"));
});

test("preflight bloqueia mudança de preço, link, imagem, desativação e promoção expirada", () => {
  const offered = product("snapshot", "Iluminação", { ofertaPromocional: { price: 80, condition: "pix", benefits: [], source: "admin_confirmed", confirmedAt: NOW.getTime() - 1_000, expiresAt: NOW.getTime() + 10_000 } });
  const approved = buildWeeklyEditorialSnapshot([offered], { mode: "thematic", categories: ["Iluminação"] }, NOW).snapshot;
  assert.equal(compareWeeklyEditorialSnapshot(approved, [{ ...offered, preco: 101 }], NOW).valid, false);
  assert.equal(compareWeeklyEditorialSnapshot(approved, [{ ...offered, link: "https://market.example.com/item/changed" }], NOW).valid, false);
  assert.equal(compareWeeklyEditorialSnapshot(approved, [{ ...offered, ativo: false }], NOW).valid, false);
  assert.equal(compareWeeklyEditorialSnapshot(approved, [offered], new Date(NOW.getTime() + 20_000)).valid, false);
});

test("cutoff consulta somente collection weekly production sent", async () => {
  const calls: Array<[string, unknown]> = [];
  const query: any = {
    select() { return this; }, eq(field: string, value: unknown) { calls.push([field, value]); return this; }, like(field: string, value: unknown) { calls.push([field, value]); return this; }, not(field: string, op: string, value: unknown) { calls.push([`${field}:${op}`, value]); return this; }, order() { return this; }, limit() { return this; }, async maybeSingle() { return { data: { sent_at: "2026-08-20T00:00:00Z" }, error: null }; },
  };
  const result = await loadLastSuccessfulWeeklySentAt({ from(table: string) { calls.push(["table", table]); return query; } } as any);
  assert.equal(result, "2026-08-20T00:00:00Z");
  assert.ok(calls.some(([field, value]) => field === "edition_key" && value === "weekly:%"));
  assert.ok(calls.some(([field, value]) => field === "status" && value === "sent"));
});

const readyRuntime: any = {
  weeklyEnabledRawState: "true", weeklyProductionEnabled: true, productionListConfigured: true, productionSyncVerified: true,
  productionAudienceReady: true, productionBrevoMembers: 4, testEmailConfigured: true, testEmailValid: true, testEmailMasked: "t***@example.com",
  brevoApiKeyPresent: true, brevoMarketingProviderReady: true, eligibleSubscribers: 4, readyForTest: false,
};

test("preflight é read-only e alerta com menos de três produtos", async () => {
  let writes = 0;
  const result = await runWeeklyProductionPreflight({
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ADMIN_CHAT_ID: "1", GEMINI_API_KEY: "key" }, now: NOW,
    productsLoader: async () => [product("one"), product("two")], lastSentAtLoader: async () => "2026-08-28T00:00:00Z",
    clickCountLoader: async () => new Map(), runtimeLoader: async () => readyRuntime,
    duplicateEditionLoader: async () => { writes += 0; return false; },
  });
  assert.equal(result.readOnly, true); assert.equal(result.ready, false); assert.equal(result.eligibleProducts, 2); assert.equal(writes, 0);
});

test("preflight com três produtos aprovados fica pronto sem criar campanha", async () => {
  const result = await runWeeklyProductionPreflight({
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ADMIN_CHAT_ID: "1", GEMINI_API_KEY: "key" }, now: NOW,
    productsLoader: async () => [product("one"), product("two"), product("three")], lastSentAtLoader: async () => "2026-08-28T00:00:00Z",
    clickCountLoader: async () => new Map(), runtimeLoader: async () => readyRuntime, duplicateEditionLoader: async () => false,
  });
  assert.equal(result.ready, true); assert.equal(result.selectableProducts, 3);
});

test("preflight bloqueia quando o orçamento semanal Gemini está esgotado", async () => {
  const result = await runWeeklyProductionPreflight({
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ADMIN_CHAT_ID: "1", GEMINI_API_KEY: "key" }, now: NOW,
    productsLoader: async () => [product("one"), product("two"), product("three")], lastSentAtLoader: async () => "2026-08-28T00:00:00Z",
    clickCountLoader: async () => new Map(), runtimeLoader: async () => readyRuntime, duplicateEditionLoader: async () => false,
    geminiBudgetLoader: () => ({ available: false, used: 20, limit: 20, resetAt: NOW.getTime() + 3_600_000 }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.geminiBudgetAvailable, false);
});

test("primeiro clique Telegram aprova sem enviar; segundo clique explícito é obrigatório", async () => {
  const products = [product("gate-one"), product("gate-two"), product("gate-three")];
  const editorial = buildWeeklyEditorialSnapshot(products, { mode: "thematic", categories: ["Iluminação"] }, NOW);
  const links = products.map((item, index) => ({ productId: item.id, position: index + 1, layout: index === 0 ? "feature" as const : "grid" as const }));
  const draft = createCampaignDraft(null, "123", { subject: "Weekly", html: "<html>{{ unsubscribe }}</html>", text: "Weekly", offerUrl: "https://example.com" }, NOW, "weekly-two-step", "collection", links, "weekly:2026-08-30:fixture", {
    editorialSnapshot: editorial.snapshot, editorialFingerprint: editorial.fingerprint, editorialCompositionMode: "thematic", editorialCategories: ["Iluminação"],
    previewExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalAudienceCount: 4, approvalAudienceStatus: "ready",
  });
  const campaigns = new Map<string, any>();
  campaigns.set(draft.id, transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }, NOW));
  const store: any = {
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async updateCampaign(campaign: any) { campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); },
    async getCampaignTelegramCard() { return null; }, async saveCampaignTelegramCard() {}, async listCampaignProducts() { return links; },
  };
  let createCalls = 0; let sendNowCalls = 0;
  const provider: any = {
    async createCampaign() { createCalls += 1; return { status: "succeeded", brevoCampaignId: "900", operation: "create", providerRef: "900", providerReference: "900" }; },
    async sendNow() { sendNowCalls += 1; return { status: "succeeded", brevoCampaignId: "900", operation: "send_now", providerRef: "900", providerReference: "900" }; },
    async sendTest() { throw new Error("SEND_TEST_FORBIDDEN"); },
  };
  const answers: string[] = [];
  const deps: any = {
    store, weeklyProvider: provider, productsLoader: async () => products,
    productionAudienceSync: async () => ({ listId: 77, eligibleSubscribers: 4, brevoMembers: 4 }), productionEnabledCheck: async () => true,
    answerCallbackQuery: async (_id: string, text: string) => { answers.push(text); }, editTelegramMessageText: async () => ({ ok: true }), sendTelegramMessage: async () => ({ ok: true }), env: { NEWSLETTER_WEEKLY_ENABLED: "true" }, now: NOW,
  };
  await handleNewsletterCampaignCallback(`campaign_weekly_approve:${draft.id}`, "cb-approve", "123", "1", 1, deps);
  const approved = await store.getCampaign(draft.id);
  assert.equal(approved.status, "approved"); assert.equal(createCalls, 0); assert.equal(sendNowCalls, 0); assert.match(answers[0], /Nenhum email foi enviado/);
  assert.match(campaignKeyboard(approved)[0][0].text, /Enviar agora para 4 assinantes/);
  await handleNewsletterCampaignCallback(`campaign_weekly_send:${draft.id}`, "cb-send", "123", "1", 1, deps);
  assert.equal(createCalls, 1); assert.equal(sendNowCalls, 1);
});

test("primeiro clique não aprova conteúdo já alterado e exige regeneração", async () => {
  const products = [product("stale-one"), product("stale-two"), product("stale-three")];
  const editorial = buildWeeklyEditorialSnapshot(products, { mode: "thematic", categories: ["Iluminação"] }, NOW);
  const links = products.map((item, index) => ({ productId: item.id, position: index + 1, layout: index === 0 ? "feature" as const : "grid" as const }));
  const draft = createCampaignDraft(null, "123", { subject: "Weekly", html: "<html>{{ unsubscribe }}</html>", text: "Weekly", offerUrl: "https://example.com" }, NOW, "weekly-stale-approval", "collection", links, "weekly:2026-08-30:stale", {
    editorialSnapshot: editorial.snapshot, editorialFingerprint: editorial.fingerprint, editorialCompositionMode: "thematic", editorialCategories: ["Iluminação"],
    previewExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalAudienceCount: null, approvalAudienceStatus: "pending",
  });
  const campaigns = new Map<string, any>([[draft.id, transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }, NOW)]]);
  const store: any = {
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async updateCampaign(campaign: any) { campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); },
  };
  let audienceSyncCalls = 0;
  const answers: string[] = [];
  await handleNewsletterCampaignCallback(`campaign_weekly_approve:${draft.id}`, "cb-stale", "123", undefined, undefined, {
    store,
    productsLoader: async () => [{ ...products[0], preco: 999 }, products[1], products[2]],
    productionAudienceSync: async () => { audienceSyncCalls += 1; return { listId: 77, eligibleSubscribers: 4, brevoMembers: 4 }; },
    answerCallbackQuery: async (_id, text) => { answers.push(text || ""); },
    editTelegramMessageText: async () => ({ ok: true }),
    sendTelegramMessage: async () => ({ ok: true }),
    now: NOW,
  });
  assert.equal((await store.getCampaign(draft.id)).status, "cancelled");
  assert.equal(audienceSyncCalls, 0);
  assert.match(answers[0], /Conteúdo mudou desde a aprovação/);
});

test("falha no sync do primeiro clique deixa audiência pendente e nunca exibe confirmação stale", async () => {
  const products = [product("sync-one"), product("sync-two"), product("sync-three")];
  const editorial = buildWeeklyEditorialSnapshot(products, { mode: "thematic", categories: ["Iluminação"] }, NOW);
  const links = products.map((item, index) => ({ productId: item.id, position: index + 1, layout: index === 0 ? "feature" as const : "grid" as const }));
  const draft = createCampaignDraft(null, "123", { subject: "Weekly", html: "<html>{{ unsubscribe }}</html>", text: "Weekly", offerUrl: "https://example.com" }, NOW, "weekly-sync-failure", "collection", links, "weekly:2026-08-30:sync", {
    editorialSnapshot: editorial.snapshot, editorialFingerprint: editorial.fingerprint, editorialCompositionMode: "thematic", editorialCategories: ["Iluminação"],
    previewExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), approvalAudienceCount: 99, approvalAudienceStatus: "ready",
  });
  const campaigns = new Map<string, any>([[draft.id, transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" }, NOW)]]);
  const store: any = {
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async updateCampaign(campaign: any) { campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); },
  };
  await handleNewsletterCampaignCallback(`campaign_weekly_approve:${draft.id}`, "cb-sync", "123", undefined, undefined, {
    store,
    productsLoader: async () => products,
    productionAudienceSync: async () => { throw new Error("SYNC_UNAVAILABLE"); },
    answerCallbackQuery: async () => {}, editTelegramMessageText: async () => ({ ok: true }), sendTelegramMessage: async () => ({ ok: true }), now: NOW,
  });
  const approved = await store.getCampaign(draft.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvalAudienceStatus, "pending");
  assert.equal(approved.approvalAudienceCount, null);
  assert.doesNotMatch(campaignKeyboard(approved).flat().map((button: any) => button.text).join(" "), /Enviar agora/);
});
