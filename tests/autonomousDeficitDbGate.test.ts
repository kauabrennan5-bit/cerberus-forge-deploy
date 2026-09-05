import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20260905204547_autonomous_deficit_gate_v2.sql",
  import.meta.url,
);

test("autonomous deficit fallback bypasses only editorial DB publication states", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /ppa\.source in \('autonomous_curator', 'recovery'\)/);
  assert.match(sql, /ppa\.evidence ->> 'deficitFallback'/);
  assert.match(sql, /ppa\.evidence ->> 'bestOfLotFallback'/);
  assert.match(sql, /if not v_deficit_fallback then/);
  assert.match(sql, /new\.display_title_status <> 'reviewed'/);
  assert.match(sql, /new\.image_editorial_status <> 'clean'/);

  // Objective technical publication invariants must remain hard blocks.
  assert.match(sql, /new\.image_curation is null/);
  assert.match(sql, /primaryImageUrl'\) !~\* '\^https:\/\/'/);
  assert.match(sql, /new\.image_review_fingerprint is null/);
  assert.match(sql, /new\.preco is null or new\.preco <= 0/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:CATEGORY_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:AFFILIATE_LINK_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING/);
});
