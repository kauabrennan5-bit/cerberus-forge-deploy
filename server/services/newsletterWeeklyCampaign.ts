import { createHash } from "node:crypto";
import type { Product } from "../../src/types";
import { deriveConfidenceV2, deriveMinSampleSize, confidenceV2ToScore } from "../commercialBrain/statisticalRigor";
import * as productsRepository from "../repositories/productsRepository";
import { createSupabaseNewsletterCampaignStore, type NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { submitCampaignForApproval } from "./newsletterCampaignService";
import { createCampaignDraft, type CampaignProductLink, type EmailCampaign } from "./newsletterCampaignState";
import { getNewsletterInstitutionalOptions } from "./newsletterInstitutional";
import { sendTelegramMessage, type TelegramDeliveryResult } from "./telegramBot";
import { generateWeeklyNewsletterCopy, type WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";
import { renderWeeklyNewsletter } from "./newsletterWeeklyTemplate";

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
  copyGenerator?: (products: readonly Product[]) => Promise<WeeklyNewsletterCopy>;
  institutionalLoader?: (env: NodeJS.ProcessEnv) => Promise<Awaited<ReturnType<typeof getNewsletterInstitutionalOptions>>>;
  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  testMode?: boolean;
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

function freshnessMs(product: Product): number {
  const created = product.createdAt ? Date.parse(product.createdAt) : 0;
  const offerConfirmed = product.ofertaPromocional?.source === "admin_confirmed" ? Number(product.ofertaPromocional.confirmedAt || 0) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(offerConfirmed) ? offerConfirmed : 0);
}

export async function loadLastSuccessfulCollectionSentAt(): Promise<string | null> {
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("email_campaigns").select("sent_at").eq("campaign_type", "collection").eq("status", "sent").not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
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

function rankCandidates(products: Product[], clickCounts: Map<string, number>): Product[] {
  const minSample = deriveMinSampleSize().nTotal;
  return [...products].sort((a, b) => {
    const aClicks = clickCounts.get(a.id) || 0;
    const bClicks = clickCounts.get(b.id) || 0;
    const aConfidence = deriveConfidenceV2({ recordCount: aClicks, minSampleRequired: minSample }).confidence;
    const bConfidence = deriveConfidenceV2({ recordCount: bClicks, minSampleRequired: minSample }).confidence;
    return confidenceV2ToScore(bConfidence) - confidenceV2ToScore(aConfidence)
      || bClicks - aClicks
      || freshnessMs(b) - freshnessMs(a);
  });
}

function editionKey(products: readonly Product[], now: Date, testMode: boolean): string {
  const digest = createHash("sha256").update(products.map(p => p.id).sort().join("\n"), "utf8").digest("hex").slice(0, 20);
  return `${testMode ? "weekly-test" : "weekly"}:${now.toISOString().slice(0, 10)}:${digest}`;
}

function telegramPreview(campaign: EmailCampaign, products: readonly Product[], copy: WeeklyNewsletterCopy, clickCounts: Map<string, number>, testMode: boolean): string {
  const minSample = deriveMinSampleSize().nTotal;
  const lines = products.map((product, index) => {
    const clicks = clickCounts.get(product.id) || 0;
    const confidence = deriveConfidenceV2({ recordCount: clicks, minSampleRequired: minSample });
    const canonicalPrice = product.ofertaPromocional?.source === "admin_confirmed" && product.ofertaPromocional.price > 0 ? product.ofertaPromocional.price : product.preco;
    return `${index === 0 ? "⭐" : "•"} ${product.displayTitle || product.produto}\n   R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")} · ${clicks} cliques · confiança ${confidence.confidence}`;
  });
  return [
    testMode ? "🧪 <b>RASCUNHO SEMANAL — LISTA DE TESTE</b>" : "📨 <b>RASCUNHO SEMANAL CERBERUS</b>",
    "",
    `<b>Assunto:</b> ${copy.subject}`,
    `<b>Preview:</b> ${copy.previewText}`,
    "",
    ...lines,
    "",
    "Nenhum e-mail foi enviado ainda.",
    testMode ? "Ao aprovar, somente o destino de teste configurado receberá a campanha." : "Somente sua aprovação explícita cria os destinatários e inicia o envio pelo Brevo.",
    `<code>${campaign.id}</code>`,
  ].join("\n");
}

async function notify(sender: WeeklyDraftDeps["telegramSender"], chatId: string, text: string, markup?: unknown): Promise<TelegramDeliveryResult> {
  return (sender || sendTelegramMessage)(chatId, text, markup);
}


export async function runWeeklyDraftCycle(deps: WeeklyDraftDeps = {}): Promise<WeeklyDraftOutcome> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const testMode = deps.testMode === true;
  const weeklyEnabled = env.NEWSLETTER_WEEKLY_ENABLED === "true";
  if (!testMode && !weeklyEnabled) return { status: "skipped", reason: "disabled", newProductCount: 0 };

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
    const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
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
    successStage("RUNTIME_CONFIG");

    startStage("SUPABASE_READ");
    let products: Product[];
    let lastSentAt: string | null;
    try {
      products = await (deps.productsLoader || productsRepository.getProducts)();
      lastSentAt = testMode
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : await (deps.lastSentAtLoader || loadLastSuccessfulCollectionSentAt)();
    } catch {
      fail("SUPABASE_READ", "SUPABASE_READ_FAILED");
    }
    successStage("SUPABASE_READ");

    startStage("PRODUCT_SELECTION");
    const cutoffMs = lastSentAt ? Date.parse(lastSentAt) : now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const active = products.filter(product => product.ativo === true && product.status === "published");
    const newlyFresh = active.filter(product => freshnessMs(product) > cutoffMs);
    const fresh = newlyFresh.filter(product => Boolean(product.ref?.trim()));
    context.activeProductCount = active.length;
    context.newProductCount = newlyFresh.length;
    context.eligibleProductCount = fresh.length;
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
    let selected: Product[];
    try { selected = rankCandidates(fresh, clickCounts).slice(0, 4); }
    catch { fail("RANKING", "RANKING_FAILED"); }
    successStage("RANKING");

    const key = editionKey(selected, now, testMode);
    startStage("SUPABASE_READ");
    let existing: EmailCampaign | null;
    try { existing = await store.findOperationalCollectionByEditionKey(key); }
    catch { fail("SUPABASE_READ", "SUPABASE_READ_FAILED"); }
    successStage("SUPABASE_READ");
    if (existing) return { status: "skipped", reason: "duplicate", newProductCount: fresh.length };

    startStage("GEMINI");
    let copy: WeeklyNewsletterCopy;
    try { copy = await (deps.copyGenerator || generateWeeklyNewsletterCopy)(selected); }
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
      rendered = renderWeeklyNewsletter(selected, copy, { campaignId, publicBaseUrl, socialLinks: institutional.socialLinks });
      links = selected.map((product, index) => ({ productId: product.id, position: index + 1, layout: index === 0 ? "feature" : "grid" }));
      draft = createCampaignDraft(null, actor, rendered, now, campaignId, "collection", links, key);
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
      delivery = await notify(deps.telegramSender, chatId, telegramPreview(pending, selected, copy, clickCounts, testMode), {
        inline_keyboard: [
          [{ text: testMode ? "✅ Aprovar teste" : "✅ Aprovar e enviar", callback_data: `campaign_weekly_approve:${pending.id}` }],
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
