import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("dedicated scheduler owns all ten-minute manual-review triggers", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(scheduler, /cron: "\*\/10 \* \* \* \*"/);
  assert.match(scheduler, /cerberus-autonomous-curator-production/);
  assert.match(scheduler, /cancel-in-progress: true/);
  assert.match(scheduler, /id-token: write/);
  assert.match(scheduler, /api\/internal\/autonomous-curator\/readiness/);
  assert.match(scheduler, /api\/internal\/autonomous-curator\/daily/);
  assert.match(scheduler, /api\/internal\/autonomous-curator\/status/);
  assert.match(scheduler, /"dryRun":false,"notify":true/);
  assert.doesNotMatch(scheduler, /api\/internal\/autonomous-curator\/continuous/);

  assert.doesNotMatch(primary, /cron:/);
  assert.doesNotMatch(primary, /github\.event_name == 'schedule'/);
  assert.match(primary, /github\.event_name == 'push' && 'status'/);
  assert.match(primary, /cerberus-autonomous-curator-status/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'continuous'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'dry_run'/);
});

test("dedicated scheduler waits for Supabase readiness before starting production curation", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(scheduler, /AUTONOMOUS_CURATOR_READINESS=true/);
  assert.match(scheduler, /body\?\.dependency !== 'supabase'/);
  assert.match(scheduler, /body\?\.reviewOnly !== true/);
  assert.match(scheduler, /for attempt in \$\(seq 1 24\)/);
});

test("dedicated scheduler retries transient curator start failures without weakening manual review", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(scheduler, /for attempt in \$\(seq 1 12\)/);
  assert.match(scheduler, /000\|429\|502\|503\|504/);
  assert.match(scheduler, /Autonomous Curator start transient failure/);
  assert.match(scheduler, /accepted:\$\{body\.status \|\| 'accepted'\}/);
  assert.match(scheduler, /AUTONOMOUS_CURATOR_START=/);
  assert.doesNotMatch(scheduler, /"autoPublish":true/);
});

test("curator routes expose read-only readiness and classify dependency startup failures as 503", async () => {
  const routes = await readFile(new URL("../server/routes/autonomousCuratorRoutes.ts", import.meta.url), "utf8");
  assert.match(routes, /app\.get\("\/api\/internal\/autonomous-curator\/readiness"/);
  assert.match(routes, /dependency: "supabase"/);
  assert.match(routes, /reviewOnly: config\.autoPublishEnabled === false/);
  assert.match(routes, /daily_dependency_unavailable/);
  assert.match(routes, /res\.status\(503\)\.json\(\{ ok: false, code: "AUTONOMOUS_CURATOR_DEPENDENCY_UNAVAILABLE" \}\)/);
});

test("dedicated scheduler waits for the audited daily run terminal state", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(scheduler, /const run = body\?\.latestRun/);
  assert.match(scheduler, /\['completed','partial','failed'\]\.includes\(String\(run\.status\)\)/);
  assert.match(scheduler, /terminalStatus && run\.completed_at/);
  assert.match(scheduler, /done:\$\{run\.status\}/);
});

test("dedicated scheduler treats disabled curator as a safe terminal state", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  assert.match(scheduler, /body\?\.status === 'disabled'/);
  assert.match(scheduler, /AUTONOMOUS_CURATOR=disabled/);
  assert.match(scheduler, /body\?\.accepted === true/);
});

test("dedicated scheduler is explicitly authorized for GitHub OIDC", async () => {
  const auth = await readFile(new URL("../server/services/newsletterWeeklyAutomationAuth.ts", import.meta.url), "utf8");
  assert.match(auth, /\.github\/workflows\/autonomous-curator-scheduler\.yml@\$\{EXPECTED_REF\}/);
});

test("obsolete recovery workflow is removed so scheduled cycles cannot duplicate", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url)),
  );
});
