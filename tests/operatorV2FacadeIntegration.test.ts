import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("canonical Operator facade delegates heartbeat and scheduler to independent V2 health", async () => {
  const source = await readFile(new URL("../server/services/cerberusOperator.ts", import.meta.url), "utf8");
  assert.match(source, /runOperatorHealthChecksV2/);
  assert.match(source, /synchronizeOperatorIncidents/);
  assert.match(source, /export async function runSystemHealthCheck/);
  assert.match(source, /export function startOperatorScheduler/);
  assert.match(source, /runSystemHealthCheck\(\)/);
  assert.doesNotMatch(source, /cerberus-static-catalog\.onrender\.com/);
});

test("V2 health defines frontend, backend and catalog projection as independent components", async () => {
  const source = await readFile(new URL("../server/services/operatorHealthChecksV2.ts", import.meta.url), "utf8");
  assert.match(source, /cerberus-design-preview\.onrender\.com/);
  assert.match(source, /cerberus-forge-deploy-backend\.onrender\.com/);
  assert.match(source, /"Site"/);
  assert.match(source, /"Backend"/);
  assert.match(source, /"Produtos\/API"/);
  assert.match(source, /"Catálogo\/Projection"/);
  assert.match(source, /"Telegram"/);
  assert.match(source, /"Gemini"/);
  assert.match(source, /"OpenAI"/);
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
