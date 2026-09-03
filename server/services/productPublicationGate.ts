import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import { isPublicProductCategory } from "../../src/lib/productCategory";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { requireSupabase } from "../repositories/productsRepository";
import {
  imageUrlFingerprint,
  isEditorialDisplayTitle,
} from "./productEditorialReview";

export const PUBLICATION_GATE_VERSION = "1";
export const MAX_CATALOG_SIMILARITY = 0.82;

export type PublicationSource = "autonomous_curator" | "product_rotation" | "admin" | "queue" | "recovery";

export type ProductPublicationEvidence = {
  source: PublicationSource;
  score: number;
  threshold?: number;
  maximumCatalogSimilarity: number;
  categoryMismatch: boolean;
  offBrand: boolean;
  lifecycleApproved: boolean;
  reviewState?: string | null;
};

type SourceIdentity = {
  marketplace: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  productId: string | null;
};

export type ProductPublicationEligibilityInput = {
  product: Product;
  identity: SourceIdentity | null;
  evidence: ProductPublicationEvidence;
  canonicalThreshold: number;
  duplicateProductIds?: string[];
};

export type ProductPublicationEligibility = {
  ok: boolean;
  errors: string[];
  primaryImageUrl: string | null;
  threshold: number;
};

function validHttpsUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function validAffiliateLink(link: string | undefined): boolean {
  const url = validHttpsUrl(link);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === "shopee.com.br" || host.endsWith(".shopee.com.br");
}

function validOfficialShopeeIdentity(identity: SourceIdentity | null, productId: string): boolean {
  if (!identity || identity.marketplace.toLowerCase() !== "shopee") return false;
  if (!identity.shopId || !identity.itemId || identity.productId !== productId) return false;
  const parsed = extractShopeeIdentity(identity.sourceProductUrl);
  return parsed.shopId === identity.shopId && parsed.itemId === identity.itemId;
}

function normalizedLink(value: string | undefined): string {
  const url = validHttpsUrl(value);
  if (!url) return "";
  url.hash = "";
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

export function validateProductPublicationEligibility(input: ProductPublicationEligibilityInput): ProductPublicationEligibility {
  const { product, evidence } = input;
  const errors: string[] = [];
  const threshold = Number.isFinite(Number(evidence.threshold))
    ? Math.max(input.canonicalThreshold, Number(evidence.threshold))
    : input.canonicalThreshold;
  const primaryImageUrl = product.imageCuration?.status === "ready"
    ? product.imageCuration.primaryImageUrl?.trim() || null
    : null;

  if (!validOfficialShopeeIdentity(input.identity, product.id)) errors.push("PUBLICATION_SHOPEE_IDENTITY_INVALID");
  if (!input.identity?.shopId || !input.identity?.itemId) errors.push("PUBLICATION_SHOPEE_IDS_MISSING");
  if (!input.identity?.sourceProductUrl || !validHttpsUrl(input.identity.sourceProductUrl)) errors.push("PUBLICATION_SOURCE_URL_INVALID");
  if (!validAffiliateLink(product.link)) errors.push("PUBLICATION_AFFILIATE_LINK_INVALID");
  if (!isPublicProductCategory(product.categoria)) errors.push("PUBLICATION_CATEGORY_INVALID");
  if (!Number.isFinite(evidence.score) || evidence.score < threshold) errors.push("PUBLICATION_SCORE_BELOW_CANONICAL_THRESHOLD");

  if (product.imageEditorialStatus !== "clean") errors.push("PUBLICATION_IMAGE_NOT_CLEAN");
  if (!product.imageCuration || product.imageCuration.status !== "ready") errors.push("PUBLICATION_IMAGE_REVIEW_NOT_READY");
  if (!primaryImageUrl || !validHttpsUrl(primaryImageUrl)) errors.push("PUBLICATION_PRIMARY_IMAGE_MISSING");
  if (!product.imageReviewFingerprint || !primaryImageUrl || product.imageReviewFingerprint !== imageUrlFingerprint(primaryImageUrl)) {
    errors.push("PUBLICATION_IMAGE_FINGERPRINT_STALE");
  }
  const primaryAssessment = primaryImageUrl
    ? product.imageCuration?.assessments.find(assessment => assessment.url === primaryImageUrl)
    : undefined;
  if (!primaryAssessment || primaryAssessment.decision !== "clean" || primaryAssessment.confidence === "LOW") {
    errors.push("PUBLICATION_IMAGE_PRIMARY_NOT_EDITORIALLY_APPROVED");
  }
  if (product.imageCuration?.assessments.some(assessment => assessment.decision === "off_brand" && assessment.confidence !== "LOW")) {
    errors.push("PUBLICATION_IMAGE_OFF_BRAND");
  }

  const displayTitle = String(product.displayTitle || "").replace(/\s+/g, " ").trim();
  const rawTitle = String(product.rawTitle || product.produto || "").replace(/\s+/g, " ").trim();
  if (product.displayTitleStatus !== "reviewed") errors.push("PUBLICATION_DISPLAY_TITLE_NOT_REVIEWED");
  if (!displayTitle || displayTitle === rawTitle || !isEditorialDisplayTitle(displayTitle)) errors.push("PUBLICATION_DISPLAY_TITLE_INVALID");
  if (!Number.isFinite(Number(product.preco)) || Number(product.preco) <= 0) errors.push("PUBLICATION_PRICE_UNVERIFIED");
  if ((input.duplicateProductIds || []).some(id => id !== product.id)) errors.push("PUBLICATION_DUPLICATE_PRODUCT");
  if (input.identity?.productId && input.identity.productId !== product.id) errors.push("PUBLICATION_IDENTITY_OWNED_BY_OTHER_PRODUCT");
  if (!Number.isFinite(evidence.maximumCatalogSimilarity) || evidence.maximumCatalogSimilarity >= MAX_CATALOG_SIMILARITY) {
    errors.push("PUBLICATION_CATALOG_SIMILARITY_PROHIBITED");
  }
  if (evidence.categoryMismatch) errors.push("PUBLICATION_CATEGORY_MISMATCH");
  if (evidence.offBrand) errors.push("PUBLICATION_OFF_BRAND");
  if (!evidence.lifecycleApproved) errors.push("PUBLICATION_PIPELINE_NOT_APPROVED");
  if (/REVIEW/i.test(String(evidence.reviewState || ""))) errors.push("PUBLICATION_REVIEW_STATE_FORBIDDEN");

  return { ok: errors.length === 0, errors: [...new Set(errors)], primaryImageUrl, threshold };
}

async function canonicalAutoPublishThreshold(): Promise<number> {
  const { data, error } = await requireSupabase()
    .from("autonomous_curator_config")
    .select("auto_publish_threshold")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw error;
  const threshold = Number(data?.auto_publish_threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("PUBLICATION_CANONICAL_THRESHOLD_UNAVAILABLE");
  return threshold;
}

async function loadIdentity(productId: string): Promise<SourceIdentity | null> {
  const { data, error } = await requireSupabase()
    .from("product_source_identities")
    .select("marketplace,shop_id,item_id,source_product_url,product_id")
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    marketplace: String(data.marketplace || ""),
    shopId: String(data.shop_id || ""),
    itemId: String(data.item_id || ""),
    sourceProductUrl: String(data.source_product_url || ""),
    productId: data.product_id ? String(data.product_id) : null,
  };
}

async function duplicateProductIds(product: Product, identity: SourceIdentity | null): Promise<string[]> {
  const { data, error } = await requireSupabase()
    .from("products")
    .select("id,link,ativo,status")
    .neq("id", product.id);
  if (error) throw error;
  const incomingLink = normalizedLink(product.link);
  const duplicates = (data || []).filter(row => {
    if (row.ativo === false || String(row.status || "") === "archived") return false;
    return incomingLink && normalizedLink(String(row.link || "")) === incomingLink;
  }).map(row => String(row.id));

  if (identity) {
    const { data: identityRows, error: identityError } = await requireSupabase()
      .from("product_source_identities")
      .select("product_id")
      .eq("marketplace", identity.marketplace)
      .eq("shop_id", identity.shopId)
      .eq("item_id", identity.itemId)
      .not("product_id", "is", null);
    if (identityError) throw identityError;
    for (const row of identityRows || []) {
      if (row.product_id && String(row.product_id) !== product.id) duplicates.push(String(row.product_id));
    }
  }
  return [...new Set(duplicates)];
}

export async function assertProductPublicationEligibility(
  product: Product,
  evidence: ProductPublicationEvidence,
): Promise<ProductPublicationEligibility> {
  const canonicalThreshold = await canonicalAutoPublishThreshold();
  const identity = await loadIdentity(product.id);
  const duplicates = await duplicateProductIds(product, identity);
  const eligibility = validateProductPublicationEligibility({
    product,
    identity,
    evidence,
    canonicalThreshold,
    duplicateProductIds: duplicates,
  });
  if (!eligibility.ok) throw new Error(`PRODUCT_PUBLICATION_BLOCKED:${eligibility.errors.join("|")}`);
  return eligibility;
}

export async function publishProductWithGate(input: {
  product: Product;
  evidence: ProductPublicationEvidence;
  createdBy?: string;
}): Promise<void> {
  const eligibility = await assertProductPublicationEligibility(input.product, input.evidence);
  const client = requireSupabase();
  const authorizationId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const { error: authorizationError } = await client.from("product_publication_authorizations").insert({
    authorization_id: authorizationId,
    product_id: input.product.id,
    source: input.evidence.source,
    gate_version: PUBLICATION_GATE_VERSION,
    score: input.evidence.score,
    threshold: eligibility.threshold,
    maximum_catalog_similarity: input.evidence.maximumCatalogSimilarity,
    expires_at: expiresAt,
    evidence: {
      primaryImageUrl: eligibility.primaryImageUrl,
      lifecycleApproved: input.evidence.lifecycleApproved,
      categoryMismatch: input.evidence.categoryMismatch,
      offBrand: input.evidence.offBrand,
      reviewState: input.evidence.reviewState || null,
    },
  });
  if (authorizationError) throw authorizationError;

  const { data, error } = await client.from("products").update({
    ativo: true,
    status: "published",
    ...(input.createdBy ? { created_by: input.createdBy } : {}),
  }).eq("id", input.product.id).select("id").maybeSingle();
  if (error || !data) {
    await client.from("product_publication_authorizations").delete().eq("authorization_id", authorizationId).is("consumed_at", null).then(() => undefined, () => undefined);
    if (error) throw error;
    throw new Error("PRODUCT_PUBLICATION_TRANSITION_NOT_APPLIED");
  }
  input.product.ativo = true;
  input.product.status = "published";
  if (input.createdBy) input.product.createdBy = input.createdBy;
}
