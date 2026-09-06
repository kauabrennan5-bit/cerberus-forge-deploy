import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260906152500_bind_manual_shopee_identity_after_publish.sql"),
  "utf8",
);

describe("manual Shopee identity binding migration", () => {
  it("binds only authorized telegram_manual publications", () => {
    assert.match(migration, /new\.created_by = 'telegram_manual'/);
    assert.match(migration, /ppa\.source = 'admin'/);
    assert.match(migration, /humanManualApproval/);
    assert.match(migration, /psi\.source_product_url = v_source_url/);
    assert.match(migration, /set product_id = new\.id/);
    assert.match(migration, /v_bound_count <> 1/);
  });
});
