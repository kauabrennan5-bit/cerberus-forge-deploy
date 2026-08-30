import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const continuous = readFileSync(new URL("../server/services/autonomousCuratorContinuous.ts", import.meta.url), "utf8");
const continuousV2 = readFileSync(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/20260830134120_autonomous_curator_reviewed_display_title_status.sql", import.meta.url),
  "utf8",
);

test("continuous curator display-title terminal state is accepted by the database contract", () => {
  assert.match(continuous, /display_title_status:\s*"reviewed"/);
  assert.match(continuousV2, /display_title_status:\s*"reviewed"/);
  assert.match(migration, /products_display_title_status_check/);
  assert.match(migration, /'reviewed'::text/);
});

test("display-title migration preserves every pre-existing accepted status", () => {
  for (const status of ["ready", "unreviewed", "review_required"]) {
    assert.match(migration, new RegExp(`'${status}'::text`));
  }
});
