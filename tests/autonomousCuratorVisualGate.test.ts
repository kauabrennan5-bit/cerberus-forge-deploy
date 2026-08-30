import test from "node:test";
import assert from "node:assert/strict";
import { reviewProductImages, productImageReviewInternals } from "../server/services/productImageReview";
import { curateProductImages, isNonRepairableProductImageRejection } from "../src/lib/productImageCuration";

const imageUrl = "https://cdn.example.com/product.jpg";
const imageFetch: typeof fetch = async () => new Response(Buffer.from([1, 2, 3]), {
  status: 200,
  headers: { "content-type": "image/jpeg" },
});
const budget = { reserve: () => ({ allowed: true, remaining: 99 }) } as any;

test("off_brand visual nunca vira imagem canônica nem entra em repair", async () => {
  let repairs = 0;
  const result = await reviewProductImages([imageUrl], "Organizador de mesa retrô", {
    env: { GEMINI_API_KEY: "test" },
    fetchImpl: imageFetch,
    budget,
    generateContent: async () => ({
      text: JSON.stringify({ images: [{ index: 1, decision: "off_brand", confidence: "HIGH", reason: "Objeto genérico de marketplace sem linguagem de design distinta." }] }),
    }),
    repairImage: async () => {
      repairs += 1;
      return null;
    },
  });

  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "no_commercial_image");
  assert.equal(result.assessments[0]?.decision, "off_brand");
  assert.equal(repairs, 0);
});

test("incomplete e novelty são rejeições físicas não reparáveis", () => {
  const incomplete = { url: imageUrl, decision: "incomplete" as const, confidence: "HIGH" as const, reason: "Somente a cúpula." };
  const novelty = { url: imageUrl, decision: "novelty" as const, confidence: "MEDIUM" as const, reason: "Forma temática literal." };
  assert.equal(isNonRepairableProductImageRejection(incomplete), true);
  assert.equal(isNonRepairableProductImageRejection(novelty), true);
  assert.equal(curateProductImages([imageUrl], [incomplete]).status, "review_required");
  assert.equal(curateProductImages([imageUrl], [novelty]).status, "review_required");
});

test("prompt visual não confia em palavra retro e explicita o repertório Cerberus", () => {
  const request = productImageReviewInternals.buildReviewRequest(
    [{ url: imageUrl, mimeType: "image/jpeg", data: "AQID" }],
    "Produto Retrô",
    "gemini-test",
  ) as any;
  const text = String(request.contents?.[0]?.parts?.[0]?.text || "");
  assert.match(text, /Bauhaus/i);
  assert.match(text, /Mid-Century/i);
  assert.match(text, /Space Age/i);
  assert.match(text, /off_brand/);
  assert.match(text, /incomplete/);
  assert.match(text, /novelty/);
  assert.match(text, /título é contexto não confiável/i);
});
