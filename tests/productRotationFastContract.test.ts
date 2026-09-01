import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productRotationInternals } from "../server/services/productRotation";

const source = readFileSync(new URL("../server/services/productRotation.ts", import.meta.url), "utf8");

test("manual rotation is a small provider-first operator browse loop", () => {
  assert.equal(productRotationInternals.ROTATION_VERSION, "5");
  assert.equal(productRotationInternals.ROTATION_SEARCH_MAX_PAGES, 1);
  assert.equal(productRotationInternals.ROTATION_SEARCH_PAGE_LIMIT, 10);
  assert.equal(productRotationInternals.ROTATION_FAST_POOL_TARGET, 10);
  assert.equal(productRotationInternals.ROTATION_FAST_MAX_EVALUATIONS, 4);
  assert.equal(productRotationInternals.ROTATION_FAST_QUEUED_EVALUATIONS, 1);
  assert.equal(productRotationInternals.ROTATION_PROPOSAL_MIN_SCORE, 60);
  assert.match(source, /pool\.slice\(0, ROTATION_FAST_MAX_EVALUATIONS\)/);
  assert.match(source, /availableQueuedCandidates\(profile\.category, rejected\)\)\.slice\(0, ROTATION_FAST_QUEUED_EVALUATIONS\)/);
});

test("manual proposal does not run autonomous deep AI publication gates", () => {
  assert.doesNotMatch(source, /extractProductForReview/);
  assert.doesNotMatch(source, /createProductionProductPipeline/);
  assert.doesNotMatch(source, /scoreAutonomousCandidate/);
  assert.doesNotMatch(source, /autoPublishThreshold/);
  assert.match(source, /QUALIFIED_FAST_OPERATOR_REVIEW/);
  assert.match(source, /image_editorial_status:\s*"unreviewed"/);
  assert.match(source, /display_title_status:\s*"unreviewed"/);
});

test("failed approval preflight resumes rotation instead of terminating it", () => {
  assert.match(source, /status:\s*"searching",[\s\S]*candidate_product_id:\s*null,[\s\S]*PREFLIGHT_REJECTED/);
  assert.doesNotMatch(source, /status:\s*"failed",\s*reason:\s*`PREFLIGHT_REJECTED/);
});
