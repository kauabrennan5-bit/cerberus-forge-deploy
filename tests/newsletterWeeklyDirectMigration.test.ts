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
  assert.doesNotMatch(runner, /sendNow|syncWeeklyBrevoProductionAudience|enableWeeklyProductionAfterVerifiedSync/);
});
