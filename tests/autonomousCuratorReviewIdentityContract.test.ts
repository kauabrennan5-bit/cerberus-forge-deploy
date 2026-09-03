import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const repositorySource = fs.readFileSync("server/repositories/autonomousCuratorRepository.ts", "utf8");
const telegramRepositorySource = fs.readFileSync("server/repositories/telegramRepository.ts", "utf8");
const migrationSource = fs.readFileSync("supabase/migrations/20260830012309_autonomous_curator.sql", "utf8");

test("review humana reserva identidade Shopee e publicação/rejeição fecha o lifecycle", () => {
  assert.match(migrationSource, /review_id text/);
  assert.match(repositorySource, /bindProductSourceIdentityByReview/);
  assert.match(repositorySource, /releaseProductSourceIdentityByReview/);
  assert.match(repositorySource, /reviewId\?: string \| null/);
  assert.match(telegramRepositorySource, /syncAutonomousCuratorReviewIdentity/);
  assert.match(telegramRepositorySource, /status === "published"/);
  assert.match(telegramRepositorySource, /\["rejected", "cancelled", "expired"\]/);
  assert.match(telegramRepositorySource, /reserveProductSourceIdentity/);
});
