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

function telegramManualProduct(overrides: Partial<Product> = {}): Product {
  return product({
    createdBy: "telegram_manual",
    displayTitleStatus: "review_required",
    imageEditorialStatus: "review_required",
    imageReviewFingerprint: undefined,
    imageCuration: {
      status: "review_required",
      rawImageUrls: ["https://cdn.example/manual.jpg"],
      primaryImageUrl: "https://cdn.example/manual.jpg",
      galleryImageUrls: [],
      assessments: [],
      reason: "human_editorial_authority",
    },
    imagens: ["https://cdn.example/manual.jpg"],
    link: "https://s.shopee.com.br/manual",
    ...overrides,
  });
}

test("public catalog eligibility mirrors Edge v5 strict, deficit fallback and governed manual contract", () => {
  assert.equal(PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, "edge-v5-manual");
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

test("Telegram human-approved publication is public without re-opening aesthetic gates", () => {
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct()), true);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ createdBy: "other" })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ link: "https://example.com/product" })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ preco: 0 })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ categoria: "Categoria inválida" as any })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ imagens: [], imageCuration: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ ativo: false })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ status: "approved" })), false);
});

test("database-row predicate accepts strict, deficit fallback or governed Telegram manual rows", () => {
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

  const manualRow = {
    ...row,
    created_by: "telegram_manual",
    display_title_status: "review_required",
    image_editorial_status: "review_required",
    image_curation: { status: "review_required", primaryImageUrl: "https://cdn.example/manual.jpg" },
    imagens: ["https://cdn.example/manual.jpg"],
    preco: 12.2,
    categoria: "Decoração",
    link: "https://s.shopee.com.br/manual",
  };
  assert.equal(isPublicCatalogEligibleDbRow(manualRow), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...manualRow, created_by: "other" }), false);
  assert.equal(isPublicCatalogEligibleDbRow({ ...manualRow, image_curation: null, imagens: [] }), false);
});

test("Edge source cannot drift from the shared public eligibility contract", async () => {
  const source = await readFile(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.eq\("ativo", true\)/);
  assert.match(source, /\.eq\("status", "published"\)/);
  assert.match(source, /\.not\("display_title", "is", null\)/);
  assert.match(source, /isStrictEditorialRow/);
  assert.match(source, /isDeficitFallbackPublicRow/);
  assert.match(source, /isTelegramManualPublicRow/);
  assert.match(source, /TELEGRAM_MANUAL_CREATED_BY = "telegram_manual"/);
  assert.match(source, /AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL = "deficit-fallback"/);
  assert.match(source, /image_review_fingerprint/);
  assert.match(source, /validShopeeAffiliateLink/);
});

test("category deficit counts strict, authorized deficit-fallback and manual Telegram products as public", () => {
  const counts = categoryCounts([
    product({ id: "strict" }),
    deficitFallbackProduct({ id: "fallback" }),
    telegramManualProduct({ id: "manual" }),
    product({ id: "bad-title", displayTitleStatus: "unreviewed" }),
    product({ id: "bad-image", imageEditorialStatus: "unreviewed" }),
  ]);
  assert.equal(counts["Iluminação"], 3);
});
