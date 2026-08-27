import path from "path";
import fs from "fs";
import { extractProductForReview as extractProductForReviewShared } from "./productAutomation";
import * as productsRepository from "../repositories/productsRepository";
import * as categoriesRepository from "../repositories/categoriesRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import * as googleAnalytics from "./googleAnalytics";
import * as cerberusOperator from "./cerberusOperator";
import { createProductionProductPipeline, restoreLifecycleRecord, type LifecycleRecord } from "./productPipeline";
import { syncCatalogAndDeploy } from "./catalogSync";
import { detectMarketplace } from "./marketplace";
import { stripRawAffiliateProvenance } from "./productLifecycle";
import { formatDiagnosticForAdmin } from "./operationalDiagnostics";
import { normalizePromotionOffer } from "./promotionOffer";
import { markTelegramBackendReady } from "./telegramDiagnostics";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import * as commercialCockpit from "./commercialCockpit";
import { runDiscoverCommand } from "./discoveryCommands";
// Bloco N11 — porta controlada de batch /discover-batch (somente URLs).
import { runDiscoverBatchCommand } from "../commercial/facilitator/discoverBatchCommand";
// FASE 25B (Commit 1) — painel de leitura Telegram (comandos read-only).
import * as telegramPanel from "./telegramPanel";
// FASE 25C (Commit 2) — orquestrador /shopee N (discovery → Affiliate → scraper → cards).
import { inspectShopeePromotionFields, inspectShopeePromotionOffer, runShopeeCommand } from "./shopeeCommand";
import type { ShopeePromotionEvidence } from "./scraper";
import {
  handleNewsletterCampaignCallback,
  handleNewsletterCampaignText,
  handleCollectionCampaignCommand,
  handleWelcomeCampaignCommand,
  renderRecentCampaignsForTelegram,
} from "./newsletterCampaignTelegram";
import { createSupabaseNewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";

const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

// FASE 25B (Commit 1): exportado para o painel de leitura (telegramPanel) reutilizar
// a chamada oficial da API Telegram sem duplicar o acesso ao token.
export function getTelegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

function getTelegramApiBase(): string {
  return `https://api.telegram.org/bot${getTelegramBotToken()}`;
}

export async function telegramApiFetch(method: string, payload: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${getTelegramApiBase()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeTelegramApiError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s]+/g, "[URL_REDACTED]")
    .slice(0, 220);
}

function logTelegramEvent(event: string, details: Record<string, string | number | boolean | undefined>): void {
  const sanitized = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (key === "chat_id" && !/^-?\d+$/.test(String(value))) return `${key}=[REDACTED_NON_NUMERIC_CHAT_ID]`;
      return `${key}=${String(value)}`;
    })
    .join(" ");
  console.info(`[Telegram] ${event}${sanitized ? ` ${sanitized}` : ""}`);
}

export function isUserAllowed(userId: string | number): boolean {
  const allowedEnv = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "1976526372";
  const allowedIds = allowedEnv.split(",").map(id => id.trim()).filter(Boolean);
  return allowedIds.includes(String(userId));
}

let testOverrideSendTelegramMessage: ((...args: any[]) => Promise<any>) | null = null;
let testOverrideSendTelegramPhoto: ((...args: any[]) => Promise<any>) | null = null;
export interface TelegramDeliveryResult {
  ok: boolean;
  result?: Record<string, unknown>;
  description?: string;
  failureReason?: string;
  httpStatus?: number;
}

async function parseTelegramDeliveryResponse(
  method: "sendMessage" | "sendPhoto",
  chatId: number | string,
  response: Response,
): Promise<TelegramDeliveryResult> {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const ok = response.ok && payload?.ok === true;
  const description = sanitizeTelegramApiError(payload?.description);
  const failureReason = ok
    ? undefined
    : description ?? (!response.ok ? `telegram_http_${response.status}` : "telegram_logical_failure");
  logTelegramEvent("response", {
    chat_id: chatId,
    response_method: method,
    response_success: ok,
    error: failureReason,
  });
  return {
    ok,
    result: payload?.result && typeof payload.result === "object" ? payload.result : undefined,
    description,
    failureReason,
    httpStatus: response.status,
  };
}

/** Substitui sendTelegramMessage/sendTelegramPhoto em testes unitários; null restaura os reais. */
export function setTestTelegramSenders(
  message: ((...args: any[]) => Promise<any>) | null,
  photo: ((...args: any[]) => Promise<any>) | null,
): void {
  testOverrideSendTelegramMessage = message;
  testOverrideSendTelegramPhoto = photo;
}

export async function sendTelegramMessage(chatId: number | string, text: string, replyMarkup?: any): Promise<TelegramDeliveryResult> {
  if (testOverrideSendTelegramMessage) return testOverrideSendTelegramMessage(chatId, text, replyMarkup);
  if (!getTelegramBotToken()) return { ok: false, failureReason: "telegram_token_missing" };
  try {
    const payload: any = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await telegramApiFetch("sendMessage", payload);
    return parseTelegramDeliveryResponse("sendMessage", chatId, res);
  } catch (err) {
    const failureReason = sanitizeTelegramApiError(err instanceof Error ? err.message : String(err)) ?? "telegram_transport_error";
    logTelegramEvent("response", { chat_id: chatId, response_method: "sendMessage", response_success: false, error: failureReason });
    console.error("Erro ao enviar mensagem Telegram:", err);
    return { ok: false, failureReason };
  }
}

export async function sendTelegramPhoto(chatId: number | string, photoUrl: string, caption: string, replyMarkup?: any): Promise<TelegramDeliveryResult> {
  if (testOverrideSendTelegramPhoto) return testOverrideSendTelegramPhoto(chatId, photoUrl, caption, replyMarkup);
  if (!getTelegramBotToken()) return { ok: false, failureReason: "telegram_token_missing" };
  try {
    const payload: any = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await telegramApiFetch("sendPhoto", payload);
    return parseTelegramDeliveryResponse("sendPhoto", chatId, res);
  } catch (err) {
    const failureReason = sanitizeTelegramApiError(err instanceof Error ? err.message : String(err)) ?? "telegram_transport_error";
    logTelegramEvent("response", { chat_id: chatId, response_method: "sendPhoto", response_success: false, error: failureReason });
    console.error("Erro ao enviar foto Telegram:", err);
    return { ok: false, failureReason };
  }
}

export async function editTelegramMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: any): Promise<any> {
  if (!getTelegramBotToken()) return;
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await telegramApiFetch("editMessageText", payload);
    const result = await res.json();
    logTelegramEvent("response", {
      chat_id: chatId,
      response_method: "editMessageText",
      response_success: Boolean(result?.ok),
      error: result?.ok ? undefined : sanitizeTelegramApiError(result?.description)
    });
    return result;
  } catch (err) {
    logTelegramEvent("response", { chat_id: chatId, response_method: "editMessageText", response_success: false, error: sanitizeTelegramApiError(err instanceof Error ? err.message : String(err)) });
    console.error("Erro ao editar texto Telegram:", err);
  }
}

export async function editTelegramMessageCaption(chatId: number | string, messageId: number, caption: string, replyMarkup?: any): Promise<any> {
  if (!getTelegramBotToken()) return;
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      caption: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await telegramApiFetch("editMessageCaption", payload);
    return await res.json();
  } catch (err) {
    console.error("Erro ao editar legenda Telegram:", err);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert: boolean = false): Promise<any> {
  if (!getTelegramBotToken()) return;
  try {
    const payload: any = {
      callback_query_id: callbackQueryId,
      show_alert: showAlert
    };
    if (text) payload.text = text;
    await telegramApiFetch("answerCallbackQuery", payload);
  } catch (err) {
    console.error("Erro ao responder callback query:", err);
  }
}

function parseAndNormalizePrice(input: string): number | null {
  if (!input) return null;
  let clean = input.replace(/[^0-9,.]/g, "").trim();
  if (!clean) return null;
  if (clean.includes(",") && clean.includes(".")) {
    if (clean.indexOf(",") > clean.indexOf(".")) {
      clean = clean.replace(".", "").replace(",", ".");
    } else {
      clean = clean.replace(",", "");
    }
  } else if (clean.includes(",")) {
    clean = clean.replace(",", ".");
  }
  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

export interface PendingReview {
  id: string;
  chatId: number;
  senderId: number | string;
  firstName: string;
  username: string;
  createdAt: number;
  expiresAt?: number;
  produto: string;
  rawTitle?: string;
  displayTitle?: string;
  curatorNote?: string;
  categoria: string;
  preco: number;
  /** Imagens comerciais ordenadas: principal canônica seguida da galeria revisada. */
  imagens: string[];
  /** URLs observadas na fonte, preservadas para auditoria da revisão. */
  imagensOriginais?: string[];
  imagemPrincipal?: string;
  imagensGaleria?: string[];
  imageEditorialStatus?: "clean" | "review_required" | "overlay_suspected";
  normalizedUrl: string;
  descricao?: string;
  status?: "pending" | "publishing" | "published" | "cancelled" | "expired" | "rejected" | "error";
  cardMessageId?: number;
  existingProduct?: any;
  lifecycle?: LifecycleRecord;
  /** Metadado observacional do preview; nunca substitui preco no produto canônico. */
  promotionEvidence?: ShopeePromotionEvidence | null;
  /** Ajuste humano de oferta, auditável e separado do preço-base canônico. */
  promotionReview?: {
    price: number;
    condition: "pix" | "pix_with_coupon" | "coupon" | "other";
    benefits: string[];
    source: "admin_confirmed";
    confirmedAt: number;
  } | null;
  /** Rascunho temporário da oferta humana, removido ao confirmar ou cancelar. */
  promotionDraft?: {
    price: number;
    condition: "pix" | "pix_with_coupon" | "coupon" | "other" | null;
    benefits: string[];
  } | null;
}

function formatPromotionCondition(condition: NonNullable<PendingReview["promotionReview"]>["condition"]): string {
  if (condition === "pix") return "no Pix";
  if (condition === "pix_with_coupon") return "no Pix com cupom";
  if (condition === "coupon") return "com cupom";
  return "sob condição observada";
}

function renderPromotionReview(review: PendingReview): string {
  const promotion = review.promotionReview;
  if (!promotion) return "";
  const price = `R$ ${promotion.price.toFixed(2).replace(".", ",")}`;
  const benefits = promotion.benefits.length > 0
    ? `\nBenefícios observados:\n${promotion.benefits.map((benefit) => `• ${benefit}`).join("\n")}`
    : "";
  return `\n🏷️ <b>Oferta promocional confirmada manualmente:</b> ${price} ${formatPromotionCondition(promotion.condition)}${benefits}\n<i>Não substitui o preço-base canônico; condições devem ser confirmadas no checkout.</i>`;
}

function buildReviewCardText(review: PendingReview): string {
  const precoStr = review.preco && review.preco > 0 ? `R$ ${review.preco.toFixed(2).replace(".", ",")}` : "⚠️ <i>Não detectado (Definir abaixo)</i>";
  const lifecycle = review.lifecycle;
  const validation = lifecycle?.validation;
  const curation = lifecycle?.curation;
  const curatorNote = review.curatorNote?.trim()
    ? `📝 <b>Nota do curador:</b> ${review.curatorNote.trim()}\n`
    : "";
  return `🛡️ <b>CERBERUS FINDS — PAINEL DE REVISÃO</b>\n\n` +
         `🏷️ <b>Produto:</b> ${review.displayTitle || review.produto}\n` +
         `📁 <b>Categoria:</b> ${review.categoria}\n` +
         `💰 <b>Preço:</b> ${precoStr}\n` +
         curatorNote +
         renderPromotionReview(review) + `\n` +
         `🛒 <b>Marketplace:</b> ${lifecycle?.candidate.marketplace || detectMarketplace(review.normalizedUrl)}\n` +
         `🔗 <b>Link:</b> <code>${review.normalizedUrl}</code>\n\n` +
         `Estado: <b>${lifecycle?.state || "PENDING_APPROVAL"}</b>\n` +
         `Validação: <b>${validation?.outcome || "PENDING"}</b>\n` +
         `Curadoria: <b>${curation?.recommendation || "REVIEW"}</b> · Score ${curation?.score ?? 0} · ${curation?.confidence || "LOW"}\n\n` +
         `<i>Publicação exige aprovação humana e validação E2E da vitrine.</i>`;
}

function buildMainReviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Confirmar & Publicar", callback_data: `confirm_pub:${reviewId}` }],
      [
        { text: "💰 Alterar Preço", callback_data: `edit_price:${reviewId}` },
        { text: "🏷️ Ajustar Promoção", callback_data: `promo_edit:${reviewId}` },
        { text: "📁 Alterar Categoria", callback_data: `edit_cat:${reviewId}` }
      ],
      [{ text: "📝 Nota do curador (opcional)", callback_data: `curator_note_init:${reviewId}` }],
      [{ text: "🔎 Ver detalhes", callback_data: `review_details:${reviewId}` }, { text: "❌ Rejeitar", callback_data: `cancel_rev:${reviewId}` }]
    ]
  };
}

async function extractProductForReview(url: string): Promise<{ success: boolean; data?: any; error?: string }> {
  // A extração editorial compartilhada usa rawContent somente como contexto
  // técnico para a curadoria; a descricao retornada é sempre editorial.
  return extractProductForReviewShared(url);
}

async function refreshReviewLifecycle(review: PendingReview): Promise<LifecycleRecord> {
  const lifecycle = await createProductionProductPipeline().evaluate({
    produto: review.produto,
    rawTitle: review.rawTitle,
    displayTitle: review.displayTitle,
    curatorNote: review.curatorNote,
    categoria: review.categoria,
    preco: review.preco > 0 ? review.preco : null,
    imagens: review.imagens,
    imagensOriginais: review.imagensOriginais,
    imagemPrincipal: review.imagemPrincipal,
    imagensGaleria: review.imagensGaleria,
    imageEditorialStatus: review.imageEditorialStatus,
    normalizedUrl: review.normalizedUrl,
    descricao: review.descricao || "",
    marketplace: detectMarketplace(review.normalizedUrl),
  });
  review.lifecycle = lifecycle;
  return lifecycle;
}

function getPublicationLink(review: PendingReview): { link?: string; error?: string } {
  const affiliateLink = typeof review.existingProduct?.affiliateUrl === "string"
    ? review.existingProduct.affiliateUrl.trim()
    : "";
  const marketplace = detectMarketplace(review.normalizedUrl);
  if (marketplace === "Shopee" && !affiliateLink) {
    return { error: "AFFILIATE_LINK_REQUIRED" };
  }
  const link = affiliateLink || review.normalizedUrl.trim();
  try {
    const parsed = new URL(link);
    if (!/^https?:$/i.test(parsed.protocol)) return { error: "PRODUCT_LINK_INVALID" };
    return { link };
  } catch {
    return { error: "PRODUCT_LINK_INVALID" };
  }
}

function getPublicationCompletenessErrors(review: PendingReview): string[] {
  const errors: string[] = [];
  const rawTitle = review.rawTitle?.trim() || review.produto?.trim() || "";
  const displayTitle = review.displayTitle?.trim() || "";
  const description = stripRawAffiliateProvenance(review.descricao || "").trim();

  if (!rawTitle) errors.push("título de origem ausente");
  // O título público deve resultar da curadoria, não de um fallback silencioso
  // para o título longo recebido do marketplace.
  if (!displayTitle || displayTitle === rawTitle) errors.push("título editorial ausente");
  if (!Number.isFinite(review.preco) || review.preco <= 0) errors.push("preço válido ausente");
  if (!Array.isArray(review.imagens) || review.imagens.filter((image) => typeof image === "string" && image.trim()).length === 0) {
    errors.push("imagem comercial válida ausente");
  }
  if (review.imageEditorialStatus === "review_required" || review.imageEditorialStatus === "overlay_suspected") errors.push("IMAGE_REVIEW_REQUIRED");
  if (description.length < 24) errors.push("descrição editorial ausente");

  return errors;
}

function getReviewImageCandidate(review: PendingReview): {
  imagens: string[];
  imagensOriginais: string[];
  imagemPrincipal?: string;
  imagensGaleria: string[];
  imageCuration?: {
    status: "ready";
    rawImageUrls: string[];
    primaryImageUrl: string;
    galleryImageUrls: string[];
    assessments: [];
  };
  imageEditorialStatus: "clean" | "review_required";
} {
  const canonical = resolveCanonicalProductImage(review);
  const primaryImageUrl = review.imagemPrincipal || canonical.primaryImageUrl;
  const galleryImageUrls = review.imagensGaleria ?? canonical.galleryImageUrls;
  const ready = Boolean(primaryImageUrl && canonical.status === "ready");
  return {
    imagens: canonical.publicHttpsImageUrls,
    imagensOriginais: review.imagensOriginais ?? canonical.rawImageUrls,
    imagemPrincipal: primaryImageUrl,
    imagensGaleria: galleryImageUrls,
    imageCuration: ready && primaryImageUrl
      ? { status: "ready", rawImageUrls: review.imagensOriginais ?? canonical.rawImageUrls, primaryImageUrl, galleryImageUrls, assessments: [] }
      : undefined,
    imageEditorialStatus: review.imageEditorialStatus === "clean" ? "clean" : review.imageEditorialStatus ? "review_required" : (ready ? "clean" : "review_required"),
  };
}

function logAndValidateReviewCallback(
  actionName: string,
  reviewId: string,
  chatId: string | number | undefined,
  review: PendingReview | null
): { valid: boolean; reason?: string } {
  const statusStr = review ? (review.status || "pending") : "não localizada";
  let valid = true;
  let reason = "OK";
  if (!review) {
    valid = false;
    reason = "Revisão não localizada no sistema.";
  } else if (statusStr === "published" && !actionName.startsWith("promo_")) {
    valid = false;
    reason = "Esta revisão já foi publicada.";
  } else if (statusStr === "publishing") {
    valid = false;
    reason = "Esta revisão já está em publicação.";
  } else if (statusStr === "cancelled") {
    valid = false;
    reason = "Esta revisão foi cancelada.";
  }
  return { valid, reason };
}

type ProductListView = {
  text: string;
  keyboard: { inline_keyboard: any[][] };
  page: number;
  total: number;
  totalPages: number;
};

type ProductListItem = {
  id: string;
  ref?: string;
  produto: string;
  preco: number;
  ativo?: boolean;
};

export function buildProductListView(products: ProductListItem[], pageInput: number): ProductListView {
  const pageSize = 5;
  const total = products.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(0, pageInput), totalPages - 1);
  const start = page * pageSize;
  const end = start + pageSize;
  const paged = products.slice(start, end);
  let text = `📦 <b>PRODUTOS — ${total} cadastrados</b>\n\n` +
             `Página ${page + 1} de ${totalPages}\n\n`;
  const buttons: any[][] = [];

  for (const product of paged) {
    const statusEmoji = product.ativo !== false ? "🟢" : "⏸️";
    const ref = product.ref || "SEM-REF";
    text += `${statusEmoji} <b>${product.produto.slice(0, 32)}</b>\n` +
            `REF: <code>${ref}</code> | R$ ${product.preco.toFixed(2).replace(".", ",")}\n\n`;
    const campaignAvailable = product.ativo === true;
    buttons.push([
      { text: `👁️ ${ref}`, callback_data: `product_view:${product.id}` },
      ...(campaignAvailable ? [{ text: "📧 E-mail", callback_data: `campaign_email:${product.id}` }] : []),
      { text: "✏️ Editar", callback_data: `product_edit:${product.id}` },
      { text: product.ativo !== false ? "⏸️ Pausar" : "🟢 Ativar", callback_data: `product_toggle:${product.id}` }
    ]);
  }

  const navRow: any[] = [];
  if (page > 0) navRow.push({ text: "◀️ Anterior", callback_data: `products_list:${page - 1}` });
  if (end < total) navRow.push({ text: "Próxima ▶️", callback_data: `products_list:${page + 1}` });
  if (navRow.length > 0) buttons.push(navRow);
  buttons.push([{ text: "🔎 Buscar", callback_data: "products_search_init" }, { text: "⬅️ Menu Principal", callback_data: "admin_menu" }]);

  return { text, keyboard: { inline_keyboard: buttons }, page, total, totalPages };
}

async function renderProductList(pageInput: number): Promise<ProductListView> {
  const products = await productsRepository.getProducts();
  return buildProductListView(products, pageInput);
}

/**
 * Renderizador do Menu Principal /start e /admin
 */
async function renderMainMenu(chatId: number | string, messageId?: number, isEdit: boolean = false): Promise<void> {
  let statsSummary = { totalProducts: 0, activeProducts: 0, todayClicks: 0, clicks7d: 0, topProductName: "Nenhum" };
  try {
    const summary = await productsRepository.getAnalyticsSummary();
    const ranking = await productsRepository.getProductAnalyticsRanking("7d");
    statsSummary.totalProducts = summary.totalProducts;
    statsSummary.activeProducts = summary.activeProducts;
    statsSummary.todayClicks = summary.todayClicks;
    statsSummary.clicks7d = summary.clicks7d;
    if (ranking.length > 0 && ranking[0].count > 0) {
      statsSummary.topProductName = ranking[0].product.produto;
    }
  } catch {}

  const text = 
    "🏴 <b>CERBERUS FINDS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🛠 <b>PAINEL ADMINISTRATIVO</b>\n\n" +
    `📦 Produtos: <b>${statsSummary.totalProducts}</b>\n` +
    `🟢 Ativos: <b>${statsSummary.activeProducts}</b>\n` +
    `⏸ Pausados: <b>${statsSummary.totalProducts - statsSummary.activeProducts}</b>\n\n` +
    `👆 Cliques hoje: <b>${statsSummary.todayClicks}</b>\n` +
    `📈 Cliques 7 dias: <b>${statsSummary.clicks7d}</b>\n\n` +
    `🏆 Mais acessado:\n<i>${statsSummary.topProductName}</i>\n` +
    "━━━━━━━━━━━━━━━━━━";

  const keyboard = {
    inline_keyboard: [
      [{ text: "📦 Produtos", callback_data: "products_list:0" }, { text: "🔎 Descobrir", callback_data: "admin_add" }],
      [{ text: "🧠 Curadoria", callback_data: "product_approvals:0" }, { text: "⏳ Aprovações", callback_data: "product_approvals:0" }],
      [{ text: "🚀 Publicações", callback_data: "products_list:0" }, { text: "📊 Analytics", callback_data: "analytics_overview" }],
      [{ text: "🗂️ Campanha 2 semanal", callback_data: "campaign_collection" }],
      [{ text: "🧠 Operator", callback_data: "operator_home" }, { text: "⚙️ Configurações", callback_data: "admin_system" }]
    ]
  };

  if (isEdit && messageId) {
    await editTelegramMessageText(chatId, messageId, text, keyboard);
  } else {
    await sendTelegramMessage(chatId, text, keyboard);
  }
}

/**
 * Processador Principal de Updates do Webhook (Texto + Callback Queries)
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!update) return;
  logTelegramEvent("update_received", {
    update_type: update.callback_query ? "callback_query" : update.message?.text ? "message" : "other"
  });

  // 1. CALLBACK QUERIES
  if (update.callback_query) {
    const cb = update.callback_query;
    const callbackId = cb.id;
    const senderId = cb.from?.id || "Desconhecido";
    const data: string = cb.data || "";
    const msg = cb.message;
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;

    if (!isUserAllowed(senderId)) {
      logTelegramEvent("admin_authorized", { chat_id: chatId, authorized: false });
      await answerCallbackQuery(callbackId, "🔒 Acesso não autorizado.", true);
      return;
    }
    logTelegramEvent("admin_authorized", { chat_id: chatId, authorized: true });

    const campaignHandled = await handleNewsletterCampaignCallback(data, callbackId, String(senderId), chatId, messageId, {
      answerCallbackQuery,
      editTelegramMessageText,
      sendTelegramMessage,
    });
    if (campaignHandled) return;

    // --- NAMESPACE: ADMIN / MENU ---
    if (data === "admin_menu" || data === "admin_back") {
      await answerCallbackQuery(callbackId);
      if (chatId && messageId) await renderMainMenu(chatId, messageId, true);
      return;
    }

    if (data.startsWith("product_approvals:")) {
      const page = Math.max(0, Number.parseInt(data.split(":")[1] || "0", 10) || 0);
      const reviews = await telegramRepo.listPendingReviews(50);
      const pageSize = 5;
      const pageCount = Math.max(1, Math.ceil(reviews.length / pageSize));
      const safePage = Math.min(page, pageCount - 1);
      const visible = reviews.slice(safePage * pageSize, safePage * pageSize + pageSize);
      let text = `⏳ <b>FILA DE APROVAÇÃO</b>\n\n${reviews.length} proposta(s) pendente(s)\nPágina ${safePage + 1} de ${pageCount}\n\n`;
      text += visible.length === 0 ? "Nenhuma proposta aguarda aprovação." : visible.map((review, index) => {
        const lifecycle = review.lifecycle;
        const curation = lifecycle?.curation;
        const issues = [...(lifecycle?.validation.errors || []), ...(lifecycle?.validation.warnings || [])];
        return `<b>${safePage * pageSize + index + 1}. ${review.produto}</b>\n` +
          `🛒 ${lifecycle?.candidate.marketplace || detectMarketplace(review.normalizedUrl)} · 💰 R$ ${review.preco.toFixed(2).replace(".", ",")}\n` +
          `🧠 ${curation?.recommendation || "REVIEW"} · Score ${curation?.score ?? 0} · ${curation?.confidence || "LOW"}\n` +
          `⚠️ ${issues.join("; ") || "Sem problemas críticos identificados."}\n` +
          `📅 ${new Date(review.createdAt).toLocaleString("pt-BR")}\n`;
      }).join("\n");
      const keyboardRows: any[] = visible.map(review => ([
        { text: `🔎 ${review.produto.slice(0, 24)}`, callback_data: `review_details:${review.id}` },
        { text: "✅ Aprovar", callback_data: `confirm_pub:${review.id}` },
        { text: "❌ Rejeitar", callback_data: `cancel_rev:${review.id}` },
      ]));
      const nav: any[] = [];
      if (safePage > 0) nav.push({ text: "◀️ Anterior", callback_data: `product_approvals:${safePage - 1}` });
      if (safePage + 1 < pageCount) nav.push({ text: "Próxima ▶️", callback_data: `product_approvals:${safePage + 1}` });
      if (nav.length) keyboardRows.push(nav);
      keyboardRows.push([{ text: "⬅️ Painel", callback_data: "admin_menu" }]);
      await answerCallbackQuery(callbackId);
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: keyboardRows });
      return;
    }

    // --- NAMESPACE: CERBERUS OPERATOR ---
    if (data === "operator_home" || data === "operator_refresh") {
      await answerCallbackQuery(callbackId, "Verificando saúde do sistema...");
      const report = await cerberusOperator.runSystemHealthCheck();
      const operational = cerberusOperator.getOperationalState();
      const pendingApprovals = cerberusOperator.getPendingApprovals();
      const statusEmoji = report.overallStatus === "HEALTHY" ? "🟢" : report.overallStatus === "DEGRADED" ? "🟡" : "🔴";
      const healthyCount = Object.values(report.components).filter(c => c.status === "HEALTHY").length;
      const totalCount = Object.keys(report.components).length;
      
      const text = 
        "🧠 <b>CERBERUS HEARTBEAT & OPERATOR</b>\n" +
        "━━━━━━━━━━━━━━━━━━\n" +
        `Status do Sistema: ${statusEmoji} <b>${report.overallStatus}</b>\n` +
        `Componentes OK: <b>${healthyCount}/${totalCount}</b>\n` +
        `Modo: <code>${report.mode}</code>\n` +
        `Nível: <b>LEVEL ${operational.autonomyLevel}</b>\n` +
        `Estado: <code>${operational.operatorState}</code>\n\n` +
        `• Backend: ${report.components["Backend"]?.status === "HEALTHY" ? "🟢" : "🔴"}\n` +
        `• Supabase: ${report.components["Supabase"]?.status === "HEALTHY" ? "🟢" : "🔴"}\n` +
        `• Catálogo: ${report.components["Catálogo"]?.status === "HEALTHY" ? "🟢" : "🔴"}\n` +
        `• Tracking: ${report.components["Tracking"]?.status === "HEALTHY" ? "🟢" : "🔴"}\n` +
        `• Analytics: ${report.components["Analytics"]?.status === "HEALTHY" ? "🟢" : "🟡"}\n` +
        `• Telegram: ${report.components["Telegram"]?.status === "HEALTHY" ? "🟢" : "🔴"}\n` +
        `• Site / Deploy: ${report.components["Site"]?.status === "HEALTHY" ? "🟢" : "🟡"}\n\n` +
        `🚨 Incidentes ativos: <b>${report.activeIncidentsCount}</b>\n` +
        `🔐 Ações pendentes: <b>${pendingApprovals.length}</b>\n` +
        `📣 Escalations: <b>${operational.escalations}</b>\n` +
        `🕐 Última verificação: ${report.lastCheckAt}\n` +
        `⏰ Próxima agendada: ${report.nextCheckAt || "Em breve"}\n` +
        "━━━━━━━━━━━━━━━━━━";

      const keyboard = {
        inline_keyboard: [
          [{ text: "🏥 Status Detalhado", callback_data: "operator_health" }, { text: "🚨 Incidentes", callback_data: "operator_incidents" }],
          [{ text: "📊 Histórico", callback_data: "operator_history" }, { text: "🔧 Ações", callback_data: "operator_actions" }],
          [{ text: "🔐 Pendências", callback_data: "operator_pending" }, { text: "📣 Escalations", callback_data: "operator_escalations" }],
          [{ text: "⚙️ Modo", callback_data: "operator_config" }, { text: "📜 Logs", callback_data: "operator_logs" }],
          [{ text: "🔄 Verificar Agora", callback_data: "operator_refresh" }],
          [{ text: "⬅️ Menu Principal", callback_data: "admin_menu" }]
        ]
      };

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_history") {
      await answerCallbackQuery(callbackId);
      const history = cerberusOperator.getHealthHistory();
      let text = "📊 <b>HISTÓRICO RECENTE DE HEALTH CHECKS</b>\n\n";
      if (history.length === 0) {
        text += "Nenhum histórico registrado ainda.";
      } else {
        for (const h of history.slice(0, 8)) {
          const em = h.status === "HEALTHY" ? "🟢" : h.status === "DEGRADED" ? "🟡" : "🔴";
          text += `${em} [${h.timestamp}] <b>${h.component}</b> (${h.latencyMs}ms)${h.error ? ` - <i>${h.error}</i>` : ""}\n`;
        }
      }
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_pending") {
      await answerCallbackQuery(callbackId);
      const pending = cerberusOperator.getPendingApprovals();
      let text = "🔐 <b>AÇÕES PENDENTES DE APROVAÇÃO</b>\n\n";
      text += pending.length === 0
        ? "Nenhuma ação aguarda aprovação administrativa."
        : pending.map(item => `• <code>${item.actionId}</code>\n  Solicitação: ${item.id}\n  Criada: ${new Date(item.createdAt).toLocaleString("pt-BR")}\n`).join("\n");
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_escalations") {
      await answerCallbackQuery(callbackId);
      const escalated = cerberusOperator.getEscalatedIncidents();
      let text = "📣 <b>INCIDENTES ESCALADOS</b>\n\n";
      text += escalated.length === 0
        ? "Nenhum incidente exige intervenção humana no momento."
        : escalated.slice(0, 10).map(item => `• <code>${item.id}</code> · <b>${item.component}</b>\n  ${item.result}\n`).join("\n");
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_health") {
      await answerCallbackQuery(callbackId);
      const report = await cerberusOperator.runSystemHealthCheck();
      let text = "🏥 <b>RELATÓRIO DE HEALTH CHECK</b>\n\n";
      for (const [name, comp] of Object.entries(report.components)) {
        const em = comp.status === "HEALTHY" ? "🟢" : comp.status === "DEGRADED" ? "🟡" : "🔴";
        text += `${em} <b>${name}</b>: ${comp.status} (${comp.latencyMs}ms)${comp.error ? `\n   └ <i>${comp.error}</i>` : ""}\n`;
      }
      text += `\n🕒 Verificado em: ${report.lastCheckAt}`;
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_incidents") {
      await answerCallbackQuery(callbackId);
      const list = cerberusOperator.getIncidents();
      let text = "🚨 <b>INCIDENTES REGISTRADOS</b>\n\n";
      if (list.length === 0) {
        text += "Nenhum incidente ativo ou recente registrado. O sistema opera normalmente.";
      } else {
        for (const inc of list.slice(0, 5)) {
          text += `• <code>${inc.id}</code> [${inc.severity}] <b>${inc.component}</b>\n  Status: ${inc.status} | ${inc.timestamp}\n  Diag: ${inc.diagnosis}\n\n`;
        }
      }
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_actions") {
      await answerCallbackQuery(callbackId);
      let text = "🔧 <b>AÇÕES DE SAFE AUTO-HEAL</b>\n\nApenas ações previamente registradas podem ser executadas. Não há shell, SQL, alteração de secrets ou operações destrutivas.\n\n";
      const actions = cerberusOperator.AVAILABLE_OPERATOR_ACTIONS;
      const buttons = actions.map(a => [{ text: `${a.name} · ${a.risk}`, callback_data: `operator_run:${a.id}` }]);
      buttons.push([{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]);
      const keyboard = { inline_keyboard: buttons };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("operator_run:")) {
      const actionId = data.split(":")[1];
      const action = cerberusOperator.AVAILABLE_OPERATOR_ACTIONS.find(item => item.id === actionId);
      if (!action) {
        await answerCallbackQuery(callbackId, "Ação não autorizada.", true);
        return;
      }

      if (action.requiresApproval) {
        const approval = cerberusOperator.requestOperatorApproval(actionId, undefined, String(senderId));
        if (!approval) {
          await answerCallbackQuery(callbackId, "Não foi possível criar aprovação.", true);
          return;
        }
        const text = "🔐 <b>AÇÃO REQUER APROVAÇÃO</b>\n\n" +
          `Ação proposta: <code>${action.id}</code>\n` +
          `Risco: <b>${action.risk}</b>\n` +
          "Motivo: esta ação pode sincronizar a projeção versionada com GitHub/Render.\n\n" +
          "A aprovação é explícita, temporária e vinculada ao administrador autorizado.";
        const keyboard = { inline_keyboard: [
          [{ text: "✅ Aprovar", callback_data: `operator_approve:${approval.id}` }, { text: "❌ Recusar", callback_data: `operator_reject:${approval.id}` }],
          [{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]
        ] };
        if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
        return;
      }

      await answerCallbackQuery(callbackId, "Executando ação autorizada...");
      const res = await cerberusOperator.runSafeAutoHeal(actionId, { actor: "ADMIN", adminId: String(senderId) });
      const title = res.status === "SUCCESS" ? "✅ <b>AUTO-HEAL CONCLUÍDO</b>" : res.status === "DRY_RUN" ? "🧪 <b>DRY RUN</b>" : "⚠️ <b>AÇÃO NÃO CONCLUÍDA</b>";
      const text = `${title}\n\nAção: <code>${actionId}</code>\nStatus: <b>${res.status}</b>\nValidação: ${res.audit.validation || "Não aplicável"}\n\n${res.message}`;
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("operator_approve:")) {
      const approvalId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "Executando ação aprovada...");
      const res = await cerberusOperator.approveOperatorAction(approvalId, String(senderId));
      const text = !res
        ? "⚠️ <b>APROVAÇÃO EXPIRADA OU INVÁLIDA</b>\n\nNenhuma ação foi executada."
        : `${res.status === "SUCCESS" ? "✅" : "⚠️"} <b>RESULTADO DA AÇÃO APROVADA</b>\n\nAção: <code>${res.actionId}</code>\nStatus: <b>${res.status}</b>\n\n${res.message}`;
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("operator_reject:")) {
      await answerCallbackQuery(callbackId, "Ação recusada.");
      const text = "❌ <b>AÇÃO RECUSADA PELO ADMINISTRADOR</b>\n\nNenhuma alteração foi executada.";
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "operator_config") {
      await answerCallbackQuery(callbackId);
      const mode = cerberusOperator.getOperatorMode();
      const text = "⚙️ <b>CONFIGURAÇÃO DO OPERATOR</b>\n\n" +
        `Modo atual: <code>${mode}</code>\n\n` +
        "OBSERVE: apenas diagnostica.\n" +
        "SAFE_AUTO_HEAL: executa somente ações LOW registradas.\n" +
        "DRY_RUN: mostra a ação segura sem modificar nada.\n" +
        "ADMIN_APPROVAL: ações sensíveis ficam pendentes de aprovação.";
      const keyboard = { inline_keyboard: [
        [{ text: "👁 OBSERVE", callback_data: "operator_mode:OBSERVE" }, { text: "🧪 DRY RUN", callback_data: "operator_mode:DRY_RUN" }],
        [{ text: "🔧 SAFE AUTO-HEAL", callback_data: "operator_mode:SAFE_AUTO_HEAL" }],
        [{ text: "🔐 ADMIN APPROVAL", callback_data: "operator_mode:ADMIN_APPROVAL" }],
        [{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]
      ] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("operator_mode:")) {
      const mode = data.split(":")[1] as "OBSERVE" | "SAFE_AUTO_HEAL" | "DRY_RUN" | "ADMIN_APPROVAL";
      const allowedModes = ["OBSERVE", "SAFE_AUTO_HEAL", "DRY_RUN", "ADMIN_APPROVAL"];
      if (!allowedModes.includes(mode)) {
        await answerCallbackQuery(callbackId, "Modo inválido.", true);
        return;
      }
      cerberusOperator.setOperatorMode(mode);
      await answerCallbackQuery(callbackId, `Modo alterado para ${mode}.`);
      if (chatId && messageId) await renderMainMenu(chatId, messageId, true);
      return;
    }

    if (data === "operator_logs") {
      await answerCallbackQuery(callbackId);
      const logs = cerberusOperator.getAutoHealAuditLog();
      let text = "📜 <b>AUDIT LOG DE SAFE AUTO-HEAL</b>\n\n";
      if (logs.length === 0) {
        text += "Nenhuma ação de autocorreção registrada recentemente.";
      } else {
        for (const l of logs.slice(0, 10)) {
          text += `• <code>${l.actionId}</code> · <b>${l.status}</b>\n  Resultado: ${l.result}\n  Duração: ${l.durationMs}ms${l.rollback ? " · rollback" : ""}\n\n`;
        }
      }
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar ao Operator", callback_data: "operator_home" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "admin_system") {
      await answerCallbackQuery(callbackId);
      const report = await cerberusOperator.runSystemHealthCheck();
      const gaStatus = googleAnalytics.getGA4Status();
      const gaApiStr = gaStatus.isConfigured ? "🟢 Configurada" : "⚪ Não configurada";
      const health = ["Backend", "Supabase", "Produtos", "Catálogo", "Tracking", "Analytics", "Telegram", "Site", "Deploy", "GitHub"]
        .map(name => `${name} ${report.components[name]?.status === "HEALTHY" ? "🟢" : report.components[name]?.status === "UNKNOWN" ? "⚪" : "🟡"}`)
        .join("\n");
      const text = "🩺 <b>STATUS DO SISTEMA</b>\n\n" +
                   health + "\n" +
                   "GA4 Data API " + gaApiStr + "\n\n" +
                   "📦 Produtos canônicos: <b>" + (report.components["Produtos"]?.details || "não confirmado") + "</b>\n" +
                   "🕒 Operation ID: <code>" + (report.components["Backend"]?.operationId || "não disponível") + "</code>";
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "admin_menu" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "admin_highlights") {
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const highlights = products.filter(p => p.destaque);
      let text = `⭐ <b>DESTAQUES DO CATÁLOGO</b>\nTotal em destaque: <b>${highlights.length}</b>\n\n`;
      const buttons = [];
      for (const p of highlights.slice(0, 10)) {
        text += `• <code>${p.ref}</code> - ${p.produto}\n`;
        buttons.push([{ text: `✏️ ${p.ref}`, callback_data: `product_edit:${p.id}` }]);
      }
      buttons.push([{ text: "⬅️ Voltar", callback_data: "admin_menu" }]);
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data === "admin_categories") {
      await answerCallbackQuery(callbackId);
      const cats = await categoriesRepository.getCategories();
      let text = "🏷️ <b>GERENCIAR CATEGORIAS</b>\n\n";
      const buttons = [];
      for (const c of cats) {
        text += `• ${c.name}\n`;
        buttons.push([{ text: `✏️ Renomear ${c.name}`, callback_data: `rename_cat_init:${c.name}` }]);
      }
      buttons.push([{ text: "➕ Adicionar Categoria", callback_data: "add_cat_init" }]);
      buttons.push([{ text: "⬅️ Voltar", callback_data: "admin_menu" }]);
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data === "admin_add") {
      await answerCallbackQuery(callbackId);
      if (chatId) {
        await sendTelegramMessage(chatId, "➕ <b>ADICIONAR NOVO PRODUTO</b>\n\nEnvie o link de um produto da Shopee ou Mercado Livre para iniciar a extração automática por IA e revisão.");
      }
      return;
    }

    // --- NAMESPACE: PRODUCTS ---
    if (data.startsWith("products_list:")) {
      const page = Number.parseInt(data.split(":")[1] || "0", 10) || 0;
      await answerCallbackQuery(callbackId);
      const listView = await renderProductList(page);
      logTelegramEvent("handler", { chat_id: chatId, handler: "product_list", products_count: listView.total, page: listView.page, response_method: "editMessageText" });
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, listView.text, listView.keyboard);
      return;
    }

    if (data.startsWith("product_view:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) {
        if (chatId && messageId) await editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "products_list:0" }]] });
        return;
      }

      let text = `👁️ <b>DETALHES DO PRODUTO</b>\n\n` +
                 `<b>Nome:</b> ${product.produto}\n` +
                 `<b>REF:</b> <code>${product.ref}</code>\n` +
                 `<b>Preço:</b> R$ ${product.preco.toFixed(2).replace(".", ",")}\n` +
                 `<b>Categoria:</b> ${product.categoria}\n` +
                 `<b>Status:</b> ${product.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n` +
                 `<b>Destaque:</b> ${product.destaque ? "Sim" : "Não"}\n`;

      const campaignAvailable = product.ativo === true && (!product.status || product.status === "approved" || product.status === "published");
      const keyboard = {
        inline_keyboard: [
          [{ text: "🎯 Ver Analytics", callback_data: `analytics_product:${product.id}:7d` }],
          ...(campaignAvailable ? [[{ text: "📧 Criar campanha", callback_data: `campaign_email:${product.id}` }]] : []),
          [{ text: "✏️ Editar", callback_data: `product_edit:${product.id}` }, { text: "🗄️ Arquivar", callback_data: `product_del_confirm:${product.id}` }],
          [{ text: "🔗 Abrir no Site", url: `https://cerberusfinds.com/produto/${product.slug || product.id}` }],
          [{ text: "⬅️ Voltar", callback_data: "products_list:0" }]
        ]
      };

      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, text, keyboard);
      }
      return;
    }

    if (data.startsWith("product_toggle:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (product) {
        if (product.ativo !== false) {
          await productsRepository.pauseProduct(product.id);
        } else {
          await productsRepository.updateProduct(product.id, { ativo: true, status: "published" }, { syncCatalog: false });
          const publication = await syncCatalogAndDeploy(product.produto, product.id);
          if (!publication.success) {
            await productsRepository.pauseProduct(product.id);
            throw new Error(publication.error || "PUBLICATION_ERROR");
          }
        }
      }
      const listView = await renderProductList(0);
      logTelegramEvent("handler", { chat_id: chatId, handler: "product_list", products_count: listView.total, page: listView.page, response_method: "editMessageText" });
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, listView.text, listView.keyboard);
      return;
    }

    if (data.startsWith("product_edit:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) return;

      const editTxt = `🛠️ <b>EDITAR PRODUTO</b>\n\n` +
                      `🆔 <b>REF:</b> <code>${product.ref}</code>\n` +
                      `🏷️ <b>Título:</b> ${product.produto}\n` +
                      `💰 <b>Preço:</b> R$ ${product.preco.toFixed(2).replace(".", ",")}\n` +
                      `📁 <b>Categoria:</b> ${product.categoria}\n` +
                      `📊 <b>Status:</b> ${product.ativo !== false ? 'Ativo 🟢' : 'Pausado ⏸️'}\n\n` +
                      `<i>Selecione o campo que deseja alterar:</i>`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "📝 Título", callback_data: `field_edit:${product.id}:produto` }, { text: "💰 Preço", callback_data: `field_edit:${product.id}:preco` }],
          [{ text: "📁 Categoria", callback_data: `field_edit:${product.id}:categoria` }, { text: "📝 Descrição", callback_data: `field_edit:${product.id}:descricao` }],
          [{ text: product.ativo !== false ? "⏸ Pausar" : "🟢 Reativar", callback_data: `product_toggle:${product.id}` }, { text: "🗄️ ARQUIVAR", callback_data: `product_del_confirm:${product.id}` }],
          [{ text: "⬅️ Voltar", callback_data: `product_view:${product.id}` }]
        ]
      };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, editTxt, keyboard);
      return;
    }

    if (data.startsWith("field_edit:")) {
      const parts = data.split(":");
      const prodId = parts[1];
      const field = parts[2];
      await answerCallbackQuery(callbackId, `Digite o novo valor para ${field}:`);
      await telegramRepo.setUserState(senderId, { action: `edit_field:${field}`, productId: prodId });
      if (chatId) {
        await sendTelegramMessage(chatId, `✏️ <b>EDITAR CAMPO: ${field.toUpperCase()}</b>\n\nEnvie o novo valor por mensagem de texto:`);
      }
      return;
    }

    if (data.startsWith("product_del_confirm:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) return;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🗄️ CONFIRMAR ARQUIVAMENTO", callback_data: `product_del_exec:${product.id}` }],
          [{ text: "❌ Cancelar", callback_data: `product_edit:${product.id}` }]
        ]
      };
      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, `🚨 <b>CONFIRMAR ARQUIVAMENTO</b>\n\nProduto: <b>${product.produto}</b>\nREF: <code>${product.ref}</code>\n\nO produto permanecerá no Supabase para histórico e sairá da projeção pública.`, keyboard);
      }
      return;
    }

    if (data.startsWith("product_del_exec:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "Arquivando produto...");
      const success = await productsRepository.deleteProduct(prodId);
      if (chatId) {
        if (success) {
          await sendTelegramMessage(chatId, "✅ <b>Produto arquivado com histórico preservado no Supabase e projeção pública sincronizada.</b>");
          await renderMainMenu(chatId);
        } else {
          await sendTelegramMessage(chatId, "❌ Falha ao remover produto.");
        }
      }
      return;
    }

    if (data === "products_search_init") {
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: "products_search" });
      if (chatId) {
        await sendTelegramMessage(chatId, "🔎 <b>BUSCAR PRODUTO</b>\n\nDigite o nome, REF ou termo para buscar no catálogo:");
      }
      return;
    }

    // --- NAMESPACE: ANALYTICS (ESTRITO SUPABASE) ---
    if (data === "analytics_overview") {
      await answerCallbackQuery(callbackId);
      let opSummary;
      let opError = null;
      try {
        opSummary = await productsRepository.getAnalyticsSummary();
      } catch (err: any) {
        opError = err.message;
      }

      let text = "📊 <b>CERBERUS ANALYTICS</b>\n━━━━━━━━━━━━━━━━━━\n\n";
      if (opError) {
        text += "⚠️ <b>ANALYTICS INDISPONÍVEL</b>\n\nNão foi possível consultar os dados de produção.\nTente novamente em alguns instantes.\n\n<code>" + opError + "</code>";
      } else if (opSummary) {
        text += "📦 <b>CATÁLOGO</b>\n" +
                "• Produtos cadastrados: <b>" + opSummary.totalProducts + "</b>\n" +
                "• Produtos ativos: <b>" + opSummary.activeProducts + "</b>\n\n" +
                "🖱️ <b>CLIQUES</b>\n" +
                "• Cliques hoje: <b>" + opSummary.todayClicks + "</b>\n" +
                "• Cliques 7 dias: <b>" + opSummary.clicks7d + "</b>\n" +
                "• Cliques 30 dias: <b>" + opSummary.clicks30d + "</b>\n" +
                "• Cliques totais: <b>" + opSummary.totalClicks + "</b>\n\n" +
                "🛒 <b>MARKETPLACES</b>\n" +
                "• Shopee: <b>" + (opSummary.marketplaceCounts.Shopee || 0) + "</b>\n" +
                "• Mercado Livre: <b>" + (opSummary.marketplaceCounts["Mercado Livre"] || 0) + "</b>\n\n" +
                "🏆 <b>PRODUTO MAIS ACESSADO</b>\n" +
                (opSummary.topProducts.length > 0 ? `<i>${opSummary.topProducts[0].name}</i> (${opSummary.topProducts[0].count} cliques)` : "Nenhum clique registrado") + "\n" +
                "━━━━━━━━━━━━━━━━━━";
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: "🎯 Analytics por produto", callback_data: "analytics_products:0" }],
          [{ text: "🏆 Ranking de produtos", callback_data: "analytics_ranking:7d" }],
          [{ text: "🔄 Atualizar", callback_data: "analytics_overview" }, { text: "⬅️ Menu Principal", callback_data: "admin_menu" }]
        ]
      };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("analytics_products:")) {
      const page = parseInt(data.split(":")[1]) || 0;
      await answerCallbackQuery(callbackId);
      let list;
      try {
        list = await productsRepository.getProductsForAnalytics();
      } catch {
        list = [];
      }

      const pageSize = 5;
      const start = page * pageSize;
      const end = start + pageSize;
      const paged = list.slice(start, end);
      const total = list.length;

      const totalPages = Math.ceil(total / pageSize) || 1;
      let text = `🎯 <b>ANALYTICS POR PRODUTO</b>\n\n` +
                 `${total} produtos cadastrados\n` +
                 `Página ${page + 1} de ${totalPages}\n` +
                 `━━━━━━━━━━━━━━━━━━\n` +
                 `Selecione um produto abaixo:\n\n`;
      const buttons = [];

      for (const item of paged) {
        buttons.push([{ text: `📦 ${item.product.produto.slice(0, 26)} — 👆 ${item.totalClicks} cliques`, callback_data: `analytics_product:${item.product.id}:7d` }]);
      }

      const navRow = [];
      if (page > 0) {
        navRow.push({ text: "◀️ Anterior", callback_data: `analytics_products:${page - 1}` });
      }
      if (end < total) {
        navRow.push({ text: "Próxima ▶️", callback_data: `analytics_products:${page + 1}` });
      }
      if (navRow.length > 0) {
        buttons.push(navRow);
      }

      buttons.push([{ text: "📊 Visão Geral", callback_data: "analytics_overview" }, { text: "⬅️ Voltar", callback_data: "analytics_overview" }]);

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data.startsWith("analytics_ranking:")) {
      const period = data.split(":")[1] || "7d";
      await answerCallbackQuery(callbackId);
      let ranking;
      try {
        ranking = await productsRepository.getProductAnalyticsRanking(period);
      } catch {
        ranking = [];
      }

      const periodLabels: Record<string, string> = { today: "HOJE", "7d": "7 DIAS", "30d": "30 DIAS", total: "TOTAL" };
      let text = `🏆 <b>RANKING DE PRODUTOS — ${periodLabels[period] || "7 DIAS"}</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

      const top10 = ranking.slice(0, 10);
      if (top10.length === 0 || top10.every(r => r.count === 0)) {
        text += "Nenhum clique registrado no período.\n";
      } else {
        top10.forEach((item, idx) => {
          const medal = medals[idx] || `${idx + 1}️⃣`;
          text += `${medal} <b>${item.product.produto.slice(0, 30)}</b> — <b>${item.count}</b>\n`;
        });
      }
      text += "\n━━━━━━━━━━━━━━━━━━";

      const keyboard = {
        inline_keyboard: [
          [
            { text: period === "today" ? "• Hoje •" : "Hoje", callback_data: "analytics_ranking:today" },
            { text: period === "7d" ? "• 7d •" : "7d", callback_data: "analytics_ranking:7d" },
            { text: period === "30d" ? "• 30d •" : "30d", callback_data: "analytics_ranking:30d" },
            { text: period === "total" ? "• Total •" : "Total", callback_data: "analytics_ranking:total" }
          ],
          [{ text: "📊 Visão Geral", callback_data: "analytics_overview" }, { text: "⬅️ Voltar", callback_data: "analytics_overview" }]
        ]
      };

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("analytics_product:")) {
      const parts = data.split(":");
      const prodId = parts[1];
      const period = parts[2] || "7d";
      await answerCallbackQuery(callbackId);

      const stats = await productsRepository.getProductAnalytics(prodId, period);
      if (!stats) {
        if (chatId && messageId) await editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "analytics_products:0" }]] });
        return;
      }

      const p = stats.product;
      const shortTitle = p.produto.length > 38 ? p.produto.slice(0, 35) + "..." : p.produto;

      const totalMkt = (stats.marketplaceCounts.Shopee || 0) + (stats.marketplaceCounts["Mercado Livre"] || 0);
      const shopeePct = totalMkt > 0 ? Math.round(((stats.marketplaceCounts.Shopee || 0) / totalMkt) * 100) : 0;
      const meliPct = totalMkt > 0 ? Math.round(((stats.marketplaceCounts["Mercado Livre"] || 0) / totalMkt) * 100) : 0;

      const text = `📊 <b>ANALYTICS DO PRODUTO</b>\n` +
                   `━━━━━━━━━━━━━━━━━━\n\n` +
                   `📦 <b>${shortTitle}</b>\n` +
                   `REF: <code>${p.ref}</code> | ${p.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n\n` +
                   `📈 <b>Desempenho</b>\n` +
                   `• Hoje: <b>${stats.todayClicks}</b>\n` +
                   `• 7 dias: <b>${stats.clicks7d}</b>\n` +
                   `• 30 dias: <b>${stats.clicks30d}</b>\n` +
                   `• Total: <b>${stats.totalClicks}</b>\n\n` +
                   `🛒 <b>Marketplaces</b>\n` +
                   `• Shopee: <b>${stats.marketplaceCounts.Shopee || 0}</b> (${shopeePct}%)\n` +
                   `• Mercado Livre: <b>${stats.marketplaceCounts["Mercado Livre"] || 0}</b> (${meliPct}%)\n\n` +
                   `🕐 <b>Último clique</b>\n` +
                   `• ${stats.lastClickTime}\n\n` +
                   `🌐 <b>Origem</b>\n` +
                   `• ${stats.lastUtmSource}\n` +
                   `━━━━━━━━━━━━━━━━━━`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: period === "today" ? "• Hoje •" : "Hoje", callback_data: `analytics_product:${p.id}:today` },
            { text: period === "7d" ? "• 7d •" : "7d", callback_data: `analytics_product:${p.id}:7d` },
            { text: period === "30d" ? "• 30d •" : "30d", callback_data: `analytics_product:${p.id}:30d` },
            { text: period === "total" ? "• Total •" : "Total", callback_data: `analytics_product:${p.id}:total` }
          ],
          [
            { text: "🔎 Trocar produto", callback_data: "analytics_products:0" },
            { text: "📊 Ranking", callback_data: "analytics_ranking:7d" }
          ],
          [
            { text: "⬅️ Voltar", callback_data: "analytics_products:0" },
            { text: "🏠 Painel", callback_data: "admin_menu" }
          ]
        ]
      };

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    // --- NAMESPACE: CATEGORIES / REVIEWS ---
    if (data === "add_cat_init") {
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: "add_cat_name" });
      if (chatId) await sendTelegramMessage(chatId, "📁 <b>ADICIONAR CATEGORIA</b>\n\nDigite o nome da nova categoria:");
      return;
    }

    if (data.startsWith("rename_cat_init:")) {
      const oldName = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: `rename_cat_name:${oldName}` });
      if (chatId) await sendTelegramMessage(chatId, `✏️ <b>RENOMEAR CATEGORIA: ${oldName}</b>\n\nDigite o novo nome:`);
      return;
    }

    // DECISION != ACTION — Fase 23 (2026-08-20): "approve_only" registra a
    // decisão humana de aprovar SOMENTE no repositório de review
    // (status="published") para encaminhamento à publicação manual. NUNCA
    // executa pipeline.publish, acquisition mutation, N13/N14/N15, scraping,
    // Seller API ou qualquer alteração do catálogo canônico.
    if (data.startsWith("approve_only:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("approve_only", reviewId, chatId, review);
      if (!validation.valid || !review) {
        await answerCallbackQuery(callbackId, validation.reason, true);
        if (chatId) await sendTelegramMessage(chatId, `⚠️ ${validation.reason}`);
        return;
      }
      // Registro governado: approval registrado no repositório de review,
      // fonte da aprovação marcada para auditoria (manual affiliate preview).
      review.status = "published";
      review.descricao = `${review.descricao ?? ""} · approved_by=approve_only · approved_at=${new Date().toISOString()}`.trim();
      await telegramRepo.savePendingReview(review);
      await telegramRepo.deleteUserState(senderId);
      const isPreview = (review.categoria || "").startsWith("affiliate_preview") || review.existingProduct?.source === "affiliate_preview";
      const feedback = isPreview
        ? "✅ <b>PREVIEW APROVADO — DECISÃO REGISTRADA</b>\n\nSem automação nesta fase: o encaminhamento à publicação manual segue o fluxo existente. Nenhuma publicação, aquisição ou mutation foi executada."
        : "✅ <b>APROVAÇÃO REGISTRADA (approve_only)</b>\n\nEncaminhado à publicação manual — nenhuma automação de publicação foi executada.";
      await answerCallbackQuery(callbackId, "Decisão registrada — encaminhado à publicação manual.");
      // O card de affiliate preview é enviado como MENSAGEM DE TEXTO
      // (sendTelegramMessage), não como foto com caption — editCaption falharia
      // silenciosamente. Garantia de feedback visível: nova mensagem ao chat.
      if (chatId) await sendTelegramMessage(chatId, feedback);
      logTelegramEvent("approve_only", { chat_id: chatId, review_id: reviewId, source: isPreview ? "affiliate_preview" : "manual", feedback_delivered: true });
      return;
    }
    if (data.startsWith("confirm_pub:")) {
      const reviewId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "⏳ Publicando...");
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("Confirmar & Publicar", reviewId, chatId, review);
      if (!validation.valid || !review) {
        if (chatId) await sendTelegramMessage(chatId, `⚠️ ${validation.reason}`);
        return;
      }
      try {
        const completenessErrors = getPublicationCompletenessErrors(review);
        if (completenessErrors.length > 0) {
          review.status = "error";
          await telegramRepo.savePendingReview(review);
          if (chatId) {
            await sendTelegramMessage(
              chatId,
              `❌ <b>PUBLICAÇÃO BLOQUEADA</b>\n\nA review não tem dados suficientes para criar um produto canônico: ${completenessErrors.join(", ")}. Nenhum produto foi criado. Reprocesse ou ajuste a review sem inventar informações.`
            );
          }
          return;
        }
        // Trava a mesma review antes de qualquer persistência canônica: um
        // segundo toque no botão não pode criar um produto duplicado enquanto
        // Supabase → GitHub → catálogo público está em andamento.
        review.status = "publishing";
        await telegramRepo.savePendingReview(review);
        const pipeline = createProductionProductPipeline();
        const publicationLink = getPublicationLink(review);
        if (!publicationLink.link) {
          review.status = "error";
          await telegramRepo.savePendingReview(review);
          if (chatId) await sendTelegramMessage(chatId, `❌ <b>${publicationLink.error}</b>\n\nA publicação foi bloqueada antes de criar um produto canônico. A review Shopee precisa manter um link de afiliado oficial válido.`);
          return;
        }
        // O lifecycle é reavaliado com a review integral no instante de
        // publicação. Assim, um preview salvo antes de edições de preço ou da
        // curadoria não descarta displayTitle, descrição, oferta ou link.
        let lifecycle = await pipeline.evaluate({
          produto: review.produto,
          rawTitle: review.rawTitle,
          displayTitle: review.displayTitle || review.rawTitle || review.produto,
          curatorNote: review.curatorNote,
          categoria: review.categoria,
          preco: review.preco,
          ...getReviewImageCandidate(review),
          normalizedUrl: review.normalizedUrl,
          link: publicationLink.link,
          descricao: stripRawAffiliateProvenance(review.descricao),
          marketplace: detectMarketplace(review.normalizedUrl),
        });
        // A oferta humana confirmada acompanha o candidato exclusivamente como
        // metadado separado. O pipeline preserva review.preco como preço-base.
        const promotionOffer = normalizePromotionOffer(review.promotionReview);
        if (promotionOffer) lifecycle.candidate.ofertaPromocional = promotionOffer;
        if (lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {
          review.lifecycle = lifecycle;
          review.status = "error";
          await telegramRepo.savePendingReview(review);
          throw new Error(lifecycle.validation.errors.join(" ") || "VALIDATION_ERROR");
        }
        lifecycle = pipeline.approve(lifecycle);
        lifecycle = await pipeline.publish(lifecycle);
        review.lifecycle = lifecycle;
        if (lifecycle.state !== "PUBLISHED" || !lifecycle.publishedProductId) {
          review.status = "error";
          await telegramRepo.savePendingReview(review);
          const diagnosticText = lifecycle.diagnostic
            ? formatDiagnosticForAdmin(lifecycle.diagnostic)
            : `<b>${lifecycle.error || "PUBLICATION_ERROR"}</b> · <code>${lifecycle.operationId || "sem-operation-id"}</code>\nA publicação não foi confirmada pela cadeia canônica.`;
          if (chatId) await sendTelegramMessage(chatId, `❌ <b>PUBLICAÇÃO NÃO CONCLUÍDA</b>\n\n${diagnosticText}`);
          return;
        }
        const publishedProduct = lifecycle.publishedProduct ?? await productsRepository.getProductByIdOrSlug(lifecycle.publishedProductId);
        if (!publishedProduct) throw new Error("PERSISTENCE_ERROR");
        review.status = "published";
        await telegramRepo.savePendingReview(review);
        await telegramRepo.deleteUserState(senderId);

        const promotionNote = review.promotionReview
          ? `\n\n🏷️ Oferta promocional registrada na revisão: <b>R$ ${review.promotionReview.price.toFixed(2).replace(".", ",")}</b> ${formatPromotionCondition(review.promotionReview.condition)}.\n<i>O catálogo preserva o preço-base canônico; confirmação no checkout continua necessária.</i>`
          : "";
        const successText = `✅ <b>PEÇA PUBLICADA COM SUCESSO!</b>\n\n<b>${publishedProduct.displayTitle || publishedProduct.produto}</b>\nREF: <code>${publishedProduct.ref}</code>\nPreço-base: R$ ${publishedProduct.preco.toFixed(2).replace(".", ",")}\n🆔 Operação: <code>${lifecycle.operationId || "confirmada"}</code>${promotionNote}\n\nSupabase gravado, catálogo sincronizado e vitrine pública validada.`;
        // O card Shopee pode ser foto ou texto. Uma nova mensagem funciona em
        // ambos os casos; editMessageCaption falha para cards enviados como
        // texto e não pode ser a única confirmação de publicação.
        if (chatId) await sendTelegramMessage(chatId, successText);
      } catch (err: any) {
        review.status = "error";
        await telegramRepo.savePendingReview(review).catch(() => undefined);
        if (chatId) await sendTelegramMessage(chatId, "❌ <b>PERSISTENCE_ERROR</b>\n\nNão foi possível concluir a persistência canônica. Consulte o Operator para diagnóstico e operation ID.");
      }
      return;
    }

    if (data.startsWith("review_details:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      await answerCallbackQuery(callbackId);
      if (!review) {
        if (chatId) await sendTelegramMessage(chatId, "⚠️ Revisão não localizada.");
        return;
      }
      const lifecycle = review.lifecycle;
      const text = "🔎 <b>DETALHES DA REVISÃO</b>\n\n" +
        `Estado: <b>${lifecycle?.state || "PENDING_APPROVAL"}</b>\n` +
        `Validação: <b>${lifecycle?.validation.outcome || "PENDING"}</b>\n` +
        `Erros: ${lifecycle?.validation.errors.join("; ") || "Nenhum"}\n` +
        `Warnings: ${lifecycle?.validation.warnings.join("; ") || "Nenhum"}\n` +
        `Recomendação: <b>${lifecycle?.curation.recommendation || "REVIEW"}</b>\n` +
        `Score: ${lifecycle?.curation.score ?? 0} · Confiança: ${lifecycle?.curation.confidence || "LOW"}`;
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, buildMainReviewKeyboard(reviewId));
      return;
    }

    if (data.startsWith("curator_note_init:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("curator_note", reviewId, chatId, review);
      if (!validation.valid || !review) {
        await answerCallbackQuery(callbackId, validation.reason, true);
        return;
      }
      await telegramRepo.setUserState(senderId, { action: `curator_note:${reviewId}` });
      await answerCallbackQuery(callbackId);
      if (chatId) await sendTelegramMessage(chatId, "📝 <b>NOTA DO CURADOR (OPCIONAL)</b>\n\nEnvie uma nota breve para a página da peça. Envie <code>-</code> para remover ou deixar sem nota. A confirmação e publicação continuam disponíveis mesmo sem texto.");
      return;
    }

    if (data.startsWith("edit_price:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("edit_price", reviewId, chatId, review);
      if (!validation.valid) {
        await answerCallbackQuery(callbackId, validation.reason, true);
        return;
      }
      await telegramRepo.setUserState(senderId, { action: "awaiting_price", reviewId });
      await answerCallbackQuery(callbackId, "Digite o novo preço:");
      if (chatId) await sendTelegramMessage(chatId, "💰 <b>DIGITE O NOVO PREÇO EM REAIS:</b>\nExemplo: <code>189,90</code>");
      return;
    }

    if (data.startsWith("promo_edit:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("promo_edit", reviewId, chatId, review);
      if (!validation.valid || !review) {
        await answerCallbackQuery(callbackId, validation.reason, true);
        return;
      }
      await telegramRepo.setUserState(senderId, { action: "awaiting_promotion_price", reviewId });
      await answerCallbackQuery(callbackId, "Digite o preço promocional observado.");
      if (chatId) await sendTelegramMessage(chatId, "🏷️ <b>AJUSTAR PREÇO PROMOCIONAL</b>\n\nDigite o valor exibido no anúncio. Exemplo: <code>264,44</code>\n\n<i>Esse valor será registrado separadamente do preço-base e exigirá confirmação.</i>");
      return;
    }

    if (data.startsWith("promo_condition:")) {
      const condition = data.split(":")[1] as "pix" | "pix_with_coupon" | "coupon" | "other";
      const userState = await telegramRepo.getUserState(senderId);
      const review = userState?.reviewId ? await telegramRepo.getPendingReview(userState.reviewId) : null;
      if (!userState || userState.action !== "awaiting_promotion_condition" || !review?.promotionDraft) {
        await answerCallbackQuery(callbackId, "Ajuste promocional não encontrado ou expirado.", true);
        return;
      }
      review.promotionDraft.condition = condition;
      await telegramRepo.savePendingReview(review);
      await telegramRepo.setUserState(senderId, { action: "awaiting_promotion_benefits", reviewId: userState.reviewId });
      await answerCallbackQuery(callbackId, "Condição registrada.");
      if (chatId) await sendTelegramMessage(chatId, "🧾 Informe benefícios observados, um por linha (ex.: <code>Compre R$200 e ganhe R$6 off</code>).\n\nEnvie <code>-</code> se não houver benefício adicional.");
      return;
    }

    if (data.startsWith("promo_confirm:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const userState = await telegramRepo.getUserState(senderId);
      const validation = logAndValidateReviewCallback("promo_confirm", reviewId, chatId, review);
      if (!validation.valid || !review || !userState || userState.action !== "confirm_promotion" || userState.reviewId !== reviewId || !review.promotionDraft?.price || !review.promotionDraft.condition) {
        await answerCallbackQuery(callbackId, "Ajuste promocional inválido ou expirado.", true);
        return;
      }
      const wasPublished = review.status === "published";
      const confirmedPromotion = {
        price: review.promotionDraft.price,
        condition: review.promotionDraft.condition,
        benefits: review.promotionDraft.benefits,
        source: "admin_confirmed",
        confirmedAt: Date.now(),
      } as const;
      const promotionOffer = normalizePromotionOffer(confirmedPromotion);
      if (!promotionOffer) {
        await answerCallbackQuery(callbackId, "Oferta promocional inválida.", true);
        return;
      }
      let syncedProduct = null;
      if (wasPublished) {
        const affiliateLink = (review.existingProduct?.affiliateUrl || review.normalizedUrl || "").trim();
        try {
          syncedProduct = await productsRepository.updatePublishedPromotionByLink(affiliateLink, promotionOffer);
        } catch {
          if (chatId) await sendTelegramMessage(chatId, "❌ <b>PROMOTION_SYNC_ERROR</b>\n\nA oferta não foi confirmada na vitrine pública. O preço-base não foi alterado e a promoção anterior foi preservada.");
          return;
        }
        if (!syncedProduct) {
          if (chatId) await sendTelegramMessage(chatId, "❌ <b>PROMOTION_PERSISTENCE_ERROR</b>\n\nNão foi localizado um produto publicado correspondente para atualizar a oferta. Nenhuma promoção foi declarada pública.");
          return;
        }
      }
      review.promotionReview = confirmedPromotion;
      review.promotionDraft = null;
      await telegramRepo.savePendingReview(review);
      await telegramRepo.deleteUserState(senderId);
      await answerCallbackQuery(callbackId, "Oferta promocional registrada.");
      const publicConfirmation = syncedProduct
        ? "\n\n✅ A oferta foi sincronizada e validada na vitrine pública."
        : "\n\n<i>O produto não foi publicado nem teve o preço-base alterado.</i>";
      if (chatId) await sendTelegramMessage(chatId, `✅ <b>OFERTA PROMOCIONAL REGISTRADA</b>\n\nPreço-base: <b>R$ ${review.preco.toFixed(2).replace(".", ",")}</b>${renderPromotionReview(review)}${publicConfirmation}`);
      return;
    }

    if (data.startsWith("promo_cancel:")) {
      const userState = await telegramRepo.getUserState(senderId);
      const review = userState?.reviewId ? await telegramRepo.getPendingReview(userState.reviewId) : null;
      if (review?.promotionDraft) {
        review.promotionDraft = null;
        await telegramRepo.savePendingReview(review);
      }
      await telegramRepo.deleteUserState(senderId);
      await answerCallbackQuery(callbackId, "Ajuste promocional cancelado.");
      if (chatId) await sendTelegramMessage(chatId, "❌ Ajuste promocional cancelado. Nenhum dado foi alterado.");
      return;
    }

    if (data.startsWith("edit_cat:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("edit_cat", reviewId, chatId, review);
      if (!validation.valid) {
        await answerCallbackQuery(callbackId, validation.reason, true);
        return;
      }
      await telegramRepo.setUserState(senderId, { action: "awaiting_category", reviewId });
      await answerCallbackQuery(callbackId, "Digite a nova categoria:");
      if (chatId) await sendTelegramMessage(chatId, "📁 <b>DIGITE A NOVA CATEGORIA:</b>\nExemplos: <code>Camisetas</code>, <code>Calças</code>, <code>Acessórios</code>, <code>Calçados</code>, <code>Jaquetas</code> ou <code>Moletons</code>.");
      return;
    }

    if (data.startsWith("cancel_rev:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      if (review) {
        review.status = "rejected";
        if (review.lifecycle?.state === "PENDING_APPROVAL") {
          review.lifecycle = createProductionProductPipeline().reject(restoreLifecycleRecord(review.lifecycle), "Administrador rejeitou a proposta.");
        }
        await telegramRepo.savePendingReview(review);
      }
      await telegramRepo.deleteUserState(senderId);
      await answerCallbackQuery(callbackId, "❌ Cancelado.");
      // O card pode ser foto (caption) ou texto — garantia de feedback visível.
      if (chatId) await sendTelegramMessage(chatId, "❌ <b>DECISÃO REGISTRADA — DESCARTADO</b>\n\nA proposta foi descartada e nenhuma publicação ou aquisição foi executada.");
      logTelegramEvent("cancel_rev", { chat_id: chatId, review_id: reviewId });
      return;
    }
  }

  // 2. MENSAGENS DE TEXTO
  if (update.message && update.message.text) {
    const msg = update.message;
    const senderId = msg.from?.id || "Desconhecido";
    const firstName = msg.from?.first_name || "Anônimo";
    const username = msg.from?.username ? `@${msg.from.username}` : "N/A";
    const text: string = msg.text.trim();
    const chatId = msg.chat?.id;

    if (!isUserAllowed(senderId)) {
      logTelegramEvent("admin_authorized", { chat_id: chatId, authorized: false });
      if (chatId) await sendTelegramMessage(chatId, `🔒 <b>Acesso Negado</b> (ID: <code>${senderId}</code>)`);
      return;
    }

    logTelegramEvent("admin_authorized", { chat_id: chatId, authorized: true });
    if (text.startsWith("/")) logTelegramEvent("command", { chat_id: chatId, command: text.split(/\s+/, 1)[0].toLowerCase() });

    // --- FASE 25B (Commit 1) — PAINEL DE LEITURA (READ-ONLY) ---
    // /menu /status /pendentes /aprovados. ZERO escrita, ZERO publication/acquisition.
    if (text.startsWith("/menu")) {
      if (chatId) await sendTelegramMessage(chatId, telegramPanel.renderReadPanelMenu());
      return;
    }
    if (text.startsWith("/status")) {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderStatus());
      return;
    }
    if (text.startsWith("/pendentes")) {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderPendingReviews());
      return;
    }
    if (text.startsWith("/aprovados")) {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderApproved());
      return;
    }
    // /shopee-schema — inspeção autenticada e somente-leitura do schema oficial.
    // O comando é alcançável somente depois da whitelist administradora acima.
    if (text === "/shopee-schema") {
      const inspection = await inspectShopeePromotionFields();
      if (!chatId) return;
      if (!inspection.available) {
        await sendTelegramMessage(chatId, `⚠️ <b>SCHEMA SHOPEE INDISPONÍVEL</b>\n\nMotivo: <code>${inspection.reason ?? "não informado"}</code>\nNenhuma query de produto foi alterada.`);
        return;
      }
      const promotionFields = inspection.fields.filter((field) => /price|discount|coupon|voucher|promo|campaign|shipping|freight/i.test(field));
      await sendTelegramMessage(chatId, `🔎 <b>SCHEMA OFICIAL SHOPEE — SOMENTE LEITURA</b>\n\nTipo: <code>${inspection.nodeType}</code>\nCampos promocionais/localizados: <code>${promotionFields.join(", ") || "nenhum"}</code>\n\n<i>Nenhuma query de descoberta, link de afiliado, review ou produto foi alterada.</i>`);
      return;
    }

    // /shopee-offer SHOP_ID ITEM_ID — leitura oficial de valores para uma oferta exata.
    if (text.startsWith("/shopee-offer")) {
      const parts = text.split(/\s+/).slice(1);
      if (!chatId) return;
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        await sendTelegramMessage(chatId, "⚠️ <b>SINTAXE</b>\n\nUse <code>/shopee-offer SHOP_ID ITEM_ID</code>. Nenhuma consulta foi executada.");
        return;
      }
      const offer = await inspectShopeePromotionOffer(parts[0], parts[1]);
      if (!offer.available || !offer.values) {
        await sendTelegramMessage(chatId, `⚠️ <b>OFERTA OFICIAL INDISPONÍVEL</b>\n\nMotivo: <code>${offer.reason ?? "não informado"}</code>\nNenhuma query de descoberta, review ou produto foi alterada.`);
        return;
      }
      const value = (raw: string | number | null) => raw === null ? "não retornado" : String(raw);
      await sendTelegramMessage(chatId, `🔎 <b>OFERTA OFICIAL SHOPEE — SOMENTE LEITURA</b>\n\n<code>price:</code> ${value(offer.values.price)}\n<code>priceMin:</code> ${value(offer.values.priceMin)}\n<code>priceMax:</code> ${value(offer.values.priceMax)}\n<code>priceDiscountRate:</code> ${value(offer.values.priceDiscountRate)}\n\n<i>Os valores são retornados pela Affiliate API e ainda não alteram cards, reviews ou preço-base.</i>`);
      return;
    }

    // /shopee N — orquestrador de lote (FASE 25C):
    //   discovery Shopee → aquisição oficial → scraper → identidade →
    //   PendingReview → cards. ZERO publicação automática.
    if (text.startsWith("/shopee")) {
      const args = text.slice("/shopee".length).trim();
      if (chatId) {
        const result = await runShopeeCommand(args);
        if (!result.chatTargetConfigured || !result.affiliateClientAvailable) {
          await sendTelegramMessage(
            chatId,
            "⚠️ <b>/shopee indisponível</b> — ambiente incompleto: " +
              `${result.chatTargetConfigured ? "" : "TELEGRAM_ALLOWED_USER_IDS ausente; "}` +
              `${result.affiliateClientAvailable ? "" : "credenciais da Affiliate API ausentes."}` +
              "\nNenhuma consulta foi executada.",
          );
        } else if (result.processed === 0) {
          await sendTelegramMessage(
            chatId,
            "⚠️ <b>/shopee rejeitado</b>\n\nSintaxe: /shopee N [termo] — N inteiro entre 1 e 10.\nNenhuma ação foi executada.",
          );
        }
        // Cards individuais e o card final do lote já foram enviados pelo
        // orquestrador; nada adicional é enviado aqui (fail-safe).
      }
      return;
    }
    // --- INTERCEPTAÇÃO ABSOLUTA DE /analytics ---
    if (text.startsWith("/analytics")) {
      const parts = text.split(" ");
      const arg = parts[1] ? parts[1].trim() : "";

      if (arg) {
        const stats = await productsRepository.getProductAnalytics(arg, "7d");
        if (!stats) {
          if (chatId) await sendTelegramMessage(chatId, `⚠️ Produto <code>${arg}</code> não encontrado no Supabase.`);
          return;
        }
        const p = stats.product;
        const textResp = `📊 <b>ANALYTICS DO PRODUTO</b>\n\n` +
                         `<b>Nome:</b> ${p.produto}\n` +
                         `<b>REF:</b> <code>${p.ref}</code>\n` +
                         `<b>Preço:</b> R$ ${p.preco.toFixed(2).replace(".", ",")}\n` +
                         `<b>Cliques (7d):</b> ${stats.clicks7d} (Hoje: ${stats.todayClicks})\n` +
                         `<b>Total:</b> ${stats.totalClicks}\n`;
        const keyboard = {
          inline_keyboard: [
            [{ text: "📊 Visão Geral", callback_data: "analytics_overview" }, { text: "🔗 Abrir", url: p.link }]
          ]
        };
        if (chatId) await sendTelegramMessage(chatId, textResp, keyboard);
        return;
      } else {
        // Redireciona para visão geral
        let opSummary = await productsRepository.getAnalyticsSummary();
        let textResp = "📊 <b>CERBERUS ANALYTICS</b>\n\n" +
                       "📦 Total: <b>" + opSummary.totalProducts + "</b> | Ativos: <b>" + opSummary.activeProducts + "</b>\n" +
                       "🖱️ Cliques hoje: <b>" + opSummary.todayClicks + "</b> | 7d: <b>" + opSummary.clicks7d + "</b> | Total: <b>" + opSummary.totalClicks + "</b>\n";
        const keyboard = {
          inline_keyboard: [
            [{ text: "🎯 Analytics por produto", callback_data: "analytics_products:0" }],
            [{ text: "🏠 Menu Principal", callback_data: "admin_menu" }]
          ]
        };
        if (chatId) await sendTelegramMessage(chatId, textResp, keyboard);
        return;
      }
    }

    // Bloco N9 — renderizador RENDER-ONLY do estado do ciclo comercial.
// Lê APENAS: getCycle/getDecisionByCycle/listSteps (somente leituras).
// NUNCA executa estágio, decisão, publicação ou qualquer mutação.
async function renderCycleState(input: string): Promise<string> {
  try {
    const args = input.slice("/cycle".length).trim();
    if (!args.startsWith("status ")) {
      return "🔄 <b>BLOCO N9 — CICLO COMERCIAL</b>\n\nUso: <code>/cycle status &lt;cycle_id&gt;</code>\n\nCiclo = projeção orquestrada (N2→N8). DECISION != ACTION — este comando NUNCA executa estágio, decisão ou publicação; apenas consulta o estado consolidado do ciclo.";
    }
    const cycleId = args.slice("status ".length).trim();
    if (!/^ncc-[A-Za-z0-9_-]+$/.test(cycleId)) {
      return "⚠️ <b>CYCLE_ID INVÁLIDO</b>\n\nFormato esperado: <code>ncc-&lt;marketplace&gt;-&lt;hash&gt;</code>\n\nUse <code>/cycle status &lt;cycle_id&gt;</code>.";
    }
    const { getCycleState } = await import("../commercial/cycle/commercialCycleService");
    const state = await getCycleState(cycleId);
    if (!state.ok || !state.state) {
      return `⚠️ <b>CICLO NÃO ENCONTRADO</b>\n\nCycle ID: <code>${cycleId}</code>\nMotivo: ${state.reason ?? "not_found"}\n\nCiclos só existem após serem abertos pelas rotas administrativas do N9.`;
    }
    const s = state.state;
    const lines: string[] = [];
    lines.push("🔄 <b>CICLO COMERCIAL N9</b>");
    lines.push(`\nCycle: <code>${s.cycleId ?? cycleId}</code>`);
    lines.push(`Status: ${String(s.status ?? "?")}`);
    lines.push(`Marketplace: ${String(s.marketplace ?? "?")} · Fonte: ${String(s.sourceUrl ?? "?")}`);
    lines.push(`Candidate: <code>${String(s.candidateId ?? "—")}</code>`);
    lines.push(`Decisão (gate v1): ${String(s.decision ?? "—")}`);
    lines.push(`Identidade: ${String(s.resolutionStatus ?? "—")}`);
    if (Array.isArray(s.blockingRules) && s.blockingRules.length > 0) {
      lines.push(`Bloqueios: ${s.blockingRules.join(", ")}`);
    }
    lines.push(`\nIDENTITY ≠ CONFIRMED · DECISION ≠ ACTION\nEste comando NÃO executa nada.`);
    return lines.join("\n");
  } catch {
    return "⚠️ <b>ERRO DE INFRAESTRUTURA</b>\n\nNão foi possível consultar o ciclo (leitura falhou). Sem dados confiáveis, nada é executado (fail-closed).";
  }
}


    // FASE 25C (Commit 3) — /publicar <reviewId>: encaminha uma review pendente
    // ou aprovada (status=pending|published via approve_only) ao fluxo canônico
    // de publicação EXIGINDO confirmação humana explícita no card de confirmação.
    // DECISION ≠ ACTION: NENHUMA publicação é executada aqui; somente o card
    // de confirmação (confirm_pub) dispara o pipeline canônico.
    // Este bloco NÃO pertence ao escopo read-only da FASE 25B: ele é o único
    // ponto onde o painel de leitura conecta a decisão humana ao pipeline
    // canônico, e a execução do pipeline continua exclusivamente no callback
    // confirm_pub (que exige o clique em [✅ Confirmar & Publicar]).
    if (text.startsWith("/publicar")) {
      const args = text.slice("/publicar".length).trim();
      const reviewId = args ? args.split(/\s+/)[0] : "";
      if (!reviewId) {
        if (chatId) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>Sintaxe:</b> <code>/publicar &lt;reviewId&gt;</code>\n\nO <code>reviewId</code> aparece nos cards do lote <code>/shopee N</code> (linha 🔎 Auditoria) e no comando <code>/pendentes</code>.\n\nEste comando NUNCA publica automaticamente: ele encaminha a review ao card de confirmação humana [✅ Confirmar &amp; Publicar]. Nenhuma publicação, aquisição ou mutation foi executada.",
          );
        }
        return;
      }
      const review = await telegramRepo.getPendingReview(reviewId);
      if (!review) {
        if (chatId) await sendTelegramMessage(chatId, "⚠️ <b>Review não localizada.</b>\n\nVerifique o <code>reviewId</code> (formato <code>affprev-...</code>) ou use <code>/pendentes</code> para listar as revisões ativas. Nenhuma ação foi executada.");
        return;
      }
      const statusStr = review.status || "pending";
      if (statusStr === "cancelled" || statusStr === "rejected") {
        if (chatId) await sendTelegramMessage(chatId, `❌ <b>Review cancelada</b> (status=<code>${statusStr}</code>) — não pode ser encaminhada à publicação. Nenhuma ação foi executada.`);
        return;
      }
      if (statusStr === "error") {
        if (chatId) await sendTelegramMessage(chatId, "❌ <b>Review em estado de erro.</b>\n\nA última validação canônica falhou — ajuste a review (preço/imagens/categoria) antes de tentar novamente. Nenhuma publicação foi executada.");
        return;
      }
      const now = Date.now();
      if (review.expiresAt && now > review.expiresAt && statusStr !== "published") {
        if (chatId) await sendTelegramMessage(chatId, "⏰ <b>Review expirada.</b>\n\nA janela de decisão (24h) encerrou. Envie o link novamente via <code>/shopee</code> ou pela rota de preview. Nenhuma ação foi executada.");
        return;
      }
      // Pré-visualização do estado canônico (read-only preview do lifecycle):
      // permite ao usuário ver preço inválido/pendências ANTES de confirmar.
      let previewState: string = "NÃO VALIDADA";
      let previewOutcome: string = "aguardando";
      try {
        const restored = review.lifecycle ? restoreLifecycleRecord(review.lifecycle) : null;
        let preview: LifecycleRecord;
        if (restored && (restored.state === "PENDING_APPROVAL" || restored.state === "APPROVED")) {
          preview = restored;
        } else {
          const publicationLink = getPublicationLink(review);
          preview = await createProductionProductPipeline().evaluate({
            produto: review.produto,
            rawTitle: review.rawTitle,
            displayTitle: review.displayTitle || review.rawTitle || review.produto,
            curatorNote: review.curatorNote,
            categoria: review.categoria,
            preco: review.preco,
            ...getReviewImageCandidate(review),
            normalizedUrl: review.normalizedUrl,
            link: publicationLink.link || review.normalizedUrl,
            descricao: review.descricao,
            marketplace: detectMarketplace(review.normalizedUrl),
          });
        }
        previewState = preview.state;
        previewOutcome = preview.validation?.outcome ?? "aguardando";
        // Persistir a pré-avaliação para o confirm_pub reutilizar (sem reexecutar).
        if (!review.lifecycle) {
          review.lifecycle = preview;
          await telegramRepo.savePendingReview(review);
        }
      } catch {
        // Falha de pré-avaliação NÃO bloqueia o encaminhamento: o confirm_pub
        // reexecutará a avaliação canônica e aplicará fail-closed.
        previewState = "PRÉ-AVALIAÇÃO INDISPONÍVEL";
      }
      const produto = typeof review.produto === "string" && review.produto.trim() ? review.produto : "(sem nome)";
      const priceText =
        review.preco && review.preco > 0
          ? `${review.preco.toFixed(2).replace(".", ",")} <i>(escala não verificada)</i>`
          : "<b>AUSENTE</b> — use <b>💰 Alterar Preço</b> antes de confirmar";
      const keyboard = buildMainReviewKeyboard(reviewId);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🚀 <b>ENCAMINHAMENTO À PUBLICAÇÃO</b>\n\n` +
            `📋 Review: <code>${reviewId}</code>\n` +
            `🏷️ Produto: ${produto}\n` +
            `💰 Preço: ${priceText}\n` +
            `🛒 Marketplace: ${detectMarketplace(review.normalizedUrl)}\n` +
            `📊 Estado canônico prévio: <code>${previewState}</code> · <code>${previewOutcome}</code>\n\n` +
            `Confirme para executar o pipeline canônico (avaliação → aprovação → publicação). A publicação só ocorre após o clique em <b>✅ Confirmar &amp; Publicar</b>.`,
          keyboard,
        );
      }
      logTelegramEvent("command", { chat_id: chatId, command: "/publicar", review_id: reviewId, preview_state: previewState });
      return;
    }

// --- COMANDOS /start /admin /listar /categorias /help ---
    if (text.startsWith("/start") || text.startsWith("/admin")) {
      if (chatId) await renderMainMenu(chatId);
      return;
    }

    if (text === "/campanhas" || text.startsWith("/campanhas ") || text === "/campaigns" || text.startsWith("/campaigns ")) {
      if (chatId) {
        const campaigns = await createSupabaseNewsletterCampaignStore().listRecentCampaigns(10);
        const view = renderRecentCampaignsForTelegram(campaigns);
        logTelegramEvent("handler", { chat_id: chatId, handler: "campaign_list", campaigns_count: campaigns.length, response_method: "sendMessage" });
        await sendTelegramMessage(chatId, view.text, { inline_keyboard: view.keyboard });
      }
      return;
    }

    if (text === "/campanha2" || text.startsWith("/campanha2 ") || text === "/colecao" || text.startsWith("/colecao ")) {
      const exceptionalPreview = text.trim() === "/campanha2 atual" || text.trim() === "/colecao atual";
      if (chatId) {
        logTelegramEvent("handler", { chat_id: chatId, handler: exceptionalPreview ? "collection_campaign_exceptional_preview" : "collection_campaign_create", response_method: "sendMessage" });
        await handleCollectionCampaignCommand(String(senderId), chatId, {
          answerCallbackQuery,
          editTelegramMessageText,
          sendTelegramMessage,
          collectionSince: exceptionalPreview ? null : undefined,
          collectionUntil: exceptionalPreview ? null : undefined,
          collectionSize: exceptionalPreview ? 5 : undefined,
          minimumCollectionProducts: exceptionalPreview ? 5 : undefined,
        });
      }
      return;
    }

    if (text === "/boasvindas" || text.startsWith("/boasvindas ")) {
      if (chatId) {
        logTelegramEvent("handler", { chat_id: chatId, handler: "welcome_campaign_create", response_method: "sendMessage" });
        await handleWelcomeCampaignCommand(String(senderId), chatId, {
          answerCallbackQuery,
          editTelegramMessageText,
          sendTelegramMessage,
        });
      }
      return;
    }

    if (text.startsWith("/listar") || text.startsWith("/produtos")) {
      if (chatId) {
        const listView = await renderProductList(0);
        logTelegramEvent("handler", { chat_id: chatId, handler: "product_list", products_count: listView.total, page: listView.page, response_method: "sendMessage" });
        await sendTelegramMessage(chatId, listView.text, listView.keyboard);
      }
      return;
    }

    if (text.startsWith("/categorias")) {
      const cats = await categoriesRepository.getCategories();
      let catTxt = "🏷️ <b>CATEGORIAS DO CATÁLOGO</b>\n\n";
      const buttons = [];
      for (const c of cats) {
        catTxt += `• ${c.name}\n`;
        buttons.push([{ text: `✏️ ${c.name}`, callback_data: `rename_cat_init:${c.name}` }]);
      }
      buttons.push([{ text: "➕ Adicionar", callback_data: "add_cat_init" }]);
      buttons.push([{ text: "⬅️ Menu", callback_data: "admin_menu" }]);
      if (chatId) await sendTelegramMessage(chatId, catTxt, { inline_keyboard: buttons });
      return;
    }

    if (text.startsWith("/help")) {
      if (chatId) await renderMainMenu(chatId);
      return;
    }

    // --- BLOCO 17 — COMANDOS DO COCKPIT COMERCIAL (RENDER-ONLY) ---
    // COCKPIT = INFORMAÇÃO, NÃO AUTORIDADE. Nenhum comando abaixo executa
    // variante, produto, Telegram, agente ou executor.
    if (text.startsWith("/priority")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderPriority());
      return;
    }
    if (text.startsWith("/opportunities")) {
      const arg = text.split(" ")[1]?.trim();
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderOpportunities(arg));
      return;
    }
    if (text.startsWith("/risks")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderRisks());
      return;
    }
    if (text.startsWith("/experiments")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderExperiments());
      return;
    }
    if (text.startsWith("/agents")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderAgents());
      return;
    }
    if (text.startsWith("/decisions")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderDecisions());
      return;
    }
    if (text.startsWith("/recommendations")) {
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderRecommendations());
      return;
    }
    // Blocos N6/N7 — Affiliate Registry (RENDER-ONLY: /affiliates [link_id ou provider_code])
    // AFFILIATE LINK != AUTHORITY · REGISTRY = DADOS, NÃO AUTORIDADE
    if (text.startsWith("/affiliates")) {
      const args = text.slice("/affiliates".length).trim();
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderAffiliates(args || undefined));
      return;
    }
    // Bloco N9 — Ciclo Comercial (RENDER-ONLY: /cycle status <cycle_id>)
    // CICLO = PROJEÇÃO ORQUESTRADA, NÃO AUTORIDADE. O comando NUNCA executa
    // estágio, decisão ou publicação; apenas consulta o estado consolidado
    // do ciclo (ciclo, decisão v1 e passos registrados). DECISION != ACTION.
    if (text.startsWith("/cycle")) {
      if (chatId) await sendTelegramMessage(chatId, await renderCycleState(text));
      return;
    }
    // Bloco N3 — pesquisa + evidência (RENDER-ONLY: /research <candidate_id>
    // EVIDENCE != FACT CANÔNICO · RESEARCH != PUBLICATION · RESEARCH != PROMOTION)
    if (text.startsWith("/research")) {
      const args = text.slice("/research".length).trim();
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderResearch(args || undefined));
      return;
    }
    // Bloco N4 — filtro + priorização (RENDER-ONLY: /assess <candidate_id> [--reassess] [--list])
    // ASSESSMENT != ACTION · PRIORITY != DECISION · SCORE SEM RACIONAL = SEM SIGNIFICADO
    if (text.startsWith("/assess")) {
      const args = text.slice("/assess".length).trim();
      if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderAssessment(args || undefined));
      return;
    }

    // Bloco N1 — funil de candidatos (render-only, CANDIDATE != FACT CANÔNICO)
    // Bloco N2 — descoberta controlada: /discover ML url <url> e /discover SH search <termo>
    // Bloco N11 — /discover-batch ML|SH <url1> [url2] ... (lote controlado).
    // Discriminação explícita para não capturar o novo comando:
    // "/discover" exato OU "/discover " (com argumento).
    if (text === "/discover" || text.startsWith("/discover ")) {
      const args = text.slice("/discover".length).trim();
      if (!args) {
        if (chatId) await sendTelegramMessage(chatId, await commercialCockpit.renderDiscover());
        return;
      }
      if (chatId) {
        const response = await runDiscoverCommand(args);
        await sendTelegramMessage(chatId, response);
      }
      return;
    }
    if (text === "/discover-batch" || text.startsWith("/discover-batch ") || text === "/discover_batch" || text.startsWith("/discover_batch ")) {
      const commandLength = text.startsWith("/discover_batch") ? "/discover_batch".length : "/discover-batch".length;
      const args = text.slice(commandLength).trim();
      if (chatId) {
        const response = await runDiscoverBatchCommand(args);
        await sendTelegramMessage(chatId, response);
      }
      return;
    }
    // --- DETECÇÃO DE LINKS (FLUXO DE PUBLICAÇÃO) ---
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);
    if (matches && matches.length > 0) {
      for (const link of matches) {
        const marketplace = detectMarketplace(link);
        if (marketplace === "Shopee") {
          // Links Shopee precisam passar primeiro pela aquisição oficial. O
          // fluxo genérico antigo chamava apenas o scraper, que não consegue
          // extrair uma página confiável de shortlinks afiliados. O orquestrador
          // resolve o shortlink, confirma shop/item + offerLink na Affiliate API,
          // e só depois usa o scraper na productLink canônica.
          if (chatId) await runShopeeCommand(`1 ${link}`);
          continue;
        }
        if (chatId) await sendTelegramMessage(chatId, `🔎 Analisando peça de <b>${marketplace}</b>...`);
        const extResult = await extractProductForReview(link);
        if (!extResult.success || !extResult.data) {
          if (chatId) await sendTelegramMessage(chatId, `❌ Falha ao extrair: ${extResult.error || "Erro desconhecido"}`);
          continue;
        }
        const lifecycle = await createProductionProductPipeline().evaluate({
          ...extResult.data,
          normalizedUrl: extResult.data.normalizedUrl,
          marketplace: detectMarketplace(extResult.data.normalizedUrl),
        });
        // A ausência exclusiva de preço é recuperável: a prévia é mantida para
        // correção humana. Outros erros ainda bloqueiam a criação da proposta.
        const recoverableMissingPrice = lifecycle.validation.errors.length > 0 &&
          lifecycle.validation.errors.every(error => error === "Preço válido é obrigatório.");
        if ((lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") && !recoverableMissingPrice) {
          if (chatId) await sendTelegramMessage(chatId, `⚠️ <b>VALIDATION_ERROR</b>\n\n${lifecycle.validation.errors.join(" ") || "Produto não pode seguir para aprovação."}`);
          continue;
        }
        const reviewId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const review: PendingReview = {
          id: reviewId,
          chatId: chatId || 0,
          senderId,
          firstName,
          username,
          createdAt: Date.now(),
          lifecycle,
          ...extResult.data
        };
        await telegramRepo.savePendingReview(review);
        const cardText = buildReviewCardText(review);
        const keyboard = buildMainReviewKeyboard(reviewId);

        if (chatId) {
          let sentMsg: any = null;
          const primaryImageUrl = resolveCanonicalProductImage(review).primaryImageUrl;
          if (primaryImageUrl) {
            sentMsg = await sendTelegramPhoto(chatId, primaryImageUrl, cardText, keyboard);
          } else {
            sentMsg = await sendTelegramMessage(chatId, cardText, keyboard);
          }
          if (sentMsg?.result?.message_id) {
            review.cardMessageId = sentMsg.result.message_id;
            await telegramRepo.savePendingReview(review);
          }
        }
      }
      return;
    }

    // --- ESTADOS DE USUÁRIO / MÁQUINAS DE ESTADO ---
    const userState = await telegramRepo.getUserState(senderId);

    if (userState?.action === "campaign_subject") {
      const campaignHandled = await handleNewsletterCampaignText(text, String(senderId), chatId, {
        answerCallbackQuery,
        editTelegramMessageText,
        sendTelegramMessage,
      });
      if (campaignHandled) return;
    }

    if (userState && userState.action.startsWith("edit_field:")) {
      const field = userState.action.split(":")[1];
      const prodId = userState.productId;
      const update: any = {};
      if (field === "preco") {
        const p = parseAndNormalizePrice(text);
        if (p === null) {
          if (chatId) await sendTelegramMessage(chatId, "❌ Preço inválido.");
          return;
        }
        update[field] = p;
      } else {
        update[field] = text;
      }
      try {
        await productsRepository.updateProduct(prodId, update);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Campo <b>${field}</b> atualizado com sucesso no Supabase e no site!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro ao atualizar: ${err.message}`);
      }
      return;
    }

    if (userState && userState.action.startsWith("curator_note:")) {
      const reviewId = userState.action.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      if (!review) {
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, "⚠️ Revisão não localizada.");
        return;
      }
      const note = text.trim() === "-" ? "" : text.replace(/\s+/g, " ").trim().slice(0, 500);
      review.curatorNote = note || undefined;
      await refreshReviewLifecycle(review);
      await telegramRepo.savePendingReview(review);
      await telegramRepo.deleteUserState(senderId);
      if (chatId) await sendTelegramMessage(chatId, note ? "✅ Nota do curador registrada na revisão." : "✅ Nota do curador removida da revisão.");
      return;
    }

    if (userState && userState.action === "products_search") {
      await telegramRepo.deleteUserState(senderId);
      const query = text.toLowerCase();
      const products = await productsRepository.getProducts();
      const matched = products.filter(p => p.produto.toLowerCase().includes(query) || p.ref.toLowerCase().includes(query) || p.categoria.toLowerCase().includes(query));
      
      let textResp = `🔎 <b>RESULTADOS DA BUSCA: "${text}"</b>\nEncontradas: ${matched.length} peças\n\n`;
      const buttons = [];
      for (const p of matched.slice(0, 10)) {
        textResp += `• <code>${p.ref}</code> - ${p.produto}\n`;
        buttons.push([{ text: `👁️ ${p.ref}`, callback_data: `product_view:${p.id}` }]);
      }
      buttons.push([{ text: "⬅️ Menu Principal", callback_data: "admin_menu" }]);
      if (chatId) await sendTelegramMessage(chatId, textResp, { inline_keyboard: buttons });
      return;
    }

    if (userState && userState.action === "add_cat_name") {
      try {
        await categoriesRepository.addCategory(text);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Categoria <b>${text}</b> adicionada com sucesso!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro: ${err.message}`);
      }
      return;
    }

    if (userState && userState.action.startsWith("rename_cat_name:")) {
      const oldName = userState.action.split(":")[1];
      try {
        await categoriesRepository.renameCategory(oldName, text);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Categoria renomeada de ${oldName} para ${text}!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro: ${err.message}`);
      }
      return;
    }

    if (userState && userState.action === "awaiting_category") {
      const targetReview = await telegramRepo.getPendingReview(userState.reviewId);
      const category = text.replace(/\s+/g, " ").trim();
      if (!targetReview) {
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, "⚠️ A revisão não está mais disponível. Envie o link novamente para criar uma nova prévia.");
        return;
      }
      if (category.length < 2 || category.length > 60) {
        if (chatId) await sendTelegramMessage(chatId, "❌ Categoria inválida. Digite um nome entre 2 e 60 caracteres.");
        return;
      }

      targetReview.categoria = category;
      await refreshReviewLifecycle(targetReview);
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.deleteUserState(senderId);
      const updatedCardText = buildReviewCardText(targetReview);
      const keyboard = buildMainReviewKeyboard(targetReview.id);
      if (chatId) {
        await sendTelegramMessage(chatId, `✅ Categoria atualizada para <b>${category}</b>.`);
        const primaryImageUrl = resolveCanonicalProductImage(targetReview).primaryImageUrl;
        if (targetReview.cardMessageId) await editTelegramMessageCaption(chatId, targetReview.cardMessageId, updatedCardText, keyboard);
        else if (primaryImageUrl) await sendTelegramPhoto(chatId, primaryImageUrl, updatedCardText, keyboard);
        else await sendTelegramMessage(chatId, updatedCardText, keyboard);
      }
      return;
    }

    if (userState && userState.action === "awaiting_promotion_price") {
      const price = parseAndNormalizePrice(text);
      if (price === null || price <= 0) {
        if (chatId) await sendTelegramMessage(chatId, "❌ Valor promocional inválido. Envie um valor como <code>264,44</code>.");
        return;
      }
      const targetReview = userState.reviewId ? await telegramRepo.getPendingReview(userState.reviewId) : null;
      if (!targetReview) {
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, "⚠️ A revisão não está mais disponível para receber a promoção.");
        return;
      }
      targetReview.promotionDraft = { price, condition: null, benefits: [] };
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.setUserState(senderId, { action: "awaiting_promotion_condition", reviewId: userState.reviewId });
      if (chatId) await sendTelegramMessage(chatId, "🏷️ <b>QUAL CONDIÇÃO ACOMPANHA ESSE VALOR?</b>", {
        inline_keyboard: [
          [{ text: "Pix", callback_data: "promo_condition:pix" }, { text: "Pix com cupom", callback_data: "promo_condition:pix_with_coupon" }],
          [{ text: "Cupom", callback_data: "promo_condition:coupon" }, { text: "Outra condição", callback_data: "promo_condition:other" }],
          [{ text: "❌ Cancelar", callback_data: `promo_cancel:${userState.reviewId}` }],
        ],
      });
      return;
    }

    if (userState && userState.action === "awaiting_promotion_benefits") {
      const benefits = text.trim() === "-"
        ? []
        : text.split(/\n|;/)
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter((value) => value.length >= 3 && value.length <= 180)
          .slice(0, 5);
      const targetReview = userState.reviewId ? await telegramRepo.getPendingReview(userState.reviewId) : null;
      if (!targetReview?.promotionDraft?.condition) {
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, "⚠️ O rascunho promocional não está mais disponível. Inicie o ajuste novamente.");
        return;
      }
      targetReview.promotionDraft.benefits = benefits;
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.setUserState(senderId, { action: "confirm_promotion", reviewId: userState.reviewId });
      const price = `R$ ${targetReview.promotionDraft.price.toFixed(2).replace(".", ",")}`;
      if (chatId) await sendTelegramMessage(chatId, `🔎 <b>CONFIRMAR OFERTA PROMOCIONAL</b>\n\nPreço promocional: <b>${price}</b> ${formatPromotionCondition(targetReview.promotionDraft.condition)}\nBenefícios: ${benefits.length > 0 ? benefits.map((benefit) => `\n• ${benefit}`).join("") : "não informado"}\n\n<i>O preço-base canônico não será alterado.</i>`, {
        inline_keyboard: [
          [{ text: "✅ Confirmar oferta", callback_data: `promo_confirm:${userState.reviewId}` }],
          [{ text: "❌ Cancelar", callback_data: `promo_cancel:${userState.reviewId}` }],
        ],
      });
      return;
    }

    // Fallback de preço para revisão pendente
    let targetReview: PendingReview | null = null;
    if (userState && userState.action === "awaiting_price") {
      targetReview = await telegramRepo.getPendingReview(userState.reviewId);
    }
    if (!targetReview) {
      targetReview = await telegramRepo.getLatestPendingReviewForUser(senderId, chatId);
    }

    const normPrice = parseAndNormalizePrice(text);
    if (!targetReview) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "⚠️ <b>Comando ou mensagem não reconhecida.</b>\n\nEnvie o link de um produto para cadastrar ou digite /start para abrir o painel administrativo."
        );
      }
      return;
    }

    if (normPrice !== null && normPrice > 0) {
      targetReview.preco = normPrice;
      await refreshReviewLifecycle(targetReview);
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.deleteUserState(senderId);

      const updatedCardText = buildReviewCardText(targetReview);
      const keyboard = buildMainReviewKeyboard(targetReview.id);

      if (chatId) {
        await sendTelegramMessage(chatId, `✅ Preço atualizado para R$ ${normPrice.toFixed(2).replace(".", ",")}:`);
        if (targetReview.cardMessageId) {
          await editTelegramMessageCaption(chatId, targetReview.cardMessageId, updatedCardText, keyboard);
        } else {
          const primaryImageUrl = resolveCanonicalProductImage(targetReview).primaryImageUrl;
          if (primaryImageUrl) await sendTelegramPhoto(chatId, primaryImageUrl, updatedCardText, keyboard);
          else await sendTelegramMessage(chatId, updatedCardText, keyboard);
        }
      }
    } else {
      if (chatId) {
        await sendTelegramMessage(chatId, "❌ Valor de preço inválido. Envie um número válido (ex: 89,90).");
      }
    }
  }
}

export async function startTelegramPolling(): Promise<void> {
  if (!getTelegramBotToken()) {
    console.warn("⚠️ [Telegram Bot] Backend iniciado sem TELEGRAM_BOT_TOKEN; webhook permanecerá indisponível.");
    return;
  }
  // O nome histórico da função é preservado para compatibilidade, mas o sistema usa somente webhook.
  markTelegramBackendReady();
  console.log("🤖 [Telegram Bot] Componente inicializado independentemente do Operator; polling permanece desativado em favor do Webhook do Render.");
}
