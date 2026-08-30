import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");

test("continuous curator builds a deduplicated global search pool before expensive evaluation", () => {
  assert.match(source, /const candidatePool:/);
  assert.match(source, /const seenIdentities = new Set<string>\(\)/);
  assert.match(source, /for \(let queryIndex = 0; queryIndex < queries\.length; queryIndex \+= 1\)/);
  assert.match(source, /seenIdentities\.has\(identityKey\)/);
  assert.match(source, /candidatePool\.sort\(\(a, b\) =>/);
  assert.match(source, /for \(const entry of candidatePool\)/);
  assert.match(source, /if \(examined >= input\.budget\) break/);
});

test("global pool refactor keeps expensive Cerberus publication gates intact", () => {
  assert.match(source, /hasBlockedProfileTerm\(input\.profile/);
  assert.match(source, /IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR/);
  assert.match(source, /PIPELINE_NOT_AUTO_PUBLISHABLE/);
  assert.match(source, /maximumCatalogSimilarity >= 0\.82/);
  assert.match(source, /breakdown\.finalScore < input\.config\.autoPublishThreshold/);
});
