import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { generateSlug } from "../../src/data/initialProducts";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import { extractProductForReview } from "./productAutomation";
import { createProductionProductPipeline, type LifecycleRecord } from "./productPipeline";
import { syncCatalogAndDeploy } from "./catalogSync";
import { sendTelegramMessage } from "./telegramBot";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageCurationFingerprint,
} from "./productEditorialReview";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  type AutonomousCuratorCategoryProfile,
} from "./autonomousCuratorProfiles";
import {
  assertCategoryPublicationAllowed as assertCategoryGrowthPublicationAllowed,
  calculateCategoryPolicy,
} from "./autonomousCuratorCategoryPolicy";
import {
  cheapProfileScore,
  hasBlockedProfileTerm,
  scoreAutonomousCandidate,
  type AutonomousCuratorScoreBreakdown,
} from "./autonomousCuratorScoring";
import {
  expandAutonomousCuratorQueries,
  rankAutonomousCuratorCandidates,
  type SemanticDiscoveryCandidate,
  type SemanticDiscoveryDecision,
} from "./autonomousCuratorSemanticDiscovery";

const QUEUE_CREATED_BY = "autonomous_curator_queue";
const QUEUE_NOTE_PREFIX = "AUTONOMOUS_CURATOR_QUEUE_V1:";
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_MAX_PAGE = 10;
const MAX_CYCLE_HISTORY = 48;
const QUALIFIED_COMPARISON_TARGET = 4;
const DEFAULT_LIVE_CATALOG_TARGET = 10;
const REVIEW_RECOVERY_PREFIX = "REVIEW_RECOVERY_PENDING:";

type QueueMetadata = {
  score: number;
  profileVersion: string;
  queuedAt: string;
  publishedAt?: string | null;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  imageUrl?: string | null;
};

type CuratedCandidate = {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  affiliateUrl: string;
  sourceImageUrl: string | null;
  rawTitle: string;
  displayTitle: string;
  description: string;
  category: PublicProductCategory;
  price: number;
  images: string[];
  imageCuration: NonNullable<Product["imageCuration"]>;
  score: number;
  breakdown: AutonomousCuratorScoreBreakdown;
  lifecycle: LifecycleRecord;
};

type RecoverySeed = {
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  rawTitle: string;
  price: number | null;
  imageUrl: string | null;
  reason: string;
};

type DiscoveryMetrics = {
  queriesExecuted: number;
  candidatesDiscovered: number;
  candidatesExamined: number;
  candidatesEnriched: number;
  candidatesRejected: number;
  technicalFailures: number;
};

type DiscoveryResult = {
  candidate: CuratedCandidate | null;
  reason: string;
  examined: number;
  searchedPages: number[];
  recoverySeed: RecoverySeed | null;
  metrics: DiscoveryMetrics;
};

export type ContinuousCuratorCategoryResultV2 = {
  category: PublicProductCategory;
  due: boolean;
  published: boolean;
  queued: boolean;
  score: number | null;
  title: string | null;
  reason: string;
  productId: string | null;
  searchedPages: number[];
};

export type ContinuousCuratorResultV2 = {
  cycleId: string;
  cycleNumber: number;
  runId: string;
  runDate: string;
  status: "completed" | "partial" | "failed" | "disabled";
  publishedThisCycle: number;
  fulfilledCategories: number;
  queuedProducts: number;
  failedThisCycle: number;
  categories: ContinuousCuratorCategoryResultV2[];
};

type ContinuousOptions = {
  cycleId?: string;
  now?: Date;
  notify?: boolean;
  env?: NodeJS.ProcessEnv;
  shopeeClient?: ShopeeApiClient;
  extractor?: typeof extractProductForReview;
};

type CycleMetrics = {
  attemptedCategories: number;
  attemptedCategoryNames: PublicProductCategory[];
  queriesExecuted: number;
  candidatesDiscovered: number;
  candidatesExamined: number;
  candidatesEnriched: number;
  candidatesRejected: number;
  publicationAttempts: number;
  archivedAfterPublication: number;
  technicalFailures: number;
};

function localRunDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(item => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function canonicalSourceUrl(shopId: string, itemId: string): string {
  return `https://shopee.com.br/product/${shopId}/${itemId}`;
}

function sourceIdentityMatches(url: string, shopId: string, itemId: string): boolean {
  const identity = extractShopeeIdentity(url);
  return identity.shopId === shopId && identity.itemId === itemId;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function queueTarget(env: NodeJS.ProcessEnv): number {
  return positiveInt(env.AUTONOMOUS_CURATOR_QUEUE_TARGET_PER_CATEGORY, 7, 30);
}

function liveCatalogTarget(env: NodeJS.ProcessEnv): number {
  return positiveInt(env.AUTONOMOUS_CURATOR_LIVE_CATALOG_TARGET, DEFAULT_LIVE_CATALOG_TARGET, 100);
}

function dailyTargetFromEnv(env: NodeJS.ProcessEnv): number | null {
  const parsed = Number.parseInt(String(env.AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function recoveryModeFromEnv(env: NodeJS.ProcessEnv): boolean {
  return String(env.AUTONOMOUS_CURATOR_RECOVERY_MODE || "").trim().toLowerCase() === "true";
}

function deficitCategoryScope(env: NodeJS.ProcessEnv): Set<PublicProductCategory> {
  const requested = String(env.AUTONOMOUS_CURATOR_DEFICIT_CATEGORIES || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return new Set(
    AUTONOMOUS_CURATOR_PROFILES
      .map(profile => profile.category)
      .filter(category => requested.includes(category)),
  );
}

function activePublishedCount(products: readonly Product[]): number {
  return products.filter(product => product.status === "published" && product.ativo !== false).length;
}

function inventoryDeficit(products: readonly Product[], env: NodeJS.ProcessEnv): number {
  return Math.max(0, liveCatalogTarget(env) - activePublishedCount(products));
}

function dueForCycle(lastPublishedAt: string | null, now: Date, emergencyMode: boolean, emergencyRemaining: number): boolean {
  if (emergencyMode) return emergencyRemaining > 0;
  return dueForPublication(lastPublishedAt, now);
}

function queueNote(meta: QueueMetadata): string {
  return `${QUEUE_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

function parseQueueNote(value: unknown): QueueMetadata | null {
  const text = String(value || "");
  if (!text.startsWith(QUEUE_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(QUEUE_NOTE_PREFIX.length)) as Partial<QueueMetadata>;
    if (!Number.isFinite(Number(parsed.score)) || !parsed.shopId || !parsed.itemId || !parsed.sourceProductUrl || !parsed.queuedAt || !parsed.query) return null;
    return {
      score: Number(parsed.score),
      profileVersion: String(parsed.profileVersion || "unknown"),
      queuedAt: String(parsed.queuedAt),
      publishedAt: parsed.publishedAt ? String(parsed.publishedAt) : null,
      query: String(parsed.query),
      shopId: String(parsed.shopId),
      itemId: String(parsed.itemId),
      sourceProductUrl: String(parsed.sourceProductUrl),
      imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl : null,
    };
  } catch {
    return null;
  }
}

function dueForPublication(lastPublishedAt: string | null, now: Date): boolean {
  if (!lastPublishedAt) return true;
  const timestamp = Date.parse(lastPublishedAt);
  return !Number.isFinite(timestamp) || now.getTime() - timestamp >= DAY_MS;
}

function discoveryPage(cycleNumber: number, category: string, queryIndex: number): number {
  let hash = 0;
  for (const char of category) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return 1 + ((Math.max(1, cycleNumber) - 1 + queryIndex + (hash % SEARCH_MAX_PAGE)) % SEARCH_MAX_PAGE);
}

function discoveryPages(cycleNumber: number, _category: string, _queryIndex: number): number[] {
  const depth = Math.min(SEARCH_MAX_PAGE, Math.max(1, Math.floor(cycleNumber)));
  return Array.from({ length: depth }, (_, index) => index + 1);
}

function rotateQueries(profile: AutonomousCuratorCategoryProfile, cycleNumber: number): string[] {
  if (profile.queries.length <= 1) return [...profile.queries];
  const start = (Math.max(1, cycleNumber) - 1) % profile.queries.length;
  return [...profile.queries.slice(start), ...profile.queries.slice(0, start)];
}

function trustedEvidenceOverride(name: string, imageUrl: string | null): string {
  const product: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: String(name || "").replace(/\s+/g, " ").trim().slice(0, 300),
  };
  if (imageUrl && /^https:\/\//i.test(imageUrl)) product.image = [imageUrl];
  return `<script type="application/ld+json">${JSON.stringify(product).replace(/</g, "\\u003c")}</script>`;
}

function similarityUniverse(products: readonly Product[]): Product[] {
  return products.filter(product =>
    (product.status === "published" && product.ativo !== false)
    || (product.createdBy === QUEUE_CREATED_BY && product.status === "paused" && product.ativo === false),
  );
}

function isTechnicalReviewFailure(reason: string): boolean {
  const upper = String(reason || "").toUpperCase();
  return [
    "IMAGE_REVIEW_UNAVAILABLE",
    "IMAGE_REVIEW_BUDGET_EXHAUSTED",
    "IMAGE_REVIEW_MODEL_UNAVAILABLE",
    "IMAGE_FETCH_UNAVAILABLE",
    "OPENAI_RATE_LIMITED",
    "OPENAI_QUOTA_EXHAUSTED",
    "OPENAI_AUTH_ERROR",
    "OPENAI_MODEL_UNAVAILABLE",
    "OPENAI_TIMEOUT",
    "OPENAI_PROVIDER_UNAVAILABLE",
    "GEMINI",
    "RESOURCE_EXHAUSTED",
    "RATE_LIMIT",
    "TIMEOUT",
  ].some(marker => upper.includes(marker));
}

function reviewRecoveryReason(reason: string): string {
  return reason.startsWith(REVIEW_RECOVERY_PREFIX) ? reason : `${REVIEW_RECOVERY_PREFIX}${reason}`;
}

function revalidationPermanentFailure(reason: string): boolean {
  const upper = reason.toUpperCase();
  if (upper.includes("REVIEW_RECOVERY_PENDING")) return false;
  return ![
    "TIMEOUT", "RATE_LIMIT", "NETWORK", "TRANSIENT", "UNAVAILABLE", "MODEL_UNAVAILABLE",
    "IMAGE_FETCH_UNAVAILABLE", "AUTH_ERROR", "FORBIDDEN", "SHOPEE_SEARCH",
  ].some(marker => upper.includes(marker));
}

function safeFailureScalar(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^a-zA-Z0-9À-ÿ _.:/()=\-]/g, "?")
    .slice(0, maxLength);
}

function safeCategoryFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const message = safeFailureScalar(error.message, 150);
    return message || "CONTINUOUS_CATEGORY_FAILED";
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = safeFailureScalar(record.code, 36);
    const message = safeFailureScalar(record.message, 100);
    const detail = [code && `code=${code}`, message && `message=${message}`].filter(Boolean).join("|");
    return detail ? `CONTINUOUS_CATEGORY_FAILED:${detail}`.slice(0, 160) : "CONTINUOUS_CATEGORY_FAILED";
  }
  return "CONTINUOUS_CATEGORY_FAILED";
}

function buildShopeeClient(env: NodeJS.ProcessEnv): ShopeeApiClient | null {
  const appId = String(env.SHOPEE_APP_ID || env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = String(env.SHOPEE_APP_SECRET || env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  if (!appId || !secret) return null;
  return createShopeeApiClient({ appId, secret, baseUrl: env.SHOPEE_AFFILIATE_API_BASE_URL });
}

async function assertFreshCategoryPublicationAllowed(category: PublicProductCategory, env: NodeJS.ProcessEnv): Promise<void> {
  const dailyTarget = dailyTargetFromEnv(env);
  if (!dailyTarget) return;
  const freshProducts = await productsRepository.getProducts();
  const policy = calculateCategoryPolicy(freshProducts, dailyTarget);
  assertCategoryGrowthPublicationAllowed({
    category,
    counts: policy.categoryCounts,
    dailyTargetPerCategory: dailyTarget,
    mode: "growth",
  });
}

async function categoryStillNeedsRecovery(category: PublicProductCategory, env: NodeJS.ProcessEnv): Promise<boolean> {
  const dailyTarget = dailyTargetFromEnv(env);
  if (!dailyTarget || !recoveryModeFromEnv(env)) return true;
  const policy = calculateCategoryPolicy(await productsRepository.getProducts(), dailyTarget);
  return policy.categoryDeficits[category] > 0;
}

async function evaluateIdentity(input: {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  discoveryName: string;
  discoveryPrice: number | null;
  sourceImageUrl: string | null;
  products: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
  allowedProductId?: string | null;
}): Promise<{ candidate: CuratedCandidate | null; reason: string }> {
  const sourceIdentity = await curatorRepo.findProductSourceIdentity("Shopee", input.shopId, input.itemId);
  const reservedUntil = sourceIdentity?.reservedUntil ? Date.parse(sourceIdentity.reservedUntil) : 0;
  const ownedByOtherProduct = Boolean(sourceIdentity?.productId && sourceIdentity.productId !== input.allowedProductId);
  const activelyReserved = Boolean(sourceIdentity && !sourceIdentity.productId && Number.isFinite(reservedUntil) && reservedUntil > Date.now());
  if (ownedByOtherProduct || activelyReserved) return { candidate: null, reason: "SOURCE_IDENTITY_ALREADY_OWNED" };

  const acquisition = await input.client.acquireAffiliateLink({ shopId: input.shopId, itemId: input.itemId });
  if (acquisition.status !== "link_acquired" || !acquisition.affiliateUrl || !acquisition.productLink || !acquisition.shopId || !acquisition.itemId) {
    return { candidate: null, reason: `AFFILIATE_${acquisition.status}` };
  }
  if (acquisition.shopId !== input.shopId || acquisition.itemId !== input.itemId || !sourceIdentityMatches(acquisition.productLink, input.shopId, input.itemId)) {
    return { candidate: null, reason: "AFFILIATE_IDENTITY_MISMATCH" };
  }

  const evidence = trustedEvidenceOverride(acquisition.name || input.discoveryName, input.sourceImageUrl);
  const extracted = await input.extractor(acquisition.productLink, evidence);
  if (!extracted.success || !extracted.data) {
    const reason = `EXTRACTION_${extracted.error || "failed"}`;
    return { candidate: null, reason: isTechnicalReviewFailure(reason) ? reviewRecoveryReason(reason) : reason };
  }
  const data = extracted.data;
  if (!sourceIdentityMatches(data.normalizedUrl, input.shopId, input.itemId)) return { candidate: null, reason: "SCRAPER_IDENTITY_MISMATCH" };

  const rawTitle = (data.rawTitle || data.produto || acquisition.name || input.discoveryName || "").trim();
  const displayTitle = (data.displayTitle || "").trim();
  const description = (data.descricao || "").trim();
  const category = data.categoria as PublicProductCategory;
  const scrapedPrice = Number(data.preco);
  const acquisitionPrice = Number(acquisition.price);
  const discoveryPrice = Number(input.discoveryPrice);
  const price = Number.isFinite(scrapedPrice) && scrapedPrice > 0
    ? scrapedPrice
    : Number.isFinite(acquisitionPrice) && acquisitionPrice > 0
      ? acquisitionPrice
      : Number.isFinite(discoveryPrice) && discoveryPrice > 0 ? discoveryPrice : Number.NaN;
  const imageCuration = data.imageCuration;
  const image = resolveCanonicalProductImage({ imagens: data.imagens, imageCuration, imageEditorialStatus: data.imageEditorialStatus });

  const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);
  if (blocked) return { candidate: null, reason: `PROFILE_BLOCKED_TERM:${blocked}` };
  if (!displayTitle || displayTitle === rawTitle || description.length < 24) return { candidate: null, reason: "EDITORIAL_COPY_INCOMPLETE" };
  if (category !== input.profile.category) return { candidate: null, reason: `CATEGORY_MISMATCH:${category || "unknown"}` };
  if (!Number.isFinite(price) || price <= 0) return { candidate: null, reason: "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK" };
  if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl) {
    const reason = `IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR:${imageCuration?.reason || "unknown"}`;
    return { candidate: null, reason: isTechnicalReviewFailure(reason) ? reviewRecoveryReason(reason) : reason };
  }

  const sourceUrl = canonicalSourceUrl(input.shopId, input.itemId);
  const lifecycle = await createProductionProductPipeline().evaluate({
    normalizedUrl: sourceUrl,
    link: acquisition.affiliateUrl,
    marketplace: "Shopee",
    produto: displayTitle,
    rawTitle,
    displayTitle,
    categoria: category,
    preco: price,
    imagens: image.publicHttpsImageUrls,
    imagensOriginais: imageCuration.rawImageUrls,
    imageCuration,
    imagemPrincipal: image.primaryImageUrl,
    imagensGaleria: image.galleryImageUrls,
    imageEditorialStatus: "clean",
    descricao: description,
  });
  if (lifecycle.validation.outcome !== "PASS" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED" || lifecycle.curation.recommendation !== "PUBLISH") {
    return { candidate: null, reason: `PIPELINE_NOT_AUTO_PUBLISHABLE:${lifecycle.validation.errors.join("|") || lifecycle.curation.recommendation}` };
  }

  const breakdown = scoreAutonomousCandidate({
    profile: input.profile,
    rawTitle,
    displayTitle,
    description,
    category,
    price,
    imageCuration,
    pipelineScore: lifecycle.curation.score,
    existingProducts: similarityUniverse(input.products),
  });
  if (breakdown.maximumCatalogSimilarity >= 0.82) return { candidate: null, reason: `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}` };
  if (!input.config.autoPublishEnabled || breakdown.finalScore < input.config.autoPublishThreshold) {
    return { candidate: null, reason: `BELOW_AUTO_PUBLISH_THRESHOLD:${breakdown.finalScore}` };
  }

  return {
    candidate: {
      profile: input.profile,
      query: input.query,
      shopId: input.shopId,
      itemId: input.itemId,
      sourceProductUrl: sourceUrl,
      affiliateUrl: acquisition.affiliateUrl,
      sourceImageUrl: input.sourceImageUrl,
      rawTitle,
      displayTitle,
      description,
      category,
      price,
      images: image.publicHttpsImageUrls,
      imageCuration,
      score: breakdown.finalScore,
      breakdown,
      lifecycle,
    },
    reason: "QUALIFIED",
  };
}

function semanticEntryScore(cheap: number, page: number, decision: SemanticDiscoveryDecision | undefined): number {
  const lexical = cheap > -1000 ? Math.min(240, Math.max(0, cheap)) : 0;
  const semantic = decision?.worthEnriching ? decision.fitScore * 3 + decision.categoryFit : 0;
  const confidence = decision?.confidence === "HIGH" ? 18 : decision?.confidence === "MEDIUM" ? 8 : 0;
  return lexical + semantic + confidence + (page === 1 ? 12 : 0);
}

function emptyDiscoveryMetrics(): DiscoveryMetrics {
  return {
    queriesExecuted: 0,
    candidatesDiscovered: 0,
    candidatesExamined: 0,
    candidatesEnriched: 0,
    candidatesRejected: 0,
    technicalFailures: 0,
  };
}

async function discoverQualifiedCandidate(input: {
  profile: AutonomousCuratorCategoryProfile;
  cycleNumber: number;
  budget: number;
  products: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
}): Promise<DiscoveryResult> {
  let examined = 0;
  let lastReason = "NO_QUALIFIED_CANDIDATE_THIS_CYCLE";
  let shopeeReturned = 0;
  let blockedCount = 0;
  let visualRejected = 0;
  let scoreRejected = 0;
  let recoverySeed: RecoverySeed | null = null;
  const metrics = emptyDiscoveryMetrics();
  const searchedPages: number[] = [];
  const baseQueries = rotateQueries(input.profile, input.cycleNumber);
  const expandedQueries = await expandAutonomousCuratorQueries(input.profile, baseQueries, { env: input.env });
  const queries = [...new Set([...baseQueries, ...expandedQueries].map(query => query.trim()).filter(Boolean))];
  type SearchOfferItem = Awaited<ReturnType<ShopeeApiClient["searchOffers"]>>["items"][number];
  type PoolEntry = { query: string; page: number; item: SearchOfferItem; cheap: number };
  const candidatePool: PoolEntry[] = [];
  const seenIdentities = new Set<string>();

  const collectPage = async (query: string, page: number): Promise<void> => {
    searchedPages.push(page);
    metrics.queriesExecuted += 1;
    const search = await input.client.searchOffers({ query, limit: input.config.maxSearchCandidates, page });
    if (!search.ok) {
      lastReason = `SHOPEE_SEARCH:${search.reason || "failed"}`;
      metrics.technicalFailures += 1;
      if (["SHOPEE_AUTH_ERROR", "SHOPEE_FORBIDDEN"].includes(String(search.reason))) throw new Error(lastReason);
      return;
    }
    shopeeReturned += search.items.length;
    metrics.candidatesDiscovered += search.items.length;
    for (const item of search.items) {
      if (!item.shopId || !item.itemId || !item.productLink || !item.name) continue;
      if (hasBlockedProfileTerm(input.profile, item.name || "")) {
        blockedCount += 1;
        metrics.candidatesRejected += 1;
        continue;
      }
      const identityKey = `${item.shopId}:${item.itemId}`;
      if (seenIdentities.has(identityKey)) continue;
      seenIdentities.add(identityKey);
      const cheap = cheapProfileScore(input.profile, item.name || "");
      candidatePool.push({ query, page, item, cheap });
    }
  };

  for (const query of queries) await collectPage(query, 1);

  const recallTarget = Math.max(24, input.budget * 2);
  const lexicalRecallCount = () => candidatePool.filter(entry => entry.cheap > -1000).length;
  if (lexicalRecallCount() < recallTarget) {
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
      const pages = discoveryPages(input.cycleNumber, input.profile.category, queryIndex);
      for (const page of pages.slice(1)) {
        await collectPage(queries[queryIndex], page);
        if (lexicalRecallCount() >= recallTarget) break;
      }
      if (lexicalRecallCount() >= recallTarget) break;
    }
  }

  const lexicalEntries = candidatePool
    .filter(entry => entry.cheap > -1000)
    .sort((a, b) =>
      (b.cheap + (b.page === 1 ? 12 : 0)) - (a.cheap + (a.page === 1 ? 12 : 0))
      || String(a.item.itemId).localeCompare(String(b.item.itemId))
      || a.query.localeCompare(b.query),
    );
  const rescueEntries = candidatePool.filter(entry => entry.cheap <= -1000);
  const semanticEntryLimit = positiveInt(input.env.OPENAI_AUTONOMOUS_DISCOVERY_MAX_CANDIDATES, 48, 80);
  const semanticLexicalTarget = Math.min(Math.ceil(semanticEntryLimit / 2), lexicalEntries.length);
  const semanticEntries: PoolEntry[] = lexicalEntries.slice(0, semanticLexicalTarget);
  const rescueByQuery = new Map<string, PoolEntry[]>();
  for (const entry of rescueEntries) {
    const bucket = rescueByQuery.get(entry.query) || [];
    bucket.push(entry);
    rescueByQuery.set(entry.query, bucket);
  }
  const rescueBuckets = [...rescueByQuery.values()].map(bucket => bucket.sort((a, b) => Number(a.page !== 1) - Number(b.page !== 1)));
  while (semanticEntries.length < semanticEntryLimit && rescueBuckets.some(bucket => bucket.length > 0)) {
    for (const bucket of rescueBuckets) {
      const next = bucket.shift();
      if (next) semanticEntries.push(next);
      if (semanticEntries.length >= semanticEntryLimit) break;
    }
  }

  const semanticCandidates: SemanticDiscoveryCandidate[] = semanticEntries.map(entry => ({
    identityKey: `${entry.item.shopId}:${entry.item.itemId}`,
    name: entry.item.name || "",
    query: entry.query,
    page: entry.page,
    price: entry.item.price,
    imageUrl: entry.item.imageUrl,
    lexicalScore: entry.cheap,
  }));
  const semantic = await rankAutonomousCuratorCandidates(input.profile, semanticCandidates, { env: input.env });
  if (semantic.status === "unavailable") metrics.technicalFailures += 1;
  const semanticByIdentity = new Map(semantic.decisions.map(decision => [decision.identityKey, decision] as const));
  const rescueThreshold = positiveInt(input.env.OPENAI_AUTONOMOUS_DISCOVERY_RESCUE_THRESHOLD, 68, 100);
  const categoryThreshold = positiveInt(input.env.OPENAI_AUTONOMOUS_DISCOVERY_CATEGORY_THRESHOLD, 70, 100);
  const rankedPool = candidatePool.filter(entry => {
    if (entry.cheap > -1000) return true;
    if (semantic.status !== "ok") return false;
    const decision = semanticByIdentity.get(`${entry.item.shopId}:${entry.item.itemId}`);
    return Boolean(decision?.worthEnriching && decision.fitScore >= rescueThreshold && decision.categoryFit >= categoryThreshold);
  });
  const semanticRescued = rankedPool.filter(entry => entry.cheap <= -1000).length;

  rankedPool.sort((a, b) => {
    const aDecision = semanticByIdentity.get(`${a.item.shopId}:${a.item.itemId}`);
    const bDecision = semanticByIdentity.get(`${b.item.shopId}:${b.item.itemId}`);
    return semanticEntryScore(b.cheap, b.page, bDecision) - semanticEntryScore(a.cheap, a.page, aDecision)
      || String(a.item.itemId).localeCompare(String(b.item.itemId))
      || a.query.localeCompare(b.query);
  });

  const logMetrics = (qualifiedCount: number) => {
    console.info(
      `[Autonomous Curator Discovery] category=${input.profile.category} shopee_returned=${shopeeReturned} blocked=${blockedCount} lexical_pass=${lexicalEntries.length} semantic_status=${semantic.status} semantic_rescued=${semanticRescued} enriched=${examined} visual_rejected=${visualRejected} score_rejected=${scoreRejected} qualified=${qualifiedCount} expanded_queries=${expandedQueries.length}`,
    );
  };

  const qualified: Array<{ candidate: CuratedCandidate; cheap: number; page: number; semantic?: SemanticDiscoveryDecision }> = [];
  for (const entry of rankedPool) {
    if (examined >= input.budget) break;
    metrics.candidatesExamined += 1;
    const shopId = String(entry.item.shopId);
    const itemId = String(entry.item.itemId);
    const identityKey = `${shopId}:${itemId}`;
    const identity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
    const reservedUntil = identity?.reservedUntil ? Date.parse(identity.reservedUntil) : 0;
    if (identity?.productId || (identity && Number.isFinite(reservedUntil) && reservedUntil > Date.now())) continue;
    examined += 1;
    metrics.candidatesEnriched += 1;
    const evaluated = await evaluateIdentity({
      profile: input.profile,
      query: entry.query,
      shopId,
      itemId,
      discoveryName: entry.item.name || "",
      discoveryPrice: entry.item.price,
      sourceImageUrl: entry.item.imageUrl,
      products: input.products,
      client: input.client,
      env: input.env,
      extractor: input.extractor,
      config: input.config,
    });
    lastReason = evaluated.reason;
    if (evaluated.reason.startsWith(REVIEW_RECOVERY_PREFIX)) {
      metrics.technicalFailures += 1;
      recoverySeed = {
        query: entry.query,
        shopId,
        itemId,
        sourceProductUrl: canonicalSourceUrl(shopId, itemId),
        rawTitle: entry.item.name || "",
        price: entry.item.price,
        imageUrl: entry.item.imageUrl,
        reason: evaluated.reason,
      };
    }
    if (evaluated.reason.startsWith("IMAGE_REVIEW_") || evaluated.reason.startsWith("EXTRACTION_IMAGE_REVIEW_") || evaluated.reason.startsWith(REVIEW_RECOVERY_PREFIX)) visualRejected += 1;
    if (evaluated.reason.startsWith("BELOW_AUTO_PUBLISH_THRESHOLD") || evaluated.reason.startsWith("CATALOG_SIMILARITY")) scoreRejected += 1;
    if (!evaluated.candidate) metrics.candidatesRejected += 1;
    if (evaluated.candidate) {
      const semanticDecision = semanticByIdentity.get(identityKey);
      if (semanticDecision) {
        const auditedBreakdown = evaluated.candidate.breakdown as AutonomousCuratorScoreBreakdown & { semanticDiscovery?: Record<string, unknown> };
        auditedBreakdown.semanticDiscovery = {
          provider: "openai",
          model: semantic.model,
          fitScore: semanticDecision.fitScore,
          categoryFit: semanticDecision.categoryFit,
          confidence: semanticDecision.confidence,
          rescuedFromLexicalGate: entry.cheap <= -1000,
          signals: semanticDecision.signals,
          reason: semanticDecision.reason,
        };
      }
      qualified.push({ candidate: evaluated.candidate, cheap: entry.cheap, page: entry.page, semantic: semanticDecision });
      if (qualified.length >= QUALIFIED_COMPARISON_TARGET) break;
    }
  }

  if (qualified.length > 0) {
    qualified.sort((a, b) =>
      b.candidate.score - a.candidate.score
      || (b.semantic?.fitScore || 0) - (a.semantic?.fitScore || 0)
      || Number(a.page !== 1) - Number(b.page !== 1)
      || b.cheap - a.cheap
      || a.candidate.price - b.candidate.price,
    );
    logMetrics(qualified.length);
    return {
      candidate: qualified[0].candidate,
      reason: `BEST_OF_${qualified.length}_QUALIFIED_CANDIDATES`,
      examined,
      searchedPages,
      recoverySeed,
      metrics,
    };
  }

  logMetrics(0);
  return { candidate: null, reason: `${lastReason};SEARCH_CONTINUES_NEXT_SCHEDULED_CYCLE`, examined, searchedPages, recoverySeed, metrics };
}

function queuedForCategory(products: readonly Product[], category: PublicProductCategory): Product[] {
  return products
    .filter(product => product.createdBy === QUEUE_CREATED_BY && product.categoria === category && product.status === "paused" && product.ativo === false && parseQueueNote(product.curatorNote))
    .sort((a, b) => (parseQueueNote(b.curatorNote)?.score || 0) - (parseQueueNote(a.curatorNote)?.score || 0));
}

async function claimQueueIdentity(candidate: CuratedCandidate, productId: string): Promise<boolean> {
  const { error } = await requireSupabase().from("product_source_identities").insert({
    marketplace: "Shopee",
    shop_id: candidate.shopId,
    item_id: candidate.itemId,
    source_product_url: candidate.sourceProductUrl,
    product_id: productId,
    review_id: null,
    source: QUEUE_CREATED_BY,
    reserved_run_id: null,
    reserved_until: null,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

async function persistPausedCandidate(candidate: CuratedCandidate, now: Date, env: NodeJS.ProcessEnv): Promise<Product | null> {
  if (await curatorRepo.findProductSourceIdentity("Shopee", candidate.shopId, candidate.itemId)) return null;
  const client = requireSupabase();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const productId = `prod-${now.getTime()}-${suffix}`;
  if (!(await claimQueueIdentity(candidate, productId))) return null;
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: now.toISOString(),
    publishedAt: null,
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    imageUrl: candidate.sourceImageUrl,
  };
  const slug = `${generateSlug(candidate.displayTitle)}-${suffix.slice(0, 6)}`;
  const model = env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "gemini-3.5-flash-lite";
  const { error } = await client.from("products").insert({
    id: productId,
    ref: `AUTOQ-${suffix.toUpperCase()}`,
    produto: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    link: candidate.affiliateUrl,
    ativo: false,
    destaque: false,
    status: "paused",
    created_by: QUEUE_CREATED_BY,
    slug,
    descricao: candidate.description,
    pagina_ponte_url: "",
    oferta_promocional: null,
    raw_title: candidate.rawTitle,
    display_title: candidate.displayTitle,
    curator_note: queueNote(meta),
    image_editorial_status: "clean",
    image_curation: candidate.imageCuration,
    image_reviewed_at: now.toISOString(),
    image_review_model: model,
    image_review_version: IMAGE_REVIEW_VERSION,
    image_review_fingerprint: imageCurationFingerprint(candidate.imageCuration),
    display_title_status: "reviewed",
    display_title_reviewed_at: now.toISOString(),
    display_title_review_model: env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
    display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION,
  });
  if (error) {
    await client.from("product_source_identities").delete().eq("marketplace", "Shopee").eq("shop_id", candidate.shopId).eq("item_id", candidate.itemId).eq("product_id", productId);
    throw error;
  }
  try {
    await curatorRepo.saveProductImageEditorialReview({ productId, curation: candidate.imageCuration, model, reviewVersion: "1.2" });
  } catch (error) {
    await client.from("products").delete().eq("id", productId);
    await client.from("product_source_identities").delete().eq("marketplace", "Shopee").eq("shop_id", candidate.shopId).eq("item_id", candidate.itemId).eq("product_id", productId);
    throw error;
  }
  return {
    id: productId,
    ref: `AUTOQ-${suffix.toUpperCase()}`,
    produto: candidate.displayTitle,
    rawTitle: candidate.rawTitle,
    displayTitle: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    imageEditorialStatus: "clean",
    imageCuration: candidate.imageCuration,
    link: candidate.affiliateUrl,
    ativo: false,
    destaque: false,
    status: "paused",
    createdBy: QUEUE_CREATED_BY,
    slug,
    descricao: candidate.description,
    curatorNote: queueNote(meta),
    createdAt: now.toISOString(),
  };
}

async function archiveQueueProduct(product: Product): Promise<void> {
  const { error } = await requireSupabase().from("products").update({ ativo: false, status: "archived" }).eq("id", product.id);
  if (error) throw error;
  product.status = "archived";
  product.ativo = false;
}

async function maybeQueueCandidate(candidate: CuratedCandidate, products: Product[], now: Date, env: NodeJS.ProcessEnv): Promise<{ queued: boolean; product: Product | null; reason: string }> {
  const categoryQueue = queuedForCategory(products, candidate.category);
  const target = queueTarget(env);
  if (categoryQueue.length >= target) {
    const weakest = [...categoryQueue].sort((a, b) => (parseQueueNote(a.curatorNote)?.score || 0) - (parseQueueNote(b.curatorNote)?.score || 0))[0];
    const weakestScore = parseQueueNote(weakest?.curatorNote)?.score || 0;
    if (candidate.score <= weakestScore) return { queued: false, product: null, reason: `QUEUE_FULL_STRONGER_OR_EQUAL:${weakestScore}` };
    if (weakest) await archiveQueueProduct(weakest);
  }
  const product = await persistPausedCandidate(candidate, now, env);
  if (!product) return { queued: false, product: null, reason: "QUEUE_IDENTITY_ALREADY_OWNED" };
  products.unshift(product);
  return { queued: true, product, reason: "QUEUED_PAUSED_FOR_FUTURE_PUBLICATION" };
}

async function refreshQueuedCandidate(input: {
  product: Product;
  profile: AutonomousCuratorCategoryProfile;
  products: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
}): Promise<{ candidate: CuratedCandidate | null; reason: string }> {
  const meta = parseQueueNote(input.product.curatorNote);
  if (!meta) return { candidate: null, reason: "QUEUE_METADATA_MISSING" };
  return evaluateIdentity({
    profile: input.profile,
    query: meta.query,
    shopId: meta.shopId,
    itemId: meta.itemId,
    discoveryName: input.product.rawTitle || input.product.produto,
    discoveryPrice: input.product.preco,
    sourceImageUrl: meta.imageUrl || input.product.imagens?.[0] || null,
    products: input.products.filter(product => product.id !== input.product.id),
    client: input.client,
    env: input.env,
    extractor: input.extractor,
    config: input.config,
    allowedProductId: input.product.id,
  });
}

async function updateQueuedProduct(product: Product, candidate: CuratedCandidate, now: Date, published: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  const previous = parseQueueNote(product.curatorNote);
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: previous?.queuedAt || product.createdAt || now.toISOString(),
    publishedAt: published ? now.toISOString() : null,
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    imageUrl: candidate.sourceImageUrl,
  };
  const { error } = await requireSupabase().from("products").update({
    produto: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    link: candidate.affiliateUrl,
    descricao: candidate.description,
    raw_title: candidate.rawTitle,
    display_title: candidate.displayTitle,
    curator_note: queueNote(meta),
    image_editorial_status: "clean",
    image_curation: candidate.imageCuration,
    image_reviewed_at: now.toISOString(),
    image_review_model: env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
    image_review_version: IMAGE_REVIEW_VERSION,
    image_review_fingerprint: imageCurationFingerprint(candidate.imageCuration),
    display_title_status: "reviewed",
    display_title_reviewed_at: now.toISOString(),
    display_title_review_model: env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
    display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION,
    ativo: published,
    status: published ? "published" : "paused",
  }).eq("id", product.id);
  if (error) throw error;
  product.produto = candidate.displayTitle;
  product.rawTitle = candidate.rawTitle;
  product.displayTitle = candidate.displayTitle;
  product.categoria = candidate.category;
  product.preco = candidate.price;
  product.imagens = candidate.images;
  product.link = candidate.affiliateUrl;
  product.descricao = candidate.description;
  product.imageCuration = candidate.imageCuration;
  product.imageEditorialStatus = "clean";
  product.imageReviewedAt = now.toISOString();
  product.imageReviewModel = env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite";
  product.imageReviewVersion = IMAGE_REVIEW_VERSION;
  product.imageReviewFingerprint = imageCurationFingerprint(candidate.imageCuration);
  product.displayTitleStatus = "reviewed";
  product.displayTitleReviewedAt = now.toISOString();
  product.displayTitleReviewModel = env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite";
  product.displayTitleReviewVersion = DISPLAY_TITLE_REVIEW_VERSION;
  product.curatorNote = queueNote(meta);
  product.ativo = published;
  product.status = published ? "published" : "paused";
}

async function lastPublishedAt(category: PublicProductCategory, products: readonly Product[]): Promise<string | null> {
  const active = products.filter(product => product.categoria === category && product.status === "published" && product.ativo !== false);
  if (active.length === 0) return null;
  let newest: string | null = null;
  for (const product of active) {
    const meta = parseQueueNote(product.curatorNote);
    const timestamp = meta?.publishedAt || (product.createdBy === QUEUE_CREATED_BY ? product.createdAt || null : null);
    if (timestamp && (!newest || Date.parse(timestamp) > Date.parse(newest))) newest = timestamp;
  }
  const activeIds = new Set(active.map(product => product.id));
  const { data, error } = await requireSupabase().from("autonomous_curator_candidates")
    .select("updated_at,product_id")
    .eq("category", category)
    .eq("decision", "auto_published")
    .not("product_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  for (const row of data || []) {
    if (!row.product_id || !activeIds.has(String(row.product_id))) continue;
    const timestamp = String(row.updated_at);
    if (!newest || Date.parse(timestamp) > Date.parse(newest)) newest = timestamp;
    break;
  }
  return newest;
}

async function getRunMetadata(runId: string): Promise<Record<string, unknown>> {
  const { data, error } = await requireSupabase().from("autonomous_curator_runs").select("metadata").eq("id", runId).single();
  if (error) throw error;
  return data?.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
}

async function markCycleStarted(runId: string, cycleId: string, cycleNumber: number, now: Date, metadata: Record<string, unknown>): Promise<void> {
  const { error } = await requireSupabase().from("autonomous_curator_runs").update({
    status: "running",
    profile_version: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    completed_at: null,
    metadata: {
      ...metadata,
      profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
      continuous: true,
      continuous_version: "3",
      continuous_cycle_id: cycleId,
      continuous_cycle_count: cycleNumber,
      continuous_cycle_started_at: now.toISOString(),
      continuous_cycle_completed_at: null,
    },
  }).eq("id", runId);
  if (error) throw error;
}

async function markPublished(runId: string, candidate: CuratedCandidate, productId: string): Promise<void> {
  await curatorRepo.saveAutonomousCuratorCategoryResult({
    runId,
    category: candidate.category,
    searchQuery: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    rawTitle: candidate.rawTitle,
    displayTitle: candidate.displayTitle,
    score: candidate.score,
    scoreBreakdown: candidate.breakdown as unknown as Record<string, unknown>,
    decision: "auto_published",
    reason: "PUBLISHED_FROM_CONTINUOUS_CURATOR_V2_AND_PUBLICLY_VALIDATED",
    productId,
  });
}

async function persistReviewRecovery(runId: string, category: PublicProductCategory, seed: RecoverySeed): Promise<void> {
  await curatorRepo.saveAutonomousCuratorCategoryResult({
    runId,
    category,
    searchQuery: seed.query,
    shopId: seed.shopId,
    itemId: seed.itemId,
    sourceProductUrl: seed.sourceProductUrl,
    rawTitle: seed.rawTitle,
    score: null,
    scoreBreakdown: {
      recoverySeed: {
        price: seed.price,
        imageUrl: seed.imageUrl,
      },
    },
    decision: "review_required",
    reason: seed.reason,
  });
}

function recoverySeedFromStored(result: curatorRepo.AutonomousCuratorCategoryResult | null): RecoverySeed | null {
  if (!result || result.decision !== "review_required" || !String(result.reason || "").startsWith(REVIEW_RECOVERY_PREFIX)) return null;
  if (!result.shopId || !result.itemId || !result.sourceProductUrl || !result.searchQuery || !result.rawTitle) return null;
  const seed = result.scoreBreakdown?.recoverySeed;
  const stored = seed && typeof seed === "object" ? seed as Record<string, unknown> : {};
  const price = Number(stored.price);
  return {
    query: result.searchQuery,
    shopId: result.shopId,
    itemId: result.itemId,
    sourceProductUrl: result.sourceProductUrl,
    rawTitle: result.rawTitle,
    price: Number.isFinite(price) && price > 0 ? price : null,
    imageUrl: typeof stored.imageUrl === "string" ? stored.imageUrl : null,
    reason: String(result.reason),
  };
}

function mergeDiscoveryMetrics(target: CycleMetrics, source: DiscoveryMetrics): void {
  target.queriesExecuted += source.queriesExecuted;
  target.candidatesDiscovered += source.candidatesDiscovered;
  target.candidatesExamined += source.candidatesExamined;
  target.candidatesEnriched += source.candidatesEnriched;
  target.candidatesRejected += source.candidatesRejected;
  target.technicalFailures += source.technicalFailures;
}

function adminChatId(env: NodeJS.ProcessEnv): number | null {
  const raw = String(env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

async function notify(result: ContinuousCuratorResultV2, env: NodeJS.ProcessEnv): Promise<void> {
  const chatId = adminChatId(env);
  if (!chatId) return;
  const lines = result.categories.map(item => `${item.published ? "✅" : item.queued ? "⏸️" : item.due ? "🔎" : "🗂️"} <b>${item.category}</b>: ${item.title || item.reason}${item.score === null ? "" : ` · ${item.score}/100`}`);
  const text = [
    "🧠 <b>CERBERUS CONTINUOUS CURATOR V2</b>",
    "",
    `Ciclo: <code>${result.cycleId}</code> · #${result.cycleNumber}`,
    `Publicados neste ciclo: <b>${result.publishedThisCycle}</b> · categorias na meta: <b>${result.fulfilledCategories}/10</b>`,
    `Fila pausada: <b>${result.queuedProducts}</b> · falhas técnicas: <b>${result.failedThisCycle}</b>`,
    "",
    ...lines,
    "",
    result.status === "completed"
      ? "As 10 categorias estão cobertas; os próximos ciclos respeitam a progressão cumulativa."
      : "Categorias pendentes continuam automaticamente no próximo ciclo; os gates de curadoria permanecem inalterados.",
  ].join("\n");
  await sendTelegramMessage(chatId, text).catch(() => undefined);
}

export async function runAutonomousCuratorContinuousV2(options: ContinuousOptions = {}): Promise<ContinuousCuratorResultV2> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const cycleId = options.cycleId || `continuous-${randomUUID()}`;
  const runDate = localRunDate(now);
  const config = await curatorRepo.getAutonomousCuratorConfig();
  if (!config.enabled) {
    return { cycleId, cycleNumber: 0, runId: "", runDate, status: "disabled", publishedThisCycle: 0, fulfilledCategories: 0, queuedProducts: 0, failedThisCycle: 0, categories: [] };
  }
  const client = options.shopeeClient || buildShopeeClient(env);
  if (!client) throw new Error("AUTONOMOUS_CURATOR_SHOPEE_NOT_CONFIGURED");
  const extractor = options.extractor || extractProductForReview;
  const open = await curatorRepo.openAutonomousCuratorRun({
    runDate,
    dryRun: false,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    categoriesTotal: AUTONOMOUS_CURATOR_PROFILES.length,
  });
  const runId = open.run.id;
  const baseMetadata = await getRunMetadata(runId);
  const cycleNumber = Math.max(0, Number(baseMetadata.continuous_cycle_count || 0)) + 1;
  await markCycleStarted(runId, cycleId, cycleNumber, now, baseMetadata);

  const metrics: CycleMetrics = {
    attemptedCategories: 0,
    attemptedCategoryNames: [],
    queriesExecuted: 0,
    candidatesDiscovered: 0,
    candidatesExamined: 0,
    candidatesEnriched: 0,
    candidatesRejected: 0,
    publicationAttempts: 0,
    archivedAfterPublication: 0,
    technicalFailures: 0,
  };
  let failedThisCycle = 0;
  let cycleClosed = false;

  try {
    let products = await productsRepository.getProducts();
    const dailyTarget = dailyTargetFromEnv(env);
    const deficitScope = deficitCategoryScope(env);
    const scopedRecoveryMode = recoveryModeFromEnv(env) && Boolean(dailyTarget);
    const liveCatalogTargetCount = liveCatalogTarget(env);
    const liveCatalogCountBefore = activePublishedCount(products);
    const inventoryDeficitBefore = Math.max(0, liveCatalogTargetCount - liveCatalogCountBefore);
    const emergencyMode = inventoryDeficitBefore > 0;
    let emergencyRefillRemaining = inventoryDeficitBefore;
    const categories: ContinuousCuratorCategoryResultV2[] = [];
    const pendingPublications: Array<{ product: Product; candidate: CuratedCandidate }> = [];

    for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
      const result: ContinuousCuratorCategoryResultV2 = {
        category: profile.category,
        due: true,
        published: false,
        queued: false,
        score: null,
        title: null,
        reason: "SEARCHING",
        productId: null,
        searchedPages: [],
      };

      if (scopedRecoveryMode && !deficitScope.has(profile.category)) {
        result.due = false;
        result.reason = "CATEGORY_TARGET_ALREADY_SATISFIED_WHILE_DEFICITS_EXIST";
        categories.push(result);
        continue;
      }

      metrics.attemptedCategories += 1;
      metrics.attemptedCategoryNames.push(profile.category);
      try {
        const last = await lastPublishedAt(profile.category, products);
        const editorialDue = dueForPublication(last, now);
        result.due = scopedRecoveryMode ? true : dueForCycle(last, now, emergencyMode, emergencyRefillRemaining);
        result.reason = scopedRecoveryMode
          ? `CATEGORY_DEFICIT_RECOVERY_TARGET_${dailyTarget}`
          : emergencyMode
            ? result.due
              ? `EMERGENCY_REFILL_DEFICIT_${emergencyRefillRemaining}`
              : "INVENTORY_FLOOR_RESTORED_DEFER_EDITORIAL_CADENCE"
            : editorialDue
              ? "SEARCHING_FOR_DUE_PRODUCT"
              : `COOLDOWN_UNTIL_${new Date(Date.parse(last || now.toISOString()) + DAY_MS).toISOString()}`;
        let budgetRemaining = config.maxEnrichPerCategory;

        if (result.due && config.maxDailyPerCategory > 0) {
          const previousCategoryResult = await curatorRepo.getAutonomousCuratorCategoryResult(runId, profile.category);
          const recoverySeed = recoverySeedFromStored(previousCategoryResult);
          if (recoverySeed && budgetRemaining > 0) {
            metrics.candidatesExamined += 1;
            metrics.candidatesEnriched += 1;
            budgetRemaining -= 1;
            const recovered = await evaluateIdentity({
              profile,
              query: recoverySeed.query,
              shopId: recoverySeed.shopId,
              itemId: recoverySeed.itemId,
              discoveryName: recoverySeed.rawTitle,
              discoveryPrice: recoverySeed.price,
              sourceImageUrl: recoverySeed.imageUrl,
              products,
              client,
              env,
              extractor,
              config,
            });
            if (recovered.candidate) {
              const queued = await maybeQueueCandidate(recovered.candidate, products, now, env);
              if (queued.product) {
                await assertFreshCategoryPublicationAllowed(profile.category, env);
                metrics.publicationAttempts += 1;
                await updateQueuedProduct(queued.product, recovered.candidate, now, true, env);
                pendingPublications.push({ product: queued.product, candidate: recovered.candidate });
                result.published = true;
                result.score = recovered.candidate.score;
                result.title = recovered.candidate.displayTitle;
                result.productId = queued.product.id;
                result.reason = "PENDING_PUBLIC_CATALOG_VALIDATION_FROM_REVIEW_RECOVERY";
              }
            } else if (recovered.reason.startsWith(REVIEW_RECOVERY_PREFIX)) {
              metrics.technicalFailures += 1;
              metrics.candidatesRejected += 1;
              await persistReviewRecovery(runId, profile.category, { ...recoverySeed, reason: recovered.reason });
              result.reason = recovered.reason;
            } else {
              metrics.candidatesRejected += 1;
              await curatorRepo.saveAutonomousCuratorCategoryResult({
                runId,
                category: profile.category,
                searchQuery: recoverySeed.query,
                shopId: recoverySeed.shopId,
                itemId: recoverySeed.itemId,
                sourceProductUrl: recoverySeed.sourceProductUrl,
                rawTitle: recoverySeed.rawTitle,
                decision: "rejected",
                reason: recovered.reason,
              });
            }
          }

          if (!result.published) {
            for (const queuedProduct of queuedForCategory(products, profile.category)) {
              const refreshed = await refreshQueuedCandidate({ product: queuedProduct, profile, products, client, env, extractor, config });
              if (!refreshed.candidate) {
                result.reason = refreshed.reason.startsWith(REVIEW_RECOVERY_PREFIX)
                  ? refreshed.reason
                  : `QUEUE_REVALIDATION_REJECTED:${refreshed.reason}`;
                if (refreshed.reason.startsWith(REVIEW_RECOVERY_PREFIX)) metrics.technicalFailures += 1;
                else if (revalidationPermanentFailure(refreshed.reason)) await archiveQueueProduct(queuedProduct);
                continue;
              }
              await assertFreshCategoryPublicationAllowed(profile.category, env);
              metrics.publicationAttempts += 1;
              await updateQueuedProduct(queuedProduct, refreshed.candidate, now, true, env);
              await curatorRepo.saveProductImageEditorialReview({
                productId: queuedProduct.id,
                curation: refreshed.candidate.imageCuration,
                model: env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
                reviewVersion: "1.2",
              });
              pendingPublications.push({ product: queuedProduct, candidate: refreshed.candidate });
              if (emergencyMode) emergencyRefillRemaining = Math.max(0, emergencyRefillRemaining - 1);
              result.published = true;
              result.score = refreshed.candidate.score;
              result.title = refreshed.candidate.displayTitle;
              result.productId = queuedProduct.id;
              result.reason = "PENDING_PUBLIC_CATALOG_VALIDATION_FROM_QUEUE";
              break;
            }
          }

          if (!result.published && budgetRemaining > 0) {
            const discovery = await discoverQualifiedCandidate({ profile, cycleNumber, budget: budgetRemaining, products, client, env, extractor, config });
            mergeDiscoveryMetrics(metrics, discovery.metrics);
            budgetRemaining = Math.max(0, budgetRemaining - discovery.examined);
            result.searchedPages.push(...discovery.searchedPages);
            if (discovery.recoverySeed) {
              await persistReviewRecovery(runId, profile.category, discovery.recoverySeed);
              result.reason = discovery.recoverySeed.reason;
            }
            if (discovery.candidate) {
              const queued = await maybeQueueCandidate(discovery.candidate, products, now, env);
              if (queued.product) {
                await assertFreshCategoryPublicationAllowed(profile.category, env);
                metrics.publicationAttempts += 1;
                await updateQueuedProduct(queued.product, discovery.candidate, now, true, env);
                pendingPublications.push({ product: queued.product, candidate: discovery.candidate });
                if (emergencyMode) emergencyRefillRemaining = Math.max(0, emergencyRefillRemaining - 1);
                result.published = true;
                result.score = discovery.candidate.score;
                result.title = discovery.candidate.displayTitle;
                result.productId = queued.product.id;
                result.reason = "PENDING_PUBLIC_CATALOG_VALIDATION_FROM_DISCOVERY";
              } else {
                result.reason = queued.reason;
              }
            } else if (!discovery.recoverySeed) {
              result.reason = discovery.reason;
            }
          }
        }

        const allowFutureDiscovery = budgetRemaining > 0 && await categoryStillNeedsRecovery(profile.category, env);
        if (allowFutureDiscovery) {
          const future = await discoverQualifiedCandidate({ profile, cycleNumber: cycleNumber + 1, budget: budgetRemaining, products, client, env, extractor, config });
          mergeDiscoveryMetrics(metrics, future.metrics);
          result.searchedPages.push(...future.searchedPages);
          if (future.recoverySeed) await persistReviewRecovery(runId, profile.category, future.recoverySeed);
          if (future.candidate) {
            const queued = await maybeQueueCandidate(future.candidate, products, now, env);
            result.queued = queued.queued;
            if (!result.published && queued.product) {
              result.score = future.candidate.score;
              result.title = future.candidate.displayTitle;
              result.productId = queued.product.id;
            }
            if (!result.due || result.reason.startsWith("COOLDOWN_")) result.reason = queued.reason;
          } else if ((!result.due || result.reason.startsWith("COOLDOWN_")) && !future.recoverySeed) {
            result.reason = future.reason;
          }
        }
      } catch (error) {
        failedThisCycle += 1;
        metrics.technicalFailures += 1;
        result.reason = safeCategoryFailureReason(error);
      }
      result.searchedPages = [...new Set(result.searchedPages)];
      categories.push(result);
    }

    if (pendingPublications.length > 0) {
      const sync = await syncCatalogAndDeploy("continuous autonomous curator v2");
      if (!sync.success) {
        failedThisCycle += pendingPublications.length;
        metrics.technicalFailures += pendingPublications.length;
        for (const item of pendingPublications) {
          await updateQueuedProduct(item.product, item.candidate, now, false, env);
          const result = categories.find(category => category.category === item.candidate.category);
          if (result) {
            result.published = false;
            result.queued = true;
            result.reason = `CATALOG_SYNC_FAILED:${sync.error || "unknown"}`;
          }
        }
        await syncCatalogAndDeploy("continuous autonomous curator v2 rollback").catch(() => undefined);
      } else {
        for (const item of pendingPublications) {
          await markPublished(runId, item.candidate, item.product.id);
          const result = categories.find(category => category.category === item.candidate.category);
          if (result) result.reason = "PUBLISHED_AND_PUBLICLY_VALIDATED";
        }
      }
    }

    products = await productsRepository.getProducts();
    const liveCatalogCountAfter = activePublishedCount(products);
    const inventoryDeficitAfter = Math.max(0, liveCatalogTargetCount - liveCatalogCountAfter);
    const categoryPolicyAfter = dailyTarget ? calculateCategoryPolicy(products, dailyTarget) : null;
    let fulfilledCategories = 0;
    if (categoryPolicyAfter) {
      fulfilledCategories = categoryPolicyAfter.fulfilledCategories;
    } else {
      for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
        const last = await lastPublishedAt(profile.category, products);
        if (last && !dueForPublication(last, now)) fulfilledCategories += 1;
      }
    }
    const queuedProducts = products.filter(product => product.createdBy === QUEUE_CREATED_BY && product.status === "paused" && product.ativo === false && parseQueueNote(product.curatorNote)).length;
    const publishedThisCycle = categories.filter(category => category.published && category.reason === "PUBLISHED_AND_PUBLICLY_VALIDATED").length;
    const remainingDeficit = categoryPolicyAfter ? categoryPolicyAfter.totalDeficit : inventoryDeficitAfter;
    const status: ContinuousCuratorResultV2["status"] = remainingDeficit > 0
      ? failedThisCycle > 0 && fulfilledCategories === 0 ? "failed" : "partial"
      : failedThisCycle === 0 ? "completed" : "partial";

    const completedAt = new Date().toISOString();
    const priorHistory = Array.isArray(baseMetadata.continuous_cycles) ? baseMetadata.continuous_cycles : [];
    const cycleAudit = {
      cycleId,
      cycleNumber,
      startedAt: now.toISOString(),
      completedAt,
      status,
      fulfilledCategories,
      publishedThisCycle,
      queuedProducts,
      failedThisCycle,
      categoryDeficits: categoryPolicyAfter?.categoryDeficits || null,
      metrics: {
        attemptedCategories: metrics.attemptedCategories,
        queriesExecuted: metrics.queriesExecuted,
        candidatesDiscovered: metrics.candidatesDiscovered,
        candidatesExamined: metrics.candidatesExamined,
        candidatesEnriched: metrics.candidatesEnriched,
        candidatesRejected: metrics.candidatesRejected,
        publicationAttempts: metrics.publicationAttempts,
        technicalFailures: metrics.technicalFailures,
      },
      categories: categories.map(category => ({
        category: category.category,
        due: category.due,
        published: category.published,
        queued: category.queued,
        score: category.score,
        title: category.title,
        reason: category.reason,
        searchedPages: category.searchedPages,
      })),
    };
    const continuousCycles = [...priorHistory, cycleAudit].slice(-MAX_CYCLE_HISTORY);
    const publishedThisRun = continuousCycles.reduce((sum, cycle) => {
      if (!cycle || typeof cycle !== "object") return sum;
      const count = Number((cycle as Record<string, unknown>).publishedThisCycle || 0);
      return sum + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
    const reviewRequired = categories.filter(category => category.reason.startsWith(REVIEW_RECOVERY_PREFIX)).length;

    await curatorRepo.finishAutonomousCuratorRun({
      runId,
      status: status === "completed" ? "completed" : status === "failed" ? "failed" : "partial",
      categoriesProcessed: metrics.attemptedCategories,
      autoPublished: publishedThisRun,
      reviewRequired,
      rejected: metrics.candidatesRejected,
      failed: failedThisCycle,
      metadata: {
        ...baseMetadata,
        profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
        continuous: true,
        continuous_version: "3",
        continuous_cycle_id: cycleId,
        continuous_cycle_count: cycleNumber,
        continuous_cycle_started_at: now.toISOString(),
        continuous_cycle_completed_at: completedAt,
        fulfilled_categories: fulfilledCategories,
        attempted_categories: metrics.attemptedCategories,
        attempted_category_names: metrics.attemptedCategoryNames,
        queries_executed: metrics.queriesExecuted,
        candidates_discovered: metrics.candidatesDiscovered,
        candidates_examined: metrics.candidatesExamined,
        candidates_enriched: metrics.candidatesEnriched,
        candidates_rejected: metrics.candidatesRejected,
        publication_attempts: metrics.publicationAttempts,
        published_this_cycle: publishedThisCycle,
        published_this_run: publishedThisRun,
        published_active_now: liveCatalogCountAfter,
        archived_after_publication: metrics.archivedAfterPublication,
        technical_failures: metrics.technicalFailures,
        queued_products: queuedProducts,
        failed_this_cycle: failedThisCycle,
        queue_target_per_category: queueTarget(env),
        live_catalog_target: liveCatalogTargetCount,
        live_catalog_count_before: liveCatalogCountBefore,
        live_catalog_count_after: liveCatalogCountAfter,
        inventory_deficit_before: inventoryDeficitBefore,
        inventory_deficit_after: inventoryDeficitAfter,
        category_deficits_after: categoryPolicyAfter?.categoryDeficits || null,
        deficit_categories_after: categoryPolicyAfter?.deficitCategories || null,
        deficit_recovery_pending: Boolean(categoryPolicyAfter && categoryPolicyAfter.totalDeficit > 0),
        discovery_attempt_index: cycleNumber,
        emergency_refill: emergencyMode,
        continuous_cycles: continuousCycles,
      },
    });
    cycleClosed = true;

    const result: ContinuousCuratorResultV2 = {
      cycleId,
      cycleNumber,
      runId,
      runDate,
      status,
      publishedThisCycle,
      fulfilledCategories,
      queuedProducts,
      failedThisCycle,
      categories,
    };
    if (options.notify !== false) await notify(result, env);
    return result;
  } catch (error) {
    const interruptedAt = new Date().toISOString();
    const reason = safeCategoryFailureReason(error);
    const latestMetadata = await getRunMetadata(runId).catch(() => baseMetadata);
    const publishedThisRun = Math.max(0, Number(latestMetadata.published_this_run || 0));
    await curatorRepo.finishAutonomousCuratorRun({
      runId,
      status: "failed",
      categoriesProcessed: metrics.attemptedCategories,
      autoPublished: publishedThisRun,
      reviewRequired: 0,
      rejected: metrics.candidatesRejected,
      failed: Math.max(1, failedThisCycle),
      metadata: {
        ...latestMetadata,
        continuous: true,
        continuous_version: "3",
        continuous_cycle_id: cycleId,
        continuous_cycle_count: cycleNumber,
        continuous_cycle_started_at: now.toISOString(),
        continuous_cycle_completed_at: interruptedAt,
        cycle_interrupted: true,
        cycle_interruption_reason: reason,
        attempted_categories: metrics.attemptedCategories,
        attempted_category_names: metrics.attemptedCategoryNames,
        queries_executed: metrics.queriesExecuted,
        candidates_discovered: metrics.candidatesDiscovered,
        candidates_examined: metrics.candidatesExamined,
        candidates_enriched: metrics.candidatesEnriched,
        candidates_rejected: metrics.candidatesRejected,
        publication_attempts: metrics.publicationAttempts,
        technical_failures: Math.max(1, metrics.technicalFailures),
      },
    }).then(() => { cycleClosed = true; }).catch(finalizeError => {
      console.error(`[Autonomous Curator] cycle finalization failed code=${safeCategoryFailureReason(finalizeError)}`);
    });
    throw error;
  } finally {
    if (!cycleClosed) {
      console.error(`[Autonomous Curator] cycle closure could not be persisted run=${runId} cycle=${cycleId}`);
    }
  }
}

export const autonomousCuratorContinuousV2Internals = {
  DAY_MS,
  QUEUE_CREATED_BY,
  QUEUE_NOTE_PREFIX,
  REVIEW_RECOVERY_PREFIX,
  dueForPublication,
  discoveryPage,
  discoveryPages,
  rotateQueries,
  trustedEvidenceOverride,
  similarityUniverse,
  queueNote,
  parseQueueNote,
  queueTarget,
  liveCatalogTarget,
  dailyTargetFromEnv,
  recoveryModeFromEnv,
  deficitCategoryScope,
  activePublishedCount,
  inventoryDeficit,
  dueForCycle,
  isTechnicalReviewFailure,
  revalidationPermanentFailure,
  safeCategoryFailureReason,
  semanticEntryScore,
  recoverySeedFromStored,
};
