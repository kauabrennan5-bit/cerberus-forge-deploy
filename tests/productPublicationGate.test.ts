import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Product } from "../src/types";
import { imageUrlFingerprint } from "../server/services/productEditorialReview";
import {
  validateProductPublicationEligibility,
  MAX_CATALOG_SIMILARITY,
} from "../server/services/productPublicationGate";

const primaryImageUrl = "https://down-br.img.susercontent.com/file/clean-image";

function reviewedProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-reviewed",
    ref: "REF-REVIEWED",
    produto: "Nome bruto marketplace muito longo",
    rawTitle: "Nome bruto marketplace muito longo",
    displayTitle: "Luminária cromada de mesa",
    displayTitleStatus: "reviewed",
    displayTitleReviewedAt: "2026-09-02T20:00:00.000Z",
    displayTitleReviewModel: "gemini-review",
    displayTitleReviewVersion: "1",
    categoria: "Iluminação",
    preco: 249.9,
    imagens: [primaryImageUrl],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [primaryImageUrl],
      primaryImageUrl,
      galleryImageUrls: [],
      assessments: [{
        url: primaryImageUrl,
        decision: "clean",
        confidence: "HIGH",
        reason: "Produto completo em foto comercial limpa.",
      }],
    },
    imageReviewedAt: "2026-09-02T20:00:00.000Z",
    imageReviewModel: "visual-chain",
    imageReviewVersion: "1",
    imageReviewFingerprint: imageUrlFingerprint(primaryImageUrl),
    link: "https://s.shopee.com.br/affiliate-example",
    ativo: false,
    destaque: false,
    status: "paused",
    ...overrides,
  };
}

const identity = {
  marketplace: "Shopee",
  shopId: "123",
  itemId: "456",
  sourceProductUrl: "https://shopee.com.br/product/123/456",
  productId: "prod-reviewed",
  reviewId: null,
};

function eligibility(product = reviewedProduct(), evidenceOverrides: Record<string, unknown> = {}) {
  return validateProductPublicationEligibility({
    product,
    identity: { ...identity, productId: product.id },
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: {
      source: "autonomous_curator",
      score: 92,
      maximumCatalogSimilarity: 0.3,
      categoryMismatch: false,
      offBrand: false,
      lifecycleApproved: true,
      reviewState: "CURATED",
      ...evidenceOverrides,
    },
  });
}

test("fully reviewed candidate above canonical threshold can pass publication authority", () => {
  const result = eligibility();
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("score 71 remains blocked when canonical threshold is 88", () => {
  const result = eligibility(reviewedProduct(), { score: 71 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PUBLICATION_SCORE_BELOW_CANONICAL_THRESHOLD"));
});

test("unreviewed display title and image can never become autonomously published", () => {
  const result = eligibility(reviewedProduct({
    displayTitleStatus: "unreviewed",
    imageEditorialStatus: "unreviewed",
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PUBLICATION_DISPLAY_TITLE_NOT_REVIEWED"));
  assert.ok(result.errors.includes("PUBLICATION_IMAGE_NOT_CLEAN"));
});

test("stale image fingerprint is blocked even if status says clean", () => {
  const result = eligibility(reviewedProduct({ imageReviewFingerprint: "stale" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PUBLICATION_IMAGE_FINGERPRINT_STALE"));
});

test("off-brand, REVIEW state and prohibited similarity remain hard blockers for automatic authority", () => {
  const result = eligibility(reviewedProduct(), {
    offBrand: true,
    reviewState: "REVIEW_REQUIRED",
    maximumCatalogSimilarity: MAX_CATALOG_SIMILARITY,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PUBLICATION_OFF_BRAND"));
  assert.ok(result.errors.includes("PUBLICATION_REVIEW_STATE_FORBIDDEN"));
  assert.ok(result.errors.includes("PUBLICATION_CATALOG_SIMILARITY_PROHIBITED"));
});

test("manual Product Rotation confirmation overrides editorial evidence but not technical integrity", () => {
  const manualEvidence = {
    source: "product_rotation",
    manualEditorialOverride: true,
    score: 10,
    offBrand: true,
    lifecycleApproved: false,
    reviewState: "REVIEW_REQUIRED",
    maximumCatalogSimilarity: 0.99,
  };
  const result = eligibility(reviewedProduct(), manualEvidence);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);

  const invalidLink = eligibility(reviewedProduct({ link: "https://example.com/not-shopee" }), manualEvidence);
  assert.equal(invalidLink.ok, false);
  assert.ok(invalidLink.errors.includes("PUBLICATION_AFFILIATE_LINK_INVALID"));
});

test("Telegram PUBLICAR has final editorial authority but preserves objective hard blocks", () => {
  const product = reviewedProduct({
    displayTitleStatus: "unreviewed",
    imageEditorialStatus: "unreviewed",
    imageCuration: undefined,
    imageReviewFingerprint: undefined,
  });
  const humanEvidence = {
    source: "admin" as const,
    humanManualApproval: true,
    sourceProductUrl: identity.sourceProductUrl,
    score: 10,
    maximumCatalogSimilarity: 0.99,
    categoryMismatch: false,
    offBrand: true,
    lifecycleApproved: false,
    reviewState: "REVIEW_REQUIRED",
  };
  const result = validateProductPublicationEligibility({
    product,
    identity: { ...identity, productId: null, reviewId: "review-telegram-1" },
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: humanEvidence,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);

  const invalidPrice = validateProductPublicationEligibility({
    product: { ...product, preco: 0 },
    identity: { ...identity, productId: null, reviewId: "review-telegram-1" },
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: humanEvidence,
  });
  assert.ok(invalidPrice.errors.includes("PUBLICATION_PRICE_UNVERIFIED"));

  const missingImage = validateProductPublicationEligibility({
    product: { ...product, imagens: [] },
    identity: { ...identity, productId: null, reviewId: "review-telegram-1" },
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: humanEvidence,
  });
  assert.ok(missingImage.errors.includes("PUBLICATION_PRIMARY_IMAGE_MISSING"));

  const duplicate = validateProductPublicationEligibility({
    product,
    identity: { ...identity, productId: null, reviewId: "review-telegram-1" },
    canonicalThreshold: 88,
    duplicateProductIds: ["another-product"],
    evidence: humanEvidence,
  });
  assert.ok(duplicate.errors.includes("PUBLICATION_DUPLICATE_PRODUCT"));
});

test("database migration enforces authorization and never fabricates editorial review", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260903041603_product_publication_gate.sql", import.meta.url), "utf8");
  assert.match(migration, /products_publication_authorization_guard/);
  assert.match(migration, /PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING/);
  assert.match(migration, /display_title_status <> 'reviewed'/);
  assert.match(migration, /image_editorial_status <> 'clean'/);
  assert.match(migration, /set ativo = false,\s*status = 'paused'/);
  assert.doesNotMatch(migration, /set\s+display_title_status\s*=\s*'reviewed'/i);
  assert.doesNotMatch(migration, /set\s+image_editorial_status\s*=\s*'clean'/i);
});

test("manual rotation override exists only inside product_rotation authorization path", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260904194500_manual_rotation_editorial_override.sql", import.meta.url), "utf8");
  assert.match(migration, /ppa\.source = 'product_rotation'/);
  assert.match(migration, /manualEditorialOverride/);
  assert.match(migration, /categoryMismatch/);
  assert.match(migration, /AFFILIATE_LINK_INVALID/);
  assert.match(migration, /SHOPEE_IDENTITY_INVALID/);
  assert.match(migration, /PRICE_UNVERIFIED/);
});

test("Telegram human override migration keeps technical gates and reserved-card identity", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260906004155_human_telegram_publication_editorial_override.sql", import.meta.url), "utf8");
  assert.match(migration, /ppa\.source = 'admin'/);
  assert.match(migration, /humanManualApproval/);
  assert.match(migration, /sourceProductUrl/);
  assert.match(migration, /psi\.review_id is not null/);
  assert.match(migration, /PRIMARY_IMAGE_MISSING/);
  assert.match(migration, /PRICE_UNVERIFIED/);
  assert.match(migration, /CATEGORY_INVALID/);
  assert.match(migration, /AFFILIATE_LINK_INVALID/);
  assert.match(migration, /SHOPEE_IDENTITY_INVALID/);
  assert.doesNotMatch(migration, /set\s+display_title_status\s*=\s*'reviewed'/i);
  assert.doesNotMatch(migration, /set\s+image_editorial_status\s*=\s*'clean'/i);
});
