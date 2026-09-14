import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("scripts/run-autonomous-curator-continuous-v2-dry-run.ts", "utf8");
const workflow = readFileSync(".github/workflows/autonomous-curator-continuous-v2-dry-run.yml", "utf8");

test("Continuous V2 dry-run does not pass a blank Shopee base URL to the client", () => {
  assert.match(runner, /function optionalTrimmed\(value: string \| undefined\): string \| undefined/);
  assert.match(runner, /const trimmed = value\?\.trim\(\)/);
  assert.match(runner, /return trimmed \? trimmed : undefined/);
  assert.match(runner, /baseUrl:\s*optionalTrimmed\(process\.env\.SHOPEE_AFFILIATE_API_BASE_URL\)/);
  assert.doesNotMatch(runner, /baseUrl:\s*process\.env\.SHOPEE_AFFILIATE_API_BASE_URL\s*[,}]/);
});

test("Continuous V2 operational proof reruns when the Shopee client changes", () => {
  assert.match(workflow, /server\/commercial\/affiliate\/shopeeApiClient\.ts/);
});
