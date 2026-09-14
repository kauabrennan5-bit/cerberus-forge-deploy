import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const serverlessSmoke = readFileSync(".github/workflows/serverless-runtime-smoke.yml", "utf8");
const cloudflareE2e = readFileSync(".github/workflows/cloudflare-production-e2e.yml", "utf8");

test("legacy Render production smoke and SHA verifier stay retired", () => {
  assert.equal(existsSync(".github/workflows/production-smoke-test.yml"), false);
  assert.equal(existsSync(".github/workflows/render-live-sha.yml"), false);
  assert.equal(existsSync("scripts/production-smoke-test.mjs"), false);
});

test("serverless and Cloudflare checks are the canonical replacements", () => {
  assert.match(serverlessSmoke, /Serverless Runtime Smoke/);
  assert.match(serverlessSmoke, /cerberus-public-api\/health/);
  assert.match(serverlessSmoke, /cerberus-runtime-api\/health/);
  assert.match(serverlessSmoke, /cerberus-telegram-gateway\/health/);
  assert.match(serverlessSmoke, /renderDependency/);
  assert.doesNotMatch(serverlessSmoke, /onrender\.com/i);

  assert.match(cloudflareE2e, /Cloudflare Production E2E/);
  assert.match(cloudflareE2e, /cerberus-finds\.pages\.dev/);
  assert.match(cloudflareE2e, /EXPECTED_SHA/);
  assert.match(cloudflareE2e, /CLOUDFLARE_PRODUCTION_E2E=PASS/);
  assert.doesNotMatch(cloudflareE2e, /onrender\.com/i);
});
