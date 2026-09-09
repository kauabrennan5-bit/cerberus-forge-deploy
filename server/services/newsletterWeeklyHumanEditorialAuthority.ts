import type { Product } from "../../src/types";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import { imageUrlFingerprint } from "./productEditorialReview";

export type WeeklyHumanEditorialAuthority = {
  reviewId: string;
  approvedAt: string;
  primaryImageUrl: string;
  imageFingerprint: string;
  operationId: string | null;
  shopId: string;
  itemId: string;
};

const authorities = new WeakMap<Product, WeeklyHumanEditorialAuthority>();

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function primaryImage(product: Product): string {
  return clean(product.imageCuration?.primaryImageUrl) || clean(product.imagens?.[0]);
}

export function attachWeeklyHumanEditorialAuthority(product: Product, authority: WeeklyHumanEditorialAuthority | null): Product {
  if (authority) authorities.set(product, authority);
  else authorities.delete(product);
  return product;
}

export function getWeeklyHumanEditorialAuthority(product: Product): WeeklyHumanEditorialAuthority | null {
  return authorities.get(product) || null;
}

export function isWeeklyHumanEditorialAuthorityCurrent(product: Product): boolean {
  const authority = getWeeklyHumanEditorialAuthority(product);
  if (!authority || product.ativo !== true || product.status !== "published") return false;
  const currentPrimary = primaryImage(product);
  if (!currentPrimary || !/^https:\/\//i.test(currentPrimary)) return false;
  if (currentPrimary !== authority.primaryImageUrl) return false;
  return authority.imageFingerprint === imageUrlFingerprint(currentPrimary);
}

export async function loadWeeklyProductsWithHumanEditorialAuthority(): Promise<Product[]> {
  const products = await productsRepository.getProducts();
  if (products.length === 0) return products;

  const ids = products.map(product => product.id);
  const { data, error } = await requireSupabase()
    .from("product_publication_authorizations")
    .select("product_id,review_id,approved_at,approval_origin,shop_id,item_id,source_product_url,primary_image_url,image_fingerprint,operation_id,evidence,consumed_at")
    .in("product_id", ids)
    .eq("source", "admin")
    .eq("approval_origin", "telegram")
    .not("consumed_at", "is", null)
    .not("review_id", "is", null)
    .not("approved_at", "is", null)
    .order("consumed_at", { ascending: false });
  if (error) throw new Error(`WEEKLY_HUMAN_EDITORIAL_AUTHORITY_READ_FAILED:${error.code || "unknown"}`);

  const latestByProduct = new Map<string, Record<string, any>>();
  for (const row of Array.isArray(data) ? data : []) {
    const productId = clean(row.product_id);
    if (!productId || latestByProduct.has(productId)) continue;
    const evidence = row.evidence && typeof row.evidence === "object" ? row.evidence as Record<string, unknown> : {};
    const human = evidence.humanManualApproval === true || String(evidence.humanManualApproval).toLowerCase() === "true";
    if (!human) continue;
    latestByProduct.set(productId, row as Record<string, any>);
  }

  for (const product of products) {
    const row = latestByProduct.get(product.id);
    if (!row) continue;
    const currentPrimary = primaryImage(product);
    const approvedPrimary = clean(row.primary_image_url);
    const persistedFingerprint = clean(row.image_fingerprint);
    const reviewId = clean(row.review_id);
    const approvedAt = clean(row.approved_at);
    const shopId = clean(row.shop_id);
    const itemId = clean(row.item_id);
    if (!currentPrimary || !approvedPrimary || currentPrimary !== approvedPrimary) continue;
    if (!persistedFingerprint || persistedFingerprint !== imageUrlFingerprint(currentPrimary)) continue;
    if (!reviewId || !approvedAt || !shopId || !itemId) continue;

    attachWeeklyHumanEditorialAuthority(product, {
      reviewId,
      approvedAt,
      primaryImageUrl: approvedPrimary,
      imageFingerprint: persistedFingerprint,
      operationId: clean(row.operation_id) || null,
      shopId,
      itemId,
    });
  }
  return products;
}

export const newsletterWeeklyHumanEditorialAuthorityInternals = {
  primaryImage,
};
