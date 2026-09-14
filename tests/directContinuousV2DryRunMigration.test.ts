import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/autonomous-curator-continuous-v2-dry-run.yml", "utf8");
const runner = readFileSync("scripts/run-autonomous-curator-continuous-v2-dry-run.ts", "utf8");

test("Continuous V2 dry-run executes directly without Render or OIDC", () => {
  assert.match(workflow, /run-autonomous-curator-continuous-v2-dry-run\.ts/);
  assert.match(workflow, /cron:\s*["']23 \* \* \* \*["']/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(workflow, /ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE/);
  assert.doesNotMatch(workflow, /curl\s+.*api\/internal\/autonomous-curator\/continuous/i);
});

test("Continuous V2 dry-run is observational and cannot mutate catalog or Telegram", () => {
  assert.match(runner, /readAutonomousCuratorInvariant/);
  assert.match(runner, /mode:\s*["']continuous-v2-dry-run-observational["']/);
  assert.match(runner, /renderDependency:\s*false/);
  assert.match(runner, /const autoPublished = 0/);
  assert.match(runner, /catalogMutations:\s*0/);
  assert.match(runner, /reviewsCreated:\s*0/);
  assert.match(runner, /telegramMessagesSent:\s*0/);
  assert.match(runner, /productionRunOpened:\s*false/);
  assert.doesNotMatch(runner, /runAutonomousCuratorContinuousV2\s*\(/);
  assert.doesNotMatch(runner, /createProduct|updateProduct|savePendingReview|sendTelegram|syncCatalogAndDeploy|sendNow/);
});
