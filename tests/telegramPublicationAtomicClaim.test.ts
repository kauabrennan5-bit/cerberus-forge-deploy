import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../server/repositories/telegramRepository.ts", import.meta.url),
  "utf8",
);

test("publishing transition uses Supabase compare-and-set instead of blind upsert", () => {
  const start = source.indexOf('if (normReview.status === "publishing")');
  assert.ok(start >= 0, "publishing claim branch must exist");
  const end = source.indexOf('reviews[normReview.id] = normReview;', start);
  assert.ok(end > start, "publishing claim must complete before local persistence");
  const body = source.slice(start, end);

  assert.match(body, /\.from\("telegram_pending_reviews"\)/);
  assert.match(body, /\.update\(reviewRowPayload\(normReview\)\)/);
  assert.match(body, /\.eq\("id", normReview\.id\)/);
  assert.match(body, /\.in\("status", \["pending", "error"\]\)/);
  assert.match(body, /\.select\("id"\)/);
  assert.match(body, /TELEGRAM_REVIEW_PUBLICATION_ALREADY_CLAIMED/);
  assert.doesNotMatch(body, /\.upsert\(/);
});
