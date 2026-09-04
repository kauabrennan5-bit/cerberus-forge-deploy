import type { Product } from "../../src/types";

export const PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION = "edge-v3";

function imageCurationReady(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && String((value as Record<string, unknown>).status || "") === "ready";
}

export function isPublicCatalogEligibleProduct(product: Product): boolean {
  return product.ativo === true
    && product.status === "published"
    && product.displayTitleStatus === "reviewed"
    && product.imageEditorialStatus === "clean"
    && product.displayTitle !== undefined
    && product.displayTitle !== null
    && imageCurationReady(product.imageCuration);
}

export function isPublicCatalogEligibleDbRow(row: Record<string, unknown>): boolean {
  return row.ativo === true
    && String(row.status || "") === "published"
    && String(row.display_title_status || "") === "reviewed"
    && String(row.image_editorial_status || "") === "clean"
    && row.display_title !== null
    && row.display_title !== undefined
    && imageCurationReady(row.image_curation);
}
