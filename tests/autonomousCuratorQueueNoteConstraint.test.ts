import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260904_autonomous_curator_queue_note_length.sql", import.meta.url),
  "utf8",
);

test("curator queue metadata gets a bounded internal allowance without relaxing public curator notes", () => {
  assert.match(migration, /products_curator_note_length_check/);
  assert.match(migration, /created_by\s*=\s*'autonomous_curator_queue'/);
  assert.match(migration, /curator_note\s+like\s+'AUTONOMOUS_CURATOR_QUEUE_V1:%'/);
  assert.match(migration, /char_length\(curator_note\)\s+between\s+1\s+and\s+2000/);
  assert.match(migration, /created_by\s+is\s+distinct\s+from\s+'autonomous_curator_queue'/);
  assert.match(migration, /char_length\(curator_note\)\s+between\s+1\s+and\s+500/);
});
