/**
 * Cerberus /shopee manual discovery flow.
 *
 * Contract: /shopee <termo completo> <quantidade 1..10>
 * Discovery is official Shopee Affiliate API only. No generic-search or
 * generated-product fallback is allowed in the command path.
 * Publication remains a separate human callback (confirm_pub).
 *
 * Compatibility: the legacy quantity-first shape is accepted only for an
 * explicit Shopee URL (`1 https://...`) because this is unambiguous and is
 * still used by the internal direct-link dispatcher. Quantity-first search
 * terms remain invalid.
 */
import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import { extractProductForReview, extractMarketplaceId } from "./productAutomation";
import { isShopeePromotionEvidenceFresh, type ShopeePromotionEvidence } from "./scraper";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegramBot";
import { savePendingReview } from "../repositories/telegramRepository";
import type { PendingReview } from "./telegramBot";
import { resolveShortUrlIfNeeded } from "./marketplace";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import {
  inspectShopeeProviderEnv,
  maskShopeeReference,
  newShopeeCorrelationId,
  providerErrorFromAcquisitionStatus,
  safeShopeeLog,
  searchShopeeOffersWithRetry,
  ShopeeProviderRuntimeError,
  type ShopeeProviderErrorCode,
  validateOfficialProductLink,
} from "./shopeeProviderRuntime";

const MIN_ITEMS = 1;
const MAX_ITEMS = 10;
const DISCOVERY_OVERFETCH_MULTIPLIER = 4;
const MAX_DISCOVERY_CANDIDATES = 30;
const MAX_SEARCH_PAGES = 3;
const SEARCH_PAGE_LIMIT = 10;
const LOT_PAUSE_MS = 3000;
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
let lotPauseMs = LOT_PAUSE_MS;

export function setTestShopeeLotPauseMs(milliseconds: number | null): void {
  lotPauseMs = milliseconds === null ? LOT_PAUSE_MS : Math.max(0, milliseconds);
}

export type ShopeeDiscoveryMode = "term" | "urls";

export interface ParsedShopeeCommand {
  count: number;
  query: string;
  error: string | null;
  mode?: ShopeeDiscoveryMode;
  urls?: string[];
}

export interface ParsedShopeeCommandWithDiscovery extends ParsedShopeeCommand {
  mode: ShopeeDiscoveryMode;
  urls: string[];
}

const USAGE = "uso: /shopee <termo de busca> <quantidade 1-10> — exemplo: /shopee mesa lateral de madeira 3";

function parseShopeeDiscovery(parts: string[]): { mode: ShopeeDiscoveryMode; query: string; urls: string[] } {
  const urlPattern = /^https?:\/\/(?:[^/?#]+\.)?(?:shopee\.com\.br|shopee\.com|shopee\.ee)(?:[/?#]|$)/i;
  const allUrls = parts.length > 0 && parts.every((part) => urlPattern.test(part));
  if (allUrls) {
    return {
      mode: "urls",
      query: "",
      urls: parts.map((value) => value.trim()),
    };
  }
  return { mode: "term", query: parts.join(" ").replace(/\s+/g, " ").trim(), urls: [] };
}

export function parseShopeeCommand(argsRaw: string): ParsedShopeeCommand {
  const trimmed = String(argsRaw || "").trim();
  if (!trimmed) return { count: 0, query: "", error: USAGE };
  const parts = trimmed.split(/\s+/u);
  if (parts.length < 2) return { count: 0, query: "", error: USAGE };

  // Compatibilidade estrita para o dispatcher interno antigo: `1 <URL>`.
  // Nunca aceita `1 <termo>`, portanto não há ambiguidade com o novo contrato.
  if (/^\d+$/u.test(parts[0])) {
    const legacyCount = Number(parts[0]);
    const legacyDiscovery = parseShopeeDiscovery(parts.slice(1));
    if (
      Number.isSafeInteger(legacyCount) && legacyCount >= MIN_ITEMS && legacyCount <= MAX_ITEMS &&
      legacyDiscovery.mode === "urls"
    ) {
      return {
        count: legacyCount,
        query: legacyDiscovery.urls.join(" · "),
        error: null,
        mode: "urls",
        urls: legacyDiscovery.urls,
      };
    }
  }

  const rawCount = parts.at(-1) || "";
  if (!/^\d+$/u.test(rawCount)) {
    return { count: 0, query: "", error: `${USAGE}. O último argumento deve ser um inteiro entre ${MIN_ITEMS} e ${MAX_ITEMS}.` };
  }
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count) || count < MIN_ITEMS || count > MAX_ITEMS) {
    return { count: 0, query: "", error: `${USAGE}. Quantidade inválida: use um inteiro entre ${MIN_ITEMS} e ${MAX_ITEMS}.` };
  }

  const discovery = parseShopeeDiscovery(parts.slice(0, -1));
  if (discovery.mode === "term" && !discovery.query) return { count: 0, query: "", error: USAGE };
  const query = discovery.mode === "urls" ? discovery.urls.join(" · ") : discovery.query;
  return { count, query, error: null, mode: discovery.mode, urls: discovery.urls };
}

let testClientOverride: ShopeeApiClient | null = null;
let testIdentityChecker: ((shopId: string, itemId: string) => Promise<boolean>) | null = null;

function buildShopeeClient(): ShopeeApiClient | null {
  if (testClientOverride) return testClientOverride;
  const status = inspectShopeeProviderEnv(process.env);
  if (!status.credentialsConfigured || !status.baseUrlStructurallyValid) return null;
  const appId = String(process.env.SHOPEE_APP_ID || process.env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const appSecret = String(process.env.SHOPEE_APP_SECRET || process.env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  return createShopeeApiClient({ appId, secret: appSecret, baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL });
}

export function setTestShopeeClient(client: ShopeeApiClient | null): void {
  testClientOverride = client;
}

export function setTestShopeeIdentityChecker(checker: ((shopId: string, itemId: string) => Promise<boolean>) | null): void {
  testIdentityChecker = checker;
}

async function identityAlreadyKnown(shopId: string, itemId: string): Promise<boolean> {
  if (testIdentityChecker) return testIdentityChecker(shopId, itemId);
  if (testClientOverride) return false;
  const identity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
  return Boolean(identity?.productId);
}

export async function inspectShopeePromotionFields(): Promise<{
  available: boolean;
  nodeType: string | null;
  fields: string[];
  reason: string | null;
}> {
  const client = buildShopeeClient();
  if (!client) return { available: false, nodeType: null, fields: [], reason: "SHOPEE_PROVIDER_NOT_CONFIGURED" };
  const result = await client.inspectPromotionFields();
  return { available: result.ok, nodeType: result.nodeType, fields: result.fields, reason: result.reason };
}

export async function inspectShopeePromotionOffer(shopId: string, itemId: string): Promise<{
  available: boolean;
  values: { price: string | number | null; priceMin: string | number | null; priceMax: string | number | null; priceDiscountRate: string | number | null } | null;
  reason: string | null;
}> {
  const client = buildShopeeClient();
  if (!client) return { available: false, values: null, reason: "SHOPEE_PROVIDER_NOT_CONFIGURED" };
  const result = await client.inspectPromotionOffer({ shopId, itemId });
  return { available: result.ok, values: result.values, reason: result.reason };
}

function extractCanonicalShopeeIds(url: string): { shopId: string | null; itemId: string | null } {
  const identity = extractShopeeIdentity(url);
  if (identity.shopId && identity.itemId) return identity;
  const marketplaceId = extractMarketplaceId(url);
  if (marketplaceId?.startsWith("shopee-")) {
    const parts = marketplaceId.split("-");
    return { shopId: parts[1] || null, itemId: parts[2] || null };
  }
  return { shopId: null, itemId: null };
}

export function buildShopeeBatchId(): string {
  return `shopee-${Date.now().toString(36)}`;
}

export function buildShopeeReviewId(publicUrl: string, chatId: number): string {
  const key = `${publicUrl}|${chatId}`;
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 33) ^ key.charCodeAt(index);
  return `affprev-${Math.abs(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}

type EnrichedShopeeProduct = {
  ok: boolean;
  failureReason: string | null;
  images: string[];
  rawImages: string[];
  primaryImageUrl: string | null;
  galleryImages: string[];
  imageEditorialStatus: "clean" | "review_required";
  scraperPrice: number | null;
  scraperPriceMax: number | null;
  scraperCheckoutPrice: number | null;
  scraperCheckoutPriceCondition: "pix" | "pix_with_coupon" | null;
  promotionEvidence: ShopeePromotionEvidence | null;
  rawTitle: string | null;
  curatedTitle: string | null;
  description: string;
  category: string | null;
};

async function enrichWithExistingScraper(params: {
  productLink: string;
  officialShopId: string;
  officialItemId: string;
}): Promise<EnrichedShopeeProduct> {
  const fail = (reason: string): EnrichedShopeeProduct => ({
    ok: false,
    failureReason: reason,
    images: [],
    rawImages: [],
    primaryImageUrl: null,
    galleryImages: [],
    imageEditorialStatus: "review_required",
    scraperPrice: null,
    scraperPriceMax: null,
    scraperCheckoutPrice: null,
    scraperCheckoutPriceCondition: null,
    promotionEvidence: null,
    rawTitle: null,
    curatedTitle: null,
    description: "",
    category: null,
  });
  try {
    const result = await extractProductForReview(params.productLink);
    if (!result.success || !result.data) return fail(result.error || "scraper_extraction_failed");
    const data = result.data;
    const identity = extractCanonicalShopeeIds(data.normalizedUrl);
    if (identity.shopId !== params.officialShopId || identity.itemId !== params.officialItemId) return fail("scraper_identity_mismatch");
    const canonicalImage = resolveCanonicalProductImage({
      imagens: data.imagens ?? [],
      imageCuration: data.imageCuration,
      imageEditorialStatus: data.imageEditorialStatus,
    });
    return {
      ok: true,
      failureReason: null,
      images: canonicalImage.publicHttpsImageUrls,
      rawImages: data.imagensOriginais ?? canonicalImage.rawImageUrls,
      primaryImageUrl: canonicalImage.primaryImageUrl ?? null,
      galleryImages: canonicalImage.galleryImageUrls,
      imageEditorialStatus: data.imageEditorialStatus ?? (canonicalImage.status === "ready" ? "clean" : "review_required"),
      scraperPrice: data.preco ?? null,
      scraperPriceMax: data.precoMaximo ?? null,
      scraperCheckoutPrice: data.precoCheckout ?? null,
      scraperCheckoutPriceCondition: data.condicaoPrecoCheckout ?? null,
      promotionEvidence: data.evidenciaPromocional ?? null,
      rawTitle: data.rawTitle ?? data.produto ?? null,
      curatedTitle: data.displayTitle ?? data.produto ?? null,
      description: data.descricao?.trim() ?? "",
      category: data.categoria?.trim() || null,
    };
  } catch {
    return fail("scraper_unexpected_error");
  }
}

function readinessErrors(enriched: EnrichedShopeeProduct): string[] {
  const errors: string[] = [];
  const rawTitle = enriched.rawTitle?.trim() || "";
  const displayTitle = enriched.curatedTitle?.trim() || "";
  if (!rawTitle) errors.push("título de origem ausente");
  if (!displayTitle || displayTitle === rawTitle) errors.push("título editorial ausente");
  if (enriched.description.trim().length < 24) errors.push("descrição editorial ausente");
  if (!enriched.category) errors.push("categoria pública ausente");
  if (!enriched.primaryImageUrl || !/^https:\/\//i.test(enriched.primaryImageUrl) || enriched.images.length === 0) errors.push("imagem HTTPS válida ausente");
  if (enriched.imageEditorialStatus !== "clean") errors.push("IMAGE_REVIEW_REQUIRED");
  return errors;
}

function formatMoney(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 }).format(value);
}

function buildShopeeCardText(params: {
  name: string;
  category: string;
  price: number;
  priceMax: number | null;
  priceSource: "affiliate_api" | "scraper_observacional";
  checkoutPrice: number | null;
  checkoutPriceCondition: "pix" | "pix_with_coupon" | null;
  promotionEvidence: ShopeePromotionEvidence | null;
  shopId: string;
  itemId: string;
  status: string;
  imageCount: number;
  batchId: string;
}): string {
  const price = formatMoney(params.price) || "não informado";
  const range = params.priceMax && params.priceMax > params.price ? ` · até ${formatMoney(params.priceMax)}` : "";
  const source = params.priceSource === "affiliate_api" ? "Shopee Affiliate API" : "anúncio revalidado";
  const promotionFresh = isShopeePromotionEvidenceFresh(params.promotionEvidence);
  const checkout = formatMoney(promotionFresh ? params.promotionEvidence?.checkoutPrice ?? null : params.checkoutPrice);
  const condition = promotionFresh ? params.promotionEvidence?.checkoutPriceCondition ?? null : params.checkoutPriceCondition;
  const checkoutLine = condition === "pix_with_coupon" && checkout
    ? `🏷️ <b>Pix com cupom observado:</b> ${checkout} <i>(confirme no checkout)</i>\n`
    : condition === "pix" && checkout
      ? `🏷️ <b>Pix observado:</b> ${checkout} <i>(confirme no checkout)</i>\n`
      : "";
  return [
    "🛡️ <b>CERBERUS FINDS — PREVIEW SHOPEE AFFILIATE</b>",
    "",
    `🏷️ <b>Produto:</b> ${params.name}`,
    `💰 <b>Preço canônico:</b> ${price}${range} <i>(${source})</i>`,
    `🗂️ <b>Categoria:</b> ${params.category}`,
    checkoutLine.trimEnd(),
    `🖼️ <b>Imagem:</b> ${params.imageCount} imagem(ns) HTTPS revalidada(s)`,
    `🔎 <b>Referência de auditoria:</b> <code>${maskShopeeReference(params.shopId, params.itemId)}</code>`,
    `✅ <b>Elegibilidade:</b> <code>${params.status}</code>`,
    `<b>Lote:</b> <code>${params.batchId}</code>`,
    "",
    "<i>Identidade, destino e link afiliado completos ficam preservados na revisão autoritativa; o card não expõe URLs sensíveis. Nada é publicado antes do clique humano em PUBLICAR.</i>",
  ].filter(Boolean).join("\n");
}

function buildPreviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ PUBLICAR", callback_data: `confirm_pub:${reviewId}` }],
      [{ text: "🏷️ AJUSTAR PROMOÇÃO", callback_data: `promo_edit:${reviewId}` }],
      [{ text: "❌ DESCARTAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

async function sendShopeeCard(params: { chatId: number; text: string; imageUrl: string; reviewId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const photo = await sendTelegramPhoto(params.chatId, params.imageUrl, params.text, buildPreviewKeyboard(params.reviewId));
    if (photo.ok) return { ok: true };
  } catch {
    // A falha da foto pode cair para texto, sem alterar a elegibilidade.
  }
  try {
    const text = await sendTelegramMessage(params.chatId, params.text, buildPreviewKeyboard(params.reviewId));
    return text.ok ? { ok: true } : { ok: false, reason: text.failureReason || "telegram_send_failed" };
  } catch {
    return { ok: false, reason: "telegram_transport_failed" };
  }
}

export type ShopeeLotItemStatus =
  | "ok"
  | "environment_error"
  | "provider_error"
  | "discovery_failed"
  | "duplicate_rejected"
  | "affiliate_not_eligible"
  | "scraper_enrichment_failed"
  | "editorial_curation_failed"
  | "telegram_send_failed"
  | "review_persist_failed";

export interface ShopeeLotItemResult {
  position: number;
  candidateIndex: number;
  discoveryRound: number;
  status: ShopeeLotItemStatus;
  publicUrl: string | null;
  shopId: string | null;
  itemId: string | null;
  reviewId: string | null;
  imageCount: number;
  reason: string | null;
}

export type ShopeeCommandOutcomeCode = ShopeeProviderErrorCode
  | "TELEGRAM_ALLOWED_USER_IDS_MISSING"
  | "NO_RESULTS"
  | "NO_QUALIFIED_REPLACEMENT_FOUND";

export interface ShopeeLotResult {
  lotId: string;
  correlationId: string;
  chatId: number;
  countRequested: number;
  processed: number;
  ok: number;
  failed: number;
  rejectedCandidates: number;
  candidatesExamined: number;
  candidatesReceived: number;
  searchExhausted: boolean;
  poolLocalExhausted: boolean;
  sourceExhausted: boolean;
  budgetExhausted: boolean;
  discoveryRounds: number;
  poolCandidates: number;
  discoveryError: string | null;
  errorCode: ShopeeCommandOutcomeCode | null;
  providerQueryExecuted: boolean;
  rejectionCounts: Record<string, number>;
  items: ShopeeLotItemResult[];
  chatTargetConfigured: boolean;
  affiliateClientAvailable: boolean;
}

function emptyResult(input: {
  count: number;
  lotId?: string;
  correlationId?: string;
  chatId?: number;
  chatConfigured?: boolean;
  clientAvailable?: boolean;
  errorCode?: ShopeeLotResult["errorCode"];
  discoveryError?: string | null;
}): ShopeeLotResult {
  return {
    lotId: input.lotId || "",
    correlationId: input.correlationId || "",
    chatId: input.chatId || 0,
    countRequested: input.count,
    processed: 0,
    ok: 0,
    failed: input.count,
    rejectedCandidates: 0,
    candidatesExamined: 0,
    candidatesReceived: 0,
    searchExhausted: false,
    poolLocalExhausted: false,
    sourceExhausted: false,
    budgetExhausted: false,
    discoveryRounds: 0,
    poolCandidates: 0,
    discoveryError: input.discoveryError ?? null,
    errorCode: input.errorCode ?? null,
    providerQueryExecuted: false,
    rejectionCounts: {},
    items: [],
    chatTargetConfigured: Boolean(input.chatConfigured),
    affiliateClientAvailable: Boolean(input.clientAvailable),
  };
}

export async function runShopeeCommand(argsRaw: string): Promise<ShopeeLotResult> {
  const parsed = parseShopeeCommand(argsRaw);
  if (parsed.error) return emptyResult({ count: parsed.count });

  const lotId = buildShopeeBatchId();
  const correlationId = newShopeeCorrelationId("shopee");
  const chatId = Number((process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim() || "0");
  const chatTargetConfigured = Number.isSafeInteger(chatId) && chatId > 0;
  const client = buildShopeeClient();
  const affiliateClientAvailable = client !== null;

  if (!chatTargetConfigured) {
    safeShopeeLog("shopee_command_blocked", { correlationId, requested: parsed.count, errorCode: "TELEGRAM_ALLOWED_USER_IDS_MISSING" });
    return emptyResult({
      count: parsed.count,
      lotId,
      correlationId,
      chatId,
      chatConfigured: false,
      clientAvailable: affiliateClientAvailable,
      errorCode: "TELEGRAM_ALLOWED_USER_IDS_MISSING",
      discoveryError: "TELEGRAM_ALLOWED_USER_IDS ausente; nenhuma consulta executada",
    });
  }

  if (!client) {
    await sendTelegramMessage(chatId, "⚠️ <b>/shopee bloqueado</b>\n\n<code>SHOPEE_PROVIDER_NOT_CONFIGURED</code>\nConfigure as credenciais oficiais no secret manager do ambiente. Nenhuma consulta foi executada.").catch(() => undefined);
    safeShopeeLog("shopee_command_blocked", { correlationId, requested: parsed.count, errorCode: "SHOPEE_PROVIDER_NOT_CONFIGURED" });
    return emptyResult({
      count: parsed.count,
      lotId,
      correlationId,
      chatId,
      chatConfigured: true,
      clientAvailable: false,
      errorCode: "SHOPEE_PROVIDER_NOT_CONFIGURED",
      discoveryError: "SHOPEE_PROVIDER_NOT_CONFIGURED",
    });
  }

  const discoveryMode = parsed.mode || "term";
  const candidates: Array<{ url: string; round: number }> = [];
  const seenDiscovery = new Set<string>();
  const rejectionCounts: Record<string, number> = {};
  const items: ShopeeLotItemResult[] = [];
  let providerQueryExecuted = false;
  let providerFailure: ShopeeProviderRuntimeError | null = null;
  let candidatesReceived = 0;
  let discoveryRounds = 0;
  let sourceExhausted = false;
  let budgetExhausted = false;

  const reject = (reason: string) => {
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  };

  if (discoveryMode === "urls") {
    for (const original of parsed.urls || []) {
      const resolved = await resolveShortUrlIfNeeded(original);
      const url = resolved.resolvedUrl;
      const identity = extractCanonicalShopeeIds(url);
      if (!identity.shopId || !identity.itemId || !validateOfficialProductLink(url, identity.shopId, identity.itemId)) {
        reject("DIRECT_URL_IDENTITY_INVALID");
        continue;
      }
      const key = `${identity.shopId}:${identity.itemId}`;
      if (seenDiscovery.has(key)) continue;
      seenDiscovery.add(key);
      candidates.push({ url, round: 0 });
    }
    sourceExhausted = true;
  } else {
    const target = Math.min(MAX_DISCOVERY_CANDIDATES, Math.max(parsed.count * DISCOVERY_OVERFETCH_MULTIPLIER, parsed.count));
    for (let page = 1; page <= MAX_SEARCH_PAGES && candidates.length < target; page += 1) {
      discoveryRounds = page;
      providerQueryExecuted = true;
      try {
        const search = await searchShopeeOffersWithRetry({ client, query: parsed.query, limit: SEARCH_PAGE_LIMIT, page });
        candidatesReceived += search.items.length;
        if (search.items.length === 0) {
          sourceExhausted = true;
          break;
        }
        for (const candidate of search.items) {
          if (!candidate.shopId || !candidate.itemId) { reject("IDENTITY_MISSING"); continue; }
          if (!candidate.name?.trim()) { reject("TITLE_MISSING"); continue; }
          if (candidate.price === null || !Number.isFinite(candidate.price) || candidate.price <= 0) { reject("PRICE_MISSING"); continue; }
          if (!validateOfficialProductLink(candidate.productLink, candidate.shopId, candidate.itemId)) { reject("OFFICIAL_PRODUCT_LINK_INVALID"); continue; }
          const key = `${candidate.shopId}:${candidate.itemId}`;
          if (seenDiscovery.has(key)) { reject("DUPLICATE_DISCOVERY_IDENTITY"); continue; }
          seenDiscovery.add(key);
          candidates.push({ url: candidate.productLink, round: page });
          if (candidates.length >= target) break;
        }
        if (search.items.length < SEARCH_PAGE_LIMIT) {
          sourceExhausted = true;
          break;
        }
      } catch (error) {
        providerFailure = error instanceof ShopeeProviderRuntimeError
          ? error
          : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "unexpected_search_failure", true);
        break;
      }
    }
    if (candidates.length >= MAX_DISCOVERY_CANDIDATES || discoveryRounds >= MAX_SEARCH_PAGES) budgetExhausted = !sourceExhausted;
  }

  if (providerFailure) {
    const message = providerFailure.code === "SHOPEE_PROVIDER_AUTH_FAILED"
      ? "⚠️ <b>/shopee bloqueado</b>\n\n<code>SHOPEE_PROVIDER_AUTH_FAILED</code>\nA API oficial rejeitou a autenticação. Revise as credenciais no secret manager."
      : providerFailure.code === "SHOPEE_PROVIDER_FORBIDDEN"
        ? "⚠️ <b>/shopee bloqueado</b>\n\n<code>SHOPEE_PROVIDER_FORBIDDEN</code>\nA credencial foi reconhecida, mas não possui autorização suficiente para a operação oficial. Revise os scopes/permissões do provider."
        : `⚠️ <b>/shopee indisponível temporariamente</b>\n\n<code>${providerFailure.code}</code>\nA consulta oficial falhou; nenhum resultado vazio foi fabricado.`;
    await sendTelegramMessage(chatId, message).catch(() => undefined);
    safeShopeeLog("shopee_provider_failure", { correlationId, requested: parsed.count, errorCode: providerFailure.code, providerQueryExecuted });
    const base = emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: providerFailure.code, discoveryError: providerFailure.code });
    return { ...base, providerQueryExecuted, discoveryRounds, candidatesReceived, poolCandidates: candidates.length, rejectionCounts, sourceExhausted, budgetExhausted };
  }

  if (discoveryMode === "term" && providerQueryExecuted && candidatesReceived === 0) {
    await sendTelegramMessage(
      chatId,
      `🔎 <b>SHOPEE — NENHUM RESULTADO OFICIAL</b>\n\n<code>NO_RESULTS</code>\nSolicitados: <b>${parsed.count}</b>\nEncontrados: <b>0</b>\n\nA consulta oficial foi executada com sucesso, mas não retornou candidatos. Tente um termo mais amplo.`,
    ).catch(() => undefined);
    safeShopeeLog("shopee_command_no_results", { correlationId, requested: parsed.count, providerQueryExecuted, candidatesReceived: 0, errorCode: "NO_RESULTS" });
    return {
      ...emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: "NO_RESULTS", discoveryError: "NO_RESULTS" }),
      providerQueryExecuted: true,
      discoveryRounds,
      candidatesReceived: 0,
      poolCandidates: 0,
      sourceExhausted,
      budgetExhausted,
      rejectionCounts,
    };
  }

  await sendTelegramMessage(
    chatId,
    `🛒 <b>LOTE SHOPEE INICIADO</b>\n\nSolicitados: <b>${parsed.count}</b>\nProvider: <code>ShopeeApiClient</code>\nCandidatos oficiais recebidos: <b>${candidatesReceived || candidates.length}</b>\n\n<i>Busca → revalidação → card. Publicação só após aprovação humana.</i>`,
  ).catch(() => undefined);

  let accepted = 0;
  for (let cursor = 0; cursor < candidates.length && accepted < parsed.count; cursor += 1) {
    if (cursor > 0 && lotPauseMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, lotPauseMs));
    const source = candidates[cursor];
    const identity = extractCanonicalShopeeIds(source.url);
    const item: ShopeeLotItemResult = {
      position: cursor + 1,
      candidateIndex: cursor + 1,
      discoveryRound: source.round,
      status: "discovery_failed",
      publicUrl: source.url,
      shopId: identity.shopId,
      itemId: identity.itemId,
      reviewId: null,
      imageCount: 0,
      reason: null,
    };
    items.push(item);

    if (!identity.shopId || !identity.itemId || !validateOfficialProductLink(source.url, identity.shopId, identity.itemId)) {
      item.reason = "OFFICIAL_IDENTITY_INVALID";
      reject(item.reason);
      continue;
    }

    try {
      if (await identityAlreadyKnown(identity.shopId, identity.itemId)) {
        item.status = "duplicate_rejected";
        item.reason = "SOURCE_IDENTITY_ALREADY_OWNED";
        reject(item.reason);
        continue;
      }
    } catch {
      item.status = "provider_error";
      item.reason = "CANONICAL_STATE_UNAVAILABLE";
      reject(item.reason);
      break;
    }

    const acquisition = await client.acquireAffiliateLink({ shopId: identity.shopId, itemId: identity.itemId });
    if (acquisition.status !== "link_acquired") {
      const infraFailure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
      if (infraFailure) {
        providerFailure = infraFailure;
        item.status = "provider_error";
        item.reason = infraFailure.code;
        reject(item.reason);
        break;
      }
      item.status = "affiliate_not_eligible";
      item.reason = `AFFILIATE_${acquisition.status}`;
      reject(item.reason);
      continue;
    }
    if (!acquisition.productLink || !acquisition.affiliateUrl || !acquisition.shopId || !acquisition.itemId) {
      item.status = "affiliate_not_eligible";
      item.reason = "AFFILIATE_EVIDENCE_INCOMPLETE";
      reject(item.reason);
      continue;
    }
    if (acquisition.shopId !== identity.shopId || acquisition.itemId !== identity.itemId || !validateOfficialProductLink(acquisition.productLink, acquisition.shopId, acquisition.itemId)) {
      item.status = "affiliate_not_eligible";
      item.reason = "AFFILIATE_IDENTITY_MISMATCH";
      reject(item.reason);
      continue;
    }

    const enriched = await enrichWithExistingScraper({
      productLink: acquisition.productLink,
      officialShopId: acquisition.shopId,
      officialItemId: acquisition.itemId,
    });
    if (!enriched.ok) {
      item.status = "scraper_enrichment_failed";
      item.reason = enriched.failureReason || "SCRAPER_FAILED";
      reject(item.reason);
      continue;
    }
    const errors = readinessErrors(enriched);
    if (errors.length > 0) {
      item.status = "editorial_curation_failed";
      item.reason = `EDITORIAL_INCOMPLETE:${errors.join(",")}`;
      reject(item.reason);
      continue;
    }

    const scrapedPrice = Number(enriched.scraperPrice);
    const officialPrice = Number(acquisition.price);
    const hasScrapedPrice = Number.isFinite(scrapedPrice) && scrapedPrice > 0;
    const hasOfficialPrice = Number.isFinite(officialPrice) && officialPrice > 0;
    if (!hasScrapedPrice && !hasOfficialPrice) {
      item.status = "editorial_curation_failed";
      item.reason = "PRICE_UNVERIFIED";
      reject(item.reason);
      continue;
    }
    const price = hasScrapedPrice ? scrapedPrice : officialPrice;
    const reviewId = buildShopeeReviewId(acquisition.productLink, chatId);
    const review: PendingReview = {
      id: reviewId,
      chatId,
      senderId: chatId,
      firstName: process.env.USER || "admin",
      username: process.env.USER || "admin",
      produto: enriched.rawTitle!,
      rawTitle: enriched.rawTitle!,
      displayTitle: enriched.curatedTitle!,
      categoria: enriched.category!,
      preco: price,
      imagens: enriched.images,
      imagensOriginais: enriched.rawImages,
      imagemPrincipal: enriched.primaryImageUrl!,
      imagensGaleria: enriched.galleryImages,
      imageEditorialStatus: enriched.imageEditorialStatus,
      normalizedUrl: acquisition.productLink,
      descricao: enriched.description,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + REVIEW_TTL_MS,
      existingProduct: {
        source: "affiliate_preview",
        affiliateUrl: acquisition.affiliateUrl,
        priceScaleVerified: true,
        shopId: acquisition.shopId,
        itemId: acquisition.itemId,
      },
      promotionEvidence: enriched.promotionEvidence,
    };
    try {
      await savePendingReview(review);
    } catch {
      item.status = "review_persist_failed";
      item.reason = "REVIEW_PERSIST_FAILED";
      reject(item.reason);
      continue;
    }

    const card = buildShopeeCardText({
      name: enriched.curatedTitle!,
      category: enriched.category!,
      price,
      priceMax: hasScrapedPrice ? enriched.scraperPriceMax : null,
      priceSource: hasScrapedPrice ? "scraper_observacional" : "affiliate_api",
      checkoutPrice: enriched.scraperCheckoutPrice,
      checkoutPriceCondition: enriched.scraperCheckoutPriceCondition,
      promotionEvidence: enriched.promotionEvidence,
      shopId: acquisition.shopId,
      itemId: acquisition.itemId,
      status: "QUALIFIED_FOR_HUMAN_REVIEW",
      imageCount: enriched.images.length,
      batchId: lotId,
    });
    const sent = await sendShopeeCard({ chatId, text: card, imageUrl: enriched.primaryImageUrl!, reviewId });
    item.reviewId = reviewId;
    item.imageCount = enriched.images.length;
    if (!sent.ok) {
      item.status = "telegram_send_failed";
      item.reason = sent.reason || "TELEGRAM_SEND_FAILED";
      reject(item.reason);
      continue;
    }
    item.status = "ok";
    item.reason = null;
    accepted += 1;
  }

  let errorCode: ShopeeLotResult["errorCode"] = providerFailure?.code || null;
  if (!errorCode && discoveryMode === "term" && providerQueryExecuted && candidatesReceived > 0 && accepted === 0) {
    errorCode = "NO_QUALIFIED_REPLACEMENT_FOUND";
  }
  const failureSummary = Object.entries(rejectionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => `${count}× ${reason}`)
    .join("; ") || "nenhuma rejeição registrada";
  const finalTitle = providerFailure
    ? "⚠️ <b>LOTE INTERROMPIDO POR FALHA DO PROVIDER</b>"
    : errorCode === "NO_QUALIFIED_REPLACEMENT_FOUND"
      ? "⚠️ <b>SHOPEE — NENHUM CANDIDATO QUALIFICADO</b>"
      : "🏁 <b>LOTE SHOPEE CONCLUÍDO</b>";
  await sendTelegramMessage(
    chatId,
    `${finalTitle}\n\nSolicitados: <b>${parsed.count}</b>\nEncontrados/recebidos: <b>${candidatesReceived || candidates.length}</b>\nCards aprovados para revisão humana: <b>${accepted}</b>\nRejeições: <code>${failureSummary}</code>${accepted < parsed.count && !providerFailure ? "\n\nTente um termo mais amplo para aumentar o pool oficial." : ""}${providerFailure ? `\n\nErro: <code>${providerFailure.code}</code>. Não foi convertido em NO_RESULTS.` : ""}${errorCode === "NO_QUALIFIED_REPLACEMENT_FOUND" ? "\n\nCódigo: <code>NO_QUALIFIED_REPLACEMENT_FOUND</code> — a busca foi executada e os candidatos recebidos foram rejeitados pelas regras de elegibilidade." : ""}`,
  ).catch(() => undefined);

  safeShopeeLog("shopee_command_complete", {
    correlationId,
    requested: parsed.count,
    provider: "ShopeeApiClient",
    providerQueryExecuted,
    candidatesReceived,
    candidatesExamined: items.length,
    approved: accepted,
    rejected: items.length - accepted,
    errorCode,
  });

  const poolLocalExhausted = accepted < parsed.count && items.length >= candidates.length;
  return {
    lotId,
    correlationId,
    chatId,
    countRequested: parsed.count,
    processed: items.length,
    ok: accepted,
    failed: parsed.count - accepted,
    rejectedCandidates: items.length - accepted,
    candidatesExamined: items.length,
    candidatesReceived,
    searchExhausted: poolLocalExhausted,
    poolLocalExhausted,
    sourceExhausted,
    budgetExhausted,
    discoveryRounds,
    poolCandidates: candidates.length,
    discoveryError: errorCode,
    errorCode,
    providerQueryExecuted,
    rejectionCounts,
    items,
    chatTargetConfigured,
    affiliateClientAvailable,
  };
}
