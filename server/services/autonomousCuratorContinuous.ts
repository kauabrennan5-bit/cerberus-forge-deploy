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
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  type AutonomousCuratorCategoryProfile,
} from "./autonomousCuratorProfiles";
import {
  cheapProfileScore,
  hasBlockedProfileTerm,
  scoreAutonomousCandidate,
  type AutonomousCuratorScoreBreakdown,
} from "./autonomousCuratorScoring";

const QUEUE_CREATED_BY = "autonomous_curator_queue";
const QUEUE_NOTE_PREFIX = "AUTONOMOUS_CURATOR_QUEUE_V1:";
const COPY_MODEL_DEFAULT = "gemini-3.5-flash-lite";
const SATURATED_COPY_MODELS = new Set(["gemini-3.7-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
const DAY_MS = 24 * 60 * 60 * 1000;

type QueueMetadata = {
  score: number;
  profileVersion: string;
  queuedAt: string;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
};

type ContinuousCandidate = {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  affiliateUrl: string;
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

type DiscoveryResult = { candidate: ContinuousCandidate | null; reason: string; examined: number };

export type ContinuousCuratorCategoryResult = {
  category: PublicProductCategory;
  due: boolean;
  published: boolean;
  queued: boolean;
  score: number | null;
  title: string | null;
  reason: string;
  productId: string | null;
};

export type ContinuousCuratorResult = {
  cycleId: string;
  runId: string;
  runDate: string;
  status: "completed" | "partial" | "failed" | "disabled";
  publishedThisCycle: number;
  fulfilledCategories: number;
  queuedProducts: number;
  categories: ContinuousCuratorCategoryResult[];
};

type ContinuousOptions = {
  cycleId?: string;
  now?: Date;
  notify?: boolean;
  env?: NodeJS.ProcessEnv;
  shopeeClient?: ShopeeApiClient;
  extractor?: typeof extractProductForReview;
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

function resolveCopyModel(env: NodeJS.ProcessEnv): string {
  const explicit = String(env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || "").trim();
  if (explicit) return explicit;
  const configured = String(env.GEMINI_PRODUCT_CURATOR_MODEL || "").trim();
  if (!configured || SATURATED_COPY_MODELS.has(configured)) return COPY_MODEL_DEFAULT;
  return configured;
}

async function extractWithCuratorModel(
  rawUrl: string,
  env: NodeJS.ProcessEnv,
  extractor: typeof extractProductForReview,
): Promise<Awaited<ReturnType<typeof extractProductForReview>>> {
  const previous = process.env.GEMINI_PRODUCT_CURATOR_MODEL;
  process.env.GEMINI_PRODUCT_CURATOR_MODEL = resolveCopyModel(env);
  try {
    return await extractor(rawUrl);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_PRODUCT_CURATOR_MODEL;
    else process.env.GEMINI_PRODUCT_CURATOR_MODEL = previous;
  }
}

function extractorTimeoutMs(env: NodeJS.ProcessEnv): number {
  return positiveInt(env.AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT_MS, 45_000, 120_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function rotatedQueries(profile: AutonomousCuratorCategoryProfile, cycleKey: string): string[] {
  if (profile.queries.length <= 1) return [...profile.queries];
  const start = hashSeed(`${cycleKey}:${profile.category}`) % profile.queries.length;
  return [...profile.queries.slice(start), ...profile.queries.slice(0, start)];
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
      query: String(parsed.query),
      shopId: String(parsed.shopId),
      itemId: String(parsed.itemId),
      sourceProductUrl: String(parsed.sourceProductUrl),
    };
  } catch {
    return null;
  }
}

function dueForPublication(lastPublishedAt: string | null, now: Date): boolean {
  if (!lastPublishedAt) return true;
  const timestamp = Date.parse(lastPublishedAt);
  if (!Number.isFinite(timestamp)) return true;
  return now.getTime() - timestamp >= DAY_MS;
}

function revalidationPermanentFailure(reason: string): boolean {
  const transient = [
    "TIMEOUT", "RATE_LIMIT", "NETWORK", "TRANSIENT", "UNAVAILABLE", "MODEL_UNAVAILABLE",
    "IMAGE_FETCH_UNAVAILABLE", "AUTH_ERROR", "FORBIDDEN", "SHOPEE_SEARCH",
  ];
  return !transient.some(marker => reason.toUpperCase().includes(marker));
}

function buildShopeeClient(env: NodeJS.ProcessEnv): ShopeeApiClient | null {
  const appId = (env.SHOPEE_APP_ID || env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = (env.SHOPEE_APP_SECRET || env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  if (!appId || !secret) return null;
  return createShopeeApiClient({ appId, secret, baseUrl: env.SHOPEE_AFFILIATE_API_BASE_URL });
}

async function evaluateIdentity(input: {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  discoveryName?: string | null;
  discoveryPrice?: number | null;
  existingProducts: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
  allowedProductId?: string | null;
}): Promise<{ candidate: ContinuousCandidate | null; reason: string }> {
  const { shopId, itemId } = input;
  const sourceUrl = canonicalSourceUrl(shopId, itemId);
  const sourceIdentity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
  const reservedUntil = sourceIdentity?.reservedUntil ? Date.parse(sourceIdentity.reservedUntil) : 0;
  const ownedByOtherProduct = Boolean(sourceIdentity?.productId && sourceIdentity.productId !== input.allowedProductId);
  const activelyReserved = Boolean(
    sourceIdentity
    && !sourceIdentity.productId
    && Number.isFinite(reservedUntil)
    && reservedUntil > Date.now(),
  );
  if (ownedByOtherProduct || activelyReserved) return { candidate: null, reason: "SOURCE_IDENTITY_ALREADY_OWNED" };

  const acquisition = await input.client.acquireAffiliateLink({ shopId, itemId });
  if (acquisition.status !== "link_acquired" || !acquisition.affiliateUrl || !acquisition.productLink || !acquisition.shopId || !acquisition.itemId) {
    return { candidate: null, reason: `AFFILIATE_${acquisition.status}` };
  }
  if (acquisition.shopId !== shopId || acquisition.itemId !== itemId || !sourceIdentityMatches(acquisition.productLink, shopId, itemId)) {
    return { candidate: null, reason: "AFFILIATE_IDENTITY_MISMATCH" };
  }

  let extracted: Awaited<ReturnType<typeof extractProductForReview>>;
  try {
    extracted = await withTimeout(
      extractWithCuratorModel(acquisition.productLink, input.env, input.extractor),
      extractorTimeoutMs(input.env),
      "AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT",
    );
  } catch (error) {
    return { candidate: null, reason: error instanceof Error ? error.message : "EXTRACTION_FAILED" };
  }
  if (!extracted.success || !extracted.data) return { candidate: null, reason: `EXTRACTION_${extracted.error || "failed"}` };
  const data = extracted.data;
  if (!sourceIdentityMatches(data.normalizedUrl, shopId, itemId)) return { candidate: null, reason: "SCRAPER_IDENTITY_MISMATCH" };

  const rawTitle = (data.rawTitle || data.produto || input.discoveryName || acquisition.name || "").trim();
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
      : Number.isFinite(discoveryPrice) && discoveryPrice > 0
        ? discoveryPrice
        : Number.NaN;
  const imageCuration = data.imageCuration;
  const image = resolveCanonicalProductImage({ imagens: data.imagens, imageCuration, imageEditorialStatus: data.imageEditorialStatus });

  const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);
  if (blocked) return { candidate: null, reason: `PROFILE_BLOCKED_TERM:${blocked}` };
  if (!displayTitle || displayTitle === rawTitle || description.length < 24) return { candidate: null, reason: "EDITORIAL_COPY_INCOMPLETE" };
  if (category !== input.profile.category) return { candidate: null, reason: `CATEGORY_MISMATCH:${category || "unknown"}` };
  if (!Number.isFinite(price) || price <= 0) return { candidate: null, reason: "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK" };
  if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl) {
    return { candidate: null, reason: `IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR:${imageCuration?.reason || "unknown"}` };
  }

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
    existingProducts: input.existingProducts,
  });
  if (breakdown.maximumCatalogSimilarity >= 0.82) return { candidate: null, reason: `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}` };
  if (!input.config.autoPublishEnabled || breakdown.finalScore < input.config.autoPublishThreshold) {
    return { candidate: null, reason: `BELOW_AUTO_PUBLISH_THRESHOLD:${breakdown.finalScore}` };
  }

  return {
    candidate: {
      profile: input.profile,
      query: input.query,
      shopId,
      itemId,
      sourceProductUrl: sourceUrl,
      affiliateUrl: acquisition.affiliateUrl,
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

async function discoverQualifiedCandidate(input: {
  profile: AutonomousCuratorCategoryProfile;
  cycleKey: string;
  existingProducts: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
}): Promise<DiscoveryResult> {
  let examined = 0;
  let lastReason = "NO_QUALIFIED_CANDIDATE_THIS_CYCLE";
  const queries = rotatedQueries(input.profile, input.cycleKey);
  for (const query of queries) {
    if (examined >= input.config.maxEnrichPerCategory) break;
    const search = await input.client.searchOffers({ query, limit: input.config.maxSearchCandidates });
    if (!search.ok) {
      lastReason = `SHOPEE_SEARCH:${search.reason || "failed"}`;
      if (["SHOPEE_AUTH_ERROR", "SHOPEE_FORBIDDEN", "SHOPEE_RATE_LIMITED"].includes(String(search.reason))) break;
      continue;
    }
    const ranked = [...search.items]
      .filter(item => item.shopId && item.itemId && item.productLink && item.name)
      .map(item => ({ item, cheap: cheapProfileScore(input.profile, item.name || "") }))
      .filter(entry => entry.cheap > -1000)
      .sort((a, b) => b.cheap - a.cheap || String(a.item.itemId).localeCompare(String(b.item.itemId)));
    for (const entry of ranked) {
      if (examined >= input.config.maxEnrichPerCategory) break;
      const item = entry.item;
      const shopId = String(item.shopId);
      const itemId = String(item.itemId);
      const identity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
      const reservedUntil = identity?.reservedUntil ? Date.parse(identity.reservedUntil) : 0;
      if (identity?.productId || (identity && Number.isFinite(reservedUntil) && reservedUntil > Date.now())) continue;
      examined += 1;
      const evaluated = await evaluateIdentity({
        profile: input.profile,
        query,
        shopId,
        itemId,
        discoveryName: item.name,
        discoveryPrice: item.price,
        existingProducts: input.existingProducts,
        client: input.client,
        env: input.env,
        extractor: input.extractor,
        config: input.config,
      });
      lastReason = evaluated.reason;
      if (evaluated.candidate) return { candidate: evaluated.candidate, reason: evaluated.reason, examined };
    }
  }
  return { candidate: null, reason: `${lastReason};SEARCH_CONTINUES_NEXT_HOURLY_CYCLE`, examined };
}

async function claimQueueIdentity(candidate: ContinuousCandidate, productId: string): Promise<boolean> {
  const client = requireSupabase();
  const { error } = await client.from("product_source_identities").insert({
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

async function persistPausedCandidate(candidate: ContinuousCandidate, now: Date, env: NodeJS.ProcessEnv): Promise<Product | null> {
  const client = requireSupabase();
  if (await curatorRepo.findProductSourceIdentity("Shopee", candidate.shopId, candidate.itemId)) return null;
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const productId = `prod-${now.getTime()}-${suffix}`;
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: now.toISOString(),
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
  };
  if (!(await claimQueueIdentity(candidate, productId))) return null;
  const slug = `${generateSlug(candidate.displayTitle)}-${suffix.slice(0, 6)}`;
  const model = env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "gemini-3.5-flash-lite";
  const curatorNote = queueNote(meta);
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
    curator_note: curatorNote,
    image_editorial_status: "clean",
    image_curation: candidate.imageCuration,
    image_reviewed_at: now.toISOString(),
    image_review_model: model,
    image_review_version: "1.1",
    display_title_status: "reviewed",
    display_title_reviewed_at: now.toISOString(),
    display_title_review_model: resolveCopyModel(env),
    display_title_review_version: "1.0",
  });
  if (error) {
    await client.from("product_source_identities").delete().eq("marketplace", "Shopee").eq("shop_id", candidate.shopId).eq("item_id", candidate.itemId).eq("product_id", productId);
    throw error;
  }
  try {
    await curatorRepo.saveProductImageEditorialReview({ productId, curation: candidate.imageCuration, model, reviewVersion: "1.1" });
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
    curatorNote,
    createdAt: now.toISOString(),
  };
}

function queuedForCategory(products: readonly Product[], category: PublicProductCategory): Product[] {
  return products
    .filter(product => product.createdBy === QUEUE_CREATED_BY && product.categoria === category && product.status === "paused" && product.ativo === false && parseQueueNote(product.curatorNote))
    .sort((a, b) => {
      const aScore = parseQueueNote(a.curatorNote)?.score || 0;
      const bScore = parseQueueNote(b.curatorNote)?.score || 0;
      return bScore - aScore || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
}

async function archiveQueueProduct(productId: string): Promise<void> {
  const { error } = await requireSupabase().from("products").update({ ativo: false, status: "archived" }).eq("id", productId);
  if (error) throw error;
}

async function maybeQueueCandidate(candidate: ContinuousCandidate, products: Product[], now: Date, env: NodeJS.ProcessEnv): Promise<{ queued: boolean; product: Product | null; reason: string }> {
  const categoryQueue = queuedForCategory(products, candidate.category);
  const target = queueTarget(env);
  if (categoryQueue.length >= target) {
    const weakest = [...categoryQueue].sort((a, b) => (parseQueueNote(a.curatorNote)?.score || 0) - (parseQueueNote(b.curatorNote)?.score || 0))[0];
    const weakestScore = parseQueueNote(weakest?.curatorNote)?.score || 0;
    if (candidate.score <= weakestScore) return { queued: false, product: null, reason: `QUEUE_FULL_STRONGER_OR_EQUAL:${weakestScore}` };
    if (weakest) {
      await archiveQueueProduct(weakest.id);
      weakest.status = "archived";
    }
  }
  const persisted = await persistPausedCandidate(candidate, now, env);
  if (!persisted) return { queued: false, product: null, reason: "QUEUE_IDENTITY_ALREADY_OWNED" };
  products.unshift(persisted);
  return { queued: true, product: persisted, reason: "QUEUED_PAUSED_FOR_FUTURE_PUBLICATION" };
}

async function refreshQueuedCandidate(input: {
  product: Product;
  profile: AutonomousCuratorCategoryProfile;
  existingProducts: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  config: curatorRepo.AutonomousCuratorConfig;
}): Promise<{ candidate: ContinuousCandidate | null; reason: string }> {
  const client = requireSupabase();
  const { data: identities, error } = await client.from("product_source_identities")
    .select("shop_id,item_id,source_product_url")
    .eq("marketplace", "Shopee")
    .eq("product_id", input.product.id)
    .limit(1);
  if (error) throw error;
  const identity = Array.isArray(identities) ? identities[0] : null;
  if (!identity?.shop_id || !identity?.item_id) return { candidate: null, reason: "QUEUE_SOURCE_IDENTITY_MISSING" };
  const others = input.existingProducts.filter(product => product.id !== input.product.id);
  const meta = parseQueueNote(input.product.curatorNote);
  return evaluateIdentity({
    profile: input.profile,
    query: meta?.query || input.product.produto,
    shopId: String(identity.shop_id),
    itemId: String(identity.item_id),
    discoveryName: input.product.rawTitle || input.product.produto,
    discoveryPrice: input.product.preco,
    existingProducts: others,
    client: input.client,
    env: input.env,
    extractor: input.extractor,
    config: input.config,
    allowedProductId: input.product.id,
  });
}

async function lastActivePublishedAt(category: PublicProductCategory, products: readonly Product[]): Promise<string | null> {
  const activeIds = new Set(
    products
      .filter(product => product.ativo !== false && product.status === "published" && product.categoria === category)
      .map(product => product.id),
  );
  if (activeIds.size === 0) return null;
  const client = requireSupabase();
  const { data, error } = await client.from("autonomous_curator_candidates")
    .select("updated_at,product_id")
    .eq("category", category)
    .eq("decision", "auto_published")
    .not("product_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  for (const row of data || []) {
    if (row.product_id && activeIds.has(String(row.product_id))) return String(row.updated_at);
  }
  return null;
}

async function markCycleStarted(runId: string, cycleId: string, now: Date): Promise<void> {
  const client = requireSupabase();
  const { data, error: readError } = await client.from("autonomous_curator_runs").select("metadata").eq("id", runId).single();
  if (readError) throw readError;
  const metadata = data?.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  const { error } = await client.from("autonomous_curator_runs").update({
    status: "running",
    profile_version: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    completed_at: null,
    metadata: {
      ...metadata,
      profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
      continuous: true,
      continuous_cycle_id: cycleId,
      continuous_cycle_started_at: now.toISOString(),
      continuous_cycle_completed_at: null,
    },
  }).eq("id", runId);
  if (error) throw error;
}

async function stagePublication(runId: string, candidate: ContinuousCandidate, productId: string): Promise<void> {
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
    decision: "auto_selected",
    reason: "CONTINUOUS_QUEUE_SELECTED_FOR_PUBLICATION",
    productId,
  });
}

async function updateQueuedProductFromCandidate(
  productId: string,
  candidate: ContinuousCandidate,
  now: Date,
  env: NodeJS.ProcessEnv,
  status: "paused" | "published",
): Promise<void> {
  const existing = await requireSupabase().from("products").select("created_at,curator_note").eq("id", productId).single();
  if (existing.error) throw existing.error;
  const previousMeta = parseQueueNote(existing.data?.curator_note);
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: previousMeta?.queuedAt || String(existing.data?.created_at || now.toISOString()),
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
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
    image_review_model: env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "gemini-3.5-flash-lite",
    image_review_version: "1.1",
    ativo: status === "published",
    status,
  }).eq("id", productId);
  if (error) throw error;
}

async function markPublished(runId: string, candidate: ContinuousCandidate, productId: string): Promise<void> {
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
    reason: "PUBLISHED_FROM_CONTINUOUS_CURATOR_AND_PUBLICLY_VALIDATED",
    productId,
  });
}

function adminChatId(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

async function notifyResult(result: ContinuousCuratorResult, env: NodeJS.ProcessEnv): Promise<void> {
  const chatId = adminChatId(env);
  if (!chatId) return;
  const lines = result.categories.map(item => `${item.published ? "✅" : item.queued ? "⏸️" : item.due ? "🔎" : "🗂️"} <b>${item.category}</b>: ${item.title || item.reason}${item.score === null ? "" : ` · ${item.score}/100`}`);
  const text = [
    "🧠 <b>CERBERUS CONTINUOUS CURATOR</b>",
    "",
    `Ciclo: <code>${result.cycleId}</code>`,
    `Publicados neste ciclo: <b>${result.publishedThisCycle}</b> · categorias dentro da janela: <b>${result.fulfilledCategories}/10</b>`,
    `Fila pausada: <b>${result.queuedProducts}</b> produtos qualificados`,
    "",
    ...lines,
    "",
    result.status === "completed"
      ? "As 10 categorias estão cobertas; a busca continua abastecendo e melhorando a fila futura."
      : "Categorias ainda sem produto seguem em busca automática no próximo ciclo horário; nenhum gate é reduzido para preencher a meta.",
  ].join("\n");
  await sendTelegramMessage(chatId, text).catch(() => undefined);
}

export async function runAutonomousCuratorContinuous(options: ContinuousOptions = {}): Promise<ContinuousCuratorResult> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const cycleId = options.cycleId || `continuous-${randomUUID()}`;
  const runDate = localRunDate(now);
  const config = await curatorRepo.getAutonomousCuratorConfig();
  if (!config.enabled) {
    return { cycleId, runId: "", runDate, status: "disabled", publishedThisCycle: 0, fulfilledCategories: 0, queuedProducts: 0, categories: [] };
  }
  const shopeeClient = options.shopeeClient || buildShopeeClient(env);
  if (!shopeeClient) throw new Error("AUTONOMOUS_CURATOR_SHOPEE_NOT_CONFIGURED");
  const extractor = options.extractor || extractProductForReview;
  const open = await curatorRepo.openAutonomousCuratorRun({
    runDate,
    dryRun: false,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    categoriesTotal: AUTONOMOUS_CURATOR_PROFILES.length,
  });
  const runId = open.run.id;
  await markCycleStarted(runId, cycleId, now);

  let products = await productsRepository.getProducts();
  const categoryResults: ContinuousCuratorCategoryResult[] = [];
  const pendingPublications: Array<{ product: Product; candidate: ContinuousCandidate }> = [];
  let cycleFailed = false;

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    try {
      const lastPublishedAt = await lastActivePublishedAt(profile.category, products);
      const due = dueForPublication(lastPublishedAt, now);
      let published = false;
      let queued = false;
      let score: number | null = null;
      let title: string | null = null;
      let productId: string | null = null;
      let reason = due
        ? "SEARCHING_FOR_DUE_PRODUCT"
        : `COOLDOWN_UNTIL_${new Date(Date.parse(lastPublishedAt || now.toISOString()) + DAY_MS).toISOString()}`;
      let discoveredDuringDue: ContinuousCandidate | null = null;

      if (due) {
        for (const queuedProduct of queuedForCategory(products, profile.category)) {
          const refreshed = await refreshQueuedCandidate({
            product: queuedProduct,
            profile,
            existingProducts: products,
            client: shopeeClient,
            env,
            extractor,
            config,
          });
          if (!refreshed.candidate) {
            reason = `QUEUE_REVALIDATION_REJECTED:${refreshed.reason}`;
            if (revalidationPermanentFailure(refreshed.reason)) {
              await archiveQueueProduct(queuedProduct.id);
              queuedProduct.status = "archived";
            }
            continue;
          }
          await stagePublication(runId, refreshed.candidate, queuedProduct.id);
          await updateQueuedProductFromCandidate(queuedProduct.id, refreshed.candidate, now, env, "published");
          queuedProduct.ativo = true;
          queuedProduct.status = "published";
          queuedProduct.produto = refreshed.candidate.displayTitle;
          queuedProduct.preco = refreshed.candidate.price;
          queuedProduct.link = refreshed.candidate.affiliateUrl;
          pendingPublications.push({ product: queuedProduct, candidate: refreshed.candidate });
          published = true;
          score = refreshed.candidate.score;
          title = refreshed.candidate.displayTitle;
          productId = queuedProduct.id;
          reason = "PENDING_PUBLIC_CATALOG_VALIDATION_FROM_QUEUE";
          break;
        }

        if (!published) {
          const discovery = await discoverQualifiedCandidate({
            profile,
            cycleKey: `${cycleId}:due`,
            existingProducts: products,
            client: shopeeClient,
            env,
            extractor,
            config,
          });
          if (discovery.candidate) {
            discoveredDuringDue = discovery.candidate;
            const queuedResult = await maybeQueueCandidate(discovery.candidate, products, now, env);
            if (queuedResult.product) {
              await stagePublication(runId, discovery.candidate, queuedResult.product.id);
              await updateQueuedProductFromCandidate(queuedResult.product.id, discovery.candidate, now, env, "published");
              queuedResult.product.ativo = true;
              queuedResult.product.status = "published";
              pendingPublications.push({ product: queuedResult.product, candidate: discovery.candidate });
              published = true;
              score = discovery.candidate.score;
              title = discovery.candidate.displayTitle;
              productId = queuedResult.product.id;
              reason = "PENDING_PUBLIC_CATALOG_VALIDATION_FROM_DISCOVERY";
            } else {
              reason = queuedResult.reason;
            }
          } else {
            reason = discovery.reason;
            await curatorRepo.saveAutonomousCuratorCategoryResult({
              runId,
              category: profile.category,
              searchQuery: rotatedQueries(profile, cycleId)[0] || "continuous",
              decision: "no_candidate",
              reason,
            });
          }
        }
      }

      // A publicação não encerra a curadoria. Em todos os ciclos seguintes,
      // inclusive durante o cooldown de 24h, uma nova opção qualificada pode
      // entrar na fila pausada para dias futuros.
      if (!discoveredDuringDue) {
        const discovery = await discoverQualifiedCandidate({
          profile,
          cycleKey: `${cycleId}:future`,
          existingProducts: products,
          client: shopeeClient,
          env,
          extractor,
          config,
        });
        if (discovery.candidate) {
          const queuedResult = await maybeQueueCandidate(discovery.candidate, products, now, env);
          queued = queuedResult.queued;
          if (!published && !due && queuedResult.product) {
            score = discovery.candidate.score;
            title = discovery.candidate.displayTitle;
            productId = queuedResult.product.id;
          }
          if (!due || reason.startsWith("COOLDOWN_")) reason = queuedResult.reason;
        } else if (!due || reason.startsWith("COOLDOWN_")) {
          reason = discovery.reason;
        }
      }

      categoryResults.push({ category: profile.category, due, published, queued, score, title, reason, productId });
    } catch (error) {
      cycleFailed = true;
      categoryResults.push({
        category: profile.category,
        due: true,
        published: false,
        queued: false,
        score: null,
        title: null,
        productId: null,
        reason: error instanceof Error ? error.message.slice(0, 160) : "CONTINUOUS_CATEGORY_FAILED",
      });
    }
  }

  if (pendingPublications.length > 0) {
    const sync = await syncCatalogAndDeploy("continuous autonomous curator");
    if (!sync.success) {
      cycleFailed = true;
      for (const item of pendingPublications) {
        await requireSupabase().from("products").update({ ativo: false, status: "paused" }).eq("id", item.product.id);
        const categoryResult = categoryResults.find(result => result.category === item.candidate.category);
        if (categoryResult) {
          categoryResult.published = false;
          categoryResult.queued = true;
          categoryResult.reason = `CATALOG_SYNC_FAILED:${sync.error || "unknown"}`;
        }
        await curatorRepo.saveAutonomousCuratorCategoryResult({
          runId,
          category: item.candidate.category,
          searchQuery: item.candidate.query,
          shopId: item.candidate.shopId,
          itemId: item.candidate.itemId,
          sourceProductUrl: item.candidate.sourceProductUrl,
          rawTitle: item.candidate.rawTitle,
          displayTitle: item.candidate.displayTitle,
          score: item.candidate.score,
          scoreBreakdown: item.candidate.breakdown as unknown as Record<string, unknown>,
          decision: "failed",
          reason: `CATALOG_SYNC_FAILED:${sync.error || "unknown"}`,
          productId: item.product.id,
        });
      }
      await syncCatalogAndDeploy("continuous autonomous curator rollback").catch(() => undefined);
    } else {
      for (const item of pendingPublications) {
        await markPublished(runId, item.candidate, item.product.id);
        const categoryResult = categoryResults.find(result => result.category === item.candidate.category);
        if (categoryResult) categoryResult.reason = "PUBLISHED_AND_PUBLICLY_VALIDATED";
      }
    }
  }

  products = await productsRepository.getProducts();
  let fulfilled = 0;
  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    const last = await lastActivePublishedAt(profile.category, products);
    if (last && !dueForPublication(last, now)) fulfilled += 1;
  }
  const queuedProducts = products.filter(
    product => product.createdBy === QUEUE_CREATED_BY
      && product.status === "paused"
      && product.ativo === false
      && Boolean(parseQueueNote(product.curatorNote)),
  ).length;
  const publishedThisCycle = categoryResults.filter(result => result.published && result.reason === "PUBLISHED_AND_PUBLICLY_VALIDATED").length;
  const status: ContinuousCuratorResult["status"] = cycleFailed
    ? (fulfilled > 0 ? "partial" : "failed")
    : fulfilled === AUTONOMOUS_CURATOR_PROFILES.length ? "completed" : "partial";

  await curatorRepo.finishAutonomousCuratorRun({
    runId,
    status: status === "completed" ? "completed" : status === "failed" ? "failed" : "partial",
    categoriesProcessed: AUTONOMOUS_CURATOR_PROFILES.length,
    autoPublished: fulfilled,
    reviewRequired: 0,
    rejected: AUTONOMOUS_CURATOR_PROFILES.length - fulfilled,
    failed: cycleFailed ? categoryResults.filter(item => /FAILED|ERROR/.test(item.reason)).length : 0,
    metadata: {
      profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
      continuous: true,
      continuous_cycle_id: cycleId,
      continuous_cycle_started_at: now.toISOString(),
      continuous_cycle_completed_at: new Date().toISOString(),
      fulfilled_categories: fulfilled,
      queued_products: queuedProducts,
      queue_target_per_category: queueTarget(env),
    },
  });

  const result: ContinuousCuratorResult = {
    cycleId,
    runId,
    runDate,
    status,
    publishedThisCycle,
    fulfilledCategories: fulfilled,
    queuedProducts,
    categories: categoryResults,
  };
  if (options.notify !== false) await notifyResult(result, env);
  return result;
}

export const autonomousCuratorContinuousInternals = {
  DAY_MS,
  QUEUE_CREATED_BY,
  QUEUE_NOTE_PREFIX,
  dueForPublication,
  queueNote,
  parseQueueNote,
  rotatedQueries,
  queueTarget,
  revalidationPermanentFailure,
};
