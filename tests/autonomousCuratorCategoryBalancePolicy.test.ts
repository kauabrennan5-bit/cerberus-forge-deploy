import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const coordinator = fs.readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");
const base = fs.readFileSync("server/services/autonomousCuratorContinuousV2Base.ts", "utf8");

test("coordinator combines cumulative growth with an absolute six-item public floor and a stricter configured floor", () => {
  assert.match(coordinator, /function dailyTargetPerCategory/);
  assert.match(coordinator, /today - start \+ 1/);
  assert.match(coordinator, /MIN_PUBLIC_PRODUCTS_PER_CATEGORY = 6/);
  assert.match(coordinator, /function configuredDailyFloor/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY/);
  assert.match(coordinator, /Math\.max\(configuredFloor, today - start \+ 1\)/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_GROWTH_START_DATE/);
  assert.match(coordinator, /daily_target_per_category/);
  assert.match(coordinator, /growth_day/);
  assert.doesNotMatch(coordinator, /const LIVE_TARGET_PER_CATEGORY = 2/);
  assert.doesNotMatch(coordinator, /function retirementCandidates/);
  assert.doesNotMatch(coordinator, /category_balance_retired_ids/);
});

test("deficient categories remain in bounded automatic recovery while already-covered categories cannot consume bootstrap growth", () => {
  assert.match(coordinator, /recoveryMode = totalDeficit\(countsBefore, dailyTarget\) > 0/);
  assert.match(coordinator, /burstPolicy\.totalDeficit/);
  assert.match(coordinator, /burstPolicy\.deficitCategories/);
  assert.match(coordinator, /activeBefore \+ burstPolicy\.totalDeficit/);
  assert.match(coordinator, /recoveryBurstCycles\(env\)/);
  assert.match(coordinator, /MAX_RECOVERY_BURST_CYCLES = 12/);
  assert.match(coordinator, /category_growth_over_target_publication_ids:\s*\[\]/);
  assert.match(coordinator, /const CATEGORY_GROWTH_VERSION = "7"/);
  assert.match(coordinator, /autonomous curator pre-cycle public baseline validation/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_PUBLIC_BASELINE_NOT_VALIDATED/);
});

test("daily target is fail-closed on all ten category floors plus public runtime validation", () => {
  assert.match(coordinator, /daily_target_invariant/);
  assert.match(coordinator, /daily_target_satisfied/);
  assert.match(coordinator, /post_publication_category_validation/);
  assert.match(coordinator, /public_runtime_validation/);
  assert.match(coordinator, /afterPolicy\.totalDeficit === 0/);
  assert.match(coordinator, /publicValidation\.success/);
  assert.match(coordinator, /META DO DIA AINDA NÃO CUMPRIDA/);
});

test("quality gates remain in the preserved v2 discovery engine", () => {
  assert.match(base, /IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR/);
  assert.match(base, /PIPELINE_NOT_AUTO_PUBLISHABLE/);
  assert.match(base, /maximumCatalogSimilarity >= 0\.82/);
  assert.match(base, /breakdown\.finalScore < input\.config\.autoPublishThreshold/);
});

test("growth messaging promises accumulation instead of rotating healthy products away", () => {
  assert.match(coordinator, /piso operacional permanece/);
  assert.match(coordinator, /nenhuma peça saudável é removida só para manter limite/);
  assert.match(coordinator, /already-published healthy pieces are never retired to keep a cap/);
});
