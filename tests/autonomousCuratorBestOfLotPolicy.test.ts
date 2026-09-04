import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Product } from "../src/types";
import { imageUrlFingerprint } from "../server/services/productEditorialReview";
import { validateProductPublicationEligibility } from "../server/services/productPublicationGate";

const imageUrl = "https://down-br.img.susercontent.com/file/best-of-lot-image";

function fallbackProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-best-of-lot",
    ref: "AUTO-BEST",
    produto: "Marketplace raw title",
    rawTitle: "Marketplace raw title",
    displayTitle: "Marketplace raw title",
    displayTitleStatus: "reviewed",
    displayTitleReviewedAt: "2026-09-04T20:00:00.000Z",
    displayTitleReviewModel: "deterministic-best-of-lot-v1",
    displayTitleReviewVersion: "1",
    categoria: "Decoração",
    preco: 49.9,
    imagens: [imageUrl],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [imageUrl],
      primaryImageUrl: imageUrl,
      galleryImageUrls: [],
      assessments: [{ url: imageUrl, decision: "unknown", confidence: "LOW", reason: "fallback" }],
    },
    imageReviewedAt: "2026-09-04T20:00:00.000Z",
    imageReviewModel: "best-of-lot",
    imageReviewVersion: "2",
    imageReviewFingerprint: imageUrlFingerprint(imageUrl),
    link: "https://s.shopee.com.br/affiliate-best",
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
  productId: "prod-best-of-lot",
};

test("autonomous best-of-lot bypasses soft editorial blockers but keeps technical integrity", () => {
  const product = fallbackProduct();
  const result = validateProductPublicationEligibility({
    product,
    identity,
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: {
      source: "autonomous_curator",
      score: 12,
      maximumCatalogSimilarity: 0.99,
      categoryMismatch: false,
      offBrand: true,
      lifecycleApproved: false,
      reviewState: "REVIEW_REQUIRED",
      bestOfLotFallback: true,
      publicationWarnings: ["image_review_budget_exhausted", "off_brand"],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);

  const invalidLink = validateProductPublicationEligibility({
    product: fallbackProduct({ link: "https://example.com/not-shopee" }),
    identity,
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: {
      source: "autonomous_curator",
      score: 0,
      maximumCatalogSimilarity: 1,
      categoryMismatch: false,
      offBrand: true,
      lifecycleApproved: false,
      reviewState: "REVIEW_REQUIRED",
      bestOfLotFallback: true,
    },
  });
  assert.equal(invalidLink.ok, false);
  assert.ok(invalidLink.errors.includes("PUBLICATION_AFFILIATE_LINK_INVALID"));
});

test("best-of-lot is restricted to autonomous/recovery publication sources", () => {
  const result = validateProductPublicationEligibility({
    product: fallbackProduct(),
    identity,
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: {
      source: "admin",
      score: 12,
      maximumCatalogSimilarity: 0.99,
      categoryMismatch: false,
      offBrand: true,
      lifecycleApproved: false,
      reviewState: "REVIEW_REQUIRED",
      bestOfLotFallback: true,
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PUBLICATION_SCORE_BELOW_CANONICAL_THRESHOLD"));
});

test("continuous curator keeps every searched candidate in the best-of-lot enrichment pool", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.match(source, /evaluateWithBestOfLot/);
  assert.match(source, /const rankedPool = \[\.\.\.candidatePool\]/);
  assert.match(source, /softPenalty/);
  assert.match(source, /publicationMode: "STANDARD"/);
  assert.doesNotMatch(source, /if \(hasBlockedProfileTerm\(input\.profile, item\.name\)\) \{ metrics\.candidatesRejected/);
});

test("database guard explicitly authorizes autonomous best-of-lot and preserves hard invariants", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260904203000_autonomous_best_of_lot_publication.sql", import.meta.url), "utf8");
  assert.match(migration, /bestOfLotFallback/);
  assert.match(migration, /ppa\.source in \('autonomous_curator', 'recovery'\)/);
  assert.match(migration, /AFFILIATE_LINK_INVALID/);
  assert.match(migration, /SHOPEE_IDENTITY_INVALID/);
  assert.match(migration, /PRICE_UNVERIFIED/);
  assert.match(migration, /IMAGE_REVIEW_NOT_CLEAN/);
});
