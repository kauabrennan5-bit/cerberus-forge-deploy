import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");

test("Supabase public API enforces strict editorial or current human proof before DTO projection", () => {
  assert.match(source, /display_title_status/);
  assert.match(source, /image_editorial_status/);
  assert.match(source, /image_curation/);
  assert.match(source, /strictEditorialReady/);
  assert.match(source, /isHumanGovernedCreator/);
  assert.match(source, /currentHumanApproval/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /human_editorial_review_id/);
  assert.match(source, /human_editorial_authorization_id/);
  assert.match(source, /human_editorial_image_fingerprint/);
  assert.match(source, /publicationGate/);
  assert.match(source, /rows\.filter\(\(_, index\) => gate\[index\]\)/);
});

test("Supabase public API remains read-only", () => {
  assert.match(source, /req\.method !== "GET"/);
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
});
