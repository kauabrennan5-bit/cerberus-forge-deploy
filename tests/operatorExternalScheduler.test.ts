import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isExternalOperatorScheduler } from "../server/services/cerberusOperator";

test("Operator internal scheduler is disabled only in explicit external mode", () => {
  assert.equal(isExternalOperatorScheduler({ OPERATOR_SCHEDULER_MODE: "external" } as NodeJS.ProcessEnv), true);
  assert.equal(isExternalOperatorScheduler({ OPERATOR_SCHEDULER_MODE: "EXTERNAL" } as NodeJS.ProcessEnv), true);
  assert.equal(isExternalOperatorScheduler({ OPERATOR_SCHEDULER_MODE: "internal" } as NodeJS.ProcessEnv), false);
  assert.equal(isExternalOperatorScheduler({} as NodeJS.ProcessEnv), false);
});

test("Operator external workflow runs a bounded direct read-only serverless health cycle", () => {
  const workflow = readFileSync(new URL("../.github/workflows/operator-health.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "5,15,25,35,45,55 \* \* \* \*"/);
  assert.match(workflow, /run-operator-health-direct\.ts/);
  assert.match(workflow, /https:\/\/cerberus-finds\.pages\.dev/);
  assert.match(workflow, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-telegram-gateway/);
  assert.match(workflow, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-public-api\/products/);
  assert.doesNotMatch(workflow, /id-token:\s*write|api\/internal\/operator\/health-cycle|onrender\.com/i);
  assert.doesNotMatch(workflow, /ACTIONS_ID_TOKEN_REQUEST|OIDC_AUDIENCE|CERBERUS_RENDER_RUNTIME_ENABLED/);
  assert.doesNotMatch(workflow, /BREVO_API_KEY|sendNow/);
});

test("legacy Operator OIDC route remains isolated without being used by the external workflow", () => {
  const routes = readFileSync(new URL("../server/routes/newsletterWeeklyRoutes.ts", import.meta.url), "utf8");
  const operatorRoute = readFileSync(new URL("../server/routes/operatorAutomationRoutes.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../server/services/newsletterWeeklyAutomationAuth.ts", import.meta.url), "utf8");
  const operator = readFileSync(new URL("../server/services/cerberusOperator.ts", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/operator-health.yml", import.meta.url), "utf8");

  assert.match(routes, /registerOperatorAutomationRoutes\(app\)/);
  assert.match(operatorRoute, /authorizeWeeklyAutomationRequest/);
  assert.match(operatorRoute, /runSystemHealthCheck\(\)/);
  assert.match(operatorRoute, /already_running/);
  assert.match(auth, /operator-health\.yml/);
  assert.match(operator, /OPERATOR_SCHEDULER_MODE/);
  assert.match(operator, /mode=external; internal interval disabled/);
  assert.doesNotMatch(workflow, /api\/internal\/operator\/health-cycle/);
});
