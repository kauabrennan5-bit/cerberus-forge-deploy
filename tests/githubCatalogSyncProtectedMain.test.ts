import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/services/githubCatalogSync.ts", import.meta.url), "utf8");

test("catalog sync respeita proteção de main com branch, PR, gate e expected head sha", () => {
  assert.match(source, /const PRODUCTION_BRANCH = "main"/);
  assert.match(source, /const REQUIRED_CHECK = "weekly-production-final"/);
  assert.match(source, /git\.createRef\(/);
  assert.match(source, /pulls\.create\(/);
  assert.match(source, /checks\.listForRef\(/);
  assert.match(source, /run\.conclusion === "success"/);
  assert.match(source, /GITHUB_STALE_BASE/);
  assert.match(source, /pulls\.merge\([\s\S]*sha: headSha/);
  assert.match(source, /createOrUpdateFileContents\([\s\S]*branch: branchName/);
  assert.doesNotMatch(source, /createOrUpdateFileContents\([\s\S]*branch:\s*"main"/);
});

test("catalog sync falha fechado e limpa PR/branch sem bypass", () => {
  assert.match(source, /GITHUB_REQUIRED_CHECK_FAILED/);
  assert.match(source, /GITHUB_REQUIRED_CHECK_TIMEOUT/);
  assert.match(source, /bestEffortClosePullRequest/);
  assert.match(source, /bestEffortDeleteBranch/);
  assert.doesNotMatch(source, /bypass|enforce_admins\s*:\s*false|required_status_checks\s*:\s*null/i);
});
