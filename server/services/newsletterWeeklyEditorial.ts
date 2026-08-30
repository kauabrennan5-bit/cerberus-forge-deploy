import { createHash } from "node:crypto";
import type { Product, PromotionOffer } from "../../src/types";
import { PUBLIC_PRODUCT_CATEGORIES } from "../../src/lib/productCategory";
import { deriveConfidenceV2, deriveMinSampleSize, confidenceV2ToScore } from "../commercialBrain/statisticalRigor";
import { isValidProductLink } from "../repositories/productsRepository";
import { validPromotionAt } from "./promotionOffer";
import { isDisplayTitleReviewCurrent, isImageReviewCurrent } from "./productEditorialReview";

export type WeeklyCompositionMode = "thematic" | "diversified";

export type WeeklyProductSnapshot = {
  productId: string;
  ref: string;
  displayTitle: string;
  category: string;
  canonicalPrice: number;
  promotion: PromotionOffer | null;
  primaryImageUrl: string;
  imageReviewFingerprint: string;
  imageReviewVersion: string;
  destinationIdentity: string;
};

export type WeeklyEditorialSnapshot = {
  version: "weekly-editorial-snapshot-v1";
  createdAt: string;
  compositionMode: WeeklyCompositionMode;
  categories: string[];
  products: WeeklyProductSnapshot[];
};

export type WeeklyComposition = {
  mode: WeeklyCompositionMode;
  categories: string[];
  products: Product[];
  duplicateProductIds: string[];
};

export type WeeklyProductEligibility = {
  eligible: boolean;
  reasons: string[];
  snapshot: WeeklyProductSnapshot | null;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function destinationIdentity(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function evaluateWeeklyProductEligibility(product: Product, now = new Date()): WeeklyProductEligibility {
  const reasons: string[] = [];
  if (product.ativo !== true) reasons.push("PRODUCT_INACTIVE");
  if (product.status !== "published") reasons.push("PRODUCT_NOT_PUBLISHED");
  const ref = clean(product.ref);
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,119}$/.test(ref)) reasons.push("PRODUCT_REF_INVALID");
  if (!isValidProductLink(product.link)) reasons.push("PRODUCT_LINK_INVALID");
  if (!isDisplayTitleReviewCurrent(product)) reasons.push("DISPLAY_TITLE_REVIEW_REQUIRED");
  if (!isImageReviewCurrent(product)) reasons.push("IMAGE_REVIEW_REQUIRED");
  const category = clean(product.categoria);
  if (!PUBLIC_PRODUCT_CATEGORIES.includes(category as (typeof PUBLIC_PRODUCT_CATEGORIES)[number])) reasons.push("PRODUCT_CATEGORY_INVALID");
  const canonicalPrice = Number(product.preco);
  if (!Number.isFinite(canonicalPrice) || canonicalPrice <= 0) reasons.push("PRODUCT_BASE_PRICE_INVALID");

  const primaryImageUrl = product.imageCuration?.status === "ready"
    ? clean(product.imageCuration.primaryImageUrl)
    : "";
  const imageReviewFingerprint = clean(product.imageReviewFingerprint);
  const imageReviewVersion = clean(product.imageReviewVersion);
  const displayTitle = clean(product.displayTitle);
  const linkIdentity = destinationIdentity(product.link);
  const promotion = validPromotionAt(product.ofertaPromocional, now) || null;

  if (reasons.length > 0) return { eligible: false, reasons, snapshot: null };
  return {
    eligible: true,
    reasons: [],
    snapshot: {
      productId: product.id,
      ref,
      displayTitle,
      category,
      canonicalPrice,
      promotion,
      primaryImageUrl,
      imageReviewFingerprint,
      imageReviewVersion,
      destinationIdentity: linkIdentity,
    },
  };
}

export function weeklyFreshnessMs(product: Product, now = new Date()): number {
  const created = product.createdAt ? Date.parse(product.createdAt) : 0;
  const promotion = validPromotionAt(product.ofertaPromocional, now);
  const promotionConfirmed = promotion ? Number(promotion.confirmedAt) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(promotionConfirmed) ? promotionConfirmed : 0);
}

export function rankWeeklyCandidates(
  products: readonly Product[],
  clickCounts: ReadonlyMap<string, number>,
  now = new Date(),
): Product[] {
  const minSample = deriveMinSampleSize().nTotal;
  return [...products].sort((a, b) => {
    const aClicks = clickCounts.get(a.id) || 0;
    const bClicks = clickCounts.get(b.id) || 0;
    const aConfidence = deriveConfidenceV2({ recordCount: aClicks, minSampleRequired: minSample }).confidence;
    const bConfidence = deriveConfidenceV2({ recordCount: bClicks, minSampleRequired: minSample }).confidence;
    return confidenceV2ToScore(bConfidence) - confidenceV2ToScore(aConfidence)
      || bClicks - aClicks
      || weeklyFreshnessMs(b, now) - weeklyFreshnessMs(a, now)
      || a.id.localeCompare(b.id);
  });
}

function titleTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter(token => token.length >= 3));
}

export function areWeeklyProductsNearDuplicate(a: Product, b: Product): boolean {
  if (clean(a.categoria) !== clean(b.categoria)) return false;
  const left = titleTokens(clean(a.displayTitle));
  const right = titleTokens(clean(b.displayTitle));
  if (!left.size || !right.size) return false;
  const intersection = [...left].filter(token => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && intersection / union >= 0.7;
}

export function composeWeeklyEdition(
  rankedProducts: readonly Product[],
  maximumProducts = 4,
): WeeklyComposition {
  const deduped: Product[] = [];
  const duplicateProductIds: string[] = [];
  for (const product of rankedProducts) {
    if (deduped.some(selected => areWeeklyProductsNearDuplicate(selected, product))) {
      duplicateProductIds.push(product.id);
      continue;
    }
    deduped.push(product);
  }

  if (deduped.length === 0) return { mode: "diversified", categories: [], products: [], duplicateProductIds };
  const strongPool = deduped.slice(0, Math.min(6, deduped.length));
  const heroCategory = clean(deduped[0].categoria);
  const heroCategoryCount = strongPool.filter(product => clean(product.categoria) === heroCategory).length;
  const thematic = heroCategoryCount >= 3 && heroCategoryCount / strongPool.length >= 0.6;

  let products: Product[];
  if (thematic) {
    products = deduped.filter(product => clean(product.categoria) === heroCategory).slice(0, maximumProducts);
  } else {
    products = [];
    const perCategory = new Map<string, number>();
    const deferred: Product[] = [];
    for (const product of deduped) {
      const category = clean(product.categoria);
      if ((perCategory.get(category) || 0) >= 2) {
        deferred.push(product);
        continue;
      }
      products.push(product);
      perCategory.set(category, (perCategory.get(category) || 0) + 1);
      if (products.length === maximumProducts) break;
    }
    if (products.length < 3) {
      for (const product of deferred) {
        if (products.includes(product)) continue;
        products.push(product);
        if (products.length === Math.min(maximumProducts, deduped.length)) break;
      }
    }
  }

  return {
    mode: thematic ? "thematic" : "diversified",
    categories: [...new Set(products.map(product => clean(product.categoria)))],
    products,
    duplicateProductIds,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildWeeklyEditorialSnapshot(
  products: readonly Product[],
  composition: Pick<WeeklyComposition, "mode" | "categories">,
  now = new Date(),
): { snapshot: WeeklyEditorialSnapshot; fingerprint: string } {
  const snapshots = products.map(product => {
    const eligibility = evaluateWeeklyProductEligibility(product, now);
    if (!eligibility.eligible || !eligibility.snapshot) {
      throw new Error(`WEEKLY_PRODUCT_NOT_ELIGIBLE:${product.id}:${eligibility.reasons.join(",")}`);
    }
    return eligibility.snapshot;
  });
  const snapshot: WeeklyEditorialSnapshot = {
    version: "weekly-editorial-snapshot-v1",
    createdAt: now.toISOString(),
    compositionMode: composition.mode,
    categories: [...composition.categories],
    products: snapshots,
  };
  const fingerprint = `sha256:${createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex")}`;
  return { snapshot, fingerprint };
}

export function compareWeeklyEditorialSnapshot(
  approved: WeeklyEditorialSnapshot,
  currentProducts: readonly Product[],
  now = new Date(),
): { valid: true; fingerprint: string } | { valid: false; code: string; productId?: string } {
  const currentById = new Map(currentProducts.map(product => [product.id, product]));
  const reconstructed: Product[] = [];
  for (const expected of approved.products) {
    const product = currentById.get(expected.productId);
    if (!product) return { valid: false, code: "PRODUCT_REMOVED_AFTER_APPROVAL", productId: expected.productId };
    const eligibility = evaluateWeeklyProductEligibility(product, now);
    if (!eligibility.eligible || !eligibility.snapshot) {
      const reason = eligibility.reasons[0] || "PRODUCT_NOT_ELIGIBLE_AFTER_APPROVAL";
      return { valid: false, code: reason, productId: expected.productId };
    }
    const actual = eligibility.snapshot;
    const checks: Array<[keyof WeeklyProductSnapshot, string]> = [
      ["ref", "REF_CHANGED_AFTER_APPROVAL"],
      ["displayTitle", "DISPLAY_TITLE_CHANGED_AFTER_APPROVAL"],
      ["category", "CATEGORY_CHANGED_AFTER_APPROVAL"],
      ["canonicalPrice", "PRICE_CHANGED_AFTER_APPROVAL"],
      ["promotion", "PROMOTION_CHANGED_OR_EXPIRED_AFTER_APPROVAL"],
      ["primaryImageUrl", "IMAGE_CHANGED_AFTER_APPROVAL"],
      ["imageReviewFingerprint", "IMAGE_REVIEW_CHANGED_AFTER_APPROVAL"],
      ["imageReviewVersion", "IMAGE_REVIEW_CHANGED_AFTER_APPROVAL"],
      ["destinationIdentity", "LINK_CHANGED_AFTER_APPROVAL"],
    ];
    for (const [key, code] of checks) {
      if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) {
        return { valid: false, code, productId: expected.productId };
      }
    }
    reconstructed.push(product);
  }
  const { fingerprint } = buildWeeklyEditorialSnapshot(reconstructed, {
    mode: approved.compositionMode,
    categories: approved.categories,
  }, new Date(approved.createdAt));
  return { valid: true, fingerprint };
}
