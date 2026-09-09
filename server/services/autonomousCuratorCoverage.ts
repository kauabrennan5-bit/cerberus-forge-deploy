import type { Product } from "../../src/types";
import { PUBLIC_PRODUCT_CATEGORIES, type PublicProductCategory } from "../../src/lib/productCategory";
import type { PendingReview } from "./telegramTypes";

export const CURATOR_PUBLIC_CATEGORY_FLOOR = 5;

export type CuratorCategoryCoverage = {
  category: PublicProductCategory;
  publicCount: number;
  publicDeficit: number;
  actionablePending: number;
  expiredPending: number;
  coverage: number;
  cardsNeeded: number;
};

function activePublished(product: Product): boolean {
  return product.ativo === true && product.status === "published";
}

function reviewCategory(review: PendingReview): PublicProductCategory | null {
  return PUBLIC_PRODUCT_CATEGORIES.includes(review.categoria as PublicProductCategory)
    ? review.categoria as PublicProductCategory
    : null;
}

function pendingActionable(review: PendingReview, nowMs: number): boolean {
  return review.status === "pending" && Number.isFinite(review.expiresAt) && review.expiresAt > nowMs;
}

function pendingExpired(review: PendingReview, nowMs: number): boolean {
  return review.status === "expired" || (review.status === "pending" && (!Number.isFinite(review.expiresAt) || review.expiresAt <= nowMs));
}

export function calculateCuratorCategoryCoverage(
  products: readonly Product[],
  reviews: readonly PendingReview[],
  now = new Date(),
  floor = CURATOR_PUBLIC_CATEGORY_FLOOR,
): CuratorCategoryCoverage[] {
  const target = Math.max(1, Math.trunc(floor));
  return PUBLIC_PRODUCT_CATEGORIES.map(category => {
    const publicCount = products.filter(product => activePublished(product) && product.categoria === category).length;
    const categoryReviews = reviews.filter(review => reviewCategory(review) === category);
    const actionablePending = categoryReviews.filter(review => pendingActionable(review, now.getTime())).length;
    const expiredPending = categoryReviews.filter(review => pendingExpired(review, now.getTime())).length;
    const coverage = publicCount + actionablePending;
    return {
      category,
      publicCount,
      publicDeficit: Math.max(0, target - publicCount),
      actionablePending,
      expiredPending,
      coverage,
      cardsNeeded: Math.max(0, target - coverage),
    };
  });
}

export function prioritizeCuratorCategories(
  coverage: readonly CuratorCategoryCoverage[],
): PublicProductCategory[] {
  return [...coverage]
    .sort((a, b) =>
      b.cardsNeeded - a.cardsNeeded
      || a.coverage - b.coverage
      || a.publicCount - b.publicCount
      || a.category.localeCompare(b.category),
    )
    .map(item => item.category);
}

export function curatorCategoryCanGenerateCard(
  coverage: readonly CuratorCategoryCoverage[],
  category: PublicProductCategory,
): boolean {
  return (coverage.find(item => item.category === category)?.cardsNeeded || 0) > 0;
}
