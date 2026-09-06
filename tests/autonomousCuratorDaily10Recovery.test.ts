import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("dedicated scheduler owns all quarter-hour manual-review triggers", async () => {
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(scheduler, /cron: "5,20,35,50 \* \* \* \*"/);
  assert.match(scheduler, /cerberus-autonomous-curator-production/);
  assert.match(scheduler, /cancel-in-progress: true/);
  assert.match(scheduler, /id-token: write/);
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
  assert.match(scheduler, /body\?\.accepted !== true/);
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
