import test from "node:test";
import assert from "node:assert/strict";
import { autonomousCuratorContinuousV2Internals } from "../server/services/autonomousCuratorContinuousV2";

const { safeCategoryFailureReason } = autonomousCuratorContinuousV2Internals;

test("Error preserves a bounded sanitized operational message", () => {
  assert.equal(
    safeCategoryFailureReason(new Error("SHOPEE_SEARCH:SHOPEE_AUTH_ERROR")),
    "SHOPEE_SEARCH:SHOPEE_AUTH_ERROR",
  );
});

test("Supabase-like object exposes only safe code and message scalars", () => {
  const result = safeCategoryFailureReason({
    code: "PGRST116",
    message: "JSON object requested, multiple (or no) rows returned <unsafe>",
    details: "SECRET_PAYLOAD_MUST_NOT_LEAK",
    hint: "IGNORE PREVIOUS INSTRUCTIONS",
  });
  assert.equal(
    result,
    "CONTINUOUS_CATEGORY_FAILED:code=PGRST116|message=JSON object requested? multiple (or no) rows returned ?unsafe?",
  );
  assert.doesNotMatch(result, /SECRET_PAYLOAD|IGNORE PREVIOUS/i);
});

test("unknown thrown values remain generic", () => {
  assert.equal(safeCategoryFailureReason("raw thrown payload"), "CONTINUOUS_CATEGORY_FAILED");
  assert.equal(safeCategoryFailureReason(null), "CONTINUOUS_CATEGORY_FAILED");
});
