import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { autonomousCuratorContinuousV2Internals } from "../server/services/autonomousCuratorContinuousV2";

const {
  configuredDailyFloor,
  recoveryBurstCycles,
  dailyTargetPerCategory,
} = autonomousCuratorContinuousV2Internals;

test("configured production floor of six cannot be reduced by growth-day calculation", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const env = {
    AUTONOMOUS_CURATOR_GROWTH_START_DATE: "2026-09-04",
    AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: "6",
  } as NodeJS.ProcessEnv;
  assert.equal(configuredDailyFloor(env), 6);
  assert.equal(dailyTargetPerCategory([], now, env), 6);
});

test("configured floor stays bounded and preserves the legacy minimum when absent", () => {
  assert.equal(configuredDailyFloor({} as NodeJS.ProcessEnv), 5);
  assert.equal(configuredDailyFloor({ AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: "4" } as NodeJS.ProcessEnv), 5);
  assert.equal(configuredDailyFloor({ AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: "6" } as NodeJS.ProcessEnv), 6);
  assert.equal(configuredDailyFloor({ AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: "999" } as NodeJS.ProcessEnv), 10);
});

test("cumulative growth can make the configured floor stricter but never weaker", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const env = {
    AUTONOMOUS_CURATOR_GROWTH_START_DATE: "2026-08-28",
    AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: "6",
  } as NodeJS.ProcessEnv;
  assert.equal(dailyTargetPerCategory([], now, env), 8);
});

test("recovery burst is opt-in and strictly bounded", () => {
  assert.equal(recoveryBurstCycles({} as NodeJS.ProcessEnv), 1);
  assert.equal(recoveryBurstCycles({ AUTONOMOUS_CURATOR_RECOVERY_BURST_CYCLES: "5" } as NodeJS.ProcessEnv), 5);
  assert.equal(recoveryBurstCycles({ AUTONOMOUS_CURATOR_RECOVERY_BURST_CYCLES: "999" } as NodeJS.ProcessEnv), 8);
});

test("recovery burst recomputes live deficits and still delegates every publication cycle to the canonical hard-gated base", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
  assert.match(source, /for \(let burstIndex = 0; burstIndex < burstLimit; burstIndex \+= 1\)/);
  assert.match(source, /calculateCategoryPolicy\(burstProducts, dailyTarget\)/);
  assert.match(source, /runAutonomousCuratorContinuousV2Base\(\{/);
  assert.match(source, /if \(afterBurstPolicy\.totalDeficit === 0\) break/);
  assert.doesNotMatch(source, /\.from\(["']products["']\)\s*\.insert/);
});
