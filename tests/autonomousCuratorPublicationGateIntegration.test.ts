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

test("production direct runner fails closed if a run ever reports an autonomous publication", async () => {
  const runner = await readFile(new URL("../scripts/run-autonomous-curator-direct.ts", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../.github/workflows/autonomous-curator-scheduler.yml", import.meta.url), "utf8");
  const manual = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");

  assert.match(runner, /autoPublished/);
  assert.match(runner, /autoPublished !== 0/);
  assert.match(runner, /AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED/);
  assert.match(runner, /reviewOnly:\s*true/);
  assert.match(scheduler, /run-autonomous-curator-direct\.ts manual_review/);
  assert.match(manual, /run-autonomous-curator-direct\.ts/);
  assert.doesNotMatch(scheduler, /autoPublish:\s*true|auto_publish_enabled:\s*true/);
  assert.doesNotMatch(manual, /autoPublish:\s*true|auto_publish_enabled:\s*true/);
});
