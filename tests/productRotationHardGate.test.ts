import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Product Rotation proposal stays non-public until canonical publication review", async () => {
  const source = await readFile(new URL("../server/services/productRotation.ts", import.meta.url), "utf8");
  assert.match(source, /reviewAndPublishRotationCandidate/);
  assert.match(source, /publication_preflight: "real_editorial_review_pending"/);
  assert.match(source, /publication_preflight: "passed_canonical_hard_gate"/);
  assert.doesNotMatch(source, /from\("products"\)\.update\(\{\s*ativo: true,\s*status: "published",\s*created_by: AUTO_QUEUE_CREATED_BY/s);
  assert.doesNotMatch(source, /refreshCandidateProduct\([^\n]+,\s*true\)/);
});

test("rotation publication preflight performs real image title pipeline score and central gate", async () => {
  const source = await readFile(new URL("../server/services/productRotationPublication.ts", import.meta.url), "utf8");
  assert.match(source, /reviewDisplayTitle/);
  assert.match(source, /reviewProductImages/);
  assert.match(source, /createProductionProductPipeline/);
  assert.match(source, /scoreAutonomousCandidate/);
  assert.match(source, /config\.autoPublishThreshold/);
  assert.match(source, /display_title_status: "reviewed"/);
  assert.match(source, /image_editorial_status: "clean"/);
  assert.match(source, /publishProductWithGate/);
  assert.match(source, /source: "product_rotation"/);
  assert.match(source, /REVIEW_RECOVERY_PENDING:/);
});

test("rotation rollback exception is restricted to exact applying request and original source snapshot", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260902233000_product_publication_gate.sql", import.meta.url), "utf8");
  assert.match(migration, /restore_product_after_failed_rotation/);
  assert.match(migration, /status = 'applying'/);
  assert.match(migration, /source_product_id = p_source_product_id/);
  assert.match(migration, /source_snapshot/);
  assert.match(migration, /ROTATION_RECOVERY_SOURCE_SNAPSHOT_INVALID/);
  assert.match(migration, /current_setting\('cerberus\.rotation_recovery'/);
  assert.match(migration, /grant execute on function public\.restore_product_after_failed_rotation\(uuid, text\) to service_role/);
});
