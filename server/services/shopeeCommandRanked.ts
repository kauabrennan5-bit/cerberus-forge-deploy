/**
 * Manual /shopee discovery and human-review flow.
 * DDG only discovers candidate identities. Identity, availability, title,
 * price, productLink, affiliateUrl and primary image are replaced by evidence
 * from exact Shopee Affiliate API lookups before a candidate can be accepted.
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
  mapShopeeErrorKindToProviderCode,
  providerErrorFromAcquisitionStatus,
  safeShopeeLog,
  ShopeeProviderRuntimeError,
  type ShopeeProviderErrorCode,
  validateOfficialProductLink,
} from "./shopeeProviderRuntime";
import {
  evaluateShopeeCandidateRelevance,
  qualifyOfficialShopeeImage,
  rankShopeeCandidates,
  safeShopeeImageDiagnostic,
  type ShopeeCandidateVisualState,
  type ShopeeImageQualification,
  type ShopeeRankableCandidate,
} from "./shopeeCandidateQualification";
import { discoverShopeeProducts } from "./shopeeDiscovery";
import type { ShopeeSearchState } from "./shopeeSearchProvider";

const MIN_ITEMS = 1;
const MAX_ITEMS = 10;
const MAX_DISCOVERY_CANDIDATES = 30;
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

export function ddgDiscoveryUnavailableMessage(state: Exclude<ShopeeSearchState, "DDG_OK">): string {
  const detail = state === "DDG_BLOCKED"
    ? "O DuckDuckGo bloqueou temporariamente a consulta."
    : state === "DDG_NO_RESULTS"
      ? "O DuckDuckGo não retornou candidatos para este termo."
      : "O DuckDuckGo está indisponível neste momento.";
  return [
    `⚠️ <b>${state}</b>`,
    "",
    `${detail} A descoberta automática por termo não está disponível agora.`,
    "Envie links diretos da Shopee pelo modo <code>urls</code> já suportado:",
    "<code>/shopee https://shopee.com.br/product/SHOP_ID/ITEM_ID 1</code>",
  ].join("\n");
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
  | "SHOPEE_CANDIDATES_REJECTED"
  | Exclude<ShopeeSearchState, "DDG_OK">;

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
  discoverySource: "duckduckgo" | "direct_urls" | null;
  candidatesDiscoveredViaDdg: number;
  candidatesValidatedByAffiliateApi: number;
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
    discoverySource: null,
    candidatesDiscoveredViaDdg: 0,
    candidatesValidatedByAffiliateApi: 0,
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
  affiliateUrl: string | null;
};

export interface OfficialDdgCandidate {
  candidateIndex: number;
  shopId: string;
  itemId: string;
  name: string;
  price: number;
  productLink: string;
  affiliateUrl: string;
  imageUrl: string;
}

export interface OfficialDdgCandidateRejection {
  candidateIndex: number;
  shopId: string;
  itemId: string;
  reason: string;
}

export interface OfficialDdgDiscoveryResult {
  state: ShopeeSearchState;
  discovered: number;
  validated: number;
  candidates: OfficialDdgCandidate[];
  rejections: OfficialDdgCandidateRejection[];
  officialLookupExecuted: boolean;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function lookupProviderFailure(errorKind: string | null | undefined): ShopeeProviderRuntimeError {
  const code = mapShopeeErrorKindToProviderCode(errorKind);
  return new ShopeeProviderRuntimeError(
    code,
    errorKind || "official_lookup_failed",
    ["SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(code),
  );
}

class OfficialCandidateValidationError extends ShopeeProviderRuntimeError {
  constructor(
    failure: ShopeeProviderRuntimeError,
    readonly discovered: number,
    readonly validated: number,
  ) {
    super(failure.code, failure.providerReason, failure.transient);
    this.name = "OfficialCandidateValidationError";
  }
}

function officialValidationFailure(
  errorKind: string | null | undefined,
  discovered: number,
  validated: number,
): OfficialCandidateValidationError {
  return new OfficialCandidateValidationError(lookupProviderFailure(errorKind), discovered, validated);
}

/**
 * DDG supplies only identity candidates. Every unique candidate is confirmed
 * by exact productOfferV2(shopId,itemId) lookup and exact affiliate acquisition
 * before any web metadata may enter ranking or review state.
 */
export async function discoverOfficialDdgCandidates(params: {
  client: ShopeeApiClient;
  query: string;
  limit?: number;
  correlationId?: string;
}): Promise<OfficialDdgDiscoveryResult> {
  let discovery: Awaited<ReturnType<typeof discoverShopeeProducts>>;
  try {
    discovery = await discoverShopeeProducts(params.query, params.limit ?? MAX_DISCOVERY_CANDIDATES);
  } catch {
    return { state: "DDG_UNAVAILABLE", discovered: 0, validated: 0, candidates: [], rejections: [], officialLookupExecuted: false };
  }
  if (discovery.state !== "DDG_OK") {
    return { state: discovery.state, discovered: 0, validated: 0, candidates: [], rejections: [], officialLookupExecuted: false };
  }

  const unique = Array.from(
    new Map(discovery.products.map(candidate => [`${candidate.shopId}:${candidate.itemId}`, candidate])).values(),
  ).slice(0, params.limit ?? MAX_DISCOVERY_CANDIDATES);
  const candidates: OfficialDdgCandidate[] = [];
  const rejections: OfficialDdgCandidateRejection[] = [];

  for (let index = 0; index < unique.length; index += 1) {
    const candidate = unique[index];
    const candidateIndex = index + 1;
    safeShopeeLog("shopee_candidate_discovered", {
      correlationId: params.correlationId,
      candidateIndex,
      discoveryProvider: "duckduckgo",
      identityStatus: "candidate_only",
    });

    let lookup: Awaited<ReturnType<ShopeeApiClient["lookupProduct"]>>;
    try {
      lookup = await params.client.lookupProduct({ shopId: candidate.shopId, itemId: candidate.itemId });
    } catch {
      throw officialValidationFailure("SHOPEE_UNKNOWN_ERROR", unique.length, candidates.length);
    }
    if (lookup.status === "error") {
      throw officialValidationFailure(lookup.error?.kind, unique.length, candidates.length);
    }
    if (
      lookup.status !== "found"
      || lookup.shopId !== candidate.shopId
      || lookup.itemId !== candidate.itemId
    ) {
      rejections.push({ candidateIndex, shopId: candidate.shopId, itemId: candidate.itemId, reason: "OFFICIAL_IDENTITY_NOT_CONFIRMED" });
      continue;
    }
    if (!validateOfficialProductLink(lookup.productLink, candidate.shopId, candidate.itemId)) {
      rejections.push({ candidateIndex, shopId: candidate.shopId, itemId: candidate.itemId, reason: "OFFICIAL_PRODUCT_LINK_INVALID" });
      continue;
    }

    let acquisition: Awaited<ReturnType<ShopeeApiClient["acquireAffiliateLink"]>>;
    try {
      acquisition = await params.client.acquireAffiliateLink({ shopId: candidate.shopId, itemId: candidate.itemId });
    } catch {
      throw officialValidationFailure("SHOPEE_UNKNOWN_ERROR", unique.length, candidates.length);
    }
    if (acquisition.status !== "link_acquired") {
      const infrastructure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
      if (infrastructure) {
        throw new OfficialCandidateValidationError(infrastructure, unique.length, candidates.length);
      }
      rejections.push({
        candidateIndex,
        shopId: candidate.shopId,
        itemId: candidate.itemId,
        reason: `AFFILIATE_${acquisition.status}`,
      });
      continue;
    }

    const name = normalizeOfficialTitle(acquisition.name || lookup.name || "");
    const price = Number(acquisition.price ?? lookup.priceMinorUnits);
    const productLink = String(acquisition.productLink || "").trim();
    const affiliateUrl = String(acquisition.affiliateUrl || "").trim();
    const imageUrl = String(acquisition.imageUrl || lookup.imageUrl || "").trim();
    const invalidEvidenceReason = acquisition.shopId !== candidate.shopId || acquisition.itemId !== candidate.itemId
      ? "OFFICIAL_IDENTITY_NOT_CONFIRMED"
      : !name
        ? "TITLE_MISSING"
        : !Number.isFinite(price) || price <= 0
          ? "PRICE_MISSING"
          : !validateOfficialProductLink(productLink, candidate.shopId, candidate.itemId)
            ? "OFFICIAL_PRODUCT_LINK_INVALID"
            : !isHttpsUrl(affiliateUrl)
              ? "AFFILIATE_EVIDENCE_INVALID"
              : null;
    if (invalidEvidenceReason) {
      rejections.push({ candidateIndex, shopId: candidate.shopId, itemId: candidate.itemId, reason: invalidEvidenceReason });
      continue;
    }

    candidates.push({
      candidateIndex,
      shopId: candidate.shopId,
      itemId: candidate.itemId,
      name,
      price,
      productLink,
      affiliateUrl,
      imageUrl: isHttpsUrl(imageUrl) ? imageUrl : "",
    });
    safeShopeeLog("shopee_candidate_officially_validated", {
      correlationId: params.correlationId,
      candidateIndex,
      validationProvider: "shopee_affiliate_api",
      sourceOperation: "productOfferV2_exact",
      identityStatus: "confirmed",
      imageOfficial: isHttpsUrl(imageUrl),
    });
  }

  return {
    state: candidates.length > 0 || rejections.length > 0 ? "DDG_OK" : "DDG_NO_RESULTS",
    discovered: unique.length,
    validated: candidates.length,
    candidates,
    rejections,
    officialLookupExecuted: unique.length > 0,
  };
}

async function discoverTermCandidates(params: {
  client: ShopeeApiClient;
  query: string;
  rejectionCounts: Record<string, number>;
  correlationId: string;
}): Promise<{
  candidates: WorkingCandidate[];
  received: number;
  calls: number;
  sourceExhausted: boolean;
  state: ShopeeSearchState;
  validated: number;
  officialLookupExecuted: boolean;
}> {
  const discovered = await discoverOfficialDdgCandidates({
    client: params.client,
    query: params.query,
    limit: MAX_DISCOVERY_CANDIDATES,
    correlationId: params.correlationId,
  });
  const candidates: WorkingCandidate[] = discovered.candidates.map((official) => {
    const relevance = evaluateShopeeCandidateRelevance(params.query, official.name);
    return {
      ...official,
      round: 1,
      queryVariant: "ddg",
      category: relevance.category,
      relevanceScore: relevance.score,
      preRejectReason: !official.imageUrl ? "IMAGE_MISSING" : !relevance.compatible ? relevance.reason : null,
      duplicate: false,
    };
  });
  for (const rejected of discovered.rejections) {
    candidates.push({
      candidateIndex: rejected.candidateIndex,
      shopId: rejected.shopId,
      itemId: rejected.itemId,
      name: "",
      price: 0,
      productLink: "",
      affiliateUrl: null,
      imageUrl: "",
      round: 1,
      queryVariant: "ddg",
      category: "",
      relevanceScore: 0,
      preRejectReason: rejected.reason,
      duplicate: false,
    });
  }
  candidates.sort((left, right) => left.candidateIndex - right.candidateIndex);
  return {
    candidates,
    received: discovered.discovered,
    calls: discovered.state === "DDG_OK" ? 1 : 0,
    sourceExhausted: true,
    state: discovered.state,
    validated: discovered.validated,
    officialLookupExecuted: discovered.officialLookupExecuted,
  };
}

async function discoverDirectCandidates(params: {
  client: ShopeeApiClient;
  urls: string[];
}): Promise<{ candidates: WorkingCandidate[]; received: number; validated: number; officialLookupExecuted: boolean }> {
  const candidates: WorkingCandidate[] = [];
  const seen = new Set<string>();
  let validated = 0;
  let officialLookupExecuted = false;
  for (const original of params.urls) {
    const resolved = await resolveShortUrlIfNeeded(original);
    const supplied = resolved.resolvedUrl;
    const identity = extractShopeeIdentity(supplied);
    if (!identity.shopId || !identity.itemId || !validateOfficialProductLink(supplied, identity.shopId, identity.itemId)) {
      candidates.push({ candidateIndex: candidates.length + 1, shopId: identity.shopId || "", itemId: identity.itemId || "", name: "", price: 0, productLink: supplied, affiliateUrl: null, imageUrl: "", round: 0, queryVariant: "direct", category: "", relevanceScore: 100, preRejectReason: "DIRECT_URL_IDENTITY_INVALID", duplicate: false });
      continue;
    }
    const key = `${identity.shopId}:${identity.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    officialLookupExecuted = true;
    const lookup = await params.client.lookupProduct({ shopId: identity.shopId, itemId: identity.itemId });
    if (lookup.status !== "found" || !lookup.productLink || !lookup.name || !lookup.priceMinorUnits || !validateOfficialProductLink(lookup.productLink, identity.shopId, identity.itemId)) {
      candidates.push({ candidateIndex: candidates.length + 1, shopId: identity.shopId, itemId: identity.itemId, name: normalizeOfficialTitle(lookup.name || ""), price: Number(lookup.priceMinorUnits || 0), productLink: lookup.productLink || supplied, affiliateUrl: null, imageUrl: "", round: 0, queryVariant: "direct", category: resolvePublicProductCategory("", { title: lookup.name || "" }), relevanceScore: 100, preRejectReason: "DIRECT_LOOKUP_INCOMPLETE", duplicate: false });
      continue;
    }
    validated += 1;
    let imageUrl = String(lookup.imageUrl || "").trim();
    if (!imageUrl) {
      const extracted = await extractProductForReview(lookup.productLink);
      imageUrl = extracted.success && extracted.data?.imagemPrincipal ? extracted.data.imagemPrincipal : "";
    }
    candidates.push({
      candidateIndex: candidates.length + 1,
      shopId: identity.shopId,
      itemId: identity.itemId,
      name: normalizeOfficialTitle(lookup.name),
      price: Number(lookup.priceMinorUnits),
      productLink: lookup.productLink,
      affiliateUrl: null,
      imageUrl,
      round: 0,
      queryVariant: "direct",
      category: resolvePublicProductCategory("", { title: lookup.name }),
      relevanceScore: 100,
      preRejectReason: imageUrl ? null : "IMAGE_MISSING",
      duplicate: false,
    });
  }
  return { candidates, received: candidates.length, validated, officialLookupExecuted };
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
  let discoverySource: ShopeeLotResult["discoverySource"] = null;
  let candidatesDiscoveredViaDdg = 0;
  let candidatesValidatedByAffiliateApi = 0;
  let ddgState: ShopeeSearchState = "DDG_OK";
  let candidates: WorkingCandidate[] = [];

  try {
    if ((parsed.mode || "term") === "term") {
      discoverySource = "duckduckgo";
      const discovered = await discoverTermCandidates({ client, query: parsed.query, rejectionCounts, correlationId });
      candidates = discovered.candidates;
      candidatesReceived = discovered.received;
      discoveryRounds = discovered.calls;
      sourceExhausted = discovered.sourceExhausted;
      budgetExhausted = false;
      ddgState = discovered.state;
      providerQueryExecuted = discovered.officialLookupExecuted;
      candidatesDiscoveredViaDdg = discovered.received;
      candidatesValidatedByAffiliateApi = discovered.validated;
    } else {
      discoverySource = "direct_urls";
      const discovered = await discoverDirectCandidates({ client, urls: parsed.urls || [] });
      candidates = discovered.candidates;
      candidatesReceived = discovered.received;
      candidatesValidatedByAffiliateApi = discovered.validated;
      providerQueryExecuted = discovered.officialLookupExecuted;
      sourceExhausted = true;
    }
  } catch (error) {
    if (error instanceof OfficialCandidateValidationError) {
      providerQueryExecuted = true;
      discoveryRounds = 1;
      candidatesDiscoveredViaDdg = error.discovered;
      candidatesValidatedByAffiliateApi = error.validated;
      candidatesReceived = error.discovered;
    }
    const providerFailure = error instanceof ShopeeProviderRuntimeError
      ? error
      : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "unexpected_search_failure", true);
    const code = publicProviderCode(providerFailure);
    await sendTelegramMessage(chatId, `⚠️ <b>${code}</b>\n\n${providerMessage(code)}`).catch(() => undefined);
    const base = emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code, discoveryError: code });
    return {
      ...base,
      providerQueryExecuted,
      discoveryRounds,
      candidatesReceived,
      poolCandidates: candidates.length,
      sourceExhausted,
      budgetExhausted,
      discoverySource,
      candidatesDiscoveredViaDdg,
      candidatesValidatedByAffiliateApi,
    };
  }

  if ((parsed.mode || "term") === "term" && ddgState !== "DDG_OK") {
    const code = ddgState as Exclude<ShopeeSearchState, "DDG_OK">;
    await sendTelegramMessage(chatId, ddgDiscoveryUnavailableMessage(code)).catch(() => undefined);
    return {
      ...emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code, discoveryError: code }),
      providerQueryExecuted,
      discoveryRounds,
      candidatesReceived,
      poolCandidates: candidates.length,
      sourceExhausted,
      budgetExhausted,
      discoverySource,
      candidatesDiscoveredViaDdg,
      candidatesValidatedByAffiliateApi,
    };
  }

  const startDiscoverySummary = discoverySource === "duckduckgo"
    ? `Descobertos via DDG: <b>${candidatesDiscoveredViaDdg}</b>\nValidados pela Shopee Affiliate API: <b>${candidatesValidatedByAffiliateApi}</b>`
    : `URLs diretas avaliadas: <b>${candidatesReceived}</b>\nIdentidades validadas pela Shopee Affiliate API: <b>${candidatesValidatedByAffiliateApi}</b>`;
  const startDiscoveryNote = discoverySource === "duckduckgo"
    ? "DDG apenas sugere identidades. Dados e links usados no card vêm da validação oficial exata."
    : "O modo urls foi preservado; dados e link final continuam vindo da API oficial.";
  await sendTelegramMessage(
    chatId,
    `🛒 <b>LOTE SHOPEE INICIADO</b>\n\nSolicitados: <b>${parsed.count}</b>\n${startDiscoverySummary}\nPool único para qualificação: <b>${candidates.length}</b>\n\n<i>${startDiscoveryNote}</i>`,
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
      return {
        ...emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code, discoveryError: code }),
        providerQueryExecuted,
        candidatesReceived,
        discoveryRounds,
        poolCandidates: candidates.length,
        discoverySource,
        candidatesDiscoveredViaDdg,
        candidatesValidatedByAffiliateApi,
      };
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

    let officialProductLink = candidate.productLink;
    let officialAffiliateUrl = candidate.affiliateUrl;
    let officialName = candidate.name;
    let officialPrice = Number(candidate.price);
    let officialImageUrl = candidate.imageUrl;

    // Term-mode candidates already passed exact lookup + acquisition. URL mode
    // keeps its established path and acquires the official affiliate link here.
    if (!officialAffiliateUrl) {
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
      officialProductLink = String(acquisition.productLink || "").trim();
      officialAffiliateUrl = String(acquisition.affiliateUrl || "").trim();
      officialName = normalizeOfficialTitle(acquisition.name || candidate.name);
      officialPrice = Number(acquisition.price ?? candidate.price);
      officialImageUrl = String(acquisition.imageUrl || candidate.imageUrl || "").trim();
      if (
        acquisition.shopId !== candidate.shopId
        || acquisition.itemId !== candidate.itemId
        || !validateOfficialProductLink(officialProductLink, candidate.shopId, candidate.itemId)
        || !isHttpsUrl(officialAffiliateUrl)
      ) {
        item.status = "affiliate_not_eligible";
        item.reason = "AFFILIATE_EVIDENCE_INVALID";
        hardRejectCount += 1;
        rejectionCounts.AFFILIATE_EVIDENCE_INVALID = (rejectionCounts.AFFILIATE_EVIDENCE_INVALID || 0) + 1;
        if (candidate.imageQualification?.state === "QUALIFIED") qualifiedCount -= 1;
        if (candidate.imageQualification?.state === "NEEDS_HUMAN_REVIEW") needsHumanReviewCount -= 1;
        continue;
      }
    }

    if (
      !validateOfficialProductLink(officialProductLink, candidate.shopId, candidate.itemId)
      || !isHttpsUrl(officialAffiliateUrl)
      || !officialName
    ) {
      item.status = "affiliate_not_eligible";
      item.reason = "AFFILIATE_EVIDENCE_INVALID";
      hardRejectCount += 1;
      rejectionCounts.AFFILIATE_EVIDENCE_INVALID = (rejectionCounts.AFFILIATE_EVIDENCE_INVALID || 0) + 1;
      if (candidate.imageQualification?.state === "QUALIFIED") qualifiedCount -= 1;
      if (candidate.imageQualification?.state === "NEEDS_HUMAN_REVIEW") needsHumanReviewCount -= 1;
      continue;
    }

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
    const category = candidate.category || resolvePublicProductCategory("", { title: officialName });
    if (!category) {
      item.status = "image_hard_reject";
      item.reason = "PUBLIC_CATEGORY_UNRESOLVED";
      hardRejectCount += 1;
      rejectionCounts.PUBLIC_CATEGORY_UNRESOLVED = (rejectionCounts.PUBLIC_CATEGORY_UNRESOLVED || 0) + 1;
      if (status === "QUALIFIED") qualifiedCount -= 1;
      else needsHumanReviewCount -= 1;
      continue;
    }

    const reviewId = buildShopeeReviewId(officialProductLink, chatId);
    const imageCuration = buildImageCuration(officialImageUrl, qualification);
    const review: PendingReview = {
      id: reviewId,
      chatId,
      senderId: chatId,
      firstName: process.env.USER || "admin",
      username: process.env.USER || "admin",
      produto: officialName,
      rawTitle: officialName,
      displayTitle: officialName,
      categoria: category,
      preco: officialPrice,
      imagens: [officialImageUrl],
      imagensOriginais: [officialImageUrl],
      imagemPrincipal: officialImageUrl,
      imagensGaleria: [],
      imageEditorialStatus: status === "QUALIFIED" ? "clean" : "review_required",
      imageCuration,
      normalizedUrl: officialProductLink,
      descricao: "",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + REVIEW_TTL_MS,
      existingProduct: {
        source: "affiliate_preview",
        affiliateUrl: officialAffiliateUrl,
        priceScaleVerified: true,
        shopId: candidate.shopId,
        itemId: candidate.itemId,
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
      name: officialName,
      category,
      price: officialPrice,
      shopId: candidate.shopId,
      itemId: candidate.itemId,
      status,
      reviewReason: qualification.reason,
      batchId: lotId,
    });
    const sent = await sendShopeeCard({ chatId, text: card, imageUrl: officialImageUrl, reviewId });
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
      discoverySource,
      candidatesDiscoveredViaDdg,
      candidatesValidatedByAffiliateApi,
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
  const finalDiscoverySummary = discoverySource === "duckduckgo"
    ? `Descobertos via DDG: <b>${candidatesDiscoveredViaDdg}</b>`
    : `URLs diretas avaliadas: <b>${candidatesReceived}</b>`;
  await sendTelegramMessage(
    chatId,
    `${finalTitle}\n\n${finalDiscoverySummary}\nValidados pela Shopee Affiliate API: <b>${candidatesValidatedByAffiliateApi}</b>\nHard reject: <b>${hardRejectCount}</b>\nNeeds human review: <b>${needsHumanReviewCount}</b>\nQualificados: <b>${qualifiedCount}</b>\nCards enviados: <b>${accepted}</b>\nMotivos principais: <code>${reasons}</code>${accepted < parsed.count ? "\n\nHouve candidatos, mas não houve opções utilizáveis suficientes após validação oficial e qualificação." : ""}`,
  ).catch(() => undefined);

  safeShopeeLog("shopee_command_complete", {
    correlationId,
    requested: parsed.count,
    provider: "ShopeeApiClient",
    providerQueryExecuted,
    discoverySource,
    candidatesDiscoveredViaDdg,
    candidatesValidatedByAffiliateApi,
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
    discoverySource,
    candidatesDiscoveredViaDdg,
    candidatesValidatedByAffiliateApi,
    rejectionCounts,
    items,
    chatTargetConfigured,
    affiliateClientAvailable,
  };
}
