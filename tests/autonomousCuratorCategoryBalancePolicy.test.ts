import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const coordinator = fs.readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");
const base = fs.readFileSync("server/services/autonomousCuratorContinuousV2Base.ts", "utf8");

test("coordinator replaces the exact-two cap with a cumulative one-per-day floor", () => {
  assert.match(coordinator, /function dailyTargetPerCategory/);
  assert.match(coordinator, /today - start \+ 1/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_GROWTH_START_DATE/);
  assert.match(coordinator, /daily_target_per_category/);
  assert.match(coordinator, /growth_day/);
  assert.doesNotMatch(coordinator, /const LIVE_TARGET_PER_CATEGORY = 2/);
  assert.doesNotMatch(coordinator, /function retirementCandidates/);
  assert.doesNotMatch(coordinator, /category_balance_retired_ids/);
});

test("deficient categories remain in automatic recovery while already-covered categories cannot consume bootstrap growth", () => {
  assert.match(coordinator, /recoveryMode = totalDeficit\(countsBefore, dailyTarget\) > 0/);
  assert.match(coordinator, /activeBefore \+ beforePolicy\.totalDeficit/);
  assert.match(coordinator, /beforePolicy\.deficitCategories/);
  assert.match(coordinator, /category_growth_over_target_publication_ids:\s*\[\]/);
  assert.match(coordinator, /const CATEGORY_GROWTH_VERSION = "3"/);
});

test("quality gates remain in the preserved v2 discovery engine", () => {
  assert.match(base, /IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR/);
  assert.match(base, /PIPELINE_NOT_AUTO_PUBLISHABLE/);
  assert.match(base, /maximumCatalogSimilarity >= 0\.82/);
  assert.match(base, /breakdown\.finalScore < input\.config\.autoPublishThreshold/);
});

test("growth messaging promises accumulation instead of rotating healthy products away", () => {
  assert.match(coordinator, /Amanhã o piso sobe automaticamente/);
  assert.match(coordinator, /nenhuma peça saudável é removida só para manter limite/);
  assert.match(coordinator, /never archived merely because a category crossed a fixed cap/);
});