import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCuratorBlocker,
  safeAiFailureType,
  summarizeCuratorBlockers,
} from "../server/services/autonomousCuratorObservability";

test("curator blocker observability classifies provider failures without credentials", () => {
  assert.equal(classifyCuratorBlocker("OPENAI_RATE_LIMITED http 429"), "ai_rate_limit");
  assert.equal(classifyCuratorBlocker("OPENAI_QUOTA_EXHAUSTED insufficient_quota"), "ai_quota");
  assert.equal(classifyCuratorBlocker("OPENAI_TIMEOUT"), "ai_timeout");
  assert.equal(classifyCuratorBlocker("OPENAI_MODEL_UNAVAILABLE model_not_found"), "ai_model_not_found");
  assert.equal(classifyCuratorBlocker("OPENAI_AUTH_ERROR http_401"), "ai_auth");
  assert.equal(classifyCuratorBlocker("provider failed HTTP 503"), "ai_provider_5xx");
  assert.equal(classifyCuratorBlocker("IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR"), "image");
  assert.equal(classifyCuratorBlocker("CATEGORY_MISMATCH"), "mismatch");
  assert.equal(safeAiFailureType("OPENAI_TIMEOUT"), "ai_timeout");
  assert.equal(safeAiFailureType("my-secret-key-sk-should-not-be-classified"), null);
});

test("curator blocker summary reports only non-published lanes", () => {
  const summary = summarizeCuratorBlockers([
    { category: "Iluminação", due: true, published: false, queued: false, score: null, title: null, reason: "OPENAI_RATE_LIMITED", productId: null, searchedPages: [] },
    { category: "Móveis", due: true, published: false, queued: false, score: null, title: null, reason: "IMAGE_REVIEW_MODEL_UNAVAILABLE", productId: null, searchedPages: [] },
    { category: "Tecnologia", due: true, published: true, queued: false, score: 92, title: "ok", reason: "PUBLISHED_AND_PUBLICLY_VALIDATED", productId: "p1", searchedPages: [1] },
  ] as any);
  assert.equal(summary.ai_rate_limit, 1);
  assert.equal(summary.image, 1);
  assert.equal(summary.catalog, undefined);
});
