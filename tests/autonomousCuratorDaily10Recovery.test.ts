import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("primary curator owns all quarter-hour production triggers", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(primary, /cron: "2,17,32,47 \* \* \* \*"/);
  assert.match(primary, /cerberus-autonomous-curator-production/);
  assert.match(primary, /cerberus-autonomous-curator-status/);
  assert.match(primary, /cancel-in-progress: true/);
  assert.match(primary, /id-token: write/);
  assert.match(primary, /github\.event_name == 'schedule'/);
  assert.match(primary, /github\.event_name == 'push'/);
  assert.match(primary, /github\.event_name == 'schedule' && 'continuous'/);
  assert.match(primary, /github\.event_name == 'push' && 'status'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'continuous'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'dry_run'/);
  assert.match(primary, /api\/internal\/autonomous-curator\/continuous/);
  assert.match(primary, /api\/internal\/autonomous-curator\/status/);
  assert.match(primary, /-d '\{\"notify\":true\}'/);
});

test("continuous workflow waits for the category-balance coordinator instead of stopping at base completion", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  assert.match(primary, /body\?\.running === true/);
  assert.match(primary, /body\.activeCycleId/);
  assert.match(primary, /String\(body\.activeCycleId \|\| ''\) === expectedCycle/);
  assert.match(primary, /base engine records a terminal run before the category-balance/);
});

test("continuous workflow releases concurrency when a Render restart orphans the expected cycle", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  assert.match(primary, /body\?\.running !== true/);
  assert.match(primary, /process\.stdout\.write\('orphaned'\)/);
  assert.match(primary, /AUTONOMOUS_CURATOR_CYCLE_ORPHANED_AFTER_BACKEND_RESTART/);
});

test("obsolete recovery workflow is removed so scheduled cycles cannot duplicate", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url)),
  );
});
