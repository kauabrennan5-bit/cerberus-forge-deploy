import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
import { resolvePublicProductCategory, type PublicProductCategory } from "../../src/lib/productCategory";
import { generateSlug } from "../../src/data/initialProducts";
import type { ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  type AutonomousCuratorCategoryProfile,
} from "./autonomousCuratorProfiles";
import { cheapProfileScore, hasBlockedProfileTerm } from "./autonomousCuratorScoring";
import {
  qualifyOfficialShopeeImage,
  type ShopeeImageQualification,
} from "./shopeeCandidateQualification";
import { validateOfficialProductLink } from "./shopeeProviderRuntime";
import { syncCatalogAndDeploy } from "./catalogSync";
import {
  IMAGE_REVIEW_VERSION,
  imageCurationFingerprint,
} from "./productEditorialReview";
import {
  AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY,
  AUTONOMOUS_CURATOR_FLOOR_FALLBACK_VERSION,
} from "./autonomousCuratorCatalogFloorPolicy";

const SEARCH_LIMIT = 10;
const MAX_POOL_PER_CATEGORY = 30;
const MAX_QUERIES_PER_CATEGORY = 6;
const FLOOR_NOTE_PREFIX = "AUTONOMOUS_CURATOR_QUEUE_V1:";

export type CatalogFloorFallbackWarning = {
  productId: string;
  category: PublicProductCategory;
  warnings: string[];
};

export type CatalogFloorFallbackCategoryResult = {
  category: PublicProductCategory;
  requested: number;
  published: number;
  received: number;
  technicallyExamined: number;
  reasons: Record<string, number>;
  productIds: string[];
};

export type CatalogFloorFallbackResult = {
  attempted: boolean;
  targetPerCategory: number;
  publishedIds: string[];
  warnings: CatalogFloorFallbackWarning[];
  categories: CatalogFloorFallbackCategoryResult[];
  syncSuccess: boolean;
  syncError: string | null;
};

type SearchOfferItem = Awaited<ReturnType<ShopeeApiClient["searchOffers"]>>["items"][number];

type RankedOffer = {
  item: SearchOfferItem;
  query: string;
  queryIndex: number;
  cheapScore: number;
  inferredCategory: string;
  rankScore: number;
};

type PersistableFloorCandidate = {
  category: PublicProductCategory;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  affiliateUrl: string;
  rawTitle: string;
  price: number;
  imageUrl: string;
  imageQualification: ShopeeImageQualification;
  warnings: string[];
  score: number;
};

function increment(counts: Record<string, number>, reason: string): void {
  const key = String(reason || "UNKNOWN").slice(0, 120);
  counts[key] = (counts[key] || 0) + 1;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function activePublishedCount(products: readonly Product[], category: PublicProductCategory): number {
  return products.filter(product => product.categoria === category && product.status === "published" && product.ativo !== false).length;
}

function categoryDeficit(products: readonly Product[], category: PublicProductCategory, target: number): number {
  return Math.max(0, target - activePublishedCount(products, category));
}

function rankOffer(profile: AutonomousCuratorCategoryProfile, item: SearchOfferItem, query: string, queryIndex: number): RankedOffer {
  const title = String(item.name || "").trim();
  const cheapScore = title ? cheapProfileScore(profile, title) : -1000;
  const inferredCategory = title ? resolvePublicProductCategory("", { title }) : "";
  const exactCategoryBonus = inferredCategory === profile.category ? 500 : inferredCategory ? -160 : 0;
  const lexical = cheapScore > -1000 ? Math.max(-100, Math.min(400, cheapScore)) : -500;
  const queryBonus = Math.max(0, 30 - queryIndex * 4);
  const price = Number(item.price);
  const priceBonus = Number.isFinite(price) && price > 0
    ? price <= profile.maxAutoPrice ? 40 : price <= profile.maxReviewPrice ? 15 : -25
    : -80;
  const imageBonus = isHttpsUrl(item.imageUrl) ? 30 : -120;
  return {
    item,
    query,
    queryIndex,
    cheapScore,
    inferredCategory,
    rankScore: exactCategoryBonus + lexical + queryBonus + priceBonus + imageBonus,
  };
}

async function collectRankedPool(
  profile: AutonomousCuratorCategoryProfile,
  client: ShopeeApiClient,
  reasons: Record<string, number>,
): Promise<{ ranked: RankedOffer[]; received: number }> {
  const seen = new Set<string>();
  const pool: RankedOffer[] = [];
  let received = 0;
  const queries = [...new Set(profile.queries.map(query => query.trim()).filter(Boolean))].slice(0, MAX_QUERIES_PER_CATEGORY);

  for (let queryIndex = 0; queryIndex < queries.length && pool.length < MAX_POOL_PER_CATEGORY; queryIndex += 1) {
    const query = queries[queryIndex];
    const response = await client.searchOffers({ query, limit: SEARCH_LIMIT, page: 1 });
    if (!response.ok) {
      increment(reasons, `SHOPEE_SEARCH:${response.reason || "failed"}`);
      continue;
    }
    received += response.items.length;
    for (const item of response.items) {
      const shopId = String(item.shopId || "").trim();
      const itemId = String(item.itemId || "").trim();
      const title = String(item.name || "").trim();
      if (!shopId || !itemId || !title) {
        increment(reasons, "IDENTITY_OR_TITLE_MISSING");
        continue;
      }
      if (hasBlockedProfileTerm(profile, title)) {
        increment(reasons, "PROFILE_BLOCKED_TERM");
        continue;
      }
      const identityKey = `${shopId}:${itemId}`;
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);
      pool.push(rankOffer(profile, item, query, queryIndex));
      if (pool.length >= MAX_POOL_PER_CATEGORY) break;
    }
  }

  pool.sort((left, right) =>
    right.rankScore - left.rankScore
    || right.cheapScore - left.cheapScore
    || Number(left.item.price || Number.POSITIVE_INFINITY) - Number(right.item.price || Number.POSITIVE_INFINITY)
    || String(left.item.itemId).localeCompare(String(right.item.itemId)),
  );
  return { ranked: pool, received };
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

function buildWarnings(profile: AutonomousCuratorCategoryProfile, offer: RankedOffer, qualification: ShopeeImageQualification, price: number): string[] {
  const warnings: string[] = [];
  if (offer.inferredCategory && offer.inferredCategory !== profile.category) warnings.push(`CATEGORY_MISMATCH:${offer.inferredCategory}`);
  if (offer.cheapScore <= -1000) warnings.push("PROFILE_LEXICAL_GATE_FAILED");
  if (price > profile.maxReviewPrice) warnings.push(`PRICE_ABOVE_REVIEW_PROFILE:${profile.maxReviewPrice}`);
  if (qualification.state !== "QUALIFIED") warnings.push(qualification.reason || qualification.state);
  return [...new Set(warnings)];
}

async function qualifyTechnicalCandidate(input: {
  profile: AutonomousCuratorCategoryProfile;
  offer: RankedOffer;
  client: ShopeeApiClient;
  reasons: Record<string, number>;
}): Promise<PersistableFloorCandidate | null> {
  const shopId = String(input.offer.item.shopId || "").trim();
  const itemId = String(input.offer.item.itemId || "").trim();
  const imageUrl = String(input.offer.item.imageUrl || "").trim();
  if (!shopId || !itemId) {
    increment(input.reasons, "IDENTITY_MISSING");
    return null;
  }
  if (!isHttpsUrl(imageUrl)) {
    increment(input.reasons, "IMAGE_URL_TECHNICALLY_UNUSABLE");
    return null;
  }

  const existingIdentity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
  if (existingIdentity) {
    increment(input.reasons, "SOURCE_IDENTITY_ALREADY_OWNED");
    return null;
  }

  const acquisition = await input.client.acquireAffiliateLink({ shopId, itemId });
  if (
    acquisition.status !== "link_acquired"
    || !acquisition.productLink
    || !acquisition.affiliateUrl
    || acquisition.shopId !== shopId
    || acquisition.itemId !== itemId
    || !validateOfficialProductLink(acquisition.productLink, shopId, itemId)
    || !isHttpsUrl(acquisition.affiliateUrl)
  ) {
    increment(input.reasons, `AFFILIATE_${acquisition.status}`);
    return null;
  }

  const price = Number(acquisition.price ?? input.offer.item.price);
  if (!Number.isFinite(price) || price <= 0) {
    increment(input.reasons, "PRICE_UNVERIFIED");
    return null;
  }

  let qualification: ShopeeImageQualification;
  try {
    qualification = await qualifyOfficialShopeeImage(imageUrl, acquisition.name || input.offer.item.name || "");
  } catch {
    increment(input.reasons, "IMAGE_TECHNICAL_REVIEW_UNAVAILABLE");
    return null;
  }
  // A broken/unreachable image is a technical publication failure. Editorial
  // decisions are deliberately NOT a hard gate here.
  if (!qualification.probe.ok) {
    increment(input.reasons, qualification.probe.reason || "IMAGE_TECHNICALLY_UNUSABLE");
    return null;
  }

  const rawTitle = String(acquisition.name || input.offer.item.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!rawTitle) {
    increment(input.reasons, "TITLE_MISSING");
    return null;
  }

  const warnings = buildWarnings(input.profile, input.offer, qualification, price);
  return {
    category: input.profile.category,
    query: input.offer.query,
    shopId,
    itemId,
    sourceProductUrl: acquisition.productLink,
    affiliateUrl: acquisition.affiliateUrl,
    rawTitle,
    price,
    imageUrl,
    imageQualification: qualification,
    warnings,
    score: input.offer.rankScore + Math.max(0, qualification.visualScore),
  };
}

function floorQueueNote(candidate: PersistableFloorCandidate, now: Date): string {
  return `${FLOOR_NOTE_PREFIX}${JSON.stringify({
    score: candidate.score,
    profileVersion: `${AUTONOMOUS_CURATOR_PROFILE_VERSION}-floor-${AUTONOMOUS_CURATOR_FLOOR_FALLBACK_VERSION}`,
    queuedAt: now.toISOString(),
    publishedAt: now.toISOString(),
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    imageUrl: candidate.imageUrl,
    fallback: true,
    warnings: candidate.warnings,
  })}`;
}

async function persistPausedFallback(candidate: PersistableFloorCandidate, now: Date, env: NodeJS.ProcessEnv): Promise<string | null> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const productId = `floor-${now.getTime()}-${suffix}`;
  const ref = `FLOOR-${suffix.toUpperCase()}`;
  const imageCuration = buildImageCuration(candidate.imageUrl, candidate.imageQualification);
  const cleanImage = candidate.imageQualification.state === "QUALIFIED";
  const reviewModel = env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite";

  const { error: identityError } = await requireSupabase().from("product_source_identities").insert({
    marketplace: "Shopee",
    shop_id: candidate.shopId,
    item_id: candidate.itemId,
    source_product_url: candidate.sourceProductUrl,
    product_id: productId,
    review_id: null,
    source: AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY,
    reserved_run_id: null,
    reserved_until: null,
  });
  if (identityError) {
    if ((identityError as { code?: string }).code === "23505") return null;
    throw identityError;
  }

  const row: Record<string, unknown> = {
    id: productId,
    ref,
    produto: candidate.rawTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: [candidate.imageUrl],
    link: candidate.affiliateUrl,
    ativo: false,
    destaque: false,
    status: "paused",
    created_by: AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY,
    slug: `${generateSlug(candidate.rawTitle)}-${suffix.slice(0, 6)}`,
    descricao: "",
    pagina_ponte_url: "",
    oferta_promocional: null,
    raw_title: candidate.rawTitle,
    display_title: null,
    display_title_status: "review_required",
    display_title_reviewed_at: null,
    display_title_review_model: null,
    display_title_review_version: null,
    curator_note: floorQueueNote(candidate, now),
    image_editorial_status: cleanImage ? "clean" : "review_required",
    image_curation: imageCuration,
    image_reviewed_at: cleanImage ? now.toISOString() : null,
    image_review_model: cleanImage ? reviewModel : null,
    image_review_version: cleanImage ? IMAGE_REVIEW_VERSION : null,
    image_review_fingerprint: cleanImage ? imageCurationFingerprint(imageCuration) : null,
    created_at: now.toISOString(),
  };

  const { error } = await requireSupabase().from("products").insert(row);
  if (error) {
    await requireSupabase().from("product_source_identities").delete()
      .eq("marketplace", "Shopee")
      .eq("shop_id", candidate.shopId)
      .eq("item_id", candidate.itemId)
      .eq("product_id", productId);
    throw error;
  }

  await curatorRepo.saveProductImageEditorialReview({
    productId,
    curation: imageCuration,
    model: reviewModel,
    reviewVersion: IMAGE_REVIEW_VERSION,
  }).catch(error => console.warn(`[Catalog Floor Fallback] image audit failed product=${productId}`, error));
  return productId;
}

async function setPublished(ids: readonly string[], published: boolean): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await requireSupabase().from("products")
    .update({ ativo: published, status: published ? "published" : "paused" })
    .in("id", [...new Set(ids)]);
  if (error) throw error;
}

export async function fillAutonomousCatalogFloor(input: {
  targetPerCategory: number;
  client: ShopeeApiClient;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogFloorFallbackResult> {
  const targetPerCategory = Math.max(1, Math.floor(input.targetPerCategory));
  const now = input.now || new Date();
  const env = input.env || process.env;
  let products = await productsRepository.getProducts();
  const publishedIds: string[] = [];
  const warnings: CatalogFloorFallbackWarning[] = [];
  const categories: CatalogFloorFallbackCategoryResult[] = [];

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    const requested = categoryDeficit(products, profile.category, targetPerCategory);
    const reasons: Record<string, number> = {};
    const categoryResult: CatalogFloorFallbackCategoryResult = {
      category: profile.category,
      requested,
      published: 0,
      received: 0,
      technicallyExamined: 0,
      reasons,
      productIds: [],
    };
    categories.push(categoryResult);
    if (requested <= 0) continue;

    const pool = await collectRankedPool(profile, input.client, reasons);
    categoryResult.received = pool.received;
    for (const offer of pool.ranked) {
      if (categoryResult.productIds.length >= requested) break;
      categoryResult.technicallyExamined += 1;
      const candidate = await qualifyTechnicalCandidate({ profile, offer, client: input.client, reasons });
      if (!candidate) continue;
      const productId = await persistPausedFallback(candidate, now, env);
      if (!productId) {
        increment(reasons, "SOURCE_IDENTITY_RACE_LOST");
        continue;
      }
      categoryResult.productIds.push(productId);
      publishedIds.push(productId);
      warnings.push({ productId, category: profile.category, warnings: candidate.warnings });
      // Keep the in-memory count current so a category cannot exceed the floor
      // if the same function is extended to multiple passes later.
      products = [{
        id: productId,
        ref: productId,
        produto: candidate.rawTitle,
        rawTitle: candidate.rawTitle,
        categoria: candidate.category,
        preco: candidate.price,
        imagens: [candidate.imageUrl],
        imageEditorialStatus: candidate.imageQualification.state === "QUALIFIED" ? "clean" : "review_required",
        imageCuration: buildImageCuration(candidate.imageUrl, candidate.imageQualification),
        link: candidate.affiliateUrl,
        ativo: false,
        destaque: false,
        status: "paused",
        createdBy: AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY,
        slug: productId,
        createdAt: now.toISOString(),
      }, ...products];
    }
  }

  if (publishedIds.length === 0) {
    return {
      attempted: categories.some(category => category.requested > 0),
      targetPerCategory,
      publishedIds,
      warnings,
      categories,
      syncSuccess: true,
      syncError: null,
    };
  }

  await setPublished(publishedIds, true);
  const sync = await syncCatalogAndDeploy("autonomous curator guaranteed catalog floor");
  if (!sync.success) {
    await setPublished(publishedIds, false).catch(() => undefined);
    await syncCatalogAndDeploy("autonomous curator guaranteed catalog floor rollback").catch(() => undefined);
    return {
      attempted: true,
      targetPerCategory,
      publishedIds: [],
      warnings: [],
      categories: categories.map(category => ({ ...category, published: 0, productIds: [] })),
      syncSuccess: false,
      syncError: sync.error || sync.diagnostic?.code || "CATALOG_SYNC_FAILED",
    };
  }

  const live = await productsRepository.getProducts();
  for (const category of categories) {
    category.published = category.productIds.filter(id => live.some(product => product.id === id && product.status === "published" && product.ativo !== false)).length;
  }
  return {
    attempted: true,
    targetPerCategory,
    publishedIds,
    warnings,
    categories,
    syncSuccess: true,
    syncError: null,
  };
}

export const autonomousCuratorCatalogFloorFallbackInternals = {
  SEARCH_LIMIT,
  MAX_POOL_PER_CATEGORY,
  MAX_QUERIES_PER_CATEGORY,
  activePublishedCount,
  categoryDeficit,
  rankOffer,
  buildWarnings,
  buildImageCuration,
  isHttpsUrl,
};
