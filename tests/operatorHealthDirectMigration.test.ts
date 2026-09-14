import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/operator-health.yml", "utf8");
const runner = readFileSync("scripts/run-operator-health-direct.ts", "utf8");
const service = readFileSync("server/services/operatorHealthChecksV2.ts", "utf8");

test("Operator Health runs directly against serverless targets without Render or OIDC", () => {
  assert.match(workflow, /run-operator-health-direct\.ts/);
  assert.match(workflow, /https:\/\/cerberus-finds\.pages\.dev/);
  assert.match(workflow, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-telegram-gateway/);
  assert.match(workflow, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-public-api\/products/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED|ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE/);
});

test("direct Operator runner is read-only and preserves zero-publication contract", () => {
  assert.match(runner, /runOperatorHealthChecksV2/);
  assert.match(runner, /assertNoAutoPublication/);
  assert.match(runner, /renderDependency:\s*false/);
  assert.match(runner, /mode:\s*["']operator-health-read-only["']/);
  assert.match(runner, /const autoPublished = 0/);
  assert.match(runner, /const catalogMutations = 0/);
  assert.match(runner, /const reviewsCreated = 0/);
  assert.match(runner, /const telegramMessagesSent = 0/);
  assert.match(runner, /const newsletterSends = 0/);
  assert.match(runner, /const consentChanges = 0/);
  assert.match(runner, /webhookMatchesExpectedUrl/);
  assert.doesNotMatch(runner, /runSystemHealthCheck|reconcileTelegramWebhookConfiguration|syncCatalogAndDeploy|sendNow|sendTelegram(?:Message|Photo)?/);
  assert.doesNotMatch(runner, /\.from\([^)]*\)\.(?:insert|update|upsert|delete)/);
});

test("Operator V2 probe layer contains no mutation orchestration", () => {
  assert.match(service, /runOperatorHealthChecksV2/);
  assert.match(service, /readOnly:\s*true/);
  assert.match(service, /publicationExecuted:\s*false/);
  assert.match(service, /campaignCreated:\s*false/);
  assert.match(service, /emailSent:\s*false/);
  assert.match(service, /consentChanged:\s*false/);
  assert.doesNotMatch(service, /reconcileTelegramWebhookConfiguration|runSystemHealthCheck|syncCatalogAndDeploy|sendNow|sendTelegram(?:Message|Photo)?/);
});
