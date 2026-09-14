import { withCuratorDryRun } from "../lib/curatorDryRunGuard";
import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import { isPublicProductCategory, type PublicProductCategory } from "../../src/lib/productCategory";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepository from "../repositories/autonomousCuratorRepository";
import * as telegramRepository from "../repositories/telegramRepository";
import { extractProductForReview } from "./productAutomation";
import { createProductionProductPipeline } from "./productPipeline";
import { productRotationPublicationInternals } from "./productRotationPublication";
import { AUTONOMOUS_CURATOR_PROFILES } from "./autonomousCuratorProfiles";
import { calculateCategoryCoveragePolicy } from "./autonomousCuratorCategoryPolicy";
import { cheapProfileScore, scoreAutonomousCandidate } from "./autonomousCuratorScoring";
import { evaluateSharedCandidatePoolEntry } from "./shopeeCandidatePool";
import type { ContinuousCuratorCategoryResultV2, ContinuousCuratorResultV2 } from "./autonomousCuratorContinuousV2Base";

type DeepDryRunOptions = {
  cycleId?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  shopeeClient?: ShopeeApiClient;
  extractor?: typeof extractProductForReview;
};

export type ContinuousV2DeepDryRunResult = ContinuousCuratorResultV2 & {
  dryRun: true;
  renderDependency: false;
  reviewOnly: true;
  autoPublished: 0;
  catalogMutations: 0;
  reviewsCreated: 0;
  telegramMessagesSent: 0;
  productionRunOpened: false;
  deepEvaluations: number;
  pipelineEvaluations: number;
  qualifiedCandidates: number;
};

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

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

function sourceIdentityMatches(url: string, shopId: string, itemId: string): boolean {
  const identity = extractShopeeIdentity(url);
  return identity.shopId === shopId && identity.itemId === itemId;
}

function activePublished(product: Product): boolean {
  return product.status === "published" && product.ativo === true;
}

function similarityUniverse(products: readonly Product[]): Product[] {
  return products.filter(product => activePublished(product) || (product.createdBy === "autonomous_curator_queue" && product.status === "paused" && product.ativo === false));
}

function resolveClient(env: NodeJS.ProcessEnv, provided?: ShopeeApiClient): ShopeeApiClient | null {
  if (provided) return provided;
  const appId = String(env.SHOPEE_APP_ID || env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = String(env.SHOPEE_APP_SECRET || env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  if (!appId || !secret) return null;
  return createShopeeApiClient({
    appId,
    secret,
    baseUrl: optionalTrimmed(env.SHOPEE_AFFILIATE_API_BASE_URL),
  });
}

async function deepEvaluateCandidate(input: {
  profile: (typeof AUTONOMOUS_CURATOR_PROFILES)[number];
  item: Awaited<ReturnType<ShopeeApiClient["searchOffers"]>>["items"][number];
  products: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  extractor: typeof extractProductForReview;
  reviewThreshold: number;
}): Promise<{ qualified: boolean; score: number | null; title: string | null; reason: string; pipelineEvaluated?: true }> {
  const shopId = String(input.item.shopId || "");
  const itemId = String(input.item.itemId || "");
  if (!shopId || !itemId) return { qualified: false, score: null, title: null, reason: "DRY_RUN_IDENTITY_MISSING" };

  const existingIdentity = await curatorRepository.findProductSourceIdentity("Shopee", shopId, itemId);
  if (existingIdentity?.productId) return { qualified: false, score: null, title: null, reason: "DRY_RUN_IDENTITY_ALREADY_OWNED" };

  const acquisition = await input.client.acquireAffiliateLink({ shopId, itemId });
  if (acquisition.status !== "link_acquired" || !acquisition.affiliateUrl || !acquisition.productLink || !acquisition.shopId || !acquisition.itemId) {
    return { qualified: false, score: null, title: null, reason: `DRY_RUN_AFFILIATE_${acquisition.status}` };
  }
  if (acquisition.shopId !== shopId || acquisition.itemId !== itemId || !sourceIdentityMatches(acquisition.productLink, shopId, itemId)) {
    return { qualified: false, score: null, title: null, reason: "DRY_RUN_AFFILIATE_IDENTITY_MISMATCH" };
  }

  const pool = evaluateSharedCandidatePoolEntry({
    shopId,
    itemId,
    productLink: acquisition.productLink,
    affiliateLink: acquisition.affiliateUrl,
    price: acquisition.price,
    imageUrl: input.item.imageUrl,
  }, { expectedCategory: input.profile.category });
  if (!pool.eligible) return { qualified: false, score: null, title: null, reason: `DRY_RUN_POOL_REJECTED:${pool.reason || "unknown"}` };

  const evidenceProduct: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: String(acquisition.name || input.item.name || "").replace(/\s+/g, " ").trim().slice(0, 300),
  };
  if (input.item.imageUrl && /^https:\/\//i.test(input.item.imageUrl)) evidenceProduct.image = [input.item.imageUrl];
  const evidence = `<script type="application/ld+json">${JSON.stringify(evidenceProduct).replace(/</g, "\\u003c")}</script>`;
  const extracted = await input.extractor(acquisition.productLink, evidence);
  if (!extracted.success || !extracted.data) {
    return { qualified: false, score: null, title: null, reason: `DRY_RUN_EXTRACTION_${extracted.error || "failed"}` };
  }

  const data = extracted.data;
  if (!sourceIdentityMatches(data.normalizedUrl, shopId, itemId)) {
    return { qualified: false, score: null, title: null, reason: "DRY_RUN_SCRAPER_IDENTITY_MISMATCH" };
  }
  const rawTitle = (data.rawTitle || data.produto || acquisition.name || input.item.name || "").trim();
  if (!rawTitle) return { qualified: false, score: null, title: null, reason: "DRY_RUN_RAW_TITLE_MISSING" };

  let displayTitle: string;
  try {
    displayTitle = (await productRotationPublicationInternals.reviewDisplayTitle({
      rawTitle,
      category: input.profile.category,
      env: input.env,
    })).displayTitle.trim();
  } catch {
    displayTitle = productRotationPublicationInternals.deterministicDisplayTitle(rawTitle).trim();
  }
  if (!displayTitle) return { qualified: false, score: null, title: null, reason: "DRY_RUN_DISPLAY_TITLE_MISSING" };

  const category = data.categoria as PublicProductCategory;
  if (!isPublicProductCategory(category)) return { qualified: false, score: null, title: displayTitle, reason: "DRY_RUN_PUBLIC_CATEGORY_INVALID" };
  const price = Number(data.preco || acquisition.price);
  if (!Number.isFinite(price) || price <= 0) return { qualified: false, score: null, title: displayTitle, reason: "DRY_RUN_PRICE_UNVERIFIED" };

  const imageCuration = data.imageCuration;
  const image = resolveCanonicalProductImage({
    imagens: data.imagens,
    imageCuration,
    imageEditorialStatus: data.imageEditorialStatus,
  });
  const fallbackImages = [...new Set([
    ...(data.imagens || []),
    input.item.imageUrl,
  ].filter((url): url is string => typeof url === "string" && /^https:\/\//i.test(url.trim())).map(url => url.trim()))];
  const usableImages = image.status === "ready" ? image.publicHttpsImageUrls : fallbackImages;
  const primaryImage = image.primaryImageUrl || usableImages[0] || null;
  if (!primaryImage || usableImages.length === 0) return { qualified: false, score: null, title: displayTitle, reason: "DRY_RUN_IMAGE_MISSING" };

  const effectiveImageCuration = {
    ...imageCuration,
    rawImageUrls: imageCuration.rawImageUrls?.length ? imageCuration.rawImageUrls : usableImages,
    primaryImageUrl: imageCuration.primaryImageUrl || primaryImage,
    galleryImageUrls: imageCuration.galleryImageUrls || [],
    assessments: imageCuration.assessments || [],
  };
  const lifecycle = await createProductionProductPipeline().evaluate({
    normalizedUrl: `https://shopee.com.br/product/${shopId}/${itemId}`,
    link: acquisition.affiliateUrl,
    marketplace: "Shopee",
    produto: displayTitle,
    rawTitle,
    displayTitle,
    categoria: category,
    preco: price,
    imagens: usableImages,
    imagensOriginais: effectiveImageCuration.rawImageUrls,
    imageCuration: effectiveImageCuration,
    imagemPrincipal: primaryImage,
    imagensGaleria: usableImages.slice(1),
    imageEditorialStatus: data.imageEditorialStatus === "clean" && imageCuration.status === "ready" ? "clean" : "review_required",
    descricao: (data.descricao || "").trim(),
  }, { humanReview: true });
  if (lifecycle.validation.outcome === "FAIL" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {
    return { pipelineEvaluated: true, qualified: false, score: null, title: displayTitle, reason: `DRY_RUN_PIPELINE_BLOCK:${lifecycle.validation.errors.join("|") || lifecycle.state}` };
  }

  const breakdown = scoreAutonomousCandidate({
    profile: input.profile,
    rawTitle,
    displayTitle,
    description: (data.descricao || "").trim(),
    category,
    price,
    imageCuration: effectiveImageCuration,
    pipelineScore: lifecycle.curation.score,
    existingProducts: similarityUniverse(input.products),
  });
  const qualified = breakdown.finalScore >= input.reviewThreshold;
  return {
    pipelineEvaluated: true,
    qualified,
    score: breakdown.finalScore,
    title: displayTitle,
    reason: qualified ? "DRY_RUN_QUALIFIED" : `DRY_RUN_BELOW_REVIEW_THRESHOLD:${breakdown.finalScore}`,
  };
}

export async function runAutonomousCuratorContinuousV2DeepDryRun(options: DeepDryRunOptions = {}): Promise<ContinuousV2DeepDryRunResult> {
  return withCuratorDryRun(async () => {
    const env = options.env || process.env;
    const now = options.now || new Date();
    const cycleId = options.cycleId || `continuous-dry-run-${randomUUID()}`;
    const runDate = localRunDate(now);
    const config = await curatorRepository.getAutonomousCuratorConfig();
    if (!config.enabled) {
      return {
        cycleId,
        cycleNumber: 0,
        runId: "",
        runDate,
        status: "disabled",
        publishedThisCycle: 0,
        fulfilledCategories: 0,
        queuedProducts: 0,
        failedThisCycle: 0,
        categories: [],
        dryRun: true,
        renderDependency: false,
        reviewOnly: true,
        autoPublished: 0,
        catalogMutations: 0,
        reviewsCreated: 0,
        telegramMessagesSent: 0,
        productionRunOpened: false,
        deepEvaluations: 0,
        pipelineEvaluations: 0,
        qualifiedCandidates: 0,
      };
    }

    const client = resolveClient(env, options.shopeeClient);
    if (!client) throw new Error("AUTONOMOUS_CURATOR_SHOPEE_NOT_CONFIGURED");
    const extractor = options.extractor || extractProductForReview;
    const [products, reviews] = await Promise.all([
      productsRepository.getProducts(),
      telegramRepository.listReviewsByStatus(
        ["pending", "publishing", "expired", "rejected", "cancelled", "error"],
        1_000,
        { includeExpiredPending: true, maximumLimit: 1_000 },
      ),
    ]);
    const floor = positiveInt(env.AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY, 5, 10);
    const coverage = calculateCategoryCoveragePolicy(products, reviews, floor, now.getTime());
    const maxSearchCandidates = positiveInt(env.CONTINUOUS_V2_DEEP_DRY_RUN_MAX_SEARCH, Math.min(config.maxSearchCandidates, 3), 10);
    const maxEnrichPerCategory = positiveInt(env.CONTINUOUS_V2_DEEP_DRY_RUN_MAX_ENRICH, 1, 3);
    const categories: ContinuousCuratorCategoryResultV2[] = [];
    let failedThisCycle = 0;
    let deepEvaluations = 0;
    let pipelineEvaluations = 0;
    let qualifiedCandidates = 0;

    for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
      if (coverage.cardsNeeded[profile.category] <= 0) {
        categories.push({
          category: profile.category,
          due: false,
          published: false,
          queued: false,
          score: null,
          title: null,
          reason: "DRY_RUN_CATEGORY_COVERED",
          productId: null,
          searchedPages: [],
        });
        continue;
      }

      const query = profile.queries[0];
      const result: ContinuousCuratorCategoryResultV2 = {
        category: profile.category,
        due: true,
        published: false,
        queued: false,
        score: null,
        title: null,
        reason: "DRY_RUN_SEARCHING",
        productId: null,
        searchedPages: [1],
      };
      if (!query) {
        result.reason = "DRY_RUN_QUERY_MISSING";
        failedThisCycle += 1;
        categories.push(result);
        continue;
      }

      try {
        const search = await client.searchOffers({ query, page: 1, limit: maxSearchCandidates });
        if (!search.ok) {
          result.reason = `DRY_RUN_SHOPEE_SEARCH:${search.reason || "failed"}`;
          failedThisCycle += 1;
          categories.push(result);
          continue;
        }
        const ranked = [...search.items]
          .filter(item => Boolean(item.name))
          .sort((a, b) => cheapProfileScore(profile, b.name || "") - cheapProfileScore(profile, a.name || ""));
        let best: { score: number; title: string; reason: string } | null = null;
        for (const item of ranked.slice(0, maxEnrichPerCategory)) {
          deepEvaluations += 1;
          const evaluation = await deepEvaluateCandidate({
            profile,
            item,
            products,
            client,
            env,
            extractor,
            reviewThreshold: config.reviewThreshold,
          });
          if (evaluation.pipelineEvaluated === true) pipelineEvaluations += 1;
          if (evaluation.score !== null && evaluation.title && (!best || evaluation.score > best.score)) {
            best = { score: evaluation.score, title: evaluation.title, reason: evaluation.reason };
          }
          if (evaluation.qualified) qualifiedCandidates += 1;
        }
        if (best) {
          result.score = best.score;
          result.title = best.title;
          result.reason = best.reason;
        } else {
          result.reason = "DRY_RUN_NO_DEEP_CANDIDATE_QUALIFIED";
        }
      } catch (error) {
        failedThisCycle += 1;
        result.reason = `DRY_RUN_CATEGORY_FAILED:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`;
      }
      categories.push(result);
    }

    const status: ContinuousCuratorResultV2["status"] = failedThisCycle > 0 && deepEvaluations === 0
      ? "failed"
      : coverage.totalCardsNeeded === 0 && failedThisCycle === 0 ? "completed" : "partial";
    return {
      cycleId,
      cycleNumber: 0,
      runId: "",
      runDate,
      status,
      publishedThisCycle: 0,
      fulfilledCategories: coverage.coveredCategories,
      queuedProducts: 0,
      failedThisCycle,
      categories,
      dryRun: true,
      renderDependency: false,
      reviewOnly: true,
      autoPublished: 0,
      catalogMutations: 0,
      reviewsCreated: 0,
      telegramMessagesSent: 0,
      productionRunOpened: false,
      deepEvaluations,
      pipelineEvaluations,
      qualifiedCandidates,
    };
  });
}
