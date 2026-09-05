import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateSharedCandidatePoolEntry } from "../server/services/shopeeCandidatePool";
import { imageUrlFingerprint } from "../server/services/productEditorialReview";
import { validateProductPublicationEligibility } from "../server/services/productPublicationGate";
import type { Product } from "../src/types";

const technical = {
  shopId: "111",
  itemId: "222",
  productLink: "https://shopee.com.br/product/111/222",
  affiliateLink: "https://s.shopee.com.br/affiliate-222",
  price: 99,
  imageUrl: "https://down-br.img.susercontent.com/file/222",
};

test("Curator, rotation and recovery share one technical candidate pool contract", async () => {
  const curator = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  const rotation = await readFile(new URL("../server/services/productRotation.ts", import.meta.url), "utf8");
  assert.match(curator, /evaluateSharedCandidatePoolEntry/);
  assert.match(rotation, /evaluateSharedCandidatePoolEntry/);
  assert.equal(evaluateSharedCandidatePoolEntry(technical).eligible, true);
  assert.equal(evaluateSharedCandidatePoolEntry({ ...technical, itemId: "" }).eligible, false);
  assert.equal(evaluateSharedCandidatePoolEntry({ ...technical, affiliateLink: "https://example.com/x" }).eligible, false);
  assert.equal(evaluateSharedCandidatePoolEntry({ ...technical, imageUrl: "http://insecure.example/x" }).eligible, false);
  assert.equal(evaluateSharedCandidatePoolEntry(technical, { seenIdentityKeys: new Set(["111:222"]) }).reason, "DUPLICATE_IN_SEARCH_POOL");
});

test("deficit fallback keeps hard gates and converts editorial failures into ranking warnings", () => {
  const image = technical.imageUrl;
  const product: Product = {
    id: "deficit-candidate",
    produto: "Título bruto Shopee",
    rawTitle: "Título bruto Shopee",
    displayTitle: "Título bruto Shopee",
    displayTitleStatus: "review_required",
    categoria: "Iluminação",
    preco: 99,
    imagens: [image],
    imageEditorialStatus: "review_required",
    imageCuration: { status: "review_required", rawImageUrls: [image], primaryImageUrl: image, galleryImageUrls: [], assessments: [], reason: "image_review_unavailable" },
    imageReviewFingerprint: imageUrlFingerprint(image),
    link: technical.affiliateLink,
    ativo: false,
    destaque: false,
    status: "paused",
  };
  const result = validateProductPublicationEligibility({
    product,
    identity: { marketplace: "Shopee", shopId: "111", itemId: "222", sourceProductUrl: technical.productLink, productId: product.id },
    canonicalThreshold: 88,
    duplicateProductIds: [],
    evidence: { source: "autonomous_curator", score: 52, threshold: 88, maximumCatalogSimilarity: 0.95, categoryMismatch: false, offBrand: true, lifecycleApproved: false, reviewState: "REVIEW_RECOVERY_PENDING", deficitFallback: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("manual Confirmar rotação remains a separate authority", async () => {
  const source = await readFile(new URL("../server/services/productRotation.ts", import.meta.url), "utf8");
  assert.match(source, /approveProductRotation/);
  assert.match(source, /reviewAndPublishRotationCandidate/);
  assert.doesNotMatch(source, /deficitFallback:\s*true/);
});
