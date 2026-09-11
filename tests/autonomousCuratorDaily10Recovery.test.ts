import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("dedicated scheduler owns all ten-minute manual-review triggers", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(scheduler, /cron: "\*\/10 \* \* \* \*"/);
  assert.match(scheduler, /cerberus-autonomous-curator-production/);
  assert.match(scheduler, /cancel-in-progress: true/);
  assert.match(scheduler, /CERBERUS_SERVERLESS_CURATOR_ENABLED == 'true'/);
  assert.match(scheduler, /run-autonomous-curator-direct\.ts manual_review/);
  assert.doesNotMatch(scheduler, /api\/internal\/autonomous-curator/);
  assert.doesNotMatch(scheduler, /https:\/\/[^\s"']*onrender\.com/);

  assert.doesNotMatch(primary, /cron:/);
  assert.match(primary, /workflow_dispatch:/);
  assert.match(primary, /default: dry_run/);
  assert.match(primary, /run-autonomous-curator-direct\.ts/);
  assert.doesNotMatch(primary, /api\/internal\/autonomous-curator/);
  assert.doesNotMatch(primary, /https:\/\/[^\s"']*onrender\.com/);
});

test("direct runner performs fail-closed dependency readiness before production curation", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
  assert.match(runner, /requireAny\("SUPABASE_URL"/);
  assert.match(runner, /requireAny\("SUPABASE_SERVICE_ROLE"/);
  assert.match(runner, /requireAny\("SHOPEE_APP_ID"/);
  assert.match(runner, /requireAny\("SHOPEE_APP_SECRET"/);
  assert.match(runner, /requireAny\("TELEGRAM_BOT_TOKEN"/);
  assert.match(runner, /AUTONOMOUS_CURATOR_SECRET_MISSING/);
});

test("direct scheduler has no HTTP retry loop because it invokes the bounded service in-process", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scheduler, /curl\s/);
  assert.doesNotMatch(scheduler, /OIDC|id-token:\s*write/);
  assert.match(runner, /runAutonomousCuratorDaily\(\{/);
  assert.match(runner, /manual:\s*true/);
  assert.match(runner, /if \(status === "failed"\) process\.exitCode = 1/);
});

test("legacy curator routes keep read-only readiness for compatibility while direct runtime no longer uses them", async () => {
  const routes = await readFile(new URL("../server/routes/autonomousCuratorRoutes.ts", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/internal\/autonomous-curator\/readiness"/);
  assert.match(routes, /dependency: "supabase"/);
  assert.match(routes, /reviewOnly: config\.autoPublishEnabled === false/);
  assert.match(routes, /daily_dependency_unavailable/);
  assert.doesNotMatch(scheduler, /api\/internal\/autonomous-curator\/readiness/);
});

test("direct status mode reads the audited latest run and rejects autonomous publications", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
  assert.match(runner, /from\("autonomous_curator_runs"\)/);
  assert.match(runner, /latestRun/);
  assert.match(runner, /auto_published/);
  assert.match(runner, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
});

test("disabled curator remains a safe terminal service result", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
  assert.match(runner, /const status = String\(\(result as any\)\?\.status \|\| "unknown"\)/);
  assert.match(runner, /if \(status === "failed"\) process\.exitCode = 1/);
  assert.doesNotMatch(runner, /status === "disabled"[^\n]*process\.exitCode/);
});

test("direct scheduler no longer requests GitHub OIDC because Render is not in the execution path", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(scheduler, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(scheduler, /id-token:\s*write/);
});

test("obsolete recovery workflow is removed so scheduled cycles cannot duplicate", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url)),
  );
});
