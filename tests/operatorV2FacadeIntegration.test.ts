import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { componentForIncident } from "../server/services/operatorIncidentRecovery";

test("canonical Operator facade delegates heartbeat and scheduler to independent V2 health", async () => {
  const source = await readFile(new URL("../server/services/cerberusOperator.ts", import.meta.url), "utf8");
  assert.match(source, /runOperatorHealthChecksV2/);
  assert.match(source, /synchronizeOperatorIncidents/);
  assert.match(source, /export async function runSystemHealthCheck/);
  assert.match(source, /export function startOperatorScheduler/);
  assert.match(source, /runSystemHealthCheck\(\)/);
});

test("V2 health defines frontend, backend and Supabase Edge catalog as independent components", async () => {
  const source = await readFile(new URL("../server/services/operatorHealthChecksV2.ts", import.meta.url), "utf8");
  assert.match(source, /cerberus-design-static\.onrender\.com/);
  assert.match(source, /juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api/);
  assert.match(source, /cerberus-forge-deploy-backend\.onrender\.com/);
  assert.match(source, /"Site"/);
  assert.match(source, /"Backend"/);
  assert.match(source, /"Produtos\/API"/);
  assert.match(source, /"Catálogo\/Projection"/);
  assert.match(source, /"Telegram"/);
  assert.match(source, /"Gemini"/);
  assert.match(source, /"OpenAI"/);
});

test("legacy health incident names map to their V2 measured dependency", () => {
  assert.equal(componentForIncident({ incident_type: "Lifecycle_DEGRADED", summary: "Lifecycle degraded", error_code: "Lifecycle_DEGRADED", metadata: { component: "Lifecycle", dependency: "Backend" } }), "Backend");
  assert.equal(componentForIncident({ incident_type: "Produtos_DEGRADED", summary: "Produtos degraded", error_code: "Produtos_DEGRADED", metadata: { component: "Produtos", dependency: "Backend" } }), "Produtos/API");
});

test("incident recovery resolves all supported active statuses only after component health is healthy", async () => {
  const source = await readFile(new URL("../server/services/operatorIncidentRecovery.ts", import.meta.url), "utf8");
  for (const status of ["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "AUTO_FIXING", "REQUIRES_APPROVAL", "ESCALATED", "RECOVERING", "BLOCKED"]) {
    assert.match(source, new RegExp(`"${status}"`));
  }
  assert.match(source, /observation\.status === "HEALTHY"/);
  assert.match(source, /recovered_at/);
  assert.match(source, /duration_ms/);
  assert.match(source, /health_evidence/);
});
