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

test("backend catalog sync no longer requires Pull Requests permission", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server/services/githubCatalogSync.ts"), "utf-8");

  assert.doesNotMatch(source, /octokit\.pulls\./);
  assert.match(source, /waitForProtectedPromotion\(/);
  assert.match(source, /GITHUB_CATALOG_PROMOTION_TIMEOUT_MS/);
  assert.match(source, /GITHUB_CATALOG_PR_TIMEOUT_MS/);
  assert.match(source, /Pull Requests: a branch dispara o gate/);

  const writeCall = source.match(/createOrUpdateFileContents\(\{[\s\S]*?\n\s*\}\);/)?.[0] || "";
  assert.ok(writeCall, "expected createOrUpdateFileContents call");
  assert.doesNotMatch(writeCall, /branch:\s*(?:"main"|BASE_BRANCH)/);
  assert.match(writeCall, /branch,\s*\n/);
});

test("catalog branch promotion is restricted to a validated protected pull request", () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/weekly-production-final-gate.yml"), "utf-8");

  assert.match(workflow, /"catalog-sync\/\*\*"/);
  assert.match(workflow, /promote-catalog:/);
  assert.match(workflow, /needs:\s*weekly-production-final/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /timeout-minutes:\s*25/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /public\/data\/products\.json/);
  assert.match(workflow, /JSON\.parse/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /Wait for protected pull request gate/);
  assert.match(workflow, /gh pr checks/);
  assert.match(workflow, /--required/);
  assert.match(workflow, /--watch/);
  assert.match(workflow, /--fail-fast/);
  assert.match(workflow, /weekly-production-final/);
  assert.match(workflow, /gh pr view/);
  assert.match(workflow, /pulls\/\$CATALOG_PR_NUMBER\/merge/);
  assert.match(workflow, /-f sha="\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /git push origin "\$GITHUB_SHA:refs\/heads\/main"/);
});
