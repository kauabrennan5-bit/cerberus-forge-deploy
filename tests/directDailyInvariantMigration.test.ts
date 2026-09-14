import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = ".github/workflows/daily-production-invariant.yml";
const runnerPath = "scripts/run-autonomous-curator-invariant-direct.ts";
const workflow = readFileSync(workflowPath, "utf8");
const runner = readFileSync(runnerPath, "utf8");

test("daily production invariant runs directly without Render or OIDC", () => {
  assert.match(workflow, /run-autonomous-curator-invariant-direct\.ts/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(workflow, /ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE/);
  assert.doesNotMatch(workflow, /api\/internal\/autonomous-curator\/invariant/);
});

test("direct invariant runner is observational and cannot auto-publish or mutate production state", () => {
  assert.match(runner, /readAutonomousCuratorInvariant/);
  assert.match(runner, /renderDependency:\s*false/);
  assert.match(runner, /mode:\s*["']observational["']/);
  assert.match(runner, /const autoPublished = 0/);
  assert.match(runner, /catalogMutations:\s*0/);
  assert.match(runner, /reviewsCreated:\s*0/);
  assert.match(runner, /telegramMessagesSent:\s*0/);
  assert.match(runner, /productionRunOpened:\s*false/);
  assert.match(runner, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
  assert.match(runner, /AUTONOMOUS_INVARIANT_MUTATION_CONTRACT_VIOLATED/);
  assert.doesNotMatch(runner, /runAutonomousCuratorDaily|runAutonomousCuratorContinuousV2/);
  assert.doesNotMatch(runner, /syncCatalogAndDeploy|archiveProduct|activateProduct|sendTelegramMessage|sendNow/);
});
