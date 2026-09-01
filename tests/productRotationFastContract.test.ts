import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productRotationInternals } from "../server/services/productRotation";

const source = readFileSync(new URL("../server/services/productRotation.ts", import.meta.url), "utf8");

test("manual rotation is a small operator-facing browse loop", () => {
  assert.equal(productRotationInternals.ROTATION_VERSION, "4");
  assert.equal(productRotationInternals.ROTATION_SEARCH_MAX_PAGES, 1);
  assert.equal(productRotationInternals.ROTATION_SEARCH_PAGE_LIMIT, 10);
  assert.equal(productRotationInternals.ROTATION_FAST_POOL_TARGET, 10);
  assert.equal(productRotationInternals.ROTATION_FAST_MAX_EVALUATIONS, 4);
  assert.equal(productRotationInternals.ROTATION_FAST_QUEUED_EVALUATIONS, 1);
  assert.equal(productRotationInternals.ROTATION_PROPOSAL_MIN_SCORE, 60);
  assert.match(source, /pool\.slice\(0, ROTATION_FAST_MAX_EVALUATIONS\)/);
  assert.match(source, /availableQueuedCandidates\(profile\.category, rejected\)\)\.slice\(0, ROTATION_FAST_QUEUED_EVALUATIONS\)/);
});

test("manual proposal score is decoupled from autonomous auto-publish threshold", () => {
  assert.match(source, /breakdown\.finalScore < ROTATION_PROPOSAL_MIN_SCORE/);
  assert.doesNotMatch(source, /breakdown\.finalScore < config\.autoPublishThreshold/);
  assert.match(source, /BELOW_ROTATION_PROPOSAL_THRESHOLD/);
});

test("failed approval preflight resumes rotation instead of terminating it", () => {
  assert.match(source, /status:\s*"searching",[\s\S]*candidate_product_id:\s*null,[\s\S]*PREFLIGHT_REJECTED/);
  assert.doesNotMatch(source, /status:\s*"failed",\s*reason:\s*`PREFLIGHT_REJECTED/);
});
