import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Product } from "../src/types";
import {
  isPublicCatalogEligibleDbRow,
  isPublicCatalogEligibleProduct,
  PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION,
} from "../server/services/publicCatalogEligibility";
import { categoryCounts } from "../server/services/autonomousCuratorCategoryPolicy";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    produto: "Peça",
    displayTitle: "Peça editorial",
    displayTitleStatus: "reviewed",
    categoria: "Iluminação",
    preco: 10,
    imagens: ["https://cdn.example/p1.jpg"],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: ["https://cdn.example/p1.jpg"],
      primaryImageUrl: "https://cdn.example/p1.jpg",
      galleryImageUrls: [],
      assessments: [{ url: "https://cdn.example/p1.jpg", decision: "clean", confidence: "HIGH", reason: "fixture" }],
    },
    link: "https://shopee.example/p1",
    ativo: true,
    destaque: false,
    status: "published",
    ...overrides,
  };
}

function deficitFallbackProduct(overrides: Partial<Product> = {}): Product {
  return product({
    createdBy: "autonomous_curator_queue",
    imageReviewModel: "deficit-fallback",
    imageReviewFingerprint: "fingerprint",
    displayTitleStatus: "review_required",
    imageEditorialStatus: "review_required",
    imageCuration: {
      status: "review_required",
      rawImageUrls: ["https://cdn.example/p1.jpg"],
      primaryImageUrl: "https://cdn.example/p1.jpg",
      galleryImageUrls: [],
      assessments: [],
      reason: "image_review_unavailable",
    },
    link: "https://shopee.com.br/product/123/456",
    ...overrides,
  });
}

test("public catalog eligibility mirrors Edge v4 strict plus deficit fallback contract", () => {
  assert.equal(PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, "edge-v4");
  assert.equal(isPublicCatalogEligibleProduct(product()), true);
  assert.equal(isPublicCatalogEligibleProduct(product({ displayTitleStatus: "unreviewed" })), false);
  assert.equal(isPublicCatalogEligibleProduct(product({ imageEditorialStatus: "unreviewed" })), false);
  assert.equal(isPublicCatalogEligibleProduct(product({
    imageCuration: {
      status: "review_required",
      rawImageUrls: ["https://cdn.example/p1.jpg"],
      galleryImageUrls: [],
      assessments: [],
      reason: "image_review_unavailable",
    },
  })), false);
  assert.equal(isPublicCatalogEligibleProduct(product({ ativo: false })), false);
});

test("authorized autonomous deficit fallback is public with hard technical evidence", () => {
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct()), true);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ imageReviewFingerprint: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ link: "https://example.com/product" })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({
    imageCuration: {
      status: "review_required",
      rawImageUrls: [],
      galleryImageUrls: [],
      assessments: [],
      reason: "image_review_unavailable",
    },
  })), false);
});

test("database-row predicate accepts only strict rows or marked deficit fallback rows", () => {
  const row = { id: "p1", ativo: true, status: "published", display_title: "Peça", display_title_status: "reviewed", image_editorial_status: "clean", image_curation: { status: "ready" } };
  assert.equal(isPublicCatalogEligibleDbRow(row), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, display_title_status: "unreviewed" }), false);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, image_curation: { status: "pending" } }), false);

  const fallbackRow = {
    ...row,
    created_by: "autonomous_curator_queue",
    image_review_model: "deficit-fallback",
    image_review_fingerprint: "fingerprint",
    display_title_status: "review_required",
    image_editorial_status: "review_required",
    image_curation: { status: "review_required", primaryImageUrl: "https://cdn.example/p1.jpg" },
    preco: 10,
    categoria: "Iluminação",
    link: "https://shopee.com.br/product/123/456",
  };
  assert.equal(isPublicCatalogEligibleDbRow(fallbackRow), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...fallbackRow, image_review_model: "other" }), false);
});

test("Edge source cannot drift from the shared public eligibility contract", async () => {
  const source = await readFile(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.eq\("ativo", true\)/);
  assert.match(source, /\.eq\("status", "published"\)/);
  assert.match(source, /\.not\("display_title", "is", null\)/);
  assert.match(source, /isStrictEditorialRow/);
  assert.match(source, /isDeficitFallbackPublicRow/);
  assert.match(source, /AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL = "deficit-fallback"/);
  assert.match(source, /image_review_fingerprint/);
  assert.match(source, /validShopeeAffiliateLink/);
});

test("category deficit counts strict and authorized deficit-fallback products as public", () => {
  const counts = categoryCounts([
    product({ id: "strict" }),
    deficitFallbackProduct({ id: "fallback" }),
    product({ id: "bad-title", displayTitleStatus: "unreviewed" }),
    product({ id: "bad-image", imageEditorialStatus: "unreviewed" }),
  ]);
  assert.equal(counts["Iluminação"], 2);
});
