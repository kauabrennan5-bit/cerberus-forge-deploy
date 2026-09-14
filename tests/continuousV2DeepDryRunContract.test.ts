import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const wrapper = readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");
const deep = readFileSync("server/services/autonomousCuratorContinuousV2DeepDryRun.ts", "utf8");
const runner = readFileSync("scripts/run-autonomous-curator-continuous-v2-deep-dry-run.ts", "utf8");
const workflow = readFileSync(".github/workflows/autonomous-curator-continuous-v2-deep-dry-run.yml", "utf8");

test("real Continuous V2 entrypoint diverts dryRun before mutable health", () => {
  assert.match(wrapper, /dryRun\?: boolean/);
  const entrypoint = wrapper.slice(wrapper.indexOf("export async function runAutonomousCuratorContinuousV2"));
  const dryRunBranch = entrypoint.indexOf("if (options.dryRun === true)");
  const healthAudit = entrypoint.indexOf("auditPublishedProductHealth");
  const archiveUnavailable = entrypoint.indexOf("archiveUnavailableProducts");
  assert.ok(dryRunBranch >= 0, "dryRun branch missing");
  assert.ok(healthAudit > dryRunBranch, "health audit must happen after dryRun diversion");
  assert.ok(archiveUnavailable > dryRunBranch, "archive path must happen after dryRun diversion");
  assert.match(entrypoint.slice(dryRunBranch, healthAudit), /runAutonomousCuratorContinuousV2DeepDryRun/);
});

test("deep dry-run uses real enrichment components but has no production mutation capability", () => {
  assert.match(deep, /acquireAffiliateLink/);
  assert.match(deep, /extractProductForReview/);
  assert.match(deep, /reviewDisplayTitle/);
  assert.match(deep, /createProductionProductPipeline\(\)\.evaluate/);
  assert.match(deep, /scoreAutonomousCandidate/);
  assert.match(deep, /catalogMutations:\s*0/);
  assert.match(deep, /reviewsCreated:\s*0/);
  assert.match(deep, /telegramMessagesSent:\s*0/);
  assert.match(deep, /productionRunOpened:\s*false/);

  assert.doesNotMatch(deep, /requireSupabase/);
  assert.doesNotMatch(deep, /syncCatalogAndDeploy/);
  assert.doesNotMatch(deep, /sendTelegram(?:Message|Photo)?/);
  assert.doesNotMatch(deep, /savePendingReview/);
  assert.doesNotMatch(deep, /openAutonomousCuratorRun|finishAutonomousCuratorRun|markCycleStarted/);
  assert.doesNotMatch(deep, /maybeQueueCandidate|archiveQueueProduct|persistPausedCandidate|persistContinuousHumanReview|persistReviewRecovery/);
  assert.doesNotMatch(deep, /\.from\(["']products["']\)\.(?:insert|update|delete)/);
});

test("deep dry-run proof calls the real entrypoint and asserts zero mutations", () => {
  assert.match(runner, /runAutonomousCuratorContinuousV2/);
  assert.match(runner, /dryRun:\s*true/);
  assert.match(runner, /notify:\s*false/);
  assert.match(runner, /CONTINUOUS_V2_DEEP_DRY_RUN_MUTATION_CONTRACT_VIOLATED/);
  assert.match(runner, /CONTINUOUS_V2_DEEP_DRY_RUN_NOT_DEEP_ENOUGH/);
  assert.match(workflow, /run-autonomous-curator-continuous-v2-deep-dry-run\.ts/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|CERBERUS_RENDER_RUNTIME_ENABLED|OIDC_AUDIENCE/);
});
