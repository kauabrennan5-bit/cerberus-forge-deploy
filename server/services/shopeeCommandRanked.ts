/**
 * Manual /shopee discovery and human-review flow.
 * Discovery, identity, price, productLink and primary image originate from the
 * official Shopee Affiliate API. No URL is reconstructed from identifiers.
 */
import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import { extractProductForReview } from "./productAutomation";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegramBot";
import { savePendingReview } from "../repositories/telegramRepository";
import type { PendingReview } from "./telegramBot";
import { resolveShortUrlIfNeeded } from "./marketplace";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
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
import {
  controlledShopeeQueryVariants,
  evaluateShopeeCandidateRelevance,
  qualifyOfficialShopeeImage,
  rankShopeeCandidates,
  safeShopeeImageDiagnostic,
  type ShopeeCandidateVisualState,
  type ShopeeImageQualification,
  type ShopeeRankableCandidate,
} from "./shopeeCandidateQualification";

const MIN_ITEMS = 1;
const MAX_ITEMS = 10;
const MIN_RANKING_POOL = 10;
const MAX_DISCOVERY_CANDIDATES = 30;
const MAX_SEARCH_CALLS = 6;
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
  const allUrls = parts.length > 0 && parts.every(part => urlPattern.test(part));
  if (allUrls) return { mode: "urls", query: "", urls: parts.map(value => value.trim()) };
  return { mode: "term", query: parts.join(" ").replace(/\s+/g, " ").trim(), urls: [] };
}

export function parseShopeeCommand(argsRaw: string): ParsedShopeeCommand {
  const trimmed = String(argsRaw || "").trim();
  if (!trimmed) return { count: 0, query: "", error: USAGE };
  const parts = trimmed.split(/\s+/u);
  if (parts.length < 2) return { count: 0, query: "", error: USAGE };

  if (/^\d+$/u.test(parts[0])) {
    const legacyCount = Number(parts[0]);
    const legacyDiscovery = parseShopeeDiscovery(parts.slice(1));
    if (
      Number.isSafeInteger(legacyCount)
      && legacyCount >= MIN_ITEMS
      && legacyCount <= MAX_ITEMS
      && legacyDiscovery.mode === "urls"
    ) {
      return { count: legacyCount, query: legacyDiscovery.urls.join(" · "), error: null, mode: "urls", urls: legacyDiscovery.urls };
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
  return {
    count,
    query: discovery.mode === "urls" ? discovery.urls.join(" · ") : discovery.query,
    error: null,
    mode: discovery.mode,
    urls: discovery.urls,
  };
}

let testClientOverride: ShopeeApiClient | null = null;
let testIdentityChecker: ((shopId: string, itemId: string) => Promise<boolean>) | null = null;
let testImageQualifier: ((imageUrl: string, title: string) => Promise<ShopeeImageQualification>) | null = null;

export function setTestShopeeClient(client: ShopeeApiClient | null): void {
  testClientOverride = client;
}

export function setTestShopeeIdentityChecker(checker: ((shopId: string, itemId: string) => Promise<boolean>) | null): void {
  testIdentityChecker = checker;
}

export function setTestShopeeImageQualifier(qualifier: ((imageUrl: string, title: string) => Promise<ShopeeImageQualification>) | null): void {
  testImageQualifier = qualifier;
}

function buildShopeeClient(): ShopeeApiClient | null {
  if (testClientOverride) return testClientOverride;
  const status = inspectShopeeProviderEnv(process.env);
  if (!status.credentialsConfigured || !status.baseUrlStructurallyValid) return null;
  const appId = String(process.env.SHOPEE_APP_ID ?? process.env.SHOPEE_AFFILIATE_APP_ID ?? "").trim();
  const appSecret = String(process.env.SHOPEE_APP_SECRET ?? process.env.SHOPEE_AFFILIATE_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) return null;
  return createShopeeApiClient({ appId, secret: appSecret, baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL });
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

export function buildShopeeBatchId(): string {
  return `shopee-${Date.now().toString(36)}`;
}

export function buildShopeeReviewId(publicUrl: string, chatId: number): string {
  const key = `${publicUrl}|${chatId}`;
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 33) ^ key.charCodeAt(index);
  return `affprev-${Math.abs(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}

function normalizeOfficialTitle(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function emptyProbe(reason: string): ShopeeImageQualification {
  return {
    state: "HARD_REJECT",
    reason,
    probe: { ok: false, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason },
    assessment: null,
    curationReason: null,
    visualScore: 0,
  };
}

async function qualifyImage(imageUrl: string, title: string): Promise<ShopeeImageQualification> {
  if (!imageUrl) return emptyProbe("IMAGE_MISSING");
  if (testImageQualifier) return testImageQualifier(imageUrl, title);
  return qualifyOfficialShopeeImage(imageUrl, title);
}

function publicProviderCode(error: ShopeeProviderRuntimeError): ShopeeCommandOutcomeCode {
  if (["SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(error.code)) {
    return "SHOPEE_PROVIDER_UNAVAILABLE";
  }
  return error.code;
}

function providerMessage(code: ShopeeCommandOutcomeCode): string {
  if (code === "SHOPEE_PROVIDER_NOT_CONFIGURED") return "Provider oficial não configurado; nenhuma consulta foi executada.";
  if (code === "SHOPEE_PROVIDER_AUTH_FAILED") return "A API oficial rejeitou a autenticação.";
  if (code === "SHOPEE_PROVIDER_FORBIDDEN") return "A credencial foi reconhecida, mas não possui autorização suficiente.";
  if (code === "SHOPEE_PROVIDER_RESPONSE_INVALID") return "A API oficial respondeu em formato incompatível.";
  return "O provider oficial ficou indisponível, atingiu timeout ou rate limit.";
}

function buildImageCuration(imageUrl: string, qualification: ShopeeImageQualification): ProductImageCuration {
  if (qualification.state === "QUALIFIED") {
    return {
      status: "ready",
      rawImageUrls: [imageUrl],
      primaryImageUrl: imageUrl,
      galleryImageUrls: [],
      assessments: qualification.assessment ? [qualification.assessment] : [],
    };
  }
  return {
    status: "review_required",
    rawImageUrls: [imageUrl],
    galleryImageUrls: [],
    assessments: qualification.assessment ? [qualification.assessment] : [],
    reason: qualification.curationReason || "no_commercial_image",
  };
}

function buildShopeeCardText(params: {
  rank: number;
  name: string;
  category: string;
  price: number;
  shopId: string;
  itemId: string;
  status: Exclude<ShopeeCandidateVisualState, "HARD_REJECT">;
  reviewReason: string;
  batchId: string;
}): string {
  const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 }).format(params.price);
  const warning = params.status === "NEEDS_HUMAN_REVIEW"
    ? `⚠️ <b>Revisão visual necessária:</b> <code>${params.reviewReason}</code>`
    : "✅ <b>Imagem:</b> qualificada pelo reviewer visual";
  return [
    `🛡️ <b>CERBERUS FINDS — RANK #${params.rank}</b>`,
    "",
    `🏷️ <b>Produto:</b> ${params.name}`,
    `💰 <b>Preço oficial:</b> ${price}`,
    `🗂️ <b>Categoria:</b> ${params.category}`,
    `🖼️ <b>Status:</b> <code>${params.status}</code>`,
    warning,
    `🔎 <b>Referência de auditoria:</b> <code>${maskShopeeReference(params.shopId, params.itemId)}</code>`,
    `<b>Lote:</b> <code>${params.batchId}</code>`,
    "",
    "<i>Dados de identidade, preço, imagem e destino vêm da fonte oficial. Aprovar não ignora o preflight: o estado autoritativo é consultado novamente antes de qualquer publicação.</i>",
  ].join("\n");
}

function buildPreviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ APROVAR", callback_data: `confirm_pub:${reviewId}` }],
      [{ text: "❌ CANCELAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

async function sendShopeeCard(params: { chatId: number; text: string; imageUrl: string; reviewId: string }): Promise<{ ok: boolean; reason?: string }> {
  try {
    const photo = await sendTelegramPhoto(params.chatId, params.imageUrl, params.text, buildPreviewKeyboard(params.reviewId));
    if (photo.ok) return { ok: true };
  } catch {
    // Falha de transporte da foto pode cair para texto sem alterar o estado visual.
  }
  try {
    const text = await sendTelegramMessage(params.chatId, params.text, buildPreviewKeyboard(params.reviewId));
    return text.ok ? { ok: true } : { ok: false, reason: text.failureReason || "TELEGRAM_SEND_FAILED" };
  } catch {
    return { ok: false, reason: "TELEGRAM_TRANSPORT_FAILED" };
  }
}

export type ShopeeLotItemStatus =
  | "ok"
  | "environment_error"
  | "provider_error"
  | "discovery_failed"
  | "duplicate_rejected"
  | "affiliate_not_eligible"
  | "image_hard_reject"
  | "needs_human_review"
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
  qualificationState?: ShopeeCandidateVisualState;
  rank?: number | null;
}

export type ShopeeCommandOutcomeCode = ShopeeProviderErrorCode
  | "TELEGRAM_ALLOWED_USER_IDS_MISSING"
  | "SHOPEE_NO_RESULTS"
  | "SHOPEE_CANDIDATES_REJECTED";

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
  hardRejectCount: number;
  needsHumanReviewCount: number;
  qualifiedCount: number;
  topCandidatesCount: number;
  rankingExecuted: boolean;
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
    hardRejectCount: 0,
    needsHumanReviewCount: 0,
    qualifiedCount: 0,
    topCandidatesCount: 0,
    rankingExecuted: false,
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

type WorkingCandidate = ShopeeRankableCandidate & {
  candidateIndex: number;
  preRejectReason: string | null;
  duplicate: boolean;
};

async function discoverTermCandidates(params: {
  client: ShopeeApiClient;
  query: string;
  rejectionCounts: Record<string, number>;
}): Promise<{
  candidates: WorkingCandidate[];
  received: number;
  calls: number;
  sourceExhausted: boolean;
}> {
  const candidates: WorkingCandidate[] = [];
  const seen = new Set<string>();
  const variants = controlledShopeeQueryVariants(params.query);
  let received = 0;
  let calls = 0;
  let sourceExhausted = true;

  for (let variantIndex = 0; variantIndex < variants.length && calls < MAX_SEARCH_CALLS && candidates.length < MAX_DISCOVERY_CANDIDATES; variantIndex += 1) {
    const variant = variants[variantIndex];
    const pagesForVariant = variantIndex === 0 ? 3 : 1;
    for (let page = 1; page <= pagesForVariant && calls < MAX_SEARCH_CALLS && candidates.length < MAX_DISCOVERY_CANDIDATES; page += 1) {
      calls += 1;
      const search = await searchShopeeOffersWithRetry({ client: params.client, query: variant, limit: SEARCH_PAGE_LIMIT, page });
      received += search.items.length;
      if (search.items.length === 0) break;
      for (const raw of search.items) {
        const shopId = String(raw.shopId || "").trim();
        const itemId = String(raw.itemId || "").trim();
        const name = normalizeOfficialTitle(raw.name || "");
        const price = Number(raw.price);
        const productLink = String(raw.productLink || "").trim();
        const imageUrl = String(raw.imageUrl || "").trim();
        let preRejectReason: string | null = null;
        if (!shopId || !itemId) preRejectReason = "IDENTITY_MISSING";
        else if (!name) preRejectReason = "TITLE_MISSING";
        else if (!Number.isFinite(price) || price <= 0) preRejectReason = "PRICE_MISSING";
        else if (!validateOfficialProductLink(productLink, shopId, itemId)) preRejectReason = "OFFICIAL_PRODUCT_LINK_INVALID";
        const identity = `${shopId}:${itemId}`;
        if (shopId && itemId && seen.has(identity)) {
          params.rejectionCounts.DUPLICATE_DISCOVERY_IDENTITY = (params.rejectionCounts.DUPLICATE_DISCOVERY_IDENTITY || 0) + 1;
          continue;
        }
        if (shopId && itemId) seen.add(identity);
        const relevance = name ? evaluateShopeeCandidateRelevance(params.query, name) : { compatible: false, category: "", score: 0, reason: "TITLE_MISSING" };
        if (!preRejectReason && !relevance.compatible) preRejectReason = relevance.reason;
        candidates.push({
          candidateIndex: candidates.length + 1,
          shopId,
          itemId,
          name,
          price: Number.isFinite(price) ? price : 0,
          productLink,
          imageUrl,
          round: calls,
          queryVariant: variant,
          category: relevance.category,
          relevanceScore: relevance.score,
          preRejectReason,
          duplicate: false,
        });
        if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
      }
      if (search.items.length < SEARCH_PAGE_LIMIT) break;
      sourceExhausted = false;
    }
    if (candidates.length >= Math.max(MIN_RANKING_POOL, params.query ? 10 : 10) && candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
  }
  return { candidates, received, calls, sourceExhausted };
}

async function discoverDirectCandidates(params: {
  client: ShopeeApiClient;
  urls: string[];
}): Promise<{ candidates: WorkingCandidate[]; received: number }> {
  const candidates: WorkingCandidate[] = [];
  const seen = new Set<string>();
  for (const original of params.urls) {
    const resolved = await resolveShortUrlIfNeeded(original);
    const supplied = resolved.resolvedUrl;
    const identity = extractShopeeIdentity(supplied);
    if (!identity.shopId || !identity.itemId || !validateOfficialProductLink(supplied, identity.shopId, identity.itemId)) {
      candidates.push({ candidateIndex: candidates.length + 1, shopId: identity.shopId || "", itemId: identity.itemId || "", name: "", price: 0, productLink: supplied, imageUrl: "", round: 0, queryVariant: "direct", category: "", relevanceScore: 100, preRejectReason: "DIRECT_URL_IDENTITY_INVALID", duplicate: false });
      continue;
    }
    const key = `${identity.shopId}:${identity.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lookup = await params.client.lookupProduct({ shopId: identity.shopId, itemId: identity.itemId });
    if (lookup.status !== "found" || !lookup.productLink || !lookup.name || !lookup.priceMinorUnits || !validateOfficialProductLink(lookup.productLink, identity.shopId, identity.itemId)) {
      candidates.push({ candidateIndex: candidates.length + 1, shopId: identity.shopId, itemId: identity.itemId, name: normalizeOfficialTitle(lookup.name || ""), price: Number(lookup.priceMinorUnits || 0), productLink: lookup.productLink || supplied, imageUrl: "", round: 0, queryVariant: "direct", category: resolvePublicProductCategory("", { title: lookup.name || "" }), relevanceScore: 100, preRejectReason: "DIRECT_LOOKUP_INCOMPLETE", duplicate: false });
      continue;
    }
    const extracted = await extractProductForReview(lookup.productLink);
    const imageUrl = extracted.success && extracted.data?.imagemPrincipal ? extracted.data.imagemPrincipal : "";
    candidates.push({
      candidateIndex: candidates.length + 1,
      shopId: identity.shopId,
      itemId: identity.itemId,
      name: normalizeOfficialTitle(lookup.name),
      price: Number(lookup.priceMinorUnits),
      productLink: lookup.productLink,
      imageUrl,
      round: 0,
      queryVariant: "direct",
      category: resolvePublicProductCategory("", { title: lookup.name }),
      relevanceScore: 100,
      preRejectReason: imageUrl ? null : "IMAGE_MISSING",
      duplicate: false,
    });
  }
  return { candidates, received: candidates.length };
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
    return emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: false, clientAvailable: affiliateClientAvailable, errorCode: "TELEGRAM_ALLOWED_USER_IDS_MISSING", discoveryError: "TELEGRAM_ALLOWED_USER_IDS_MISSING" });
  }
  if (!client) {
    await sendTelegramMessage(chatId, "⚠️ <b>SHOPEE_PROVIDER_NOT_CONFIGURED</b>\n\nProvider oficial não configurado; nenhuma consulta foi executada.").catch(() => undefined);
    return emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: false, errorCode: "SHOPEE_PROVIDER_NOT_CONFIGURED", discoveryError: "SHOPEE_PROVIDER_NOT_CONFIGURED" });
  }

  const rejectionCounts: Record<string, number> = {};
  const items: ShopeeLotItemResult[] = [];
  let candidatesReceived = 0;
  let discoveryRounds = 0;
  let sourceExhausted = false;
  let budgetExhausted = false;
  let providerQueryExecuted = false;
  let candidates: WorkingCandidate[] = [];

  try {
    if ((parsed.mode || "term") === "term") {
      providerQueryExecuted = true;
      const discovered = await discoverTermCandidates({ client, query: parsed.query, rejectionCounts });
      candidates = discovered.candidates;
      candidatesReceived = discovered.received;
      discoveryRounds = discovered.calls;
      sourceExhausted = discovered.sourceExhausted;
      budgetExhausted = discovered.calls >= MAX_SEARCH_CALLS && candidates.length < MAX_DISCOVERY_CANDIDATES;
    } else {
      const discovered = await discoverDirectCandidates({ client, urls: parsed.urls || [] });
      candidates = discovered.candidates;
      candidatesReceived = discovered.received;
      sourceExhausted = true;
    }
  } catch (error) {
    const providerFailure = error instanceof ShopeeProviderRuntimeError
      ? error
      : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "unexpected_search_failure", true);
    const code = publicProviderCode(providerFailure);
    await sendTelegramMessage(chatId, `⚠️ <b>${code}</b>\n\n${providerMessage(code)}`).catch(() => undefined);
    const base = emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code, discoveryError: code });
    return { ...base, providerQueryExecuted, discoveryRounds, candidatesReceived, poolCandidates: candidates.length, sourceExhausted, budgetExhausted };
  }

  if ((parsed.mode || "term") === "term" && providerQueryExecuted && candidatesReceived === 0) {
    await sendTelegramMessage(chatId, `🔎 <b>SHOPEE_NO_RESULTS</b>\n\nA busca oficial foi executada, inclusive com variações controladas quando aplicável, e não retornou candidatos.`).catch(() => undefined);
    return {
      ...emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: "SHOPEE_NO_RESULTS", discoveryError: "SHOPEE_NO_RESULTS" }),
      providerQueryExecuted: true,
      discoveryRounds,
      candidatesReceived,
      poolCandidates: candidates.length,
      sourceExhausted,
      budgetExhausted,
    };
  }

  await sendTelegramMessage(
    chatId,
    `🛒 <b>LOTE SHOPEE INICIADO</b>\n\nSolicitados: <b>${parsed.count}</b>\nProvider: <code>ShopeeApiClient</code>\nCandidatos oficiais recebidos: <b>${candidatesReceived}</b>\nPool único para qualificação: <b>${candidates.length}</b>\n\n<i>Busca oficial → qualificação → ranking → card. Publicação só após aprovação humana e novo preflight.</i>`,
  ).catch(() => undefined);

  let hardRejectCount = 0;
  let needsHumanReviewCount = 0;
  let qualifiedCount = 0;
  const eligible: WorkingCandidate[] = [];

  for (const candidate of candidates) {
    const item: ShopeeLotItemResult = {
      position: candidate.candidateIndex,
      candidateIndex: candidate.candidateIndex,
      discoveryRound: candidate.round,
      status: "discovery_failed",
      publicUrl: candidate.productLink || null,
      shopId: candidate.shopId || null,
      itemId: candidate.itemId || null,
      reviewId: null,
      imageCount: candidate.imageUrl ? 1 : 0,
      reason: null,
      qualificationState: "HARD_REJECT",
      rank: null,
    };
    items.push(item);

    if (candidate.preRejectReason) {
      const qualification = emptyProbe(candidate.preRejectReason);
      candidate.imageQualification = qualification;
      item.status = "image_hard_reject";
      item.reason = candidate.preRejectReason;
      hardRejectCount += 1;
      rejectionCounts[candidate.preRejectReason] = (rejectionCounts[candidate.preRejectReason] || 0) + 1;
      safeShopeeLog("shopee_candidate_image", { correlationId, ...safeShopeeImageDiagnostic({ candidateIndex: candidate.candidateIndex, imagePresent: Boolean(candidate.imageUrl), qualification }) });
      continue;
    }

    try {
      if (await identityAlreadyKnown(candidate.shopId, candidate.itemId)) {
        candidate.duplicate = true;
        const qualification = emptyProbe("SOURCE_IDENTITY_ALREADY_OWNED");
        candidate.imageQualification = qualification;
        item.status = "duplicate_rejected";
        item.reason = "SOURCE_IDENTITY_ALREADY_OWNED";
        hardRejectCount += 1;
        rejectionCounts.SOURCE_IDENTITY_ALREADY_OWNED = (rejectionCounts.SOURCE_IDENTITY_ALREADY_OWNED || 0) + 1;
        safeShopeeLog("shopee_candidate_image", { correlationId, ...safeShopeeImageDiagnostic({ candidateIndex: candidate.candidateIndex, imagePresent: Boolean(candidate.imageUrl), qualification }) });
        continue;
      }
    } catch {
      const code: ShopeeCommandOutcomeCode = "SHOPEE_PROVIDER_UNAVAILABLE";
      await sendTelegramMessage(chatId, `⚠️ <b>${code}</b>\n\nEstado canônico indisponível; a busca não foi convertida em falta de candidatos.`).catch(() => undefined);
      return { ...emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code, discoveryError: code }), providerQueryExecuted, candidatesReceived, discoveryRounds, poolCandidates: candidates.length };
    }

    const qualification = await qualifyImage(candidate.imageUrl, candidate.name);
    candidate.imageQualification = qualification;
    item.qualificationState = qualification.state;
    item.reason = qualification.reason;
    safeShopeeLog("shopee_candidate_image", {
      correlationId,
      ...safeShopeeImageDiagnostic({ candidateIndex: candidate.candidateIndex, imagePresent: Boolean(candidate.imageUrl), qualification }),
    });
    if (qualification.state === "HARD_REJECT") {
      item.status = "image_hard_reject";
      hardRejectCount += 1;
      rejectionCounts[qualification.reason] = (rejectionCounts[qualification.reason] || 0) + 1;
      continue;
    }
    if (qualification.state === "NEEDS_HUMAN_REVIEW") {
      item.status = "needs_human_review";
      needsHumanReviewCount += 1;
    } else {
      qualifiedCount += 1;
    }
    eligible.push(candidate);
  }

  const ranked = rankShopeeCandidates(eligible);
  const rankingExecuted = ranked.length > 0;
  let accepted = 0;
  let providerFailure: ShopeeProviderRuntimeError | null = null;

  for (let rankIndex = 0; rankIndex < ranked.length && accepted < parsed.count; rankIndex += 1) {
    const candidate = ranked[rankIndex];
    if (rankIndex > 0 && lotPauseMs > 0) await new Promise<void>(resolve => setTimeout(resolve, lotPauseMs));
    const item = items.find(current => current.candidateIndex === candidate.candidateIndex)!;
    item.rank = rankIndex + 1;

    const acquisition = await client.acquireAffiliateLink({ shopId: candidate.shopId, itemId: candidate.itemId });
    if (acquisition.status !== "link_acquired") {
      const infrastructure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
      if (infrastructure) {
        providerFailure = infrastructure;
        item.status = "provider_error";
        item.reason = infrastructure.code;
        break;
      }
      item.status = "affiliate_not_eligible";
      item.reason = `AFFILIATE_${acquisition.status}`;
      hardRejectCount += 1;
      rejectionCounts[item.reason] = (rejectionCounts[item.reason] || 0) + 1;
      if (candidate.imageQualification?.state === "QUALIFIED") qualifiedCount -= 1;
      if (candidate.imageQualification?.state === "NEEDS_HUMAN_REVIEW") needsHumanReviewCount -= 1;
      continue;
    }
    if (
      !acquisition.productLink
      || !acquisition.affiliateUrl
      || acquisition.shopId !== candidate.shopId
      || acquisition.itemId !== candidate.itemId
      || !validateOfficialProductLink(acquisition.productLink, candidate.shopId, candidate.itemId)
    ) {
      item.status = "affiliate_not_eligible";
      item.reason = "AFFILIATE_EVIDENCE_INVALID";
      hardRejectCount += 1;
      rejectionCounts.AFFILIATE_EVIDENCE_INVALID = (rejectionCounts.AFFILIATE_EVIDENCE_INVALID || 0) + 1;
      if (candidate.imageQualification?.state === "QUALIFIED") qualifiedCount -= 1;
      if (candidate.imageQualification?.state === "NEEDS_HUMAN_REVIEW") needsHumanReviewCount -= 1;
      continue;
    }

    const officialPrice = Number(acquisition.price ?? candidate.price);
    if (!Number.isFinite(officialPrice) || officialPrice <= 0) {
      item.status = "affiliate_not_eligible";
      item.reason = "PRICE_UNVERIFIED";
      hardRejectCount += 1;
      rejectionCounts.PRICE_UNVERIFIED = (rejectionCounts.PRICE_UNVERIFIED || 0) + 1;
      if (candidate.imageQualification?.state === "QUALIFIED") qualifiedCount -= 1;
      if (candidate.imageQualification?.state === "NEEDS_HUMAN_REVIEW") needsHumanReviewCount -= 1;
      continue;
    }

    const qualification = candidate.imageQualification!;
    const status = qualification.state as Exclude<ShopeeCandidateVisualState, "HARD_REJECT">;
    const category = candidate.category || resolvePublicProductCategory("", { title: candidate.name });
    if (!category) {
      item.status = "image_hard_reject";
      item.reason = "PUBLIC_CATEGORY_UNRESOLVED";
      hardRejectCount += 1;
      rejectionCounts.PUBLIC_CATEGORY_UNRESOLVED = (rejectionCounts.PUBLIC_CATEGORY_UNRESOLVED || 0) + 1;
      if (status === "QUALIFIED") qualifiedCount -= 1;
      else needsHumanReviewCount -= 1;
      continue;
    }

    const reviewId = buildShopeeReviewId(acquisition.productLink, chatId);
    const imageCuration = buildImageCuration(candidate.imageUrl, qualification);
    const review: PendingReview = {
      id: reviewId,
      chatId,
      senderId: chatId,
      firstName: process.env.USER || "admin",
      username: process.env.USER || "admin",
      produto: candidate.name,
      rawTitle: candidate.name,
      displayTitle: candidate.name,
      categoria: category,
      preco: officialPrice,
      imagens: [candidate.imageUrl],
      imagensOriginais: [candidate.imageUrl],
      imagemPrincipal: candidate.imageUrl,
      imagensGaleria: [],
      imageEditorialStatus: status === "QUALIFIED" ? "clean" : "review_required",
      imageCuration,
      normalizedUrl: acquisition.productLink,
      descricao: "",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + REVIEW_TTL_MS,
      existingProduct: {
        source: "affiliate_preview",
        affiliateUrl: acquisition.affiliateUrl,
        priceScaleVerified: true,
        shopId: acquisition.shopId,
        itemId: acquisition.itemId,
        visualReviewStatus: status,
      },
      promotionEvidence: null,
    };
    try {
      await savePendingReview(review);
    } catch {
      item.status = "review_persist_failed";
      item.reason = "REVIEW_PERSIST_FAILED";
      rejectionCounts.REVIEW_PERSIST_FAILED = (rejectionCounts.REVIEW_PERSIST_FAILED || 0) + 1;
      continue;
    }

    const card = buildShopeeCardText({
      rank: rankIndex + 1,
      name: candidate.name,
      category,
      price: officialPrice,
      shopId: candidate.shopId,
      itemId: candidate.itemId,
      status,
      reviewReason: qualification.reason,
      batchId: lotId,
    });
    const sent = await sendShopeeCard({ chatId, text: card, imageUrl: candidate.imageUrl, reviewId });
    item.reviewId = reviewId;
    item.imageCount = 1;
    if (!sent.ok) {
      item.status = "telegram_send_failed";
      item.reason = sent.reason || "TELEGRAM_SEND_FAILED";
      rejectionCounts[item.reason] = (rejectionCounts[item.reason] || 0) + 1;
      continue;
    }
    item.status = status === "QUALIFIED" ? "ok" : "needs_human_review";
    item.reason = status === "NEEDS_HUMAN_REVIEW" ? qualification.reason : null;
    accepted += 1;
  }

  if (providerFailure) {
    const code = publicProviderCode(providerFailure);
    await sendTelegramMessage(chatId, `⚠️ <b>${code}</b>\n\n${providerMessage(code)} Nenhuma falha de provider foi convertida em ausência de candidatos.`).catch(() => undefined);
    return {
      lotId,
      correlationId,
      chatId,
      countRequested: parsed.count,
      processed: items.length,
      ok: accepted,
      failed: parsed.count - accepted,
      rejectedCandidates: hardRejectCount,
      candidatesExamined: candidates.length,
      candidatesReceived,
      hardRejectCount,
      needsHumanReviewCount,
      qualifiedCount,
      topCandidatesCount: accepted,
      rankingExecuted,
      searchExhausted: sourceExhausted,
      poolLocalExhausted: accepted < parsed.count,
      sourceExhausted,
      budgetExhausted,
      discoveryRounds,
      poolCandidates: candidates.length,
      discoveryError: code,
      errorCode: code,
      providerQueryExecuted,
      rejectionCounts,
      items,
      chatTargetConfigured,
      affiliateClientAvailable,
    };
  }

  const errorCode: ShopeeCommandOutcomeCode | null = accepted < parsed.count ? "SHOPEE_CANDIDATES_REJECTED" : null;
  const reasons = Object.entries(rejectionCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ") || "nenhuma";
  const finalTitle = errorCode ? "⚠️ <b>SHOPEE_CANDIDATES_REJECTED</b>" : "🏁 <b>LOTE SHOPEE RANQUEADO</b>";
  await sendTelegramMessage(
    chatId,
    `${finalTitle}\n\nCandidatos oficiais recebidos: <b>${candidatesReceived}</b>\nHard reject: <b>${hardRejectCount}</b>\nNeeds human review: <b>${needsHumanReviewCount}</b>\nQualificados: <b>${qualifiedCount}</b>\nCards enviados: <b>${accepted}</b>\nMotivos principais: <code>${reasons}</code>${accepted < parsed.count ? "\n\nA Shopee retornou resultados, mas não houve candidatos utilizáveis suficientes após qualificação/ranking. Isso não é ausência de catálogo." : ""}`,
  ).catch(() => undefined);

  safeShopeeLog("shopee_command_complete", {
    correlationId,
    requested: parsed.count,
    provider: "ShopeeApiClient",
    providerQueryExecuted,
    candidatesReceived,
    candidatesExamined: candidates.length,
    hardRejectCount,
    needsHumanReviewCount,
    qualifiedCount,
    topCandidatesCount: accepted,
    rankingExecuted,
    errorCode,
  });

  return {
    lotId,
    correlationId,
    chatId,
    countRequested: parsed.count,
    processed: items.length,
    ok: accepted,
    failed: parsed.count - accepted,
    rejectedCandidates: hardRejectCount,
    candidatesExamined: candidates.length,
    candidatesReceived,
    hardRejectCount,
    needsHumanReviewCount,
    qualifiedCount,
    topCandidatesCount: accepted,
    rankingExecuted,
    searchExhausted: sourceExhausted,
    poolLocalExhausted: accepted < parsed.count,
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
