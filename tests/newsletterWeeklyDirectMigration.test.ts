import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/cerberus-watchdog.yml", "utf8");
const runner = readFileSync("scripts/run-newsletter-weekly-direct.ts", "utf8");

test("weekly scheduler runs direct services without Render or OIDC", () => {
  assert.match(workflow, /run-newsletter-weekly-direct\.ts/);
  assert.doesNotMatch(workflow, /onrender\.com/i);
  assert.doesNotMatch(workflow, /CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(workflow, /ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE/);
  assert.doesNotMatch(workflow, /api\/internal\/newsletter/);
  assert.doesNotMatch(workflow, /watchdog\.mjs/);
});

test("push proof is read-only preflight and scheduled writes remain fail closed", () => {
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /elif \[ "\$\{\{ github\.event_name \}\}" = "push" \]; then\s+op=preflight/s);
  assert.match(workflow, /CERBERUS_SERVERLESS_NEWSLETTER_ENABLED/);
  assert.match(workflow, /CERBERUS_SERVERLESS_WEEKLY_PREVIEW_READY/);
  assert.match(workflow, /WEEKLY_PREFLIGHT_TELEGRAM_NOTIFY:/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /WEEKLY_ALLOW_EDITORIAL_BACKFILL_EXECUTE/);
  assert.match(workflow, /CERBERUS_WEEKLY_BACKFILL_EXECUTE_ENABLED/);
});

test("direct weekly runner preserves send and consent safety boundaries", () => {
  assert.match(runner, /runWeeklyProductionPreflight/);
  assert.match(runner, /runWeeklyDraftCycle/);
  assert.match(runner, /runWeeklyEditorialBackfill/);
  assert.match(runner, /runWeeklyStaleDraftCheck/);
  assert.match(runner, /renderDependency:\s*false/);
  assert.match(runner, /newsletterSends:\s*0/);
  assert.match(runner, /sendNowCalls:\s*0/);
  assert.match(runner, /consentChanges:\s*0/);
  assert.match(runner, /providerCampaignCreates:\s*0/);
  assert.match(runner, /WEEKLY_DIRECT_BACKFILL_EXECUTE_NOT_AUTHORIZED/);
  assert.match(runner, /serverlessWeeklyPreviewReady/);
  assert.doesNotMatch(runner, /sendNow|syncWeeklyBrevoProductionAudience|enableWeeklyProductionAfterVerifiedSync/);
});
