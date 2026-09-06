import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repositorySource = await readFile(
  new URL("../server/repositories/autonomousCuratorRepository.ts", import.meta.url),
  "utf8",
);
const migrationSource = await readFile(
  new URL("../supabase/migrations/20260829212000_autonomous_curator.sql", import.meta.url),
  "utf8",
);

test("review publication identity finalization is idempotent after transactional binding", () => {
  assert.match(
    migrationSource,
    /create unique index if not exists product_source_identities_product_uq[\s\S]*product_id[\s\S]*where product_id is not null/i,
    "product_id must remain unique so product-bound reconciliation is unambiguous",
  );

  const start = repositorySource.indexOf("export async function bindProductSourceIdentityByReview");
  assert.ok(start >= 0, "bindProductSourceIdentityByReview must exist");
  const end = repositorySource.indexOf("export async function releaseProductSourceIdentityByReview", start);
  assert.ok(end > start, "bindProductSourceIdentityByReview body must be bounded");
  const body = repositorySource.slice(start, end);

  assert.match(body, /\.eq\("review_id", input\.reviewId\)\.is\("product_id", null\)/);
  assert.match(body, /if \(data\) return;/);
  assert.match(body, /\.eq\("product_id", input\.productId\)/);
  assert.match(body, /if \(alreadyBound\) return;/);
  assert.match(body, /throw new Error\("AUTONOMOUS_CURATOR_REVIEW_IDENTITY_MISSING"\)/);
});
