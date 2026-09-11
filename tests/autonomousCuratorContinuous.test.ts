import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// This file intentionally focuses on the continuous curator contract and the
// production scheduler boundary. The scheduler no longer talks to Render.

test("legacy Continuous entrypoint delegates to review-only V2 and cannot publish", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuous.ts", import.meta.url), "utf8");
  assert.match(source, /runAutonomousCuratorContinuousV2\(options\)/);
  assert.match(source, /publishedThisCycle: 0/);
  assert.match(source, /published: false/);
  assert.doesNotMatch(source, /publishProductWithGate|createProduct\(|updateProduct\(/);
});

test("dedicated production scheduler sends discoveries to manual review through the direct runner", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(scheduler, /cron: "\*\/10 \* \* \* \*"/);
  assert.match(scheduler, /cerberus-autonomous-curator-production/);
  assert.match(scheduler, /CERBERUS_SERVERLESS_CURATOR_ENABLED == 'true'/);
  assert.match(scheduler, /run-autonomous-curator-direct\.ts manual_review/);
  assert.doesNotMatch(scheduler, /https:\/\/[^\s"']*onrender\.com/);
  assert.doesNotMatch(scheduler, /api\/internal\/autonomous-curator/);

  assert.doesNotMatch(workflow, /cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /run-autonomous-curator-direct\.ts/);
  assert.match(workflow, /default: dry_run/);
  assert.doesNotMatch(workflow, /https:\/\/[^\s"']*onrender\.com/);
  assert.doesNotMatch(workflow, /api\/internal\/autonomous-curator/);
});
