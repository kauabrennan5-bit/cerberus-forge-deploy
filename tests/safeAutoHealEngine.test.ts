import assert from "node:assert/strict";
import test from "node:test";
import { SafeAutoHealEngine, type SafeAction } from "../server/services/safeAutoHealEngine";

const context = { actor: "CERBERUS" as const, incidentId: "INC-TEST", incidentFingerprint: "test-fingerprint" };

function action(overrides: Partial<SafeAction> = {}): SafeAction {
  return {
    id: "SAFE_TEST",
    name: "Safe test",
    description: "Ação determinística de teste",
    risk: "LOW",
    allowed: true,
    timeoutMs: 50,
    cooldownMs: 0,
    maxRetries: 0,
    retryable: false,
    preconditions: async () => ({ ok: true, details: "ok" }),
    execute: async () => "done",
    validate: async () => ({ ok: true, details: "valid" }),
    ...overrides,
  };
}

test("executa ação segura e registra validação", async () => {
  const engine = new SafeAutoHealEngine([action()]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "SUCCESS");
  assert.equal(engine.getAuditLog().length, 1);
  assert.equal(result.audit.validation, "valid");
});

test("bloqueia ação quando pré-condição falha", async () => {
  const engine = new SafeAutoHealEngine([action({ preconditions: async () => ({ ok: false, details: "Supabase DOWN" }) })]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "SKIPPED");
});

test("executa rollback quando a validação falha", async () => {
  let rolledBack = false;
  const engine = new SafeAutoHealEngine([action({
    snapshot: async () => "snapshot",
    validate: async () => ({ ok: false, details: "contagem divergente" }),
    rollback: async snapshot => { rolledBack = snapshot === "snapshot"; },
  })]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "FAILED");
  assert.equal(result.audit.rollback, true);
  assert.equal(rolledBack, true);
});

test("interrompe ação que ultrapassa o timeout", async () => {
  const engine = new SafeAutoHealEngine([action({
    timeoutMs: 5,
    execute: async () => new Promise(resolve => setTimeout(() => resolve("late"), 25)),
  })]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "TIMEOUT");
});

test("repete apenas ação retryable com backoff limitado", async () => {
  let attempts = 0;
  const engine = new SafeAutoHealEngine([action({
    retryable: true,
    maxRetries: 1,
    execute: async () => { attempts += 1; if (attempts === 1) throw new Error("network"); return "ok"; },
  })]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "SUCCESS");
  assert.equal(attempts, 2);
});

test("aplica cooldown e impede loop de autocorreção", async () => {
  let now = 1_000;
  const engine = new SafeAutoHealEngine([action({ cooldownMs: 5_000 })], () => now);
  assert.equal((await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context)).status, "SUCCESS");
  assert.equal((await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context)).status, "COOLDOWN");
  now += 5_001;
  assert.equal((await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context)).status, "SUCCESS");
});

test("abre circuit breaker após falhas repetidas", async () => {
  const engine = new SafeAutoHealEngine([action({ execute: async () => { throw new Error("failure"); } })], () => Date.now(), 60_000, 3);
  await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "CIRCUIT_OPEN");
});

test("dry run não executa a função de mudança", async () => {
  let executed = false;
  const engine = new SafeAutoHealEngine([action({ execute: async () => { executed = true; return "done"; } })]);
  const result = await engine.run("SAFE_TEST", "DRY_RUN", context);
  assert.equal(result.status, "DRY_RUN");
  assert.equal(executed, false);
});

test("exige aprovação explícita quando a ação está marcada", async () => {
  const engine = new SafeAutoHealEngine([action({ risk: "MEDIUM", requiresApproval: true })]);
  const result = await engine.run("SAFE_TEST", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "APPROVAL_REQUIRED");
});

test("rejeita ação não registrada e impede comandos arbitrários", async () => {
  const engine = new SafeAutoHealEngine([action()]);
  const result = await engine.run("DROP_DATABASE", "SAFE_AUTO_HEAL", context);
  assert.equal(result.status, "FORBIDDEN");
});
