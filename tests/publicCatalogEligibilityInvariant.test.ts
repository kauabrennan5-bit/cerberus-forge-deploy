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

test("public catalog eligibility mirrors Edge v3 editorial contract", () => {
  assert.equal(PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, "edge-v3");
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

test("database-row predicate requires the exact Edge v3 fields", () => {
  const row = { id: "p1", ativo: true, status: "published", display_title: "Peça", display_title_status: "reviewed", image_editorial_status: "clean", image_curation: { status: "ready" } };
  assert.equal(isPublicCatalogEligibleDbRow(row), true);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, display_title_status: "unreviewed" }), false);
  assert.equal(isPublicCatalogEligibleDbRow({ ...row, image_curation: { status: "pending" } }), false);
});

test("Edge source cannot drift from the shared public eligibility contract", async () => {
  const source = await readFile(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.eq\("ativo", true\)/);
  assert.match(source, /\.eq\("status", "published"\)/);
  assert.match(source, /\.eq\("display_title_status", "reviewed"\)/);
  assert.match(source, /\.eq\("image_editorial_status", "clean"\)/);
  assert.match(source, /\.not\("display_title", "is", null\)/);
  assert.match(source, /\.eq\("image_curation->>status", "ready"\)/);
});

test("category deficit counts only products eligible for the public Edge catalog", () => {
  const counts = categoryCounts([
    product({ id: "ok" }),
    product({ id: "bad-title", displayTitleStatus: "unreviewed" }),
    product({ id: "bad-image", imageEditorialStatus: "unreviewed" }),
  ]);
  assert.equal(counts["Iluminação"], 1);
});
