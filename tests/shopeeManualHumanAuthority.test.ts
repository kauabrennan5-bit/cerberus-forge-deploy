import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyShopeeManualImageAuthority, shopeeManualHumanAuthorityInternals } from "../server/services/shopeeManualHumanAuthority";
import type { PendingReview } from "../server/services/telegramTypes";

const IMAGE = "https://down-br.img.susercontent.com/file/manual-authority-test";

function review(reason: string, visualReviewStatus: string = "NEEDS_HUMAN_REVIEW"): PendingReview {
  return {
    id: "review-manual-authority",
    chatId: 123,
    senderId: 123,
    firstName: "admin",
    username: "admin",
    createdAt: 1_788_700_000_000,
    expiresAt: 1_788_703_600_000,
    produto: "Luminária de mesa",
    rawTitle: "Luminária de mesa original",
    displayTitle: "Luminária de mesa",
    categoria: "Iluminação",
    preco: 99.9,
    imagens: [IMAGE],
    imagensOriginais: [IMAGE],
    imagemPrincipal: IMAGE,
    imagensGaleria: [],
    imageEditorialStatus: "review_required",
    imageCuration: { status: "review_required", rawImageUrls: [IMAGE], galleryImageUrls: [], assessments: [], reason: "image_review_unavailable" },
    normalizedUrl: "https://shopee.com.br/product/123/456",
    descricao: "Descrição editorial suficiente para a publicação manual.",
    status: "pending",
    existingProduct: {
      source: "affiliate_preview",
      affiliateUrl: "https://s.shopee.com.br/teste",
      manualDeliveryContract: true,
      shopId: "123",
      itemId: "456",
      visualReviewStatus,
      manualReviewStatus: "NEEDS_HUMAN_REVIEW",
      manualReviewReasons: [reason],
    },
  };
}

describe("manual Shopee image authority", () => {
  it("turns reviewer outage into a canonical image usable only by the manual contract", () => {
    const adapted = applyShopeeManualImageAuthority(review("image_review_model_unavailable"));
    assert.equal(adapted.imageEditorialStatus, "clean");
    assert.equal(adapted.imageCuration?.status, "ready");
    assert.equal(adapted.imageCuration?.primaryImageUrl, IMAGE);
    assert.equal(adapted.existingProduct.visualReviewStatus, "NEEDS_HUMAN_REVIEW");
    assert.deepEqual(adapted.existingProduct.manualReviewReasons, ["image_review_model_unavailable"]);
  });

  it("lets human authority override an editorial visual rejection while retaining its audit reason", () => {
    const adapted = applyShopeeManualImageAuthority(review("IMAGE_OFF_BRAND_HIGH", "HARD_REJECT"));
    assert.equal(adapted.imageEditorialStatus, "clean");
    assert.equal(adapted.imageCuration?.status, "ready");
    assert.deepEqual(adapted.existingProduct.manualReviewReasons, ["IMAGE_OFF_BRAND_HIGH"]);
  });

  it("keeps objective image failures fail-closed", () => {
    const adapted = applyShopeeManualImageAuthority(review("IMAGE_TOO_SMALL", "HARD_REJECT"));
    assert.equal(adapted.imageEditorialStatus, "review_required");
    assert.equal(adapted.imageCuration?.status, "review_required");
  });

  it("does not alter reviews outside the manual delivery contract", () => {
    const original = review("image_review_model_unavailable");
    original.existingProduct.manualDeliveryContract = false;
    const adapted = applyShopeeManualImageAuthority(original);
    assert.equal(adapted, original);
    assert.equal(adapted.imageEditorialStatus, "review_required");
  });

  it("builds review-owned Shopee identity without inventing an autonomous run id", () => {
    const input = shopeeManualHumanAuthorityInternals.manualIdentityReservationInput(
      review("image_review_model_unavailable"),
      1_788_700_000_000,
    );
    assert.deepEqual(input, {
      marketplace: "Shopee",
      shopId: "123",
      itemId: "456",
      sourceProductUrl: "https://shopee.com.br/product/123/456",
      reviewId: "review-manual-authority",
      ttlMinutes: 60,
    });
    assert.equal("runId" in (input || {}), false);
  });

  it("refuses to invent manual identity metadata", () => {
    const invalid = review("image_review_model_unavailable");
    invalid.existingProduct.shopId = "";
    assert.equal(shopeeManualHumanAuthorityInternals.manualIdentityReservationInput(invalid), null);
  });
});
