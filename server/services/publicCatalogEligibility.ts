import type { Product } from "../../src/types";
import { isPublicProductCategory } from "../../src/lib/productCategory";
import { imageUrlFingerprint, isHumanEditorialApprovalCurrent } from "./productEditorialReview";

export const PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION = "edge-v6-human-approval";
export const TELEGRAM_MANUAL_CREATED_BY = "telegram_manual";

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

function productPrimaryImage(product: Product): string | null {
  const curated = product.imageCuration?.primaryImageUrl;
  if (validHttpsUrl(curated)) return String(curated);
  const first = Array.isArray(product.imagens) ? product.imagens[0] : null;
  return validHttpsUrl(first) ? String(first) : null;
}

function rowPrimaryImage(row: Record<string, unknown>): string | null {
  const curation = row.image_curation && typeof row.image_curation === "object"
    ? row.image_curation as Record<string, unknown>
    : null;
  if (validHttpsUrl(curation?.primaryImageUrl)) return String(curation?.primaryImageUrl);
  const images = Array.isArray(row.imagens) ? row.imagens : [];
  return validHttpsUrl(images[0]) ? String(images[0]) : null;
}

function strictEditorialProduct(product: Product): boolean {
  return product.displayTitleStatus === "reviewed"
    && product.imageEditorialStatus === "clean"
    && product.displayTitle !== undefined
    && product.displayTitle !== null
    && imageCurationReady(product.imageCuration);
}

function isHumanGovernedCreator(value: unknown): boolean {
  const creator = String(value || "").trim().toLowerCase();
  return creator === TELEGRAM_MANUAL_CREATED_BY
    || creator === "telegram_rotation_candidate"
    || creator.includes("autonomous_curator");
}

function technicallyPublicProduct(product: Product): boolean {
  const displayTitle = String(product.displayTitle || product.produto || "").trim();
  return displayTitle.length > 0
    && Boolean(productPrimaryImage(product))
    && Number.isFinite(Number(product.preco))
    && Number(product.preco) > 0
    && isPublicProductCategory(product.categoria)
    && validShopeeAffiliateLink(product.link);
}

function currentHumanApprovalProduct(product: Product): boolean {
  return isHumanEditorialApprovalCurrent(product);
}

export function isPublicCatalogEligibleProduct(product: Product): boolean {
  if (product.ativo !== true || product.status !== "published" || !technicallyPublicProduct(product)) return false;
  return isHumanGovernedCreator(product.createdBy)
    ? currentHumanApprovalProduct(product)
    : strictEditorialProduct(product);
}

function strictEditorialDbRow(row: Record<string, unknown>): boolean {
  return String(row.display_title_status || "") === "reviewed"
    && String(row.image_editorial_status || "") === "clean"
    && row.display_title !== null
    && row.display_title !== undefined
    && imageCurationReady(row.image_curation);
}

function technicallyPublicDbRow(row: Record<string, unknown>): boolean {
  const displayTitle = String(row.display_title || row.produto || "").trim();
  const price = Number(row.preco);
  return displayTitle.length > 0
    && Boolean(rowPrimaryImage(row))
    && Number.isFinite(price)
    && price > 0
    && isPublicProductCategory(String(row.categoria || ""))
    && validShopeeAffiliateLink(row.link);
}

function currentHumanApprovalDbRow(row: Record<string, unknown>): boolean {
  const primary = rowPrimaryImage(row);
  const approvedAt = String(row.human_editorial_approved_at || "");
  return Boolean(
    primary
    && String(row.human_editorial_image_url || "") === primary
    && approvedAt
    && Number.isFinite(Date.parse(approvedAt))
    && String(row.human_editorial_review_id || "").trim()
    && String(row.human_editorial_authorization_id || "").trim()
    && String(row.human_editorial_image_fingerprint || "") === imageUrlFingerprint(primary),
  );
}

export function isPublicCatalogEligibleDbRow(row: Record<string, unknown>): boolean {
  if (row.ativo !== true || String(row.status || "") !== "published" || !technicallyPublicDbRow(row)) return false;
  return isHumanGovernedCreator(row.created_by)
    ? currentHumanApprovalDbRow(row)
    : strictEditorialDbRow(row);
}
