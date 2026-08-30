import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { githubCatalogSyncInternals } from "../server/services/githubCatalogSync";

test("catalog sync branch identity is deterministic and content-addressed", () => {
  const first = githubCatalogSyncInternals.catalogBranchName("[{\"id\":\"a\"}]");
  const same = githubCatalogSyncInternals.catalogBranchName("[{\"id\":\"a\"}]");
  const different = githubCatalogSyncInternals.catalogBranchName("[{\"id\":\"b\"}]");

  assert.equal(first, same);
  assert.notEqual(first, different);
  assert.match(first, /^catalog-sync\/[a-f0-9]{20}$/);
});

test("only protected-gate merge readiness errors are retryable", () => {
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(405), true);
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(409), true);
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(422), true);
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(401), false);
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(403), false);
  assert.equal(githubCatalogSyncInternals.isRetryableMergeStatus(500), false);
});

test("catalog projection promotion respects protected main contract", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server/services/githubCatalogSync.ts"), "utf-8");

  assert.match(source, /octokit\.pulls\.create\(/);
  assert.match(source, /octokit\.pulls\.merge\(/);
  assert.match(source, /merge_method:\s*"squash"/);
  assert.match(source, /sha:\s*headSha/);
  assert.match(source, /octokit\.pulls\.updateBranch\(/);

  const writeCall = source.match(/createOrUpdateFileContents\(\{[\s\S]*?\n\s*\}\);/)?.[0] || "";
  assert.ok(writeCall, "expected createOrUpdateFileContents call");
  assert.doesNotMatch(writeCall, /branch:\s*(?:"main"|BASE_BRANCH)/);
  assert.match(writeCall, /branch,\s*\n/);
});
