import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/weekly-production-audience-sync.yml", "utf8");
const runner = readFileSync("scripts/run-weekly-production-audience-direct.ts", "utf8");

test("weekly audience workflow has no Render or OIDC dependency", () => {
  assert.match(workflow, /run-weekly-production-audience-direct\.ts/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(workflow, /ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE/);
  assert.doesNotMatch(workflow, /CERBERUS_HEALTH_URL|RENDER_LIVE_SHA_VERIFIED/);
  assert.doesNotMatch(workflow, /api\/internal\/newsletter\/weekly-production/);
  assert.doesNotMatch(workflow, /\bcurl\b/);
});

test("push proof is status-only and schedule cannot mutate audience", () => {
  assert.match(workflow, /if \[ "\$\{\{ github\.event_name \}\}" = "push" \]; then\s+op=status\s+allow_provider_mutations=false\s+allow_enable_production=false/);
  assert.match(workflow, /elif \[ "\$\{\{ github\.event_name \}\}" = "schedule" \]; then\s+op=reconcile\s+allow_provider_mutations=false\s+allow_enable_production=false/);
  assert.match(workflow, /CERBERUS_SERVERLESS_NEWSLETTER_PROVIDER_RECONCILE_ENABLED/);
  assert.match(workflow, /confirm_provider_mutations/);
  assert.match(workflow, /confirm_enable_production/);
  assert.match(workflow, /Provider mutation confirmation required for sync/);
  assert.match(workflow, /production enable confirmations are required for bootstrap/);
});

test("direct audience runner preserves newsletter send boundary", () => {
  assert.match(runner, /readWeeklyProductionRuntimeConfig/);
  assert.match(runner, /reconcileWeeklyBrevoCampaignStatuses/);
  assert.match(runner, /syncWeeklyBrevoProductionAudience/);
  assert.match(runner, /enableWeeklyProductionAfterVerifiedSync/);
  assert.match(runner, /renderDependency:\s*false/);
  assert.match(runner, /newsletterSends:\s*0/);
  assert.match(runner, /sendNowCalls:\s*0/);
  assert.match(runner, /providerCampaignCreates:\s*0/);
  assert.match(runner, /WEEKLY_AUDIENCE_PROVIDER_MUTATIONS_NOT_AUTHORIZED/);
  assert.match(runner, /WEEKLY_PRODUCTION_BOOTSTRAP_NOT_AUTHORIZED/);
  assert.match(runner, /WEEKLY_AUDIENCE_READ_ONLY_CONTRACT_VIOLATED/);
  assert.doesNotMatch(runner, /\bsendNow\s*\(|createEmailCampaign|sendTransactionalEmail/);
});

test("status and reconcile proof cannot change consent, provider audience or production enablement", () => {
  assert.match(runner, /\(op === "status" \|\| op === "reconcile"\)/);
  assert.match(runner, /providerAudienceMutations !== 0/);
  assert.match(runner, /localConsentReconciliations !== 0/);
  assert.match(runner, /productionEnableChanges !== 0/);
});
