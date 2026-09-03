import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync("supabase/migrations/20260830175646_autonomous_curator_search_recall.sql", "utf8");

test("autonomous curator recall budget is expanded without lowering quality gates", () => {
  assert.match(migration, /max_enrich_per_category\s*>=\s*1\s+and\s+max_enrich_per_category\s*<=\s*20/i);
  assert.match(migration, /max_search_candidates\s*=\s*10/i);
  assert.match(migration, /max_enrich_per_category\s*=\s*16/i);
  assert.doesNotMatch(migration, /auto_publish_threshold\s*=/i);
  assert.doesNotMatch(migration, /review_threshold\s*=/i);
});
