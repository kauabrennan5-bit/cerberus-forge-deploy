import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Autonomous Curator persists review proof hidden and publishes only through the central hard gate", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");

  assert.match(source, /publishProductWithGate/);
  assert.match(source, /publishQueuedProductWithHardGate/);
  assert.match(source, /source:\s*"autonomous_curator"/);
  assert.match(source, /status:\s*"paused"/);
  assert.match(source, /ativo:\s*false/);
  assert.doesNotMatch(source, /updateQueuedProduct\([^\n]+true/);
  assert.doesNotMatch(source, /status:\s*published\s*\?\s*"published"/);
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
  assert.match(source, /REVIEW_RECOVERY_PENDING:/);
  assert.match(source, /display_title_review_model:\s*candidate\.displayTitleReviewModel/);
  assert.doesNotMatch(source, /display_title_review_model:\s*env\./);
});
