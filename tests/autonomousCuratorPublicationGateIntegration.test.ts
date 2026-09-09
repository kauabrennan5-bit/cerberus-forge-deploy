import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Autonomous Curator persists a private candidate and exits only through Telegram review", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");

  assert.match(source, /persistContinuousHumanReview/);
  assert.match(source, /savePendingReview\(review\)/);
  assert.match(source, /confirm_pub:\$\{reviewId\}/);
  assert.match(source, /source:\s*"autonomous_curator"/);
  assert.match(source, /status:\s*"paused"/);
  assert.match(source, /ativo:\s*false/);
  assert.match(source, /const publishedThisCycle = 0/);
  assert.doesNotMatch(source, /publishProductWithGate|publishQueuedProductWithHardGate/);
});

test("Autonomous Curator fingerprint is bound to the reviewed primary image URL", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");

  assert.match(source, /imageUrlFingerprint\(primary\)/);
  assert.doesNotMatch(source, /imageCurationFingerprint/);
  assert.match(source, /primaryImageUrl/);
});

test("Autonomous Curator cannot label deterministic fallback copy as reviewed", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");

  assert.match(source, /reviewDisplayTitle/);
  assert.match(source, /model: "editorial-fallback"/);
  assert.match(source, /displayTitleStatus = "review_required"/);
  assert.match(source, /display_title_review_model:\s*automaticTitleApproved \? candidate\.displayTitleReviewModel : null/);
  assert.doesNotMatch(source, /display_title_review_model:\s*env\./);
});

test("production schedulers fail closed if a run ever reports an autonomous publication", async () => {
  for (const path of [
    "../.github/workflows/autonomous-curator.yml",
    "../.github/workflows/autonomous-curator-scheduler.yml",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /autonomousPublications !== 0/);
    assert.match(source, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
  }
});
