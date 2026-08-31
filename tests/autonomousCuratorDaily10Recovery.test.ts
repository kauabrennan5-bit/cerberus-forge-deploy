import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("primary curator owns all quarter-hour production triggers", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(primary, /cron: "2,17,32,47 \* \* \* \*"/);
  assert.match(primary, /group: cerberus-autonomous-curator/);
  assert.match(primary, /cancel-in-progress: false/);
  assert.match(primary, /id-token: write/);
  assert.match(primary, /github\.event_name == 'schedule'/);
  assert.match(primary, /github\.event_name == 'push'/);
  assert.match(primary, /&& 'continuous'/);
  assert.doesNotMatch(primary, /github\.event_name == 'push' && 'dry_run'/);
  assert.match(primary, /api\/internal\/autonomous-curator\/continuous/);
  assert.match(primary, /-d '\{\"notify\":true\}'/);
});

test("obsolete recovery workflow is removed so scheduled cycles cannot duplicate", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url)),
  );
});
