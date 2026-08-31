import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const coordinator = fs.readFileSync("server/services/autonomousCuratorContinuousV2Core.ts", "utf8");
const wrapper = fs.readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");
const base = fs.readFileSync("server/services/autonomousCuratorContinuousV2Base.ts", "utf8");

test("balanced coordinator keeps the proven discovery engine intact behind a two-per-category policy", () => {
  assert.match(coordinator, /const LIVE_TARGET_PER_CATEGORY = 2/);
  assert.match(coordinator, /bootstrapMode = totalDeficit\(countsBefore\) > 0/);
  assert.match(coordinator, /activeBefore \+ AUTONOMOUS_CURATOR_PROFILES\.length/);
  assert.match(coordinator, /retirementCandidates/);
  assert.match(coordinator, /syncCatalogAndDeploy\("autonomous curator category balance"\)/);
  assert.match(coordinator, /category_counts_after/);
  assert.match(coordinator, />=24h-per-category cadence/);
  assert.match(wrapper, /core\.runAutonomousCuratorContinuousV2\(options\)/);
});

test("quality gates remain in the preserved v2 discovery engine", () => {
  assert.match(base, /IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR/);
  assert.match(base, /PIPELINE_NOT_AUTO_PUBLISHABLE/);
  assert.match(base, /maximumCatalogSimilarity >= 0\.82/);
  assert.match(base, /breakdown\.finalScore < input\.config\.autoPublishThreshold/);
});

test("bootstrap extras from already-covered categories are removed before the balancing catalog sync", () => {
  assert.match(coordinator, /countsBefore\[profile\.category\].*LIVE_TARGET_PER_CATEGORY/s);
  assert.match(coordinator, /bootstrapExtraIds\.push\(product\.id\)/);
  assert.match(coordinator, /publishedIds.*bootstrapExtraIds/s);
});
