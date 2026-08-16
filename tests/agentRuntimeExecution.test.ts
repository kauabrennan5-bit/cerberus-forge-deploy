/**
 * Bloco 16 — Fase C — Testes determinísticos do Agent Runtime Execution Core.
 *
 * Nenhum teste toca banco, HTTP, Telegram, Operator, job_queue, LLM ou
 * ferramentas reais. Todos os executores estão desconectados (NOT_CONNECTED)
 * por projeto nesta fase. As verificações cobrem:
 *
 *   A.  Pipeline fechada — ordem obrigatória dos 10 estágios.
 *   B.  Decision record consumido do Policy Engine (único autorizador).
 *   C.  Guard matemático: DENY → DENY; nunca DENY → ALLOW.
 *   D.  Lifecycle machine: transições fechadas + gate de executor.
 *   E.  Execution plan imutável com execution_id determinístico.
 *   F.  Idempotência: mesma intenção = mesmo registro; contexto diferente = conflito.
 *   G.  Tool Adapter boundary: registro vazio → NOT_CONNECTED.
 *   H.  Approval boundary: provider default nunca aprova.
 *   I.  Target table derivation: declaração validada / canônica unívoca / ambiguidade rejeitada.
 *   J.  Proibição de bypass: engine que retorna ALLOW para pedido inválido
 *       NÃO executa (validação antes da avaliação).
 *   K.  Estruturais: nenhum import proibido nos módulos do runtime.
 *   L.  Imutabilidade: estados congelados não mutáveis por fora.
 *   M.  Property tests: derivismo (mesma entrada = mesma saída).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, AgentMemoryScope } from "../server/agentRegistry/types";
import type { PolicyDecision, PolicyRequest } from "../server/policyEngine/types";
import { runAgentPipeline } from "../server/agentRuntime/pipeline";
import { executeRuntime } from "../server/agentRuntime/runtime";
import { generateExecutionId, deriveInputFingerprint, canonicalJson, AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION } from "../server/agentRuntime/execution";
import { applyTransition, initialMachineState } from "../server/agentRuntime/lifecycle";
import { InMemoryExecutionStore, digestIdentityContext } from "../server/agentRuntime/idempotency";
import { resolveToolAdapter, ADAPTER_REGISTRY } from "../server/agentRuntime/toolAdapter";
import { NeverApproveProvider, DEFAULT_APPROVAL_PROVIDER } from "../server/agentRuntime/approval";
import { deriveIntentionKey } from "../server/agentRuntime/validation";
import type { AgentRuntimeRequest, ExecutionPlan } from "../server/agentRuntime/contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- fixtures ---------- */

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return Object.freeze<AgentDefinition>({
    agentId: "discovery-agent",
    version: "1.0",
    role: "descoberta",
    description: "test",
    status: "DRAFT",
    enabled: false,
    allowedTools: Object.freeze(["products.read"]),
    allowedTables: Object.freeze(["products"]),
    allowedActions: Object.freeze(["READ_PRODUCT"]),
    maxRisk: "LOW",
    tokenBudget: 0,
    timeBudgetMs: 0,
    memoryScope: Object.freeze<AgentMemoryScope[]>(["PRODUCT"]),
    policyVersion: "1.0",
    ...overrides,
  });
}

const REGISTRY = new Map<string, AgentDefinition>([
  [
    "discovery-agent",
    makeAgent(),
  ],
  [
    "enabled-agent",
    makeAgent({
      agentId: "enabled-agent",
      enabled: true,
      allowedTools: Object.freeze(["products.read"]),
      allowedActions: Object.freeze(["READ_PRODUCT"]),
      maxRisk: "MEDIUM",
      tokenBudget: 1000,
      timeBudgetMs: 60000,
    }),
  ],
  [
    "dual-table-agent",
    makeAgent({
      agentId: "dual-table-agent",
      enabled: true,
      allowedTools: Object.freeze(["products.read"]),
      allowedTables: Object.freeze(["products", "product_clicks"]),
      allowedActions: Object.freeze(["READ_PRODUCT"]),
      maxRisk: "MEDIUM",
      tokenBudget: 1000,
      timeBudgetMs: 60000,
    }),
  ],
  [
    "telegram-agent",
    makeAgent({
      agentId: "telegram-agent",
      enabled: true,
      allowedTools: Object.freeze(["telegram.send"]),
      allowedTables: Object.freeze(["products"]),
      allowedActions: Object.freeze(["SEND_TELEGRAM"]),
      maxRisk: "HIGH",
      tokenBudget: 1000,
      timeBudgetMs: 60000,
    }),
  ],
]);

function makeRequest(overrides: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  return Object.freeze<AgentRuntimeRequest>({
    agentId: "enabled-agent",
    agentVersion: "1.0",
    requestId: "req-1",
    correlationId: "corr-1",
    idempotencyKey: "idem-1",
    requestedAction: "READ_PRODUCT",
    requestedTool: "products.read",
    targetType: "PRODUCT",
    targetId: "REF-001",
    targetTable: "products",
    inputReference: "products.read/REF-001",
    memoryScope: Object.freeze(["PRODUCT"]),
    requestedAt: "2026-08-16T05:00:00.000Z",
    requestedBy: "operator",
    riskContext: { requestedRisk: "LOW", riskFloor: null },
    budgetContext: { tokenBudget: 100, timeBudgetMs: 5000, toolCallBudget: 10, costBudget: 1 },
    approvalContext: { requiresApproval: false, approvalId: null },
    ...overrides,
  });
}

/** Engine fake controlável: nunca chama o engine real. */
function fakeEngineFactory(decisions: Map<string, PolicyDecision> | PolicyDecision) {
  return (req: PolicyRequest): PolicyDecision => {
    if (decisions instanceof Map) {
      const key = `${req.agentId}/${req.action}/${req.tool}`;
      const found = decisions.get(key);
      if (!found) {
        throw new Error(`Fake engine: no canned decision for ${key} — bypass would be possible!`);
      }
      return found;
    }
    return decisions;
  };
}

const FIXED_CLOCK = () => "2026-08-16T05:00:00.000Z";

/* ---------- A/B/C: pipeline fechada + decisão do engine ---------- */

describe("Pipeline fechada (A) e decisão do engine (B/C)", () => {
  const allowEngine = fakeEngineFactory({
    decision: "ALLOW",
    reasonCode: "POLICY_ALLOW",
    reason: "fake allow",
    agentId: "enabled-agent",
    agentVersion: "1.0",
    policyVersion: "1.0",
    tool: "products.read",
    action: "READ_PRODUCT",
    risk: "LOW",
    targetTable: "products",
    memoryScope: "PRODUCT",
    checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
    policyEngineVersion: "1.0",
    evaluatedAt: "2026-08-16T05:00:00.000Z",
  } as PolicyDecision);

  it("A. pipeline executa os 10 estágios na ordem obrigatória e produz plan", async () => {
    const result = await runAgentPipeline(makeRequest(), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      executionStore: new InMemoryExecutionStore(),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.lifecycleState, "PLANNED");
    assert.ok(result.executionPlan);
    assert.equal(result.executorStatus, "EXECUTED");
    assert.equal(result.reasonCode, "PLAN_CREATED_PROOF_EXECUTED");
    assert.ok(result.reason.includes("controlled proof path"));
  });

  it("B. request estruturalmente inválido nunca chega ao engine (denial antes da avaliação)", async () => {
    let evaluated = false;
    const probeEngine = (_req: PolicyRequest): PolicyDecision => {
      evaluated = true;
      throw new Error("engine invoked when it must not be");
    };
    const result = await runAgentPipeline(
      makeRequest({ agentId: "" }),
      {
        evaluatePolicy: probeEngine,
        registryLookup: id => REGISTRY.get(id),
        clock: FIXED_CLOCK,
      }
    );
    assert.equal(result.decision, "DENY");
    assert.equal(result.reasonCode, "REQUEST_INVALID");
    assert.equal(evaluated, false);
  });

  it("B. engine DENY → lifecycle DENIED, executor SKIPPED, plan nulo", async () => {
    // Agente desabilitado é negado pela identidade (antes do engine);
    // para forçar a decisão DENY DO ENGINE, usamos o enabled-agent com um
    // pedido válido que o engine fake rejeita.
    const denyEngine = fakeEngineFactory({
      decision: "DENY",
      reasonCode: "AGENT_DISABLED",
      reason: "agent disabled",
      agentId: "enabled-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "FAIL", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);
    const result = await runAgentPipeline(
      makeRequest({ agentId: "enabled-agent" }),
      {
        evaluatePolicy: denyEngine,
        registryLookup: id => REGISTRY.get(id),
        clock: FIXED_CLOCK,
      }
    );
    assert.equal(result.decision, "DENY");
    assert.equal(result.lifecycleState, "DENIED");
    assert.equal(result.executionPlan, null);
    assert.equal(result.executorStatus, "SKIPPED");
  });

  it("B. agente desabilitado → DENY na identidade, engine nunca chamado", async () => {
    let called = 0;
    const denyEngine = (): PolicyDecision => {
      called += 1;
      throw new Error("engine invoked when it must not be");
    };
    const result = await runAgentPipeline(
      makeRequest({ agentId: "discovery-agent" }),
      {
        evaluatePolicy: denyEngine,
        registryLookup: id => REGISTRY.get(id),
        clock: FIXED_CLOCK,
      }
    );
    assert.equal(called, 0);
    assert.equal(result.decision, "DENY");
    assert.equal(result.lifecycleState, "REQUESTED");
    assert.equal(result.executionPlan, null);
    assert.equal(result.executorStatus, "SKIPPED");
  });

  it("C. guard: engine real DENY nunca pode resultar em lifecycle executável", async () => {
    // Mesmo com store e clock injetados, a decisão DENY do engine domina.
    const denyEngine = fakeEngineFactory({
      decision: "DENY",
      reasonCode: "AGENT_DISABLED",
      reason: "fake deny",
      agentId: "enabled-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);
    for (const targetState of ["PLANNED", "RUNNING", "SUCCEEDED"] as const) {
      const result = await runAgentPipeline(makeRequest(), {
        evaluatePolicy: denyEngine,
        registryLookup: id => REGISTRY.get(id),
        executionStore: new InMemoryExecutionStore(),
        clock: FIXED_CLOCK,
      });
      assert.notEqual(result.lifecycleState, targetState);
    }
  });

  it("C. REQUIRES_APPROVAL → WAITING_APPROVAL (não executa, não planeja)", async () => {
    const approvalEngine = fakeEngineFactory({
      decision: "REQUIRES_APPROVAL",
      reasonCode: "APPROVAL_REQUIRED",
      reason: "approval needed",
      agentId: "telegram-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "telegram.send",
      action: "SEND_TELEGRAM",
      risk: "HIGH",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);
    const result = await runAgentPipeline(
      makeRequest({
        agentId: "telegram-agent",
        requestedAction: "SEND_TELEGRAM",
        requestedTool: "telegram.send",
        targetTable: "products",
        riskContext: { requestedRisk: "HIGH", riskFloor: null },
      }),
      {
        evaluatePolicy: approvalEngine,
        registryLookup: id => REGISTRY.get(id),
        clock: FIXED_CLOCK,
      }
    );
    assert.equal(result.decision, "REQUIRES_APPROVAL");
    assert.equal(result.lifecycleState, "WAITING_APPROVAL");
    assert.equal(result.executionPlan, null);
  });
});

/* ---------- D: lifecycle machine ---------- */

describe("Lifecycle machine (D)", () => {
  it("transição permitida produz estado congelado novo", () => {
    const machine = initialMachineState(FIXED_CLOCK);
    const step1 = applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", "operator", FIXED_CLOCK);
    assert.equal(step1.ok, true);
    const step2 = applyTransition(step1.state, "POLICY_EVALUATED", "PLANNED", "operator", FIXED_CLOCK);
    assert.equal(step2.ok, true);
    assert.equal(step2.state.state, "PLANNED");
    assert.equal(step2.state.transitions.length, 2);
  });

  it("DENIED → PLANNED é proibido (máquina fecha o caminho)", () => {
    const machine = initialMachineState(FIXED_CLOCK);
    const step1 = applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", "operator", FIXED_CLOCK);
    const step2 = applyTransition(step1.state, "POLICY_EVALUATED", "DENIED", "operator", FIXED_CLOCK);
    const step3 = applyTransition(step2.state, "DENIED", "PLANNED", "operator", FIXED_CLOCK);
    assert.equal(step3.ok, false);
    assert.equal(step3.reasonCode, "TRANSITION_FORBIDDEN");
    assert.equal(step3.state.state, "DENIED");
  });

  it("EXPIRED/CANCELLED → PLANNED proibidos", () => {
    for (const dead of ["EXPIRED", "CANCELLED"] as const) {
      const machine = initialMachineState(FIXED_CLOCK);
      const viaExpired = applyTransition(machine, "REQUESTED", dead as never, "operator", FIXED_CLOCK);
      const attempt = applyTransition(viaExpired.state, dead, "PLANNED", "operator", FIXED_CLOCK);
      assert.equal(attempt.ok, false);
    }
  });

  it("gate de executor: RUNNING nunca é alcançável nesta fase", () => {
    const machine = initialMachineState(FIXED_CLOCK);
    const step1 = applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", "operator", FIXED_CLOCK);
    const step2 = applyTransition(step1.state, "POLICY_EVALUATED", "PLANNED", "operator", FIXED_CLOCK);
    const step3 = applyTransition(step2.state, "PLANNED", "RUNNING", "operator", FIXED_CLOCK, false);
    assert.equal(step3.ok, false);
    assert.equal(step3.reasonCode, "TRANSITION_FORBIDDEN_BY_GATE");
  });

  it("PLANNED → RUNNING só com executor conectado (comportamento documentado de fase futura)", () => {
    const machine = initialMachineState(FIXED_CLOCK);
    const step1 = applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", "operator", FIXED_CLOCK);
    const step2 = applyTransition(step1.state, "POLICY_EVALUATED", "PLANNED", "operator", FIXED_CLOCK);
    const step3 = applyTransition(step2.state, "PLANNED", "RUNNING", "operator", FIXED_CLOCK, true);
    assert.equal(step3.ok, true);
    assert.equal(step3.state.state, "RUNNING");
  });
});

/* ---------- E: execution plan + execution_id ---------- */

describe("Execution plan determinístico (E)", () => {
  it("execution_id determinístico: mesmas entradas = mesmo id", () => {
    const id1 = generateExecutionId({ intentionKey: "int-x", identityContext: { tool: "products.read", action: "READ_PRODUCT" } });
    const id2 = generateExecutionId({ intentionKey: "int-x", identityContext: { tool: "products.read", action: "READ_PRODUCT" } });
    assert.equal(id1, id2);
    assert.ok(id1.startsWith("exec-"));
  });

  it("execution_id muda quando o contexto relevante muda", () => {
    const id1 = generateExecutionId({ intentionKey: "int-x", identityContext: { tool: "products.read" } });
    const id2 = generateExecutionId({ intentionKey: "int-x", identityContext: { tool: "telegram.send" } });
    assert.notEqual(id1, id2);
  });

  it("plan imutável: não aceita mutação de campos críticos", () => {
    const allowEngine = fakeEngineFactory({
      decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
      reason: "fake",
      agentId: "enabled-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);
    runAgentPipeline(makeRequest(), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      clock: FIXED_CLOCK,
    }).then(result => {
      const plan = result.executionPlan as ExecutionPlan;
      assert.throws(() => { (plan as { executionId?: string }).executionId = "hacked"; });
      assert.throws(() => { (plan as { lifecycleState?: string }).lifecycleState = "SUCCEEDED"; });
    });
  });
});

/* ---------- F: idempotência ---------- */

describe("Idempotência (F)", () => {
  it("mesma intenção = mesmo registro (DUPLICATE_SAME_INTENTION)", async () => {
    const store = new InMemoryExecutionStore();
    const outcome1 = await store.resolveByKey({
      intentionKey: "int-abc",
      identityContextDigest: digestIdentityContext({ a: 1 }),
      executionId: "exec-1",
      lifecycleState: "PLANNED",
      createdAt: FIXED_CLOCK(),
    });
    const outcome2 = await store.resolveByKey({
      intentionKey: "int-abc",
      identityContextDigest: digestIdentityContext({ a: 1 }),
      executionId: "exec-1",
      lifecycleState: "PLANNED",
      createdAt: FIXED_CLOCK(),
    });
    assert.equal(outcome1.conflict, "NONE");
    assert.equal(outcome2.conflict, "DUPLICATE_SAME_INTENTION");
    assert.equal(outcome2.record?.executionId, "exec-1");
  });

  it("mesma intenção + contexto diferente = INTENTION_CONFLICT (colisão)", async () => {
    const store = new InMemoryExecutionStore();
    const outcome1 = await store.resolveByKey({
      intentionKey: "int-abc",
      identityContextDigest: digestIdentityContext({ a: 1 }),
      executionId: "exec-1",
      lifecycleState: "PLANNED",
      createdAt: FIXED_CLOCK(),
    });
    const outcome2 = await store.resolveByKey({
      intentionKey: "int-abc",
      identityContextDigest: digestIdentityContext({ a: 2 }),
      executionId: "exec-2",
      lifecycleState: "PLANNED",
      createdAt: FIXED_CLOCK(),
    });
    assert.equal(outcome1.ok, true);
    assert.equal(outcome2.ok, false);
    assert.equal(outcome2.conflict, "INTENTION_CONFLICT");
  });
});

/* ---------- G: Tool Adapter boundary ---------- */

describe("Tool Adapter boundary (G)", () => {
  it("registry vazio (executores reais ausentes) → NOT_CONNECTED para qualquer tool", () => {
    const emptyRegistry = Object.freeze(new Map());
    const resolution = resolveToolAdapter("telegram.send", "SEND_TELEGRAM", emptyRegistry);
    assert.equal(resolution.status, "NOT_CONNECTED");
    assert.equal(resolution.reasonCode, "EXECUTOR_NOT_CONNECTED");
    assert.equal(resolution.externalInvocation, null);
  });

  it("executor de prova controlado (ProofExecutor) resolve READ_PRODUCT como PROOF_EXECUTED, sem invocação externa", () => {
    const resolution = resolveToolAdapter("products.read", "READ_PRODUCT", ADAPTER_REGISTRY);
    assert.equal(resolution.status, "PROOF_EXECUTED");
    assert.equal(resolution.reasonCode, "PROOF_EXECUTED");
    assert.equal(resolution.externalInvocation, null);
  });

  it("executor de prova rejeita action não suportada → ACTION_UNSUPPORTED", () => {
    const resolution = resolveToolAdapter("products.read", "PUBLISH_PRODUCT", ADAPTER_REGISTRY);
    assert.equal(resolution.status, "ACTION_UNSUPPORTED");
    assert.equal(resolution.externalInvocation, null);
  });
});

/* ---------- H: approval boundary ---------- */

describe("Approval boundary (H)", () => {
  it("provider default nunca aprova", async () => {
    const provider = DEFAULT_APPROVAL_PROVIDER;
    const whenNotRequired = await provider.resolve({ requiresApproval: false, approvalId: null });
    const whenRequired = await provider.resolve({ requiresApproval: true, approvalId: "fake-approval" });
    const whenNeverApprove = await new NeverApproveProvider().resolve({ requiresApproval: true, approvalId: "x" });
    assert.equal(whenNotRequired, "NOT_REQUIRED");
    assert.equal(whenRequired, "PENDING");
    assert.equal(whenNeverApprove, "PENDING");
  });
});

/* ---------- I: target table derivation ---------- */

describe("Target table derivation (I)", () => {
  const allowEngine = fakeEngineFactory({
          decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
      reason: "fake",
      agentId: "enabled-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);

  it("declaração explícita válida aceita e chega ao engine", async () => {
    const result = await runAgentPipeline(makeRequest({ targetTable: "products" }), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.lifecycleState, "PLANNED");
  });

  it("tabela fora do catálogo/allowedTables → DENY (TABLE_NOT_ALLOWED)", async () => {
    const result = await runAgentPipeline(makeRequest({ targetTable: "operator_state" }), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.decision, "DENY");
    assert.equal(result.reasonCode, "TABLE_NOT_ALLOWED");
    assert.equal(result.lifecycleState, "REQUESTED");
  });

  it("ambiguidade sem declaração → DENY (TARGET_TABLE_AMBIGUOUS)", async () => {
    const result = await runAgentPipeline(makeRequest({ agentId: "dual-table-agent", targetTable: undefined }), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.decision, "DENY");
    assert.equal(result.reasonCode, "TARGET_TABLE_AMBIGUOUS");
  });

  it("tabela canônica unívoca (agente com 1 tabela) deriva sem declaração", async () => {
    const result = await runAgentPipeline(makeRequest({ targetTable: undefined }), {
      evaluatePolicy: allowEngine,
      registryLookup: id => REGISTRY.get(id),
      clock: FIXED_CLOCK,
    });
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.lifecycleState, "PLANNED");
  });
});

/* ---------- J: bypass proibido ---------- */

describe("Bypass proibido (J)", () => {
  it("engine ALLOW para request inválido não executa: validação vem ANTES da avaliação", async () => {
    // Um engine corrompido que sempre retorna ALLOW: o request vazio nunca
    // deve chegar a ele (deny na validação estrutural).
    let called = 0;
    const corruptEngine = (_req: PolicyRequest): PolicyDecision => {
      called += 1;
      return {
        decision: "ALLOW",
        reasonCode: "POLICY_ALLOW",
        reason: "corrupt allow",
        agentId: "corrupt-agent",
        agentVersion: "1.0",
        policyVersion: "1.0",
        tool: "products.read",
        action: "READ_PRODUCT",
        risk: "LOW",
        targetTable: "products",
        memoryScope: "PRODUCT",
        checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
        policyEngineVersion: "1.0",
        evaluatedAt: "2026-08-16T05:00:00.000Z",
      } as PolicyDecision;
    };
    const result = await runAgentPipeline(
      makeRequest({ agentId: "", requestedAction: "DELETE_PRODUCT" }),
      { evaluatePolicy: corruptEngine, registryLookup: id => REGISTRY.get(id), clock: FIXED_CLOCK }
    );
    assert.equal(called, 0, "engine NÃO pode ser chamado para request inválido");
    assert.equal(result.decision, "DENY");
    assert.equal(result.lifecycleState, "REQUESTED");
    assert.equal(result.executionPlan, null);
  });

  it("agente desabilitado + engine ALLOW → DENY na identidade (antes da avaliação)", async () => {
    let called = 0;
    const corruptEngine = (): PolicyDecision => {
      called += 1;
      return {
        decision: "ALLOW",
        reasonCode: "POLICY_ALLOW",
        reason: "corrupt",
        agentId: "discovery-agent",
        agentVersion: "1.0",
        policyVersion: "1.0",
        tool: "products.read",
        action: "READ_PRODUCT",
        risk: "LOW",
        targetTable: "products",
        memoryScope: "PRODUCT",
        checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
        policyEngineVersion: "1.0",
        evaluatedAt: "2026-08-16T05:00:00.000Z",
      } as unknown as PolicyDecision;
    };
    const result = await runAgentPipeline(
      makeRequest({ agentId: "discovery-agent" }),
      { evaluatePolicy: corruptEngine, registryLookup: id => REGISTRY.get(id), clock: FIXED_CLOCK }
    );
    assert.equal(called, 0);
    assert.equal(result.decision, "DENY");
    assert.equal(result.reasonCode, "IDENTITY_DISABLED");
  });
});

/* ---------- K: estruturais (imports proibidos) ---------- */

describe("Estruturais (K)", () => {
  const FORBIDDEN_IMPORTS = [
    "telegramBot",
    "jobQueueRepository",
    "safeAutoHealEngine",
    "productAutomation",
    "supabase",
    "llm",
    "createClient",
    "productPipeline",
    "productLifecycle",
    "operatorState",
  ];
  const runtimeFiles = [
    "server/agentRuntime/types.ts",
    "server/agentRuntime/contracts.ts",
    "server/agentRuntime/validation.ts",
    "server/agentRuntime/execution.ts",
    "server/agentRuntime/lifecycle.ts",
    "server/agentRuntime/idempotency.ts",
    "server/agentRuntime/toolAdapter.ts",
    "server/agentRuntime/approval.ts",
    "server/agentRuntime/pipeline.ts",
    "server/agentRuntime/runtime.ts",
  ];

  for (const file of runtimeFiles) {
    for (const forbidden of FORBIDDEN_IMPORTS) {
      it(`K. ${file} não importa ${forbidden}`, () => {
        const content = readFileSync(resolve(__dirname, "..", file), "utf8");
        // Procura apenas imports (linhas que mencionam from '../../*' com o nome).
        const importRegex = new RegExp(`from\\s+["'][^"']*${forbidden}[^"']*["']`, "m");
        assert.equal(importRegex.test(content), false, `${file} importa ${forbidden}`);
      });
    }
  }

  it("K. pipeline importa somente dependências autorizadas", () => {
    const content = readFileSync(resolve(__dirname, "..", "server/agentRuntime/pipeline.ts"), "utf8");
    const froms = Array.from(content.matchAll(/from\s+["']([^"']+)["']/g)).map(m => m[1]);
    const allowed = new Set([
      "../policyEngine/types",
      "../agentRegistry/agents",
      "../agentRegistry/types",
      "./validation",
      "./execution",
      "./lifecycle",
      "./idempotency",
      "./toolAdapter",
      "./approval",
      "./contracts",
    ]);
    for (const f of froms) {
      assert.ok(allowed.has(f), `import não autorizado na pipeline: ${f}`);
    }
  });
});

/* ---------- L: imutabilidade ---------- */

describe("Imutabilidade (L)", () => {
  it("L. ExecutionPlan congelado rejeita escrita", () => {
    const plan = Object.freeze<ExecutionPlan>({
      executionId: "exec-test",
      intentionKey: "int-test",
      requestId: "r",
      agentId: "a",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      approvalState: "NOT_REQUIRED",
      inputReference: "x",
      outputSchemaVersion: "1.0",
      budget: Object.freeze({ tokenBudget: 1, timeBudgetMs: 1, toolCallBudget: 1, costBudget: 1 }),
      createdAt: "2026-08-16T05:00:00.000Z",
      correlationId: "c",
      lifecycleState: "PLANNED",
      approvalRequirement: "NOT_REQUIRED",
      inputFingerprint: "fp",
      schemaVersion: AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION,
    });
    assert.throws(() => { (plan as { lifecycleState?: string }).lifecycleState = "RUNNING"; });
  });

  it("L. canonicalJson é estável (ordem de chaves não afeta)", () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  });
});

/* ---------- M: property tests ---------- */

describe("Property tests (M)", () => {
  it("M. determinismo: executeRuntime com engine ALLOW puro produz mesmo resultado N vezes", async () => {
    const allowEngine = fakeEngineFactory({
      decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
      reason: "fake",
      agentId: "enabled-agent",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "products.read",
      action: "READ_PRODUCT",
      risk: "LOW",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({ request: "PASS", agent: "PASS", enabled: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      policyEngineVersion: "1.0",
      evaluatedAt: "2026-08-16T05:00:00.000Z",
    } as PolicyDecision);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        executeRuntime(makeRequest(), {
          deps: { evaluatePolicy: allowEngine, registryLookup: id => REGISTRY.get(id), clock: FIXED_CLOCK },
        })
      )
    );
    const first = results[0];
    for (const r of results.slice(1)) {
      assert.equal(r.executionId, first.executionId);
      assert.equal(r.intentionKey, first.intentionKey);
      assert.equal(r.lifecycleState, first.lifecycleState);
    }
  });

  it("M. intention key: mesmas partes = mesma chave (deriveIntentionKey)", () => {
    const parts = { agentId: "a", agentVersion: "1.0", requestId: "r", evaluationId: "e" };
    assert.equal(deriveIntentionKey(parts), deriveIntentionKey(parts));
  });
});
