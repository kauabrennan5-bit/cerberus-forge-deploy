import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("continuous curator records the effective floor target instead of carrying stale metadata", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.match(source, /daily_target_per_category: dailyTarget/);
  assert.match(source, /live_catalog_target: liveCatalogTargetCount/);
  assert.match(source, /recovery_mode: scopedRecoveryMode/);
  assert.match(source, /deficit_category_scope: \[\.\.\.deficitScope\]/);
});

test("semantic audit records the actual provider instead of hardcoding OpenAI", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.match(source, /provider: semantic\.model\?\.startsWith\("gemini-"\) \? "gemini" : "openai"/);
  assert.doesNotMatch(source, /semanticDiscovery = \{ provider: "openai"/);
});
