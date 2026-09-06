import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database forces every nonpublished product inactive before persistence", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20260906005250_force_nonpublished_products_inactive.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /new\.status is distinct from 'published'/);
  assert.match(migration, /new\.ativo := false/);
  assert.match(migration, /before insert or update on public\.products/);
  assert.match(migration, /products_00_force_nonpublished_inactive/);
});
