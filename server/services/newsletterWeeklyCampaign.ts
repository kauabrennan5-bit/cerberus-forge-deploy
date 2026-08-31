import { createHash } from "node:crypto";
import type { Product } from "../../src/types";
import { deriveConfidenceV2, deriveMinSampleSize } from "../commercialBrain/statisticalRigor";
import * as productsRepository from "../repositories/productsRepository";
import { createSupabaseNewsletterCampaignStore, type NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { submitCampaignForApproval } from "./newsletterCampaignService";
import { createCampaignDraft, type CampaignProductLink, type EmailCampaign } from "./newsletterCampaignState";
import { getNewsletterInstitutionalOptions } from "./newsletterInstitutional";
import { sendTelegramMessage, type TelegramDeliveryResult } from "./telegramBot";
import { generateWeeklyNewsletterCopy, type WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";
import { renderWeeklyNewsletter } from "./newsletterWeeklyTemplate";
import {
  buildWeeklyEditorialSnapshot,
  composeWeeklyEdition,
  evaluateWeeklyProductEligibility,
  rankWeeklyCandidates,
  weeklyFreshnessMs,
  type WeeklyComposition,
} from "./newsletterWeeklyEditorial";
import { validPromotionAt } from "./promotionOffer";
import { readWeeklyProductionRuntimeConfig, type WeeklyProductionRuntimeConfig } from "./newsletterWeeklyProductionConfig";
import { buildWeeklyPreviewUrl } from "./newsletterWeeklyPreview";
import { buildWeeklyDesignTestCopy, selectWeeklyDesignTestProducts } from "./newsletterWeeklyDesignTest";

import {
  classifyGeminiDiagnosticReason,
  isWeeklyDraftDiagnosticError,
  logWeeklyDraftStage,
  WeeklyDraftDiagnosticError,
  type WeeklyDraftDiagnostic,
  type WeeklyDraftDiagnosticReason,
  type WeeklyDraftDiagnosticStage,
} from "./newsletterWeeklyDiagnostics";

export type WeeklyDraftOutcome =
  | { status: "created"; campaign: EmailCampaign; products: Product[] }
  | { status: "skipped"; reason: "disabled" | "no_new_products" | "insufficient_new_products" | "duplicate"; newProductCount: number };

export type WeeklyDraftDeps = {
  store?: NewsletterCampaignStore;
  productsLoader?: () => Promise<Product[]>;
  lastSentAtLoader?: () => Promise<string | null>;
  clickCountLoader?: (productIds: string[]) => Promise<Map<string, number>>;
  copyGenerator?: (products: readonly Product[], composition: WeeklyComposition) => Promise<WeeklyNewsletterCopy>;
  institutionalLoader?: (env: NodeJS.ProcessEnv) => Promise<Awaited<ReturnType<typeof getNewsletterInstitutionalOptions>>>;
  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;
  telegramChatId?: string | number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  testMode?: boolean;
  designTestMode?: boolean;
  audienceConfigLoader?: () => Promise<WeeklyProductionRuntimeConfig | null>;
};

function envActor(env: NodeJS.ProcessEnv): string {
  const explicit = (env.TELEGRAM_ADMIN_USER_ID || "").trim();
  if (explicit) return explicit;
  const firstAllowed = (env.TELEGRAM_ALLOWED_USER_IDS || env.TELEGRAM_ALLOWED_USERS || "").split(",").map(v => v.trim()).find(Boolean);
  if (firstAllowed) return firstAllowed;
  const chat = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (chat) return chat;
  throw new Error("WEEKLY_TELEGRAM_ACTOR_MISSING");
}

export async function loadLastSuccessfulWeeklySentAt(client = productsRepository.requireSupabase()): Promise<string | null> {
  const { data, error } = await client.from("email_campaigns").select("sent_at")
    .eq("campaign_type", "collection")
    .like("edition_key", "weekly:%")
    .eq("status", "sent")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data?.sent_at ? String(data.sent_at) : null;
}

export async function loadProductClickCounts(productIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!productIds.length) return counts;
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("product_clicks").select("product_id").in("product_id", productIds);
  if (error) throw error;
  for (const row of data || []) {
    const id = String(row.product_id || "");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function editionKey(products: readonly Product[], now: Date, testMode: boolean, designTestMode: boolean): string {
  const digest = createHash("sha256").update(products.map(p => p.id).sort().join("\n"), "utf8").digest("hex").slice(0, 20);
  const prefix = designTestMode ? "weekly-test:design" : testMode ? "weekly-test" : "weekly";
  return `${prefix}:${now.toISOString().slice(0, 10)}:${digest}`;
}

function telegramPreview(
  campaign: EmailCampaign,
  products: readonly Product[],
  copy: WeeklyNewsletterCopy,
  clickCounts: Map<string, number>,
  composition: WeeklyComposition,
  testMode: boolean,
  designTestMode: boolean,
  publicBaseUrl: string,
  env: NodeJS.ProcessEnv,
  audienceConfig: WeeklyProductionRuntimeConfig | null,
): string {
  const minSample = deriveMinSampleSize().nTotal;
  const lines = products.map((product, index) => {
    const clicks = clickCounts.get(product.id) || 0;
    const confidence = deriveConfidenceV2({ recordCount: clicks, minSampleRequired: minSample });
    const canonicalPrice = validPromotionAt(product.ofertaPromocional, new Date(campaign.createdAt))?.price || product.preco;
    return `${index === 0 ? "⭐ DESTAQUE" : "•"} ${product.displayTitle}\n   ${product.categoria} · R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")} · ${clicks} cliques · confiança ${confidence.confidence}\n   🖼 ${product.imageCuration?.primaryImageUrl}`;
  });
  let previewLine: string | null = null;
  try {
    previewLine = `👁 <a href="${escapeWeeklyTelegramHtml(buildWeeklyPreviewUrl(campaign, publicBaseUrl, env))}">Ver prévia completa</a>`;
  } catch {
    if (!testMode) throw new Error("WEEKLY_PREVIEW_LINK_UNAVAILABLE");
  }
  const previewAudienceCount = testMode ? 1 : (audienceConfig?.eligibleSubscribersCount ?? 0);
  const previewAudienceReady = testMode || Boolean(
    audienceConfig?.lastSyncStatus === "ready"
    && audienceConfig.brevoListId
    && audienceConfig.eligibleSubscribersCount > 0
    && audienceConfig.eligibleSubscribersCount === audienceConfig.brevoMembersCount
  );
  return [
    designTestMode
      ? "🧪 <b>TESTE DE DESIGN — 3 CARDS ISOLADOS</b>"
      : testMode ? "🧪 <b>RASCUNHO SEMANAL — LISTA DE TESTE</b>" : "📨 <b>RASCUNHO SEMANAL CERBERUS</b>",
    "",
    `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(copy.subject)}`,
    `<b>Preview:</b> ${escapeWeeklyTelegramHtml(copy.previewText)}`,
    `<b>Produtos:</b> ${products.length}`,
    `<b>Composição:</b> ${composition.mode === "thematic" ? "temática" : "diversificada"}`,
    `<b>Categorias:</b> ${composition.categories.map(escapeWeeklyTelegramHtml).join(", ")}`,
    `<b>Audiência elegível:</b> ${previewAudienceCount}`,
    `<b>Status Brevo:</b> ${previewAudienceReady ? "ready" : audienceConfig?.lastSyncStatus || "unavailable"}`,
    `<b>Criada em:</b> ${campaign.createdAt}`,
    `<b>Aprovação válida até:</b> ${campaign.approvalExpiresAt || "indisponível"}`,
    "",
    ...lines,
    previewLine,
    "",
    "Nenhum e-mail foi enviado ainda.",
    testMode ? "Ao aprovar, somente o destino de teste configurado receberá a campanha." : "O primeiro clique apenas aprova a campanha e libera a confirmação final; ele não cria campanha Brevo nem envia email.",
    `<code>${campaign.id}</code>`,
  ].join("\n");
}

async function notify(sender: WeeklyDraftDeps["telegramSender"], chatId: string, text: string, markup?: unknown): Promise<TelegramDeliveryResult> {
  return (sender || sendTelegramMessage)(chatId, text, markup);
}

function escapeWeeklyTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type WeeklyDraftCardRecoveryOutcome =
  | {
      status: "delivered";
      campaign: EmailCampaign;
      messageId: number | null;
      cardReferencePersisted: boolean;
    }
  | { status: "not_found" }
  | { status: "delivery_failed"; campaign: EmailCampaign };

export type WeeklyDraftCardRecoveryDeps = {
  chatId: string | number;
  store?: NewsletterCampaignStore;
  telegramSender?: WeeklyDraftDeps["telegramSender"];
};

/**
 * Reexibe uma weekly-test operacional persistida sem recriar campanha,
 * products, recipients ou qualquer recurso no provider de email.
 * pending_approval volta ao gate de aprovação; approved sem test_sent volta
 * ao gate humano apropriado de create+test ou de retry somente /sendTest.
 */
export async function redeliverLatestWeeklyTestDraftCard(
  deps: WeeklyDraftCardRecoveryDeps,
): Promise<WeeklyDraftCardRecoveryOutcome> {
  const chatId = String(deps.chatId ?? "").trim();
  if (!chatId) return { status: "not_found" };

  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const recent = await store.listRecentCampaigns(20);
  const campaign = recent.find(item =>
    item.campaignType === "collection"
    && Boolean(item.editionKey?.startsWith("weekly-test:"))
    && (
      item.status === "pending_approval"
      || (item.status === "approved" && !item.testSentAt)
    ),
  );
  if (!campaign) return { status: "not_found" };

  const selectedProductCount = campaign.collectionProducts.length;
  const providerCampaignId = campaign.testProviderMessageId?.trim() || "";
  let text: string;
  let keyboard: any[][];

  if (campaign.status === "pending_approval") {
    text = [
      "🧪 <b>RASCUNHO SEMANAL — LISTA DE TESTE</b>",
      "",
      "<i>Rascunho existente recuperado sem recriar campanha.</i>",
      "",
      `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(campaign.subject)}`,
      `<b>Produtos selecionados:</b> ${selectedProductCount}`,
      "",
      "Nenhum e-mail foi enviado ainda.",
      "Ao aprovar, somente o destino de teste configurado receberá a campanha.",
      `<code>${escapeWeeklyTelegramHtml(campaign.id)}</code>`,
    ].join("\n");
    keyboard = [
      [{ text: "✅ Aprovar teste", callback_data: `campaign_weekly_approve:${campaign.id}` }],
      [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
    ];
  } else if (providerCampaignId) {
    text = [
      "⚠️ <b>ENVIO DE TESTE NÃO CONFIRMADO</b>",
      "",
      "A aprovação humana foi preservada e a Marketing Campaign da Brevo já existe.",
      "",
      `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(campaign.subject)}`,
      `<b>Produtos selecionados:</b> ${selectedProductCount}`,
      "Brevo Campaign: <b>criada ✅</b>",
      "Envio de teste: <b>não confirmado ⚠️</b>",
      "Erro: <code>WEEKLY_BREVO_SENDTEST_FAILED</code>",
      "",
      "Nenhum cliente real foi envolvido. Um novo clique reutilizará a mesma campanha Brevo e repetirá somente /sendTest.",
      `<code>${escapeWeeklyTelegramHtml(campaign.id)}</code>`,
    ].join("\n");
    keyboard = [
      [{ text: "🔄 Tentar envio de teste novamente", callback_data: `campaign_weekly_retry_test:${campaign.id}` }],
      [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
    ];
  } else {
    text = [
      "🧪 <b>TESTE APROVADO — BREVO AINDA NÃO CRIADA</b>",
      "",
      "A aprovação humana está preservada, mas nenhuma referência de Marketing Campaign foi confirmada.",
      "",
      `<b>Assunto:</b> ${escapeWeeklyTelegramHtml(campaign.subject)}`,
      `<b>Produtos selecionados:</b> ${selectedProductCount}`,
      "Nenhum cliente real foi envolvido.",
      `<code>${escapeWeeklyTelegramHtml(campaign.id)}</code>`,
    ].join("\n");
    keyboard = [
      [{ text: "▶️ Continuar teste controlado", callback_data: `campaign_weekly_approve:${campaign.id}` }],
      [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
    ];
  }

  let delivery: TelegramDeliveryResult;
  try {
    delivery = await notify(deps.telegramSender, chatId, text, { inline_keyboard: keyboard });
  } catch {
    return { status: "delivery_failed", campaign };
  }
  if (!delivery.ok) return { status: "delivery_failed", campaign };

  const messageId = Number(delivery.result?.message_id);
  const validMessageId = Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
  let cardReferencePersisted = false;
  if (validMessageId !== null) {
    try {
      await store.saveCampaignTelegramCard(campaign.id, chatId, validMessageId);
      cardReferencePersisted = true;
    } catch {
      cardReferencePersisted = false;
    }
  }

  return {
    status: "delivered",
    campaign,
    messageId: validMessageId,
    cardReferencePersisted,
  };
}


export async function runWeeklyDraftCycle(deps: WeeklyDraftDeps = {}): Promise<WeeklyDraftOutcome> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const designTestMode = deps.designTestMode === true;
  const testMode = deps.testMode === true || designTestMode;
  if (!testMode && deps.store && !deps.audienceConfigLoader && env.NEWSLETTER_WEEKLY_ENABLED !== "true") {
    return { status: "skipped", reason: "disabled", newProductCount: 0 };
  }

  const attemptId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const context: Omit<WeeklyDraftDiagnostic, "stage" | "reason"> = { attemptId };
  const fail = (
    stage: WeeklyDraftDiagnosticStage,
    reason: WeeklyDraftDiagnosticReason,
    extra: Partial<WeeklyDraftDiagnostic> = {},
  ): never => {
    const diagnostic: WeeklyDraftDiagnostic = { ...context, ...extra, attemptId, stage, reason };
    logWeeklyDraftStage(attemptId, stage, "FAIL", reason);
    throw new WeeklyDraftDiagnosticError(diagnostic);
  };
  const startStage = (stage: WeeklyDraftDiagnosticStage) => logWeeklyDraftStage(attemptId, stage, "START");
  const successStage = (stage: WeeklyDraftDiagnosticStage) => logWeeklyDraftStage(attemptId, stage, "SUCCESS");

  try {
    startStage("RUNTIME_CONFIG");
    const chatId = String(deps.telegramChatId ?? env.TELEGRAM_ADMIN_CHAT_ID ?? "").trim();
    if (!chatId) fail("RUNTIME_CONFIG", "TELEGRAM_ADMIN_CHAT_MISSING");
    const publicBaseUrl = (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim();
    if (!publicBaseUrl) fail("RUNTIME_CONFIG", "PUBLIC_URL_MISSING");
    try {
      const parsed = new URL(publicBaseUrl);
      if (!/^https?:$/.test(parsed.protocol)) fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
      if (env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
        fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
      }
    } catch (error) {
      if (isWeeklyDraftDiagnosticError(error)) throw error;
      fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
    }
    let actor: string;
    try { actor = envActor(env); }
    catch { fail("RUNTIME_CONFIG", "TELEGRAM_ACTOR_MISSING"); }
    let store: NewsletterCampaignStore;
    if (deps.store) store = deps.store;
    else {
      try { store = createSupabaseNewsletterCampaignStore(); }
      catch { fail("RUNTIME_CONFIG", "SUPABASE_CONFIG_MISSING"); }
    }
    let audienceConfig: WeeklyProductionRuntimeConfig | null = null;
    if (!testMode) {
      if (deps.audienceConfigLoader) {
        try { audienceConfig = await deps.audienceConfigLoader(); }
        catch { fail("RUNTIME_CONFIG", "SUPABASE_CONFIG_MISSING"); }
      } else if (deps.store) {
        audienceConfig = {
          weeklyEnabled: env.NEWSLETTER_WEEKLY_ENABLED === "true",
          brevoListId: Number.parseInt(env.BREVO_NEWSLETTER_LIST_ID || "", 10) || null,
          contactSyncVerifiedAt: env.BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED === "true" ? now.toISOString() : null,
          lastSyncAt: null,
          lastSyncStatus: env.BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED === "true" ? "ready" : "never",
          eligibleSubscribersCount: 0,
          brevoMembersCount: 0,
          updatedAt: null,
        };
      } else {
        try { audienceConfig = await readWeeklyProductionRuntimeConfig(); }
        catch { fail("RUNTIME_CONFIG", "SUPABASE_CONFIG_MISSING"); }
      }
      if (!audienceConfig?.weeklyEnabled) {
        return { status: "skipped", reason: "disabled", newProductCount: 0 };
      }
    }
    successStage("RUNTIME_CONFIG");

    startStage("SUPABASE_READ");
    let products: Product[];
    let lastSentAt: string | null;
    try {
      products = await (deps.productsLoader || productsRepository.getProducts)();
      lastSentAt = testMode
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : await (deps.lastSentAtLoader || loadLastSuccessfulWeeklySentAt)();
    } catch {
      fail("SUPABASE_READ", "SUPABASE_READ_FAILED");
    }
    successStage("SUPABASE_READ");

    startStage("PRODUCT_SELECTION");
    const configuredLookback = Number.parseInt(env.NEWSLETTER_WEEKLY_INITIAL_LOOKBACK_DAYS || "7", 10);
    const lookbackDays = Number.isSafeInteger(configuredLookback) ? Math.max(1, Math.min(30, configuredLookback)) : 7;
    const cutoffMs = lastSentAt ? Date.parse(lastSentAt) : now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
    const active = products.filter(product => product.ativo === true && product.status === "published");
    const newlyFresh = active.filter(product => weeklyFreshnessMs(product, now) > cutoffMs);
    const strictlyEligible = newlyFresh.filter(product => evaluateWeeklyProductEligibility(product, now).eligible);
    const designSelection = designTestMode ? selectWeeklyDesignTestProducts(active, now) : null;
    const fresh = designSelection?.products || strictlyEligible;
    context.activeProductCount = active.length;
    context.newProductCount = newlyFresh.length;
    context.eligibleProductCount = strictlyEligible.length;
    successStage("PRODUCT_SELECTION");

    startStage("PRODUCT_ELIGIBILITY");
    if (fresh.length === 0) {
      logWeeklyDraftStage(attemptId, "PRODUCT_ELIGIBILITY", "FAIL", "NO_NEW_PRODUCTS");
      await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nSem produto genuinamente novo.\n\nEtapa: <b>Produtos</b>\nMotivo: <code>NO_NEW_PRODUCTS</code>\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: 0\n\nNenhum rascunho foi gerado e nenhum email foi enviado.`);
      return { status: "skipped", reason: "no_new_products", newProductCount: 0 };
    }
    if (fresh.length < 3) {
      logWeeklyDraftStage(attemptId, "PRODUCT_ELIGIBILITY", "FAIL", "INSUFFICIENT_PRODUCTS");
      await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nSão necessários no mínimo 3 produtos aptos.\n\nEtapa: <b>Produtos</b>\nMotivo: <code>INSUFFICIENT_PRODUCTS</code>\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: ${fresh.length}\nNecessários: 3\n\nNenhum email foi enviado.`);
      return { status: "skipped", reason: "insufficient_new_products", newProductCount: fresh.length };
    }
    successStage("PRODUCT_ELIGIBILITY");

    startStage("SUPABASE_READ");
    let clickCounts: Map<string, number>;
    try { clickCounts = await (deps.clickCountLoader || loadProductClickCounts)(fresh.map(p => p.id)); }
    catch { fail("SUPABASE_READ", "SUPABASE_READ_FAILED"); }
    successStage("SUPABASE_READ");

    startStage("RANKING");
    let composition: WeeklyComposition;
    let selected: Product[];
    let editorial: ReturnType<typeof buildWeeklyEditorialSnapshot>;
    try {
      composition = designSelection?.composition || composeWeeklyEdition(rankWeeklyCandidates(fresh, clickCounts, now), 4);
      selected = designSelection?.products || composition.products;
      if (selected.length < 3) {
        await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nA deduplicação/composição editorial encontrou somente ${selected.length} produtos fortes.\nNecessários: 3\n\nNenhum rascunho foi criado e nenhum email foi enviado.`);
        return { status: "skipped", reason: "insufficient_new_products", newProductCount: selected.length };
      }
      // Congela a composição editorial antes de qualquer chamada de copy.
      editorial = buildWeeklyEditorialSnapshot(selected, composition, now);
    }
    catch { fail("RANKING", "RANKING_FAILED"); }
    successStage("RANKING");

    const key = editionKey(selected, now, testMode, designTestMode);
    startStage("SUPABASE_READ");
    let existing: EmailCampaign | null;
    try { existing = await store.findOperationalCollectionByEditionKey(key); }
    catch { fail("SUPABASE_READ", "SUPABASE_READ_FAILED"); }
    successStage("SUPABASE_READ");
    if (existing) return { status: "skipped", reason: "duplicate", newProductCount: fresh.length };

    startStage("GEMINI");
    let copy: WeeklyNewsletterCopy;
    try {
      copy = designTestMode
        ? buildWeeklyDesignTestCopy(selected)
        : await (deps.copyGenerator || generateWeeklyNewsletterCopy)(selected, composition);
    }
    catch (error) { fail("GEMINI", classifyGeminiDiagnosticReason(error)); }
    successStage("GEMINI");

    startStage("HTML_RENDER");
    let rendered: ReturnType<typeof renderWeeklyNewsletter>;
    let links: CampaignProductLink[];
    let draft: EmailCampaign;
    const campaignId = crypto.randomUUID();
    try {
      const institutional = deps.institutionalLoader
        ? await deps.institutionalLoader(env)
        : await getNewsletterInstitutionalOptions(env);
      rendered = renderWeeklyNewsletter(selected, copy, { campaignId, publicBaseUrl, socialLinks: institutional.socialLinks, now });
      links = selected.map((product, index) => ({ productId: product.id, position: index + 1, layout: index === 0 ? "feature" : "grid" }));
      const approvalTtlHours = Math.max(1, Math.min(168, Number.parseInt(env.NEWSLETTER_WEEKLY_APPROVAL_TTL_HOURS || "24", 10) || 24));
      const previewTtlHours = Math.max(1, Math.min(168, Number.parseInt(env.NEWSLETTER_WEEKLY_PREVIEW_TTL_HOURS || "24", 10) || 24));
      draft = createCampaignDraft(null, actor, rendered, now, campaignId, "collection", links, key, {
        editorialSnapshot: editorial.snapshot,
        editorialFingerprint: editorial.fingerprint,
        editorialCompositionMode: composition.mode,
        editorialCategories: composition.categories,
        previewExpiresAt: new Date(now.getTime() + previewTtlHours * 60 * 60 * 1000).toISOString(),
        approvalExpiresAt: new Date(now.getTime() + approvalTtlHours * 60 * 60 * 1000).toISOString(),
        approvalAudienceCount: testMode ? 1 : null,
        approvalAudienceStatus: testMode ? "ready" : "pending",
      });
    } catch {
      fail("HTML_RENDER", "HTML_RENDER_FAILED");
    }
    successStage("HTML_RENDER");

    startStage("DRAFT_PERSIST");
    let persisted: EmailCampaign;
    try { persisted = await store.createCampaign(draft); }
    catch { fail("DRAFT_PERSIST", "DRAFT_INSERT_FAILED"); }
    context.campaignId = persisted.id;
    context.draftCreated = true;
    context.draftStatus = persisted.status;
    try { await store.createCampaignProducts(persisted.id, links); }
    catch { fail("DRAFT_PERSIST", "DRAFT_PRODUCTS_PERSIST_FAILED", { campaignId: persisted.id, draftCreated: true, draftStatus: persisted.status }); }
    let pending: EmailCampaign;
    try { pending = await submitCampaignForApproval(persisted, actor, { store, env, now }); }
    catch { fail("DRAFT_PERSIST", "DRAFT_APPROVAL_PERSIST_FAILED", { campaignId: persisted.id, draftCreated: true, draftStatus: persisted.status }); }
    context.draftStatus = pending.status;
    successStage("DRAFT_PERSIST");

    startStage("TELEGRAM_DELIVERY");
    let delivery: TelegramDeliveryResult;
    try {
      delivery = await notify(deps.telegramSender, chatId, telegramPreview(pending, selected, copy, clickCounts, composition, testMode, designTestMode, publicBaseUrl, env, audienceConfig), {
        inline_keyboard: [
          [{ text: designTestMode ? "✅ Aprovar e enviar teste de design" : testMode ? "✅ Aprovar teste" : "✅ Aprovar campanha", callback_data: `campaign_weekly_approve:${pending.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${pending.id}` }],
        ],
      });
    } catch {
      fail("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status });
    }
    if (!delivery.ok) {
      fail("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status });
    }
    const messageId = Number(delivery.result?.message_id);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      try { await store.saveCampaignTelegramCard(pending.id, chatId, messageId); }
      catch { fail("DRAFT_PERSIST", "TELEGRAM_CARD_REFERENCE_PERSIST_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status }); }
    }
    successStage("TELEGRAM_DELIVERY");
    return { status: "created", campaign: pending, products: selected };
  } catch (error) {
    if (isWeeklyDraftDiagnosticError(error)) throw error;
    fail("UNKNOWN_INTERNAL", "UNKNOWN_INTERNAL");
  }
}

export async function runWeeklyStaleDraftCheck(options: { env?: NodeJS.ProcessEnv; now?: Date; telegramSender?: WeeklyDraftDeps["telegramSender"] } = {}): Promise<number> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (!chatId) throw new Error("WEEKLY_TELEGRAM_ADMIN_CHAT_MISSING");
  const ttlHours = Math.max(1, Math.min(168, Number.parseInt(env.NEWSLETTER_WEEKLY_APPROVAL_TTL_HOURS || "24", 10)));
  const upper = new Date(now.getTime() - ttlHours * 60 * 60 * 1000).toISOString();
  const lower = new Date(now.getTime() - (ttlHours + 24) * 60 * 60 * 1000).toISOString();
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("email_campaigns").select("id, subject, created_at").eq("status", "pending_approval").like("edition_key", "weekly:%").gte("created_at", lower).lte("created_at", upper).order("created_at", { ascending: true }).limit(20);
  if (error) throw error;
  for (const campaign of data || []) {
    await notify(options.telegramSender, chatId, `⏳ <b>Rascunho semanal sem decisão</b>\n\n${String(campaign.subject || "Campanha semanal")}\n<code>${String(campaign.id)}</code>\n\nO prazo de aprovação passou. Por padrão, nada será enviado automaticamente.`);
  }
  return (data || []).length;
}
