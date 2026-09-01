import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewedShopeeImage,
  controlledShopeeQueryVariants,
  evaluateShopeeCandidateRelevance,
  rankShopeeCandidates,
  type ShopeeImageProbe,
  type ShopeeRankableCandidate,
} from "../server/services/shopeeCandidateQualification";
import type { ProductImageCuration } from "../src/lib/productImageCuration";

const goodProbe: ShopeeImageProbe = {
  ok: true,
  httpStatus: 200,
  mimeType: "image/webp",
  width: 800,
  height: 800,
  format: "webp",
  byteLength: 120000,
  reason: null,
};

function curation(decision: any, confidence: any, status: "ready" | "review_required" = "review_required"): ProductImageCuration {
  const url = "https://down-br.img.susercontent.com/file/abcdefghijklmnopqrstuvwx";
  return {
    status,
    rawImageUrls: [url],
    primaryImageUrl: status === "ready" ? url : undefined,
    galleryImageUrls: [],
    assessments: [{ url, decision, confidence, reason: "not persisted in diagnostics" }],
    reason: status === "review_required" ? `no_commercial_image:${decision}_${String(confidence).toLowerCase()}=1` as any : undefined,
  };
}

describe("Shopee image qualification — three states", () => {
  it("QUALIFIED requires clean medium/high plus valid probe", () => {
    const result = classifyReviewedShopeeImage({ probe: goodProbe, curation: curation("clean", "HIGH", "ready") });
    assert.equal(result.state, "QUALIFIED");
  });

  it("intermediate or inconclusive visual evidence becomes NEEDS_HUMAN_REVIEW", () => {
    for (const imageCuration of [
      curation("clean", "LOW"),
      curation("unknown", "HIGH"),
      curation("promotional", "MEDIUM"),
      curation("off_brand", "MEDIUM"),
    ]) {
      assert.equal(classifyReviewedShopeeImage({ probe: goodProbe, curation: imageCuration }).state, "NEEDS_HUMAN_REVIEW");
    }
  });

  it("objective high-confidence visual violations remain HARD_REJECT", () => {
    for (const decision of ["screenshot", "collage", "technical", "promotional", "logo", "off_brand", "incomplete", "novelty"] as const) {
      assert.equal(classifyReviewedShopeeImage({ probe: goodProbe, curation: curation(decision, "HIGH") }).state, "HARD_REJECT", decision);
    }
  });

  it("inaccessible/tiny/broken image evidence is HARD_REJECT before model score", () => {
    const badProbe = { ...goodProbe, ok: false, reason: "IMAGE_TOO_SMALL", width: 120, height: 120 };
    assert.equal(classifyReviewedShopeeImage({ probe: badProbe, curation: curation("clean", "HIGH", "ready") }).state, "HARD_REJECT");
  });
});

describe("Shopee query intent and deterministic ranking", () => {
  it("expands lighting intent only with controlled compatible variants", () => {
    const variants = controlledShopeeQueryVariants("luminária");
    assert.deepEqual(variants, ["luminária", "luminária de mesa", "luminária pendente", "abajur", "luminária decorativa", "iluminação decorativa"]);
    assert.deepEqual(controlledShopeeQueryVariants("copo de vidro"), ["copo de vidro"]);
  });

  it("rejects semantic/category mismatch such as bedside table for luminária", () => {
    const wrong = evaluateShopeeCandidateRelevance("luminária", "Mesa de Cabeceira Retrô com Gaveta");
    assert.equal(wrong.compatible, false);
    assert.match(wrong.reason, /MISMATCH|LOW_RELEVANCE/);
    const right = evaluateShopeeCandidateRelevance("luminária", "Luminária de Mesa Cogumelo Retrô");
    assert.equal(right.compatible, true);
    assert.equal(right.category, "Iluminação");
  });

  it("ranks by relevance and visual quality, not by lowest price", () => {
    const base = {
      productLink: "https://shopee.com.br/example",
      imageUrl: "https://down-br.img.susercontent.com/file/abcdefghijklmnopqrstuvwx",
      round: 1,
      queryVariant: "luminária",
      category: "Iluminação",
    };
    const human = classifyReviewedShopeeImage({ probe: goodProbe, curation: curation("unknown", "MEDIUM") });
    const qualified = classifyReviewedShopeeImage({ probe: goodProbe, curation: curation("clean", "HIGH", "ready") });
    const candidates: ShopeeRankableCandidate[] = [
      { ...base, shopId: "2", itemId: "2", name: "Luminária barata", price: 10, relevanceScore: 55, imageQualification: human },
      { ...base, shopId: "1", itemId: "1", name: "Luminária de mesa de design", price: 90, relevanceScore: 95, imageQualification: qualified },
    ];
    const ranked = rankShopeeCandidates(candidates);
    assert.equal(ranked[0].itemId, "1");
    assert.equal(ranked[1].itemId, "2");
  });

  it("uses normalized official identity as deterministic tiebreak", () => {
    const q = classifyReviewedShopeeImage({ probe: goodProbe, curation: curation("clean", "HIGH", "ready") });
    const common = { name: "Luminária", price: 50, productLink: "https://shopee.com.br/example", imageUrl: "https://down-br.img.susercontent.com/file/abcdefghijklmnopqrstuvwx", round: 1, queryVariant: "luminária", category: "Iluminação", relevanceScore: 90, imageQualification: q };
    const ranked = rankShopeeCandidates([
      { ...common, shopId: "20", itemId: "9" },
      { ...common, shopId: "10", itemId: "8" },
    ]);
    assert.deepEqual(ranked.map(item => `${item.shopId}:${item.itemId}`), ["10:8", "20:9"]);
  });
});
