import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("semantic fallback only ranks discovery and exits through Telegram review", async () => {
  const semantic = await readFile(new URL("../server/services/autonomousCuratorSemanticDiscovery.ts", import.meta.url), "utf8");
  const curator = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.doesNotMatch(semantic, /publishProductWithGate|from\("products"\)\.insert|status:\s*"published"/);
  assert.doesNotMatch(curator, /publishProductWithGate\(/);
  assert.match(curator, /savePendingReview\(review\)/);
  assert.match(curator, /PENDING_HUMAN_APPROVAL/);
  assert.match(curator, /maximumCatalogSimilarity >= 0\.82/);
  assert.match(curator, /breakdown\.finalScore < input\.config\.reviewThreshold/);
});
