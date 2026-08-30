import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("daily-10 curator has redundant quarter-hour production triggers", async () => {
  const primary = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  const recovery = await readFile(new URL("../.github/workflows/curator-daily-10-recovery.yml", import.meta.url), "utf8");

  assert.match(primary, /cron: "17 \* \* \* \*"/);
  assert.match(recovery, /cron: "2,32,47 \* \* \* \*"/);
  assert.match(recovery, /group: cerberus-autonomous-curator/);
  assert.match(recovery, /cancel-in-progress: false/);
  assert.match(recovery, /id-token: write/);
  assert.match(recovery, /api\/internal\/autonomous-curator\/continuous/);
  assert.match(recovery, /-d '\{\"notify\":true\}'/);
  assert.match(recovery, /CURATOR_DAILY_10_RECOVERY_DISABLED/);
});
