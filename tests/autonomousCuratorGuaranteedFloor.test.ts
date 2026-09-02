import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Product } from "../src/types";
import { AUTONOMOUS_CURATOR_PROFILES } from "../server/services/autonomousCuratorProfiles";
import { autonomousCuratorCatalogFloorFallbackInternals } from "../server/services/autonomousCuratorCatalogFloorFallback";
import { exportProductsJsonInternals } from "../server/services/exportProductsJson";
import { AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY } from "../server/services/autonomousCuratorCatalogFloorPolicy";

test("best-of-lot fallback keeps an editorially rejected image rankable when the image is technically usable", () => {
  const profile = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === "Infantil")!;
  const offer = autonomousCuratorCatalogFloorFallbackInternals.rankOffer(profile, {
    shopId: "111",
    itemId: "222",
    name: "Brinquedo Montessori de Madeira Geométrico",
    price: 89.9,
    productLink: "https://shopee.com.br/product/111/222",
    imageUrl: "https://down-br.img.susercontent.com/file/example-image-hash-123456789",
  } as any, "brinquedo montessori", 0);
  const qualification = {
    state: "HARD_REJECT" as const,
    reason: "IMAGE_NOVELTY_HIGH",
    probe: { ok: true, httpStatus: 200, mimeType: "image/jpeg", width: 800, height: 800, format: "jpeg", byteLength: 1000, reason: null },
    assessment: { url: String(offer.item.imageUrl), decision: "novelty" as const, confidence: "HIGH" as const, reason: "test" },
    curationReason: "no_commercial_image" as const,
    visualScore: 5,
  };
  const warnings = autonomousCuratorCatalogFloorFallbackInternals.buildWarnings(profile, offer, qualification, 89.9);
  const curation = autonomousCuratorCatalogFloorFallbackInternals.buildImageCuration(String(offer.item.imageUrl), qualification);
  assert.ok(Number.isFinite(offer.rankScore));
  assert.ok(warnings.includes("IMAGE_NOVELTY_HIGH"));
  assert.equal(curation.status, "review_required");
  assert.deepEqual(curation.rawImageUrls, [offer.item.imageUrl]);
});

test("guaranteed fallback keeps only factual publication failures as hard gates", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorCatalogFloorFallback.ts", import.meta.url), "utf8");
  assert.match(source, /decisions are deliberately NOT a hard gate here/);
  assert.match(source, /if \(!qualification\.probe\.ok\)/);
  assert.doesNotMatch(source, /if \(qualification\.state === "HARD_REJECT"\)\s*\{?\s*return null/);
  assert.match(source, /SOURCE_IDENTITY_ALREADY_OWNED/);
  assert.match(source, /validateOfficialProductLink/);
  assert.match(source, /PRICE_UNVERIFIED/);
});

test("public export allows only the explicit floor fallback to use a review-required raw image", () => {
  const base: Product = {
    id: "floor-test",
    produto: "Brinquedo de madeira",
    rawTitle: "Brinquedo de madeira",
    categoria: "Infantil",
    preco: 79.9,
    imagens: ["https://down-br.img.susercontent.com/file/example-image-hash-123456789"],
    imageEditorialStatus: "review_required",
    imageCuration: {
      status: "review_required",
      rawImageUrls: ["https://down-br.img.susercontent.com/file/example-image-hash-123456789"],
      galleryImageUrls: [],
      assessments: [],
      reason: "no_commercial_image",
    },
    link: "https://s.shopee.com.br/example",
    ativo: true,
    destaque: false,
    status: "published",
  };
  assert.deepEqual(exportProductsJsonInternals.publicCatalogImages(base), []);
  assert.deepEqual(
    exportProductsJsonInternals.publicCatalogImages({ ...base, createdBy: AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY }),
    base.imagens,
  );
});

test("production continuous entrypoint delegates through the guaranteed-floor coordinator while preserving strict internals", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
  assert.match(source, /autonomousCuratorContinuousGuaranteed/);
  assert.match(source, /autonomousCuratorContinuousV2Strict/);
  const guaranteed = await readFile(new URL("../server/services/autonomousCuratorContinuousGuaranteed.ts", import.meta.url), "utf8");
  assert.match(guaranteed, /fillAutonomousCatalogFloor/);
  assert.match(guaranteed, /deficitBeforeFallback > 0/);
  assert.match(guaranteed, /PUBLISHED_BY_BEST_OF_LOT_FLOOR_FALLBACK/);
});
