import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("server/services/autonomousCuratorContinuousV2Base.ts", "utf8");

test("continuous curator builds a deduplicated global search pool before expensive evaluation", () => {
  assert.match(source, /const candidatePool:/);
  assert.match(source, /const seenIdentities = new Set<string>\(\)/);
  assert.match(source, /for \(let queryIndex = 0; queryIndex < queries\.length; queryIndex \+= 1\)/);
  assert.match(source, /seenIdentities\.has\(identityKey\)/);
  assert.match(source, /const lexicalEntries = candidatePool/);
  assert.match(source, /const rankedPool = candidatePool\.filter/);
  assert.match(source, /rankedPool\.sort\(\(a, b\) =>/);
  assert.match(source, /for \(const entry of rankedPool\)/);
  assert.match(source, /if \(examined >= input\.budget\) break/);
});

test("semantic discovery can rescue only real Shopee pool identities before enrichment", () => {
  assert.match(source, /rankAutonomousCuratorCandidates\(input\.profile, semanticCandidates/);
  assert.match(source, /identityKey: `\$\{entry\.item\.shopId\}:\$\{entry\.item\.itemId\}`/);
  assert.match(source, /if \(entry\.cheap > -1000\) return true/);
  assert.match(source, /semantic\.status !== "ok"/);
  assert.match(source, /decision\?\.worthEnriching/);
});

test("global pool keeps technical blocks hard and editorial signals rank-only", () => {
  for (const hardBlock of [
    "AFFILIATE_IDENTITY_MISMATCH",
    "SCRAPER_IDENTITY_MISMATCH",
    "PUBLIC_CATEGORY_INVALID",
    "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK",
    "IMAGE_USABLE_MISSING",
    "PIPELINE_HARD_BLOCK",
  ]) assert.match(source, new RegExp(hardBlock));
  assert.match(source, /softWarnings\.push\(`PROFILE_BLOCKED_TERM:/);
  assert.match(source, /softWarnings\.push\(`CATALOG_SIMILARITY:/);
  assert.match(source, /softWarnings\.push\(`BELOW_REVIEW_THRESHOLD:/);
  assert.doesNotMatch(source, /hasBlockedProfileTerm\(input\.profile, item\.name\).*continue/);
  assert.doesNotMatch(source, /PIPELINE_NOT_AUTO_PUBLISHABLE/);
});
