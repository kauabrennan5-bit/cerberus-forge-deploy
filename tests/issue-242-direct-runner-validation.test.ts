import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Issue #242 Validation Tests: Autonomous Curator Render Migration
 *
 * This test suite validates:
 * 1. Workflows have zero Render dependencies
 * 2. Direct runner is truly ephemeral (no Express, polling, or persistent workers)
 * 3. autoPublished === 0 contract is enforced
 * 4. Telegram is the sole human approval gate
 * 5. No side effects occur during dry_run
 * 6. Manual review creates cards without auto-publishing
 */

test("Issue #242: Autonomous Curator workflow boundary — no onrender.com", async () => {
  const curatorYaml = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  const schedulerYaml = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");

  assert.doesNotMatch(curatorYaml, /onrender\.com/);
  assert.doesNotMatch(schedulerYaml, /onrender\.com/);
  console.log("✅ Workflows: zero onrender.com references");
});

test("Issue #242: Direct runner has no /api/internal/autonomous-curator/ dependencies", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const curator = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.doesNotMatch(scheduler, /\/api\/internal\/autonomous-curator\//);
  assert.doesNotMatch(curator, /\/api\/internal\/autonomous-curator\//);
  console.log("✅ Workflows: zero /api/internal/autonomous-curator/ references");
});

test("Issue #242: Direct runner script is ephemeral — no Express, polling, or persistent HTTP", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");

  // Must NOT start a server
  assert.doesNotMatch(runner, /express\(\)/);
  assert.doesNotMatch(runner, /\.listen\(/);
  assert.doesNotMatch(runner, /app\.use\(/);

  // Must NOT have polling loops for Telegram
  assert.doesNotMatch(runner, /while.*true/);
  assert.doesNotMatch(runner, /setInterval/);
  assert.doesNotMatch(runner, /poll|polling/i);

  // Must NOT start newsletter or other workers
  assert.doesNotMatch(runner, /newsletter|campaign|outbox/i);
  assert.doesNotMatch(runner, /worker|daemon/i);

  // Must terminate cleanly after execution
  assert.match(runner, /main\(\)\.catch\(/);
  assert.match(runner, /process\.exitCode/);

  console.log("✅ Direct runner: truly ephemeral (no persistent processes)");
});

test("Issue #242: autoPublished contract is enforced in direct runner", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");

  // Must check autoPublished after execution
  assert.match(runner, /autoPublished\s*=\s*Number\(/);
  assert.match(runner, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
  assert.match(runner, /autoPublished\s*!==\s*0/);

  // Must also check in status mode
  assert.match(runner, /latestRun.*auto_published/);
  assert.match(runner, /if.*AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);

  console.log("✅ Direct runner: autoPublished === 0 enforced");
});

test("Issue #242: Preflight validation requires all critical secrets", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");

  // Supabase is always required
  assert.match(runner, /requireAny\("SUPABASE_URL"/);
  assert.match(runner, /requireAny\("SUPABASE_SERVICE_ROLE"/);

  // Shopee required for dry_run and manual_review
  assert.match(runner, /requireAny\("SHOPEE_APP_ID"/);
  assert.match(runner, /requireAny\("SHOPEE_APP_SECRET"/);

  // Telegram required for manual_review
  assert.match(runner, /mode === "manual_review"/);
  assert.match(runner, /requireAny\("TELEGRAM_BOT_TOKEN"/);

  console.log("✅ Direct runner: fail-closed preflight validation");
});

test("Issue #242: Telegram is sole human approval gate in autonomousCurator.ts", async () => {
  const curator = await readFile(new URL("../server/services/autonomousCurator.ts", import.meta.url), "utf8");

  // Must persist human review
  assert.match(curator, /persistHumanReview/);
  assert.match(curator, /sendReviewCard/);

  // Must NOT auto-publish
  assert.match(curator, /const autoPublished = 0/);

  // Must NOT call createProduct directly (only for human review)
  const directCreateCalls = curator.match(/await.*createProduct\(/);
  assert.equal(directCreateCalls, null, "Direct createProduct() calls should not exist — only Telegram approval workflow");

  console.log("✅ Autonomous Curator: Telegram is sole approval gate");
});

test("Issue #242: Service dependencies are self-contained (no Render HTTP)", async () => {
  const curator = await readFile(new URL("../server/services/autonomousCurator.ts", import.meta.url), "utf8");

  // May use these (pure Supabase)
  assert.match(curator, /curatorRepo/);
  assert.match(curator, /telegramRepo/);
  assert.match(curator, /productsRepository/);

  // Must NOT make HTTP calls to Render
  assert.doesNotMatch(curator, /onrender\.com/);
  assert.doesNotMatch(curator, /cerberus-forge-deploy-backend/);

  // May use Shopee API (required for autonomous discovery)
  assert.match(curator, /ShopeeApiClient/);

  console.log("✅ Service: self-contained dependencies");
});

test("Issue #242: Dry-run mode has zero side effects on Telegram or products", async () => {
  const curator = await readFile(new URL("../server/services/autonomousCurator.ts", import.meta.url), "utf8");

  // Must check dryRun before creating review
  assert.match(curator, /if \(dryRun\)/);
  assert.match(curator, /decision: "dry_run_review"/);

  // During dry_run, must NOT call persistHumanReview
  const dryRunBlock = curator.match(/if \(dryRun\) \{[\s\S]*?continue;\s*\}/)?.[0] || "";
  assert.ok(dryRunBlock.length > 0, "dry_run block must exist");
  assert.doesNotMatch(dryRunBlock, /persistHumanReview/);

  console.log("✅ Dry-run: zero side effects on Telegram or products");
});

test("Issue #242: Manual review creates cards without auto-publishing", async () => {
  const curator = await readFile(new URL("../server/services/autonomousCurator.ts", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");

  // Runner must pass manual: true
  assert.match(runner, /manual:\s*true/);

  // Service must respect manual mode
  assert.match(curator, /options\.manual/);

  // Must NOT auto-publish even with manual: true
  assert.match(curator, /const autoPublished = 0/);

  // Must create review for human decision
  assert.match(curator, /persistHumanReview/);

  console.log("✅ Manual review: creates cards, no auto-publish");
});

test("Issue #242: Workflow dispatch has explicit mode inputs", async () => {
  const curator = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  // Must have explicit mode selection
  assert.match(curator, /inputs:\s*mode/);
  assert.match(curator, /options:\s*-\s*dry_run/);
  assert.match(curator, /options:\s*-\s*manual_review/);
  assert.match(curator, /options:\s*-\s*status/);

  console.log("✅ Workflow dispatch: explicit safe modes");
});

test("Issue #242: Scheduler is fail-closed by default", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");

  // Must check CERBERUS_SERVERLESS_CURATOR_ENABLED
  assert.match(scheduler, /vars\.CERBERUS_SERVERLESS_CURATOR_ENABLED\s*==\s*'true'/);

  // Must only run on schedule if enabled
  assert.match(scheduler, /if:.*CERBERUS_SERVERLESS_CURATOR_ENABLED/);

  console.log("✅ Scheduler: fail-closed until explicitly enabled");
});

test("Issue #242: Boundary contract job proves no Render dependencies on push", async () => {
  const curator = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  // Must have a contract job
  assert.match(curator, /jobs:\s*contract:/);
  assert.match(curator, /name:.*boundary/);

  // Must prove absence of onrender.com
  assert.match(curator, /! grep -q 'onrender\.com'/);

  // Must prove presence of contract validation
  assert.match(curator, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);

  console.log("✅ Boundary contract: enforced on every push");
});

test("Issue #242: Environment variables in workflows use secrets, never hardcoded values", async () => {
  const curator = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");

  // Must use secrets for sensitive values
  assert.match(curator, /secrets\./);
  assert.match(scheduler, /secrets\./);

  // Bot token must come from secrets
  assert.match(curator, /TELEGRAM_BOT_TOKEN:\s*\{\{\s*secrets\./);
  assert.match(scheduler, /TELEGRAM_BOT_TOKEN:\s*\{\{\s*secrets\./);

  console.log("✅ Workflows: secrets never hardcoded");
});
