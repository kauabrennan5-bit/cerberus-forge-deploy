import type { Product } from "../../src/types";
import {
  PUBLIC_PRODUCT_CATEGORIES,
  type PublicProductCategory,
} from "../../src/lib/productCategory";
import { isPublicCatalogEligibleProduct } from "./publicCatalogEligibility";

export type CategoryCounts = Record<PublicProductCategory, number>;
export type CategoryDeficits = Record<PublicProductCategory, number>;
export type CategoryPendingReview = {
  categoria: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  lifecycle?: { operationId?: string };
};

export type CategoryCoverage = {
  public_count: number;
  public_deficit: number;
  actionable_pending: number;
  expired_pending: number;
  coverage: number;
  cards_needed: number;
};

export type CategoryCoverageMap = Record<PublicProductCategory, CategoryCoverage>;

export type PublicationGrowthMode = "growth" | "replacement";

const ACTIVE_PUBLISHING_CLAIM_TTL_MS = 15 * 60 * 1_000;

export class CategoryTargetSaturationError extends Error {
  readonly code = "CATEGORY_TARGET_ALREADY_SATISFIED_WHILE_DEFICITS_EXIST";
  readonly category: PublicProductCategory;
  readonly target: number;
  readonly totalDeficit: number;

  constructor(category: PublicProductCategory, target: number, totalDeficit: number) {
    super("CATEGORY_TARGET_ALREADY_SATISFIED_WHILE_DEFICITS_EXIST");
    this.name = "CategoryTargetSaturationError";
    this.category = category;
    this.target = target;
    this.totalDeficit = totalDeficit;
  }
}

export function isActivePublishedProduct(product: Product): boolean {
  return product.status === "published" && product.ativo === true;
}

export function categoryCounts(products: readonly Product[]): CategoryCounts {
  const counts = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [category, 0])) as CategoryCounts;
  for (const product of products) {
    if (!isPublicCatalogEligibleProduct(product)) continue;
    if (!PUBLIC_PRODUCT_CATEGORIES.includes(product.categoria as PublicProductCategory)) continue;
    counts[product.categoria as PublicProductCategory] += 1;
  }
  return counts;
}

export function categoryDeficits(counts: CategoryCounts, dailyTargetPerCategory: number): CategoryDeficits {
  const target = Math.max(0, Math.floor(dailyTargetPerCategory));
  return Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [
    category,
    Math.max(0, target - (counts[category] || 0)),
  ])) as CategoryDeficits;
}

export function deficitCategories(deficits: CategoryDeficits): PublicProductCategory[] {
  return PUBLIC_PRODUCT_CATEGORIES.filter(category => (deficits[category] || 0) > 0);
}

export function totalCategoryDeficit(deficits: CategoryDeficits): number {
  return PUBLIC_PRODUCT_CATEGORIES.reduce((sum, category) => sum + Math.max(0, deficits[category] || 0), 0);
}

export function fulfilledCategoryCount(counts: CategoryCounts, dailyTargetPerCategory: number): number {
  const target = Math.max(0, Math.floor(dailyTargetPerCategory));
  return PUBLIC_PRODUCT_CATEGORIES.filter(category => (counts[category] || 0) >= target).length;
}

export function assertCategoryPublicationAllowed(input: {
  category: PublicProductCategory;
  counts: CategoryCounts;
  dailyTargetPerCategory: number;
  mode?: PublicationGrowthMode;
}): void {
  if ((input.mode || "growth") === "replacement") return;
  const deficits = categoryDeficits(input.counts, input.dailyTargetPerCategory);
  const totalDeficit = totalCategoryDeficit(deficits);
  if (totalDeficit > 0 && deficits[input.category] === 0) {
    throw new CategoryTargetSaturationError(input.category, input.dailyTargetPerCategory, totalDeficit);
  }
}

export function calculateCategoryPolicy(products: readonly Product[], dailyTargetPerCategory: number) {
  return calculateCategoryCoveragePolicy(products, [], dailyTargetPerCategory);
}

export function calculateCategoryCoveragePolicy(
  products: readonly Product[],
  reviews: readonly CategoryPendingReview[],
  categoryFloor: number,
  now = Date.now(),
) {
  const counts = categoryCounts(products);
  const target = Math.max(0, Math.floor(categoryFloor));
  const deficits = categoryDeficits(counts, target);
  const deficitCategoryList = deficitCategories(deficits);
  const totalDeficit = totalCategoryDeficit(deficits);
  const fulfilledCategories = fulfilledCategoryCount(counts, target);
  const actionablePending = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [category, 0])) as CategoryCounts;
  const expiredPending = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [category, 0])) as CategoryCounts;

  for (const review of reviews) {
    if (!PUBLIC_PRODUCT_CATEGORIES.includes(review.categoria as PublicProductCategory)) continue;
    const category = review.categoria as PublicProductCategory;
    const status = String(review.status || "pending");
    const expiresAt = Number(review.expiresAt || 0);
    const hasExpiry = Number.isFinite(expiresAt) && expiresAt > 0;
    if (status === "pending" && (!hasExpiry || expiresAt > now)) {
      actionablePending[category] += 1;
    } else if (
      status === "publishing"
      && Boolean(String(review.lifecycle?.operationId || "").trim())
      && Number.isFinite(Number(review.updatedAt))
      && Number(review.updatedAt) > now - ACTIVE_PUBLISHING_CLAIM_TTL_MS
    ) {
      // Uma execução comprovadamente ativa cobre temporariamente a categoria.
      // Claims sem operationId ou além do TTL são órfãs e não escondem déficit.
      actionablePending[category] += 1;
    } else if (status === "expired" || (status === "pending" && hasExpiry && expiresAt <= now)) {
      expiredPending[category] += 1;
    }
    // rejected/cancelled/error e publishing órfão são excluídos.
  }

  const categoryCoverage = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => {
    const publicCount = counts[category] || 0;
    const pending = actionablePending[category] || 0;
    const coverage = publicCount + pending;
    return [category, {
      public_count: publicCount,
      public_deficit: Math.max(0, target - publicCount),
      actionable_pending: pending,
      expired_pending: expiredPending[category] || 0,
      coverage,
      cards_needed: Math.max(0, target - coverage),
    } satisfies CategoryCoverage];
  })) as CategoryCoverageMap;
  const prioritizedCategories = [...PUBLIC_PRODUCT_CATEGORIES]
    .sort((left, right) => categoryCoverage[right].cards_needed - categoryCoverage[left].cards_needed
      || categoryCoverage[left].coverage - categoryCoverage[right].coverage
      || left.localeCompare(right, "pt-BR"));
  const cardsNeeded = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [
    category,
    categoryCoverage[category].cards_needed,
  ])) as CategoryDeficits;
  const totalCardsNeeded = totalCategoryDeficit(cardsNeeded);
  const coveredCategories = PUBLIC_PRODUCT_CATEGORIES.filter(category => categoryCoverage[category].cards_needed === 0).length;
  return {
    categoryCounts: counts,
    categoryDeficits: deficits,
    deficitCategories: deficitCategoryList,
    totalDeficit,
    fulfilledCategories,
    actionablePending,
    expiredPending,
    categoryCoverage,
    cardsNeeded,
    totalCardsNeeded,
    coveredCategories,
    prioritizedCategories,
  };
}
