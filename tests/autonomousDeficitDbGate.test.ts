import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20260908002035_human_approval_publication_boundary.sql",
  import.meta.url,
);

test("latest DB gate revokes every autonomous deficit and recovery authority", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /check \(auto_publish_enabled = false\)/);
  assert.match(sql, /alter column auto_publish_enabled set not null/);
  assert.match(sql, /v_authorization\.source in \('admin', 'product_rotation'\)/);
  assert.match(sql, /ppa\.approval_origin = 'telegram'/);
  assert.match(sql, /humanManualApproval/);
  assert.match(sql, /TELEGRAM_APPROVAL_NOT_PERSISTED/);
  assert.doesNotMatch(sql, /ppa\.source in \('autonomous_curator', 'recovery'\)/);
  assert.doesNotMatch(sql, /if not v_deficit_fallback then/);

  // Objective technical publication invariants must remain hard blocks.
  assert.match(sql, /PRIMARY_IMAGE_MISSING/);
  assert.match(sql, /new\.preco is null or new\.preco <= 0/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:CATEGORY_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:AFFILIATE_LINK_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:HUMAN_AUTHORIZATION_MISSING/);
  assert.match(sql, /PRODUCT_PUBLICATION_BLOCKED:PUBLICATION_ORIGIN_IMMUTABLE/);
  assert.match(sql, /new\.human_editorial_image_url = v_primary_image/);
  assert.match(sql, /before insert or update of\s+ativo, status, created_by, produto, display_title, preco, categoria, link,\s+imagens, image_curation, human_editorial_approved_at/);
  assert.match(sql, /like '%autonomous_curator%'/);
  assert.match(sql, /set ativo = false,\s*status = 'paused'/);
  assert.doesNotMatch(sql, /\)::boolean/);
  assert.match(sql, /when jsonb_typeof\(r\.data #> '\{lifecycle,audit\}'\) = 'array'/);
});
