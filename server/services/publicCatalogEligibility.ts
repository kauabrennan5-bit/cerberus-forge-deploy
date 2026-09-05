import type { Product } from "../../src/types";
import { isPublicProductCategory } from "../../src/lib/productCategory";

export const PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION = "edge-v4";
export const AUTONOMOUS_DEFICIT_FALLBACK_CREATED_BY = "autonomous_curator_queue";
export const AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL = "deficit-fallback";

function imageCurationReady(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && String((value as Record<string, unknown>).status || "") === "ready";
}

function validHttpsUrl(value: unknown): boolean {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function validShopeeAffiliateLink(value: unknown): boolean {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "shopee.com.br" || host.endsWith(".shopee.com.br"));
  } catch {
    return false;
  }
}

function deficitFallbackImageIsTechnicallyUsable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return validHttpsUrl(row.primaryImageUrl);
}

function strictEditorialProduct(product: Product): boolean {
  return product.displayTitleStatus === "reviewed"
    && product.imageEditorialStatus === "clean"
    && product.displayTitle !== undefined
    && product.displayTitle !== null
    && imageCurationReady(product.imageCuration);
}

function autonomousDeficitFallbackProduct(product: Product): boolean {
  const displayTitle = String(product.displayTitle || "").trim();
  return product.createdBy === AUTONOMOUS_DEFICIT_FALLBACK_CREATED_BY
    && product.imageReviewModel === AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL
    && (product.displayTitleStatus === "review_required" || product.displayTitleStatus === "reviewed")
    && (product.imageEditorialStatus === "review_required" || product.imageEditorialStatus === "clean")
    && displayTitle.length > 0
    && deficitFallbackImageIsTechnicallyUsable(product.imageCuration)
    && Boolean(String(product.imageReviewFingerprint || "").trim())
    && Number.isFinite(Number(product.preco))
    && Number(product.preco) > 0
    && isPublicProductCategory(product.categoria)
    && validShopeeAffiliateLink(product.link);
}

export function isPublicCatalogEligibleProduct(product: Product): boolean {
  return product.ativo === true
    && product.status === "published"
    && (strictEditorialProduct(product) || autonomousDeficitFallbackProduct(product));
}

function strictEditorialDbRow(row: Record<string, unknown>): boolean {
  return String(row.display_title_status || "") === "reviewed"
    && String(row.image_editorial_status || "") === "clean"
    && row.display_title !== null
    && row.display_title !== undefined
    && imageCurationReady(row.image_curation);
}

function autonomousDeficitFallbackDbRow(row: Record<string, unknown>): boolean {
  const displayTitle = String(row.display_title || "").trim();
  const price = Number(row.preco);
  return String(row.created_by || "") === AUTONOMOUS_DEFICIT_FALLBACK_CREATED_BY
    && String(row.image_review_model || "") === AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL
    && ["review_required", "reviewed"].includes(String(row.display_title_status || ""))
    && ["review_required", "clean"].includes(String(row.image_editorial_status || ""))
    && displayTitle.length > 0
    && deficitFallbackImageIsTechnicallyUsable(row.image_curation)
    && Boolean(String(row.image_review_fingerprint || "").trim())
    && Number.isFinite(price)
    && price > 0
    && isPublicProductCategory(String(row.categoria || ""))
    && validShopeeAffiliateLink(row.link);
}

export function isPublicCatalogEligibleDbRow(row: Record<string, unknown>): boolean {
  return row.ativo === true
    && String(row.status || "") === "published"
    && (strictEditorialDbRow(row) || autonomousDeficitFallbackDbRow(row));
}
