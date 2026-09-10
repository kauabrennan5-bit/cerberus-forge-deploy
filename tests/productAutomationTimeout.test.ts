import test from "node:test";
import assert from "node:assert/strict";
import { resolveProductCuratorTimeoutMs } from "../server/services/productAutomation";

test("product curator copy timeout uses bounded production default", () => {
  assert.equal(resolveProductCuratorTimeoutMs({}), 30_000);
  assert.equal(resolveProductCuratorTimeoutMs({ GEMINI_PRODUCT_CURATOR_TIMEOUT_MS: "45000" }), 45_000);
  assert.equal(resolveProductCuratorTimeoutMs({ GEMINI_PRODUCT_CURATOR_TIMEOUT_MS: "0" }), 30_000);
  assert.equal(resolveProductCuratorTimeoutMs({ GEMINI_PRODUCT_CURATOR_TIMEOUT_MS: "invalid" }), 30_000);
});
