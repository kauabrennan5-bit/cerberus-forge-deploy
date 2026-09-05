import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("primary curator owns all quarter-hour manual-review triggers", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(primary, /cron: "2,17,32,47 \* \* \* \*"/);
  assert.match(primary, /cerberus-autonomous-curator-production/);
  assert.match(primary, /cerberus-autonomous-curator-status/);
  assert.match(primary, /cancel-in-progress: true/);
  assert.match(primary, /id-token: write/);
  assert.match(primary, /github\.event_name == 'schedule'/);
  assert.match(primary, /github\.event_name == 'push'/);
  assert.match(primary, /github\.event_name == 'schedule' && 'manual_review'/);
  assert.match(primary, /github\.event_name == 'push' && 'status'/);
  assert.doesNotMatch(primary, /github\.event_name == 'schedule' && 'continuous'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'continuous'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'dry_run'/);
  assert.match(primary, /api\/internal\/autonomous-curator\/daily/);
  assert.match(primary, /api\/internal\/autonomous-curator\/status/);
  assert.doesNotMatch(primary, /api\/internal\/autonomous-curator\/continuous/);
  assert.match(primary, /\"notify\":\$\{dry_run\}/);
});

test("manual-review workflow waits for the audited daily run terminal state", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  assert.match(primary, /const run = body\?\.latestRun/);
  assert.match(primary, /\['completed','partial','failed','dry_run'\]\.includes\(String\(run\.status\)\)/);
  assert.match(primary, /terminalStatus && run\.completed_at/);
  assert.match(primary, /done:\$\{run\.status\}/);
});

test("manual-review workflow treats disabled curator as a safe terminal state", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  assert.match(primary, /body\?\.status === 'disabled'/);
  assert.match(primary, /AUTONOMOUS_CURATOR=disabled/);
  assert.match(primary, /body\?\.accepted !== true/);
});

test("obsolete recovery workflow is removed so scheduled cycles cannot duplicate", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url)),
  );
});