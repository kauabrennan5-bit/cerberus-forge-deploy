import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20260905210635_allow_unlimited_manual_collection_campaigns.sql",
  import.meta.url,
);

test("manual collection campaigns are re-keyed per campaign while weekly keys stay untouched", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /new\.campaign_type = 'collection'/);
  assert.match(sql, /new\.edition_key like 'collection:%'/);
  assert.match(sql, /new\.edition_key := 'manual:' \|\| new\.id::text \|\| ':' \|\| new\.edition_key/);
  assert.match(sql, /before insert on public\.email_campaigns/);
  assert.match(sql, /update public\.email_campaigns/);
  assert.match(sql, /edition_key like 'collection:%'/);

  // Automated weekly campaign families must not be rewritten or weakened.
  assert.doesNotMatch(sql, /new\.edition_key like 'weekly:%'/);
  assert.doesNotMatch(sql, /new\.edition_key like 'weekly-test:%'/);
  assert.doesNotMatch(sql, /drop index[^;]*email_campaigns_edition_key_unique/i);
});
