import type { Product } from "../../src/types";
import {
  PUBLIC_PRODUCT_CATEGORIES,
  type PublicProductCategory,
} from "../../src/lib/productCategory";

export type CategoryCounts = Record<PublicProductCategory, number>;
export type CategoryDeficits = Record<PublicProductCategory, number>;

export type PublicationGrowthMode = "growth" | "replacement";

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
  return product.status === "published" && product.ativo !== false;
}

export function categoryCounts(products: readonly Product[]): CategoryCounts {
  const counts = Object.fromEntries(PUBLIC_PRODUCT_CATEGORIES.map(category => [category, 0])) as CategoryCounts;
  for (const product of products) {
    if (!isActivePublishedProduct(product)) continue;
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
  const counts = categoryCounts(products);
  const deficits = categoryDeficits(counts, dailyTargetPerCategory);
  const deficitCategoryList = deficitCategories(deficits);
  const totalDeficit = totalCategoryDeficit(deficits);
  const fulfilledCategories = fulfilledCategoryCount(counts, dailyTargetPerCategory);
  return {
    categoryCounts: counts,
    categoryDeficits: deficits,
    deficitCategories: deficitCategoryList,
    totalDeficit,
    fulfilledCategories,
  };
}
