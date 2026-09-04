import test from "node:test";
import assert from "node:assert/strict";
import { productImageReviewInternals } from "../server/services/productImageReview";

test("OpenAI quota exhaustion is classified and does not trigger a pointless model fallback", () => {
  const quotaError = new Error("OPENAI_QUOTA_EXHAUSTED insufficient_quota");
  assert.equal(productImageReviewInternals.quotaProviderFailure(quotaError), true);
  assert.equal(productImageReviewInternals.openAIFallbackModelWorthTrying(quotaError), false);
});

test("OpenAI authentication failures do not trigger a fallback model", () => {
  const authError = new Error("OPENAI_IMAGE_REVIEW_HTTP_401_API_KEY_INVALID");
  assert.equal(productImageReviewInternals.permanentProviderFailure(authError), true);
  assert.equal(productImageReviewInternals.openAIFallbackModelWorthTrying(authError), false);
});

test("transient provider rate limits remain distinguishable from permanent failures", () => {
  const transientError = new Error("429 rate_limit provider overloaded");
  assert.equal(productImageReviewInternals.transientProviderFailure(transientError), true);
  assert.equal(productImageReviewInternals.permanentProviderFailure(transientError), false);
});
