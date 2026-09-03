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

test("unreviewed display title and image can never become published", () => {
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

test("off-brand, REVIEW state and prohibited similarity remain hard blockers", () => {
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

test("database migration enforces authorization and never fabricates editorial review", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260902233000_product_publication_gate.sql", import.meta.url), "utf8");
  assert.match(migration, /products_publication_authorization_guard/);
  assert.match(migration, /PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING/);
  assert.match(migration, /display_title_status <> 'reviewed'/);
  assert.match(migration, /image_editorial_status <> 'clean'/);
  assert.match(migration, /set ativo = false,\s*status = 'paused'/);
  assert.doesNotMatch(migration, /set\s+display_title_status\s*=\s*'reviewed'/i);
  assert.doesNotMatch(migration, /set\s+image_editorial_status\s*=\s*'clean'/i);
});
