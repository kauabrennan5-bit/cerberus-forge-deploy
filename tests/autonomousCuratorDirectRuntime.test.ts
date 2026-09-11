import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runner = readFileSync(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
const scheduler = readFileSync(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");

test("direct curator runner invokes the service and hard-rejects autonomous publication", () => {
  assert.match(runner, /runAutonomousCuratorDaily/);
  assert.match(runner, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
  assert.match(runner, /autoPublished/);
  assert.match(runner, /reviewOnly:\s*true/);
  assert.match(runner, /renderDependency:\s*false/);
});

test("curator GitHub runtimes do not call Render", () => {
  assert.doesNotMatch(workflow, /onrender\.com/);
  assert.doesNotMatch(scheduler, /onrender\.com/);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(scheduler, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.match(workflow, /run-autonomous-curator-direct\.ts/);
  assert.match(scheduler, /run-autonomous-curator-direct\.ts manual_review/);
});

test("scheduled production curator is fail-closed behind the serverless enable flag", () => {
  assert.match(scheduler, /CERBERUS_SERVERLESS_CURATOR_ENABLED == 'true'/);
  assert.match(scheduler, /github\.event_name == 'schedule'/);
  assert.doesNotMatch(scheduler, /auto.?publish/i);
});
