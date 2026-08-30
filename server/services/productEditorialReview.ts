import { createHash } from "node:crypto";
import type { Product } from "../../src/types";
import { isCommercialImageAssessment } from "../../src/lib/productImageCuration";

// Alinhados aos contratos canônicos emitidos pelo Autonomous Curator V2.
// Versões antigas permanecem persistidas para auditoria, mas não passam o gate weekly.
export const IMAGE_REVIEW_VERSION = "1.2";
export const DISPLAY_TITLE_REVIEW_VERSION = "1.0";

const FORBIDDEN_TITLE_PATTERNS = [
  /\b(shopee|mercado\s*livre|amazon|aliexpress|temu)\b/i,
  /\b(oferta|promo[cç][aã]o|imperd[ií]vel|frete\s*gr[aá]tis|envio\s*gr[aá]tis|top\s*seller)\b/i,
  /\b(sku|c[oó]d(?:igo)?\.?\s*[a-z0-9-]*|ref\.?\s*[a-z0-9-]+)\b/i,
  /\b(ignore|disregard|forget|override)\b[\s\S]{0,80}\b(previous|system|developer|instructions?)\b/i,
  /\b(system|developer|assistant)\s*(message|prompt|instruction)?\s*:/i,
  /\b(revele|mostre|imprima|reveal|show|print)\b[\s\S]{0,80}\b(prompt|instru[cç][oõ]es|secret|token)\b/i,
];

export function imageUrlFingerprint(url: string): string {
  return `sha256:${createHash("sha256").update(url.trim(), "utf8").digest("hex")}`;
}

export function imageCurationFingerprint(curation: Product["imageCuration"]): string {
  const primary = curation?.status === "ready" ? curation.primaryImageUrl?.trim() : "";
  if (!primary) throw new Error("PRODUCT_IMAGE_REVIEW_PRIMARY_MISSING");
  return imageUrlFingerprint(primary);
}

export function isEditorialDisplayTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  if (normalized.length < 3 || normalized.length > 90 || words.length > 10) return false;
  return !FORBIDDEN_TITLE_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isDisplayTitleReviewCurrent(product: Product): boolean {
  const normalizedDisplay = product.displayTitle?.replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR") || "";
  const normalizedRaw = (product.rawTitle || product.produto || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
  return (product.displayTitleStatus === "ready" || product.displayTitleStatus === "reviewed")
    && isEditorialDisplayTitle(product.displayTitle)
    && normalizedDisplay !== normalizedRaw
    && Boolean(product.displayTitleReviewedAt)
    && Boolean(product.displayTitleReviewModel?.trim())
    && product.displayTitleReviewVersion === DISPLAY_TITLE_REVIEW_VERSION;
}

export function isImageReviewCurrent(product: Product): boolean {
  const curation = product.imageCuration;
  const primary = curation?.status === "ready" ? curation.primaryImageUrl?.trim() : "";
  if (!primary || product.imageEditorialStatus !== "clean") return false;
  if (!Array.isArray(product.imagens) || !product.imagens.some(image => image.trim() === primary)) return false;
  const assessment = curation?.assessments.find(item => item.url === primary);
  return isCommercialImageAssessment(assessment)
    && product.imageReviewFingerprint === imageUrlFingerprint(primary)
    && Boolean(product.imageReviewedAt)
    && Boolean(product.imageReviewModel?.trim())
    && product.imageReviewVersion === IMAGE_REVIEW_VERSION;
}

export function invalidateImageReview(product: Product): Product {
  return {
    ...product,
    imageEditorialStatus: "unreviewed",
    imageCuration: undefined,
    imageReviewedAt: undefined,
    imageReviewModel: undefined,
    imageReviewVersion: undefined,
    imageReviewFingerprint: undefined,
  };
}

export function primaryImageChanged(current: Product, nextImages: readonly string[]): boolean {
  const primary = current.imageCuration?.primaryImageUrl?.trim();
  if (!primary) return false;
  return !nextImages.map(value => value.trim()).includes(primary);
}
