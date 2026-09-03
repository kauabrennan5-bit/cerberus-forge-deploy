import assert from "node:assert/strict";
import test from "node:test";
import {
  decideRecovery,
  OperationalStateStore,
  OperatorStateMachine,
} from "../server/services/operatorAutonomy";

test("a máquina de estados aceita o fluxo operacional válido e registra transições", () => {
  const machine = new OperatorStateMachine();
  machine.transition("CHECKING", "health check");
  machine.transition("DIAGNOSING", "diagnóstico");
  machine.transition("HEALING", "ação segura");
  machine.transition("VALIDATING", "validação");
  machine.transition("RECOVERING", "recovery");
  machine.transition("RESOLVED", "confirmado");
  assert.equal(machine.getState(), "RESOLVED");
  assert.equal(machine.getHistory().length, 6);
});

test("a máquina de estados bloqueia transição inválida", () => {
  const machine = new OperatorStateMachine();
  assert.throws(() => machine.transition("HEALING", "não permitido"), /INVALID_OPERATOR_TRANSITION/);
});

test("health check seguido de novo health check normaliza DIAGNOSING sem transição inválida", () => {
  const machine = new OperatorStateMachine();
  machine.beginHealthCheck("heartbeat 1");
  machine.transition("DIAGNOSING", "heartbeat 1 terminou observação");
  assert.doesNotThrow(() => machine.beginHealthCheck("heartbeat 2"));
  assert.equal(machine.getState(), "CHECKING");
  const history = machine.getHistory();
  assert.equal(history[0].to, "CHECKING");
  assert.equal(history[1].to, "IDLE");
  assert.equal(history[2].to, "DIAGNOSING");
  assert.equal(history[3].to, "CHECKING");
});

test("heartbeat não interrompe HEALING/VALIDATING/RECOVERING", () => {
  const machine = new OperatorStateMachine();
  machine.transition("CHECKING", "health");
  machine.transition("DIAGNOSING", "diagnóstico");
  machine.transition("HEALING", "heal");
  assert.equal(machine.beginHealthCheck("heartbeat concorrente"), null);
  assert.equal(machine.getState(), "HEALING");
});

test("Decision Engine escolhe auto-heal apenas para ação LOW registrada no nível seguro", () => {
  const decision = decideRecovery({
    mode: "SAFE_AUTO_HEAL",
    risk: "LOW",
    hasRegisteredAction: true,
    consecutiveFailures: 1,
    maxFailures: 3,
  });
  assert.equal(decision, "AUTO_HEAL");
});

test("Decision Engine encaminha GitHub MEDIUM para aprovação administrativa", () => {
  const decision = decideRecovery({
    mode: "SAFE_AUTO_HEAL",
    risk: "MEDIUM",
    hasRegisteredAction: true,
    requiresApproval: true,
    consecutiveFailures: 1,
    maxFailures: 3,
  });
  assert.equal(decision, "WAIT_APPROVAL");
});

test("Decision Engine escala falha sem ação registrada, risco alto e circuito aberto", () => {
  assert.equal(decideRecovery({ mode: "SAFE_AUTO_HEAL", hasRegisteredAction: false, consecutiveFailures: 1, maxFailures: 3 }), "ESCALATE");
  assert.equal(decideRecovery({ mode: "SAFE_AUTO_HEAL", risk: "HIGH", hasRegisteredAction: true, consecutiveFailures: 1, maxFailures: 3 }), "ESCALATE");
  assert.equal(decideRecovery({ mode: "SAFE_AUTO_HEAL", risk: "LOW", hasRegisteredAction: true, circuitOpen: true, consecutiveFailures: 1, maxFailures: 3 }), "ESCALATE");
});

test("LEVEL 0 observe não executa ações mesmo quando uma ação LOW existe", () => {
  const decision = decideRecovery({
    mode: "OBSERVE",
    risk: "LOW",
    hasRegisteredAction: true,
    consecutiveFailures: 1,
    maxFailures: 3,
  });
  assert.equal(decision, "NO_ACTION");
});

test("estado operacional registra falha de Supabase e recovery subsequente", () => {
  const machine = new OperatorStateMachine();
  const store = new OperationalStateStore();
  store.update([{ name: "Supabase", status: "DOWN", timestamp: new Date().toISOString(), latencyMs: 100, error: "timeout" }], { Supabase: "INC-001" });
  let snapshot = store.snapshot("OBSERVE", machine);
  assert.equal(snapshot.status, "DOWN");
  assert.equal(snapshot.components.Supabase.consecutiveFailures, 1);
  assert.equal(snapshot.components.Supabase.currentIncidentId, "INC-001");

  store.update([{ name: "Supabase", status: "HEALTHY", timestamp: new Date().toISOString(), latencyMs: 10 }], {});
  snapshot = store.snapshot("OBSERVE", machine);
  assert.equal(snapshot.components.Supabase.status, "RECOVERING");
  assert.equal(snapshot.components.Supabase.consecutiveFailures, 0);
});

test("estado global degrada diante de divergência de catálogo e registra escalation", () => {
  const machine = new OperatorStateMachine();
  const store = new OperationalStateStore();
  store.update([{ name: "Catálogo", status: "DEGRADED", timestamp: new Date().toISOString(), latencyMs: 25, error: "IDs divergentes" }], { Catálogo: "INC-CATALOG" });
  store.markEscalated();
  const snapshot = store.snapshot("SAFE_AUTO_HEAL", machine);
  assert.equal(snapshot.status, "DEGRADED");
  assert.equal(snapshot.escalations, 1);
  assert.equal(snapshot.autonomyLevel, 1);
});
