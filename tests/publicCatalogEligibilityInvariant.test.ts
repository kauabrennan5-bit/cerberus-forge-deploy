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
import { imageUrlFingerprint } from "../server/services/productEditorialReview";

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
    link: "https://s.shopee.com.br/p1",
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
    humanEditorialApprovedAt: "2026-09-08T12:00:00.000Z",
    humanEditorialImageUrl: "https://cdn.example/p1.jpg",
    humanEditorialImageFingerprint: imageUrlFingerprint("https://cdn.example/p1.jpg"),
    humanEditorialReviewId: "review-deficit-1",
    humanEditorialAuthorizationId: "authorization-deficit-1",
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
      reason: "image_review_unavailable",
    },
    imagens: ["https://cdn.example/manual.jpg"],
    humanEditorialApprovedAt: "2026-09-08T12:00:00.000Z",
    humanEditorialImageUrl: "https://cdn.example/manual.jpg",
    humanEditorialImageFingerprint: imageUrlFingerprint("https://cdn.example/manual.jpg"),
    humanEditorialReviewId: "review-manual-1",
    humanEditorialAuthorizationId: "authorization-manual-1",
    link: "https://s.shopee.com.br/manual",
    ...overrides,
  });
}

test("public catalog eligibility mirrors the strict and human-governed boundary", () => {
  assert.equal(PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, "edge-v6-human-approval");
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

test("Curator deficit fallback is public only with current persisted human proof", () => {
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct()), true);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ humanEditorialApprovedAt: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ humanEditorialReviewId: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ humanEditorialImageFingerprint: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ humanEditorialImageUrl: "https://cdn.example/changed.jpg" })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({ link: "https://example.com/product" })), false);
  assert.equal(isPublicCatalogEligibleProduct(deficitFallbackProduct({
    imagens: [],
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
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ humanEditorialReviewId: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ link: "https://example.com/product" })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ preco: 0 })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ categoria: "Categoria inválida" as any })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ imagens: [], imageCuration: undefined })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ ativo: false })), false);
  assert.equal(isPublicCatalogEligibleProduct(telegramManualProduct({ status: "approved" })), false);
});

test("database-row predicate accepts strict rows or governed rows with durable human proof", () => {
  const row = { id: "p1", ativo: true, status: "published", produto: "Peça", display_title: "Peça", display_title_status: "reviewed", image_editorial_status: "clean", image_curation: { status: "ready", primaryImageUrl: "https://cdn.example/p1.jpg" }, imagens: ["https://cdn.example/p1.jpg"], preco: 10, categoria: "Iluminação", link: "https://s.shopee.com.br/p1" };
  assert.equal(isPublicCatalogEligibleDbRow(row), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, display_title_status: "unreviewed" }), false);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, image_curation: { status: "pending" } }), false);

  const fallbackRow = {
    ...row,
    created_by: "autonomous_curator_queue",
    human_editorial_approved_at: "2026-09-08T12:00:00.000Z",
    human_editorial_image_url: "https://cdn.example/p1.jpg",
    human_editorial_image_fingerprint: imageUrlFingerprint("https://cdn.example/p1.jpg"),
    human_editorial_review_id: "review-deficit-1",
    human_editorial_authorization_id: "authorization-deficit-1",
    display_title_status: "review_required",
    image_editorial_status: "review_required",
    image_curation: { status: "review_required", primaryImageUrl: "https://cdn.example/p1.jpg" },
    preco: 10,
    categoria: "Iluminação",
    link: "https://shopee.com.br/product/123/456",
  };
  assert.equal(isPublicCatalogEligibleDbRow(fallbackRow), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...fallbackRow, human_editorial_review_id: null }), false);

  const manualRow = {
    ...row,
    created_by: "telegram_manual",
    display_title_status: "review_required",
    image_editorial_status: "review_required",
    image_curation: { status: "review_required", primaryImageUrl: "https://cdn.example/manual.jpg" },
    imagens: ["https://cdn.example/manual.jpg"],
    human_editorial_approved_at: "2026-09-08T12:00:00.000Z",
    human_editorial_image_url: "https://cdn.example/manual.jpg",
    human_editorial_image_fingerprint: imageUrlFingerprint("https://cdn.example/manual.jpg"),
    human_editorial_review_id: "review-manual-1",
    human_editorial_authorization_id: "authorization-manual-1",
    preco: 12.2,
    categoria: "Decoração",
    link: "https://s.shopee.com.br/manual",
  };
  assert.equal(isPublicCatalogEligibleDbRow(manualRow), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...manualRow, human_editorial_authorization_id: null }), false);
  assert.equal(isPublicCatalogEligibleDbRow({ ...manualRow, image_curation: null, imagens: [] }), false);
});

test("Edge source cannot drift from the shared public eligibility contract", async () => {
  const source = await readFile(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.eq\("ativo", true\)/);
  assert.match(source, /\.eq\("status", "published"\)/);
  assert.match(source, /toPublicProductDTOs/);
  assert.match(source, /human_editorial_review_id/);
  assert.match(source, /human_editorial_authorization_id/);
  assert.doesNotMatch(source, /curator_note/);
  assert.doesNotMatch(source, /isDeficitFallbackPublicRow/);
});

test("category coverage counts strict and human-approved products but excludes unapproved Curator rows", () => {
  const counts = categoryCounts([
    product({ id: "strict" }),
    deficitFallbackProduct({ id: "fallback" }),
    telegramManualProduct({ id: "manual" }),
    deficitFallbackProduct({ id: "unapproved", humanEditorialApprovedAt: undefined }),
    product({ id: "bad-title", displayTitleStatus: "unreviewed" }),
    product({ id: "bad-image", imageEditorialStatus: "unreviewed" }),
  ]);
  assert.equal(counts["Iluminação"], 3);
});
