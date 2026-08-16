/**
 * Bloco 16 — Fase A — Testes determinísticos do contrato do Agent Runtime.
 *
 * Nenhum teste toca banco, HTTP, Telegram, Operator ou ferramentas reais.
 * Todas as verificações são funções puras do módulo server/agentRuntime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentDefinition,
  AgentMemoryScope,
} from "../server/agentRegistry/types";
import {
  deriveIntentionKey,
  guardDecisionFlow,
  canTransition,
  checkAgentIdentity,
  checkBudget,
  checkMemoryScope,
  validateRequest,
  TRANSITION_TABLE,
} from "../server/agentRuntime/validation";
import type { AgentRuntimeRequest } from "../server/agentRuntime/contracts";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  EXECUTION_LIFECYCLE_STATES,
  APPROVAL_DECISION_STATES,
} from "../server/agentRuntime/types";

/* ---------- fixtures puras ---------- */

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return Object.freeze<AgentDefinition>({
    agentId: "discovery-agent",
    version: "1.0",
    role: "descoberta",
    description: "test",
    status: "DRAFT",
    enabled: false,
    allowedTools: Object.freeze(["catalog.read", "observations.read"]),
    allowedTables: Object.freeze(["products", "product_clicks"]),
    allowedActions: Object.freeze(["READ_PRODUCT", "READ_OBSERVATION"]),
    maxRisk: "LOW",
    tokenBudget: 0,
    timeBudgetMs: 0,
    memoryScope: Object.freeze<AgentMemoryScope[]>(["PRODUCT", "OBSERVATIONS"]),
    policyVersion: "1.0",
    ...overrides,
  });
}

const REGISTRY = new Map<string, AgentDefinition>([
  ["discovery-agent", makeAgent()],
  ["enabled-agent", makeAgent({ agentId: "enabled-agent", enabled: true, tokenBudget: 1000, timeBudgetMs: 60000, allowedTools: Object.freeze(["products.read", "observations.read"]), allowedActions: Object.freeze(["READ_PRODUCT", "READ_OBSERVATION"]) })],
]);

function makeRequest(overrides: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  return Object.freeze<AgentRuntimeRequest>({
    agentId: "discovery-agent",
    agentVersion: "1.0",
    requestId: "req-1",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    requestedAction: "READ_PRODUCT",
    requestedTool: "products.read",
    targetType: "PRODUCT",
    targetId: "REF-001",
    inputReference: "products.read/REF-001",
    memoryScope: Object.freeze(["PRODUCT"]),
    requestedAt: "2026-08-16T05:00:00.000Z",
    requestedBy: "operator",
    riskContext: { requestedRisk: "LOW", riskFloor: "MEDIUM" },
    budgetContext: { tokenBudget: 100, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1 },
    approvalContext: { requiresApproval: false, approvalId: null },
    ...overrides,
  });
}

/* ---------- identidade ---------- */

describe("Agent identity (default deny)", () => {
  it("agente desconhecido → ok=false", () => {
    const id = checkAgentIdentity(makeRequest({ agentId: "unknown-agent" }), id => REGISTRY.get(id));
    assert.equal(id.known, false);
    assert.equal(id.ok, false);
  });

  it("versão divergente do registry → ok=false", () => {
    const id = checkAgentIdentity(
      makeRequest({ agentVersion: "2.0" }),
      id => REGISTRY.get(id)
    );
    assert.equal(id.known, true);
    assert.equal(id.versionMatch, false);
    assert.equal(id.ok, false);
  });

  it("agente DRAFT/desabilitado → ok=false (AGENT_DISABLED)", () => {
    const id = checkAgentIdentity(makeRequest(), id => REGISTRY.get(id));
    assert.equal(id.enabled, false);
    assert.equal(id.ok, false);
  });

  it("tool fora do allowedTools → ok=false", () => {
    const id = checkAgentIdentity(
      makeRequest({ requestedTool: "telegram.send" }),
      id => REGISTRY.get(id)
    );
    assert.equal(id.toolAllowed, false);
    assert.equal(id.ok, false);
  });

  it("tool/action incompatível com ACTION_TOOL_MAP → ok=false", () => {
    // products.read NÃO mapeia para READ_OBSERVATION (TOOL_ACTION_MISMATCH)
    const id = checkAgentIdentity(
      makeRequest({ requestedAction: "READ_OBSERVATION", requestedTool: "products.read" }),
      id => REGISTRY.get(id)
    );
    assert.equal(id.actionAllowed, true);
    assert.equal(id.toolActionCompatible, false);
    assert.equal(id.ok, false);
  });

  it("agente habilitado com contrato completo e coerente → ok=true", () => {
    const id = checkAgentIdentity(
      makeRequest({ agentId: "enabled-agent", agentVersion: "1.0", requestedAction: "READ_PRODUCT", requestedTool: "products.read" }),
      i => REGISTRY.get(i)
    );
    assert.equal(id.known, true, "known");
    assert.equal(id.versionMatch, true, "versionMatch");
    assert.equal(id.enabled, true, "enabled");
    assert.equal(id.actionAllowed, true, "actionAllowed");
    assert.equal(id.toolAllowed, true, "toolAllowed");
    assert.equal(id.toolActionCompatible, true, "toolActionCompatible");
    assert.equal(id.ok, true, "ok");
  });

  it("identity check é imutável (frozen)", () => {
    const id = checkAgentIdentity(makeRequest(), i => REGISTRY.get(i));
    assert.throws(() => {
      (id as { enabled?: boolean }).enabled = true;
    });
  });
});

/* ---------- validação estrutural ---------- */

describe("AgentRuntimeRequest validation (default deny)", () => {
  it("requisição completa e válida → REQUEST_VALID", () => {
    const v = validateRequest(makeRequest());
    assert.equal(v.ok, true);
    assert.equal(v.reasonCode, "REQUEST_VALID");
  });

  for (const field of ["agentId", "agentVersion", "requestId", "correlationId", "idempotencyKey", "inputReference", "requestedAt"] as const) {
    it(`campo crítico ausente (${field}) → REQUEST_INVALID`, () => {
      const req = { ...makeRequest(), [field]: "" } as AgentRuntimeRequest;
      const v = validateRequest(req);
      assert.equal(v.ok, false);
      assert.equal(v.reasonCode, "REQUEST_INVALID");
      assert.equal(v.field, field);
    });
  }

  it("requestedBy arbitrário → REQUEST_INVALID", () => {
    const v = validateRequest(makeRequest({ requestedBy: "agent-himself" } as never));
    assert.equal(v.ok, false);
  });

  it("budget negativo → REQUEST_INVALID", () => {
    const v = validateRequest({
      ...makeRequest(),
      budgetContext: { tokenBudget: -1, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1 },
    });
    assert.equal(v.ok, false, `reasonCode=${v.reasonCode} field=${v.field}`);
    assert.equal(v.field, "budgetContext.tokenBudget");
  });

  it("memory scope desconhecido → REQUEST_INVALID", () => {
    const v = validateRequest(
      makeRequest({ memoryScope: ["UNKNOWN_SCOPE"] as never })
    );
    assert.equal(v.ok, false);
    assert.equal(v.field, "memoryScope");
  });
});

/* ---------- budget (D-1) ---------- */

describe("Budget contract — 0 = não alocado (fail-closed)", () => {
  it("todos os campos zero → BUDGET_UNALLOCATED", () => {
    const b = checkBudget({ tokenBudget: 0, timeBudgetMs: 0, toolCallBudget: 0, costBudget: 0 });
    assert.equal(b.ok, false);
    assert.equal(b.exhaustedField, "tokenBudget");
  });

  it("qualquer campo zero → fail-closed", () => {
    for (const field of ["tokenBudget", "timeBudgetMs", "toolCallBudget", "costBudget"] as const) {
      const budget = { tokenBudget: 100, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1, [field]: 0 };
      const b = checkBudget(budget as never);
      assert.equal(b.ok, false, `${field} deveria falhar`);
    }
  });

  it("budgets alocados → ok", () => {
    const b = checkBudget({ tokenBudget: 100, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1 });
    assert.equal(b.ok, true);
  });

  it("negative budget → fail-closed", () => {
    const b = checkBudget({ tokenBudget: -5, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1 });
    assert.equal(b.ok, false);
  });
});

/* ---------- memory scope ---------- */

describe("Memory scope — requested ⊆ allowed (default deny)", () => {
  it("subset válido → ok", () => {
    const s = checkMemoryScope(["PRODUCT", "OBSERVATIONS"], ["PRODUCT"]);
    assert.equal(s.ok, true);
    assert.deepEqual(s.deniedScopes, []);
  });

  it("escopo fora do permitido → DENY", () => {
    const s = checkMemoryScope(["PRODUCT"], ["COMMERCIAL_SIGNALS", "PRODUCT"]);
    assert.equal(s.ok, false);
    assert.deepEqual(s.deniedScopes, ["COMMERCIAL_SIGNALS"]);
  });

  it("escopo vazio → ok (nenhum acesso pedido)", () => {
    const s = checkMemoryScope(["PRODUCT"], []);
    assert.equal(s.ok, true);
  });
});

/* ---------- machine de lifecycle ---------- */

describe("Lifecycle state machine (default deny)", () => {
  it("fluxo completo ALLOW → SUCCEEDED", () => {
    const path = [
      ["REQUESTED", "POLICY_EVALUATED"],
      ["POLICY_EVALUATED", "PLANNED"],
      ["PLANNED", "RUNNING"],
      ["RUNNING", "SUCCEEDED"],
    ] as const;
    for (const [from, to] of path) {
      assert.equal(canTransition(from, to), true, `${from}→${to}`);
    }
  });

  it("fluxo REQUIRES_APPROVAL → WAITING_APPROVAL → APPROVED", () => {
    assert.equal(canTransition("POLICY_EVALUATED", "WAITING_APPROVAL"), true);
    assert.equal(canTransition("WAITING_APPROVAL", "APPROVED"), true);
    assert.equal(canTransition("APPROVED", "PLANNED"), true);
  });

  it("DENY termina em DENIED; EXPIRED termina em EXPIRED", () => {
    assert.equal(canTransition("POLICY_EVALUATED", "DENIED"), true);
    assert.equal(canTransition("WAITING_APPROVAL", "EXPIRED"), true);
    assert.equal(canTransition("WAITING_APPROVAL", "REJECTED"), true);
  });

  it("transições perigosas são proibidas por default deny", () => {
    const forbidden: ReadonlyArray<readonly [string, string]> = [
      ["REQUESTED", "RUNNING"],
      ["DENIED", "PLANNED"],
      ["SUCCEEDED", "RUNNING"],
      ["RUNNING", "APPROVED"],
      ["EXPIRED", "PLANNED"],
      ["FAILED", "RUNNING"],
      ["REJECTED", "RUNNING"],
      ["DENIED", "WAITING_APPROVAL"],
    ];
    for (const [from, to] of forbidden) {
      assert.equal(canTransition(from as never, to as never), false, `${from}→${to}`);
    }
  });

  it("tabela de transições é imutável e fechada", () => {
    assert.throws(() => {
      (TRANSITION_TABLE as [string, string][]).push(["RUNNING", "RUNNING"]);
    });
    assert.equal(TRANSITION_TABLE.length, 16);
  });

  it("catálogos de estados são imutáveis", () => {
    assert.throws(() => {
      (EXECUTION_LIFECYCLE_STATES as string[]).push("ANYTHING");
    });
    assert.throws(() => {
      (APPROVAL_DECISION_STATES as string[]).push("ANYTHING");
    });
  });
});

/* ---------- guardião DENY→ALLOW ---------- */

describe("Decision flow guard — jamais transforma DENY em ALLOW", () => {
  it("DENY → blocked (nunca vira ALLOW)", () => {
    const g = guardDecisionFlow({ decision: "DENY" }, "PENDING");
    assert.equal(g.blocked, true);
  });

  it("REQUIRES_APPROVAL + pending → blocked", () => {
    const g = guardDecisionFlow({ decision: "REQUIRES_APPROVAL" }, "PENDING");
    assert.equal(g.blocked, true);
  });

  it("REQUIRES_APPROVAL + approved → unblocked", () => {
    const g = guardDecisionFlow({ decision: "REQUIRES_APPROVAL" }, "APPROVED");
    assert.equal(g.blocked, false);
  });

  it("REQUIRES_APPROVAL + expired → blocked (reavaliação obrigatória)", () => {
    const g = guardDecisionFlow({ decision: "REQUIRES_APPROVAL" }, "EXPIRED");
    assert.equal(g.blocked, true);
  });

  it("ALLOW + not_required → unblocked", () => {
    const g = guardDecisionFlow({ decision: "ALLOW" }, "NOT_REQUIRED");
    assert.equal(g.blocked, false);
  });

  it("ALLOW + pending → flow invalid (inconsistência = deny)", () => {
    const g = guardDecisionFlow({ decision: "ALLOW" }, "PENDING");
    assert.equal(g.flowValid, false);
    assert.equal(g.blocked, true);
  });
});

/* ---------- idempotência ---------- */

describe("Idempotency — mesma intenção = mesma chave", () => {
  it("mesmos inputs → mesma chave", () => {
    const a = deriveIntentionKey({
      agentId: "discovery-agent",
      agentVersion: "1.0",
      requestId: "req-1",
      evaluationId: "ev-1",
    });
    const b = deriveIntentionKey({
      agentId: "discovery-agent",
      agentVersion: "1.0",
      requestId: "req-1",
      evaluationId: "ev-1",
    });
    assert.equal(a, b);
  });

  it("qualquer campo diferente → chave diferente", () => {
    const base = {
      agentId: "discovery-agent",
      agentVersion: "1.0",
      requestId: "req-1",
      evaluationId: "ev-1",
    };
    for (const key of ["agentId", "agentVersion", "requestId", "evaluationId"] as const) {
      const changed = { ...base, [key]: `${base[key]}-changed` };
      assert.notEqual(deriveIntentionKey(base), deriveIntentionKey(changed));
    }
  });

  it("formato determinístico: int-<hash>-<len>", () => {
    const k = deriveIntentionKey({
      agentId: "discovery-agent",
      agentVersion: "1.0",
      requestId: "req-1",
      evaluationId: "ev-1",
    });
    assert.match(k, /^int-[0-9a-z]+-[0-9a-z]+$/);
  });
});

/* ---------- contrato versionado ---------- */

describe("Contract versioning", () => {
  it("versão do contrato é 1.0", () => {
    assert.equal(AGENT_RUNTIME_CONTRACT_VERSION, "1.0");
  });

  it("constante do contrato é imutável (module namespace read-only)", async () => {
    const mod = await import("../server/agentRuntime/types");
    assert.throws(() => {
      Object.defineProperty(mod, "AGENT_RUNTIME_CONTRACT_VERSION", { value: "2.0" });
    });
  });
});
