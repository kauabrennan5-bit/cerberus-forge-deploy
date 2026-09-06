import test from "node:test";
import assert from "node:assert/strict";
import type { PendingReview } from "../server/services/telegramTypes";
import {
  applyHumanPublicationImageView,
  getPendingReview,
  setTestGetPendingReview,
} from "../server/repositories/telegramRepository";

const PUBLIC_IMAGE = "https://down-br.img.susercontent.com/file/human-authority-read-view";

function legacyReview(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    id: "affprev-human-authority",
    chatId: 123,
    senderId: 123,
    firstName: "admin",
    username: "admin",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    produto: "Luminária Cogumelo de Mesa",
    rawTitle: "Luminária Cogumelo de Mesa Retrô Shopee",
    displayTitle: "Luminária Cogumelo de Mesa",
    categoria: "Iluminação",
    preco: 129.9,
    imagens: [PUBLIC_IMAGE],
    imagensOriginais: [PUBLIC_IMAGE],
    imagemPrincipal: PUBLIC_IMAGE,
    imagensGaleria: [],
    imageEditorialStatus: "review_required",
    imageCuration: {
      status: "review_required",
      rawImageUrls: [PUBLIC_IMAGE],
      galleryImageUrls: [],
      assessments: [],
      reason: "image_review_unavailable",
    },
    normalizedUrl: "https://shopee.com.br/product/123/456",
    descricao: "Descrição editorial suficiente para uma decisão humana explícita.",
    status: "pending",
    existingProduct: {
      source: "affiliate_preview",
      affiliateUrl: "https://s.shopee.com.br/exemplo",
      manualDeliveryContract: true,
      manualReviewReasons: ["image_review_model_unavailable"],
      visualReviewStatus: "NEEDS_HUMAN_REVIEW",
    },
    ...overrides,
  };
}

test("legacy manual review gets a publication-only image compatibility view without losing audit provenance", () => {
  const original = legacyReview();
  const adapted = applyHumanPublicationImageView(original);

  assert.notEqual(adapted, original);
  assert.equal(original.imageEditorialStatus, "review_required");
  assert.equal(adapted.imageEditorialStatus, "clean");
  assert.equal(adapted.imageCuration?.status, "ready");
  assert.equal(adapted.imageCuration?.primaryImageUrl, PUBLIC_IMAGE);
  assert.deepEqual(adapted.imagens, [PUBLIC_IMAGE]);
  assert.equal(adapted.existingProduct.humanPublicationImageAuthorityApplied, true);
  assert.equal(adapted.existingProduct.originalImageEditorialStatus, "review_required");
  assert.equal(adapted.existingProduct.originalImageCurationStatus, "review_required");
  assert.equal(adapted.existingProduct.originalImageCurationReason, "image_review_unavailable");
  assert.deepEqual(adapted.existingProduct.manualReviewReasons, ["image_review_model_unavailable"]);
});

test("Autonomous Curator pending review receives the same human-authority view", () => {
  const adapted = applyHumanPublicationImageView(legacyReview({
    id: "autocur-human-authority",
    existingProduct: {
      source: "autonomous_curator",
      shopId: "123",
      itemId: "456",
      autonomousCuratorRunId: "run-1",
      manualReviewReasons: ["IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR"],
    },
  }));

  assert.equal(adapted.imageEditorialStatus, "clean");
  assert.equal(adapted.imageCuration?.status, "ready");
  assert.equal(adapted.existingProduct.originalImageEditorialStatus, "review_required");
});

test("objective technical image blockers stay fail-closed", () => {
  const original = legacyReview({
    existingProduct: {
      source: "affiliate_preview",
      manualDeliveryContract: true,
      manualReviewReasons: ["IMAGE_TOO_SMALL"],
    },
  });
  const adapted = applyHumanPublicationImageView(original);

  assert.equal(adapted, original);
  assert.equal(adapted.imageEditorialStatus, "review_required");
  assert.equal(adapted.imageCuration?.status, "review_required");
});

test("missing or non-public HTTPS image never receives compatibility approval", () => {
  const original = legacyReview({
    imagens: ["http://localhost/private.jpg"],
    imagensOriginais: ["http://localhost/private.jpg"],
    imagemPrincipal: "http://localhost/private.jpg",
  });
  const adapted = applyHumanPublicationImageView(original);

  assert.equal(adapted, original);
  assert.equal(adapted.imageEditorialStatus, "review_required");
});

test("reviews outside an explicit human publication contract are unchanged", () => {
  const original = legacyReview({
    existingProduct: {
      source: "affiliate_preview",
      manualDeliveryContract: false,
      manualReviewReasons: ["image_review_model_unavailable"],
    },
  });
  assert.equal(applyHumanPublicationImageView(original), original);
});

test("terminal reviews are never rewritten by the compatibility view", () => {
  for (const status of ["published", "rejected", "cancelled"] as const) {
    const original = legacyReview({ status });
    assert.equal(applyHumanPublicationImageView(original), original);
    assert.equal(original.imageEditorialStatus, "review_required");
  }
});

test("individual Telegram review read applies the compatibility view used by confirm_pub", async () => {
  setTestGetPendingReview(async () => legacyReview());
  try {
    const loaded = await getPendingReview("affprev-human-authority");
    assert.ok(loaded);
    assert.equal(loaded.imageEditorialStatus, "clean");
    assert.equal(loaded.imageCuration?.status, "ready");
    assert.equal(loaded.imagemPrincipal, PUBLIC_IMAGE);
    assert.equal(loaded.existingProduct.originalImageEditorialStatus, "review_required");
  } finally {
    setTestGetPendingReview(null);
  }
});
