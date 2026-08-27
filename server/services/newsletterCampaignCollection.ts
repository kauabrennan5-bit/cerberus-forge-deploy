import type { Product } from "../../src/types";
import { assessProductReadiness, type ProductImageProbe } from "../../src/lib/productCanonical";

export const DEFAULT_NEWSLETTER_COLLECTION_SIZE = 10;
export const MIN_NEWSLETTER_COLLECTION_SIZE = 1;
export const MAX_NEWSLETTER_COLLECTION_SIZE = 15;
export const MIN_WEEKLY_COLLECTION_PRODUCTS = 5;
export const NEWSLETTER_COLLECTION_LOOKBACK_DAYS = 14;

export type NewsletterCollectionSelectionOptions = {
  collectionSize?: number;
  minimumProducts?: number;
  since?: Date;
  until?: Date;
  verifyImageAccessibility?: boolean;
  imageProbe?: ProductImageProbe;
};

export type NewsletterCollectionSkippedProduct = {
  productId: string;
  reason: string;
};

export type NewsletterCollectionSelection = {
  products: Product[];
  requestedSize: number;
  since: Date | null;
  until: Date | null;
  skipped: NewsletterCollectionSkippedProduct[];
};

/**
 * Seleciona produtos mais novos em ordem estável, usando `createdAt` quando
 * disponível e preservando a ordem recebida como fallback canônico.
 */
export async function selectNewestNewsletterProducts(
  products: readonly Product[],
  options: NewsletterCollectionSelectionOptions = {},
): Promise<NewsletterCollectionSelection> {
  const requestedSize = normalizeCollectionSize(options.collectionSize);
  const minimumProducts = normalizeMinimumProducts(options.minimumProducts, requestedSize);
  const since = options.since || null;
  const until = options.until || null;

  if (since && until && since.getTime() >= until.getTime()) {
    throw new Error("CAMPAIGN_COLLECTION_DATE_WINDOW_INVALID");
  }

  const skipped: NewsletterCollectionSkippedProduct[] = [];
  const seen = new Set<string>();
  const ordered = products
    .map((product, index) => ({ product, index }))
    .sort((left, right) => {
      const leftTime = parseCreatedAt(left.product.createdAt);
      const rightTime = parseCreatedAt(right.product.createdAt);
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.index - right.index;
    });

  const selected: Product[] = [];
  for (const candidate of ordered) {
    const product = candidate.product;
    const productId = typeof product.id === "string" ? product.id.trim() : "";
    if (!productId) {
      skipped.push({ productId: "unknown", reason: "PRODUCT_ID_MISSING" });
      continue;
    }
    if (seen.has(productId)) {
      skipped.push({ productId, reason: "PRODUCT_DUPLICATE" });
      continue;
    }
    seen.add(productId);

    if (product.ativo !== true || !isApprovedOrPublished(product.status)) {
      skipped.push({ productId, reason: "PRODUCT_NOT_AVAILABLE" });
      continue;
    }

    const createdAt = parseCreatedAtOrNull(product.createdAt);
    if (since && (!createdAt || createdAt < since.getTime())) {
      skipped.push({ productId, reason: "PRODUCT_OUTSIDE_WEEK_WINDOW" });
      continue;
    }
    if (until && (!createdAt || createdAt >= until.getTime())) {
      skipped.push({ productId, reason: "PRODUCT_OUTSIDE_DATE_WINDOW" });
      continue;
    }

    const readiness = await assessProductReadiness(product, {
      channel: "campaign",
      verifyImageAccessibility: options.verifyImageAccessibility !== false,
      imageProbe: options.imageProbe,
    });
    if (!readiness.ready) {
      skipped.push({ productId, reason: readiness.errors.join(",") || "CAMPAIGN_PRODUCT_NOT_READY" });
      continue;
    }

    selected.push(product);
    if (selected.length >= requestedSize) break;
  }

  if (selected.length < minimumProducts) {
    throw new Error(`CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS:${selected.length}:${minimumProducts}`);
  }

  return { products: selected, requestedSize, since, until, skipped };
}

export function getStartOfNewsletterCollectionWindow(now = new Date()): Date {
  return new Date(now.getTime() - NEWSLETTER_COLLECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

export function getStartOfCurrentIsoWeek(now = new Date()): Date {
  const start = new Date(now);
  const day = start.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function normalizeCollectionSize(value: number | undefined): number {
  const normalized = value === undefined ? DEFAULT_NEWSLETTER_COLLECTION_SIZE : Math.trunc(value);
  if (!Number.isInteger(normalized) || normalized < MIN_NEWSLETTER_COLLECTION_SIZE || normalized > MAX_NEWSLETTER_COLLECTION_SIZE) {
    throw new Error(`CAMPAIGN_COLLECTION_SIZE_INVALID:${MIN_NEWSLETTER_COLLECTION_SIZE}:${MAX_NEWSLETTER_COLLECTION_SIZE}`);
  }
  return normalized;
}

function normalizeMinimumProducts(value: number | undefined, requestedSize: number): number {
  const normalized = value === undefined ? Math.min(MIN_WEEKLY_COLLECTION_PRODUCTS, requestedSize) : Math.trunc(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > requestedSize) {
    throw new Error("CAMPAIGN_COLLECTION_MINIMUM_INVALID");
  }
  return normalized;
}

function parseCreatedAt(value: unknown): number {
  return parseCreatedAtOrNull(value) ?? 0;
}

function parseCreatedAtOrNull(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isApprovedOrPublished(status: Product["status"]): boolean {
  return !status || status === "approved" || status === "published";
}
