import assert from "node:assert/strict";
import test from "node:test";
import { isValidPersistedOperatorState } from "../server/services/operatorStateStore";

test("estado persistido válido contém somente campos críticos seguros", () => {
  assert.equal(isValidPersistedOperatorState({
    stateKey: "REVALIDATE_SERVICES:incident-1",
    actionId: "REVALIDATE_SERVICES",
    incidentId: "incident-1",
    circuitState: "CLOSED",
    failureCount: 0,
    retryCount: 1,
    lastExecutionAt: 1_000,
    cooldownUntil: 61_000,
    lastTransitionAt: 1_000,
    metadata: {},
  }), true);
});

test("estado persistido inválido é rejeitado fail-closed", () => {
  assert.equal(isValidPersistedOperatorState({
    stateKey: "",
    actionId: "REVALIDATE_SERVICES",
    circuitState: "OPEN",
    failureCount: -1,
    retryCount: 0,
    lastTransitionAt: "agora",
  }), false);
});

test("estado com circuito desconhecido não é aceito", () => {
  assert.equal(isValidPersistedOperatorState({
    stateKey: "a:system",
    actionId: "REVALIDATE_SERVICES",
    circuitState: "UNKNOWN",
    failureCount: 0,
    retryCount: 0,
    lastTransitionAt: Date.now(),
  }), false);
});
