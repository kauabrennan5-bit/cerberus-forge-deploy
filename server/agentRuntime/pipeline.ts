/**
 * Bloco 16 — Fase C — Pipeline fechada do Agent Runtime.
 *
 * ORDEM OBRIGATÓRIA (nenhuma etapa posterior pode transformar decisão
 * negativa em positiva):
 *   1. REQUEST_VALIDATION        2. AGENT_IDENTITY
 *   3. VERSION_COMPATIBILITY     4. ACTION_TOOL_COMPATIBILITY
 *   5. BUDGET_CHECK              6. MEMORY_SCOPE_CHECK
 *   7. POLICY_EVALUATION (único autorizador — Policy Engine do Bloco 15)
 *   8. LIFECYCLE_PLANNING        9. EXECUTION_PLAN_CREATION
 *   10. EXECUTION_GATE
 *
 * Deny semantics: DENY → DENY; REQUIRES_APPROVAL → REQUIRES_APPROVAL;
 * ALLOW → pode continuar. Nunca DENY → ALLOW.
 *
 * Este módulo é uma camada de ORQUESTRAÇÃO pura: não importa Supabase,
 * Express, Telegram, Operator services, jobQueue, LLM ou filesystem.
 */

import type { PolicyDecision } from "../policyEngine/types";
import { getAgent } from "../agentRegistry/agents";
import {
  AGENT_TABLE_CATALOG,
  AGENT_REGISTRY_POLICY_VERSION,
  type AgentDefinition,
  type AgentMemoryScope,
  type AgentTableName,
} from "../agentRegistry/types";
import {
  validateRequest,
  checkAgentIdentity,
  checkBudget,
  checkMemoryScope,
  guardDecisionFlow,
  deriveIntentionKey,
  RUNTIME_REASON_CODES,
} from "./validation";
import { generateExecutionId, deriveInputFingerprint, AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION } from "./execution";
import {
  applyTransition,
  initialMachineState,
  type ExecutionMachineState,
} from "./lifecycle";
import {
  digestIdentityContext,
  type ExecutionStore,
  type IdempotencyOutcome,
  InMemoryExecutionStore,
} from "./idempotency";
import { resolveToolAdapter, type ToolAdapterResolution } from "./toolAdapter";
import { DEFAULT_APPROVAL_PROVIDER, type ApprovalProvider } from "./approval";
import type {
  AgentRuntimeRequest,
  PolicyDecisionRecord,
  ExecutionPlan,
  RuntimeResult,
} from "./contracts";

/** Estágios da pipeline (enum fechado para auditoria). */
export const PIPELINE_STAGES = Object.freeze([
  "REQUEST_VALIDATION",
  "AGENT_IDENTITY",
  "VERSION_COMPATIBILITY",
  "ACTION_TOOL_COMPATIBILITY",
  "BUDGET_CHECK",
  "MEMORY_SCOPE_CHECK",
  "POLICY_EVALUATION",
  "LIFECYCLE_PLANNING",
  "EXECUTION_PLAN_CREATION",
  "EXECUTION_GATE",
] as const);
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Registro de falha de estágio com o estágio em que ocorreu. */
export interface PipelineFailure {
  stage: PipelineStage | "PRE_PIPELINE";
  reasonCode: string;
  reason: string;
}

/** Dependências injetáveis do runtime (prova de inexistência de acoplamento). */
export interface RuntimeDependencies {
  evaluatePolicy: (request: import("../policyEngine/types").PolicyRequest) => PolicyDecision;
  registryLookup: (agentId: string) => AgentDefinition | undefined;
  executionStore: ExecutionStore;
  approvalProvider: ApprovalProvider;
  clock: () => string;
}

/** Defaults de produção determinísticos — o store real é injetável em fase futura. */
export function defaultRuntimeDependencies(
  evaluatePolicy: (decision: PolicyDecision) => PolicyDecision,
  clock: () => string = () => new Date().toISOString()
): RuntimeDependencies {
  return Object.freeze({
    evaluatePolicy,
    registryLookup: getAgent,
    executionStore: new InMemoryExecutionStore(),
    approvalProvider: DEFAULT_APPROVAL_PROVIDER,
    clock,
  });
}

/** Default do registry: lookup padrão (usado apenas quando o caller não injeta). */
function defaultLookup(agentId: string): AgentDefinition | undefined {
  return getAgent(agentId);
}

/**
 * Deriva a tabela canônica de um pedido de execução a partir do par
 * action→tool (única tool por action) e do contrato do agente. A tabela
 * declarada no request é aceita quando está no catálogo FECHADO e no
 * allowedTables do agente; na ausência de declaração, a tabela canônica da
 * action para o agente é usada quando unívoca. Ausência NÃO é wildcard:
 * se houver ambiguidade, o pedido é rejeitado (REQUEST_INVALID).
 */
function deriveTargetTable(
  request: AgentRuntimeRequest,
  agent: AgentDefinition
): { ok: boolean; table: AgentTableName | null; reasonCode: string } {
  const declared = request.targetTable ?? null;
  if (declared !== null) {
    if (!AGENT_TABLE_CATALOG.includes(declared as AgentTableName)) {
      return { ok: false, table: null, reasonCode: "REQUEST_INVALID" };
    }
    if (!agent.allowedTables.includes(declared as AgentTableName)) {
      return { ok: false, table: null, reasonCode: "TABLE_NOT_ALLOWED" };
    }
    return { ok: true, table: declared as AgentTableName, reasonCode: "REQUEST_VALID" };
  }
  // Sem declaração: tabela canônica por action — exigir que seja única.
  const matching = agent.allowedTables.filter(() => true).length;
  if (agent.allowedTables.length !== 1) {
    return {
      ok: false,
      table: null,
      reasonCode: "TARGET_TABLE_AMBIGUOUS",
    };
  }
  return { ok: true, table: agent.allowedTables[0], reasonCode: "REQUEST_VALID" };
}

/**
 * Pipeline fechada: recebe a requisição do agente e produz o RuntimeResult.
 * Nenhuma execução externa ocorre; o executor gate retorna NOT_CONNECTED.
 */
export async function runAgentPipeline(
  request: AgentRuntimeRequest,
  deps: {
    evaluatePolicy: (request: import("../policyEngine/types").PolicyRequest) => PolicyDecision;
    registryLookup?: (agentId: string) => AgentDefinition | undefined;
    executionStore?: ExecutionStore;
    approvalProvider?: ApprovalProvider;
    clock?: () => string;
  }
): Promise<RuntimeResult> {
  const registryLookup = deps.registryLookup ?? defaultLookup;
  const executionStore = deps.executionStore ?? new InMemoryExecutionStore();
  const approvalProvider = deps.approvalProvider ?? DEFAULT_APPROVAL_PROVIDER;
  const clock = deps.clock ?? (() => new Date().toISOString());

  const deny = (
    stage: PipelineStage | "PRE_PIPELINE",
    reasonCode: string,
    reason: string,
    lifecycleState: "REQUESTED" | "DENIED" = "REQUESTED"
  ): RuntimeResult => {
    const finalState: "REQUESTED" | "DENIED" =
      lifecycleState === "DENIED" ? "DENIED" : "REQUESTED";
    return Object.freeze({
      executionId: "",
      intentionKey: "",
      decision: "DENY",
      lifecycleState: finalState,
      policyEvaluation: null,
      executionPlan: null,
      reason,
      reasonCode,
      deterministic: true,
      executorStatus: "SKIPPED",
      correlationId: request.correlationId,
    });
  };

  // ---- 1. REQUEST_VALIDATION -----------------------------------------------
  const validation = validateRequest(request);
  if (!validation.ok) {
    return deny("REQUEST_VALIDATION", validation.reasonCode, `Request validation failed at field "${validation.field ?? "unknown"}".`, "REQUESTED");
  }

  // ---- 2–4. AGENT_IDENTITY / VERSION_COMPATIBILITY / ACTION_TOOL_COMPATIBILITY
  const identity = checkAgentIdentity(request, registryLookup);
  if (!identity.ok) {
    const code = identity.known
      ? identity.versionMatch
        ? identity.enabled
          ? identity.actionAllowed
            ? identity.toolAllowed
              ? "TOOL_ACTION_MISMATCH"
              : "IDENTITY_TOOL_NOT_ALLOWED"
            : "IDENTITY_ACTION_NOT_ALLOWED"
          : "IDENTITY_DISABLED"
        : "IDENTITY_VERSION_MISMATCH"
      : "IDENTITY_UNKNOWN_AGENT";
    return deny(
      code === "IDENTITY_UNKNOWN_AGENT" || code === "IDENTITY_VERSION_MISMATCH"
        ? "AGENT_IDENTITY"
        : code === "IDENTITY_DISABLED"
          ? "AGENT_IDENTITY"
          : code === "TOOL_ACTION_MISMATCH"
            ? "ACTION_TOOL_COMPATIBILITY"
            : "AGENT_IDENTITY",
      code,
      buildIdentityReason(identity, code),
      "REQUESTED"
    );
  }
  const agent = identity.definition!;

  // ---- 5. BUDGET_CHECK -----------------------------------------------------
  const budget = checkBudget(request.budgetContext);
  if (!budget.ok) {
    return deny("BUDGET_CHECK", "BUDGET_UNALLOCATED", `Budget field "${budget.exhaustedField}" is unallocated; execution fail-closed (D-1).`, "REQUESTED");
  }

  // ---- 6. MEMORY_SCOPE_CHECK -----------------------------------------------
  const scope = checkMemoryScope(agent.memoryScope, request.memoryScope);
  if (!scope.ok) {
    return deny(
      "MEMORY_SCOPE_CHECK",
      "SCOPE_NOT_SUBSET",
      `Memory scopes not permitted: ${scope.deniedScopes.join(", ")}.`,
      "REQUESTED"
    );
  }

  // ---- 7. POLICY_EVALUATION (único autorizador) ----------------------------
  const targetDerivation = deriveTargetTable(request, agent);
  if (!targetDerivation.ok) {
    return deny(
      "POLICY_EVALUATION",
      targetDerivation.reasonCode,
      targetDerivation.reasonCode === "TABLE_NOT_ALLOWED"
        ? `Target table not permitted for agent "${agent.agentId}".`
        : `Target table is ambiguous for agent "${agent.agentId}"; declare an explicit targetTable.`,
      "REQUESTED"
    );
  }
  const targetTable = targetDerivation.table!;

  const firstScope = request.memoryScope[0] ?? "NONE";
  const policyDecision = deps.evaluatePolicy({
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    policyVersion: AGENT_REGISTRY_POLICY_VERSION,
    tool: request.requestedTool,
    action: request.requestedAction,
    targetTable,
    risk: request.riskContext.requestedRisk,
    memoryScope: firstScope,
    context: request.inputReference,
  });

  const decisionRecord: PolicyDecisionRecord = Object.freeze({
    decision: policyDecision.decision,
    reasonCode: policyDecision.reasonCode,
    reason: policyDecision.reason,
    risk: policyDecision.risk as import("../agentRegistry/types").AgentRiskLevel,
    policyVersion: policyDecision.policyVersion,
    agentVersion: policyDecision.agentVersion,
    tool: policyDecision.tool as import("../agentRegistry/types").AgentToolName,
    action: policyDecision.action as import("../agentRegistry/types").AgentActionName,
    evaluationId: `eval-${policyDecision.policyVersion}-${request.requestId}`,
    timestamp: policyDecision.evaluatedAt,
  }) as PolicyDecisionRecord;
  void request; // keep parameter in scope (request used above via closure)

  // Guard matemático: DENY/approval pendente nunca viram executável.
  const approvalState = await resolveApprovalState(
    approvalProvider,
    policyDecision,
    request
  );
  const flow = guardDecisionFlow(policyDecision, approvalState);
  if (!flow.flowValid || flow.blocked) {
    const finalState =
      policyDecision.decision === "DENY"
        ? "DENIED"
        : "WAITING_APPROVAL";
    // Transição fechada pela máquina da Fase A.
    const machine = initialMachineState(clock);
    applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", request.requestedBy, clock);
    const denied = applyTransition(
      applyTransition(machine, "REQUESTED", "POLICY_EVALUATED", request.requestedBy, clock).state,
      "POLICY_EVALUATED",
      finalState,
      request.requestedBy,
      clock
    );
    if (!denied.ok) {
      return deny("LIFECYCLE_PLANNING", "TRANSITION_FORBIDDEN", "Policy decision could not be mapped to a lifecycle state; fail-closed.", "REQUESTED");
    }
    return Object.freeze({
      executionId: "",
      intentionKey: deriveIntentionKeyForRequest(request, decisionRecord),
      decision: policyDecision.decision,
      lifecycleState: finalState,
      policyEvaluation: decisionRecord,
      executionPlan: null,
      reason: policyDecision.reason,
      reasonCode: policyDecision.reasonCode,
      deterministic: true,
      executorStatus: "SKIPPED",
      correlationId: request.correlationId,
    });
  }

  // ---- 8–10. LIFECYCLE / PLAN / GATE ---------------------------------------
  const intentionKey = deriveIntentionKeyForRequest(request, decisionRecord);
  const identityContext = buildIdentityContext(request, decisionRecord);
  const executionId = generateExecutionId({ intentionKey, identityContext });
  const inputFingerprint = deriveInputFingerprint(request.inputReference, identityContext);

  // Idempotência: mesmo intention_key + mesmo contexto = mesmo registro.
  const idempotency: IdempotencyOutcome = await executionStore.resolveByKey({
    intentionKey,
    identityContextDigest: digestIdentityContext(identityContext),
    executionId,
    lifecycleState: "PLANNED",
    createdAt: clock(),
  });
  if (!idempotency.ok) {
    return deny(
      "EXECUTION_PLAN_CREATION",
      "IDEMPOTENCY_VIOLATION",
      idempotency.conflict === "INTENTION_CONFLICT"
        ? "Same intention key with different relevant context; conflict rejected."
        : "Idempotency resolution failed; fail-closed.",
      "REQUESTED"
    );
  }

  const machineAfterEval = applyTransition(
    initialMachineState(clock),
    "REQUESTED",
    "POLICY_EVALUATED",
    request.requestedBy,
    clock
  ).state;
  const machineAfterPlan = applyTransition(
    machineAfterEval,
    "POLICY_EVALUATED",
    "PLANNED",
    request.requestedBy,
    clock
  );
  if (!machineAfterPlan.ok) {
    return deny("EXECUTION_PLAN_CREATION", "TRANSITION_FORBIDDEN", "Planned state could not be reached; fail-closed.", "REQUESTED");
  }

  // ---- 10. EXECUTION_GATE --------------------------------------------------
  const adapterResolution: ToolAdapterResolution = resolveToolAdapter(
    request.requestedTool,
    request.requestedAction
  );
  // Gate desta fase: executores reais permanecem NOT_CONNECTED; somente o
  // executor de prova controlado (ProofExecutor) resolve como PROOF_EXECUTED.
  const executorStatus: "EXECUTED" | "NOT_CONNECTED" =
    adapterResolution.status === "PROOF_EXECUTED" ? "EXECUTED" : "NOT_CONNECTED";
  const plan: ExecutionPlan = Object.freeze({
    executionId,
    intentionKey,
    requestId: request.requestId,
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    policyVersion: AGENT_REGISTRY_POLICY_VERSION,
    tool: request.requestedTool,
    action: request.requestedAction,
    risk: request.riskContext.requestedRisk,
    approvalState,
    inputReference: request.inputReference,
    outputSchemaVersion: "1.0",
    budget: request.budgetContext,
    createdAt: clock(),
    correlationId: request.correlationId,
    lifecycleState: "PLANNED",
    approvalRequirement: policyDecision.decision === "REQUIRES_APPROVAL" ? "REQUIRED" : "NOT_REQUIRED",
    inputFingerprint,
    schemaVersion: AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION,
  });

  return Object.freeze({
    executionId,
    intentionKey,
    decision: policyDecision.decision,
    lifecycleState: "PLANNED",
    policyEvaluation: decisionRecord,
    executionPlan: plan,
    reason:
      adapterResolution.status === "PROOF_EXECUTED"
        ? `Execution plan created (ALLOW path). Proof executor boundary: ${adapterResolution.reasonCode}; only the controlled proof path ran — no external invocation.`
        : `Execution plan created (ALLOW path). Executor boundary: ${adapterResolution.reasonCode}; nothing was executed, published, sent or altered.`,
    reasonCode:
      adapterResolution.status === "PROOF_EXECUTED" ? "PLAN_CREATED_PROOF_EXECUTED" : "PLAN_CREATED_EXECUTOR_NOT_CONNECTED",
    deterministic: true,
    executorStatus,
    correlationId: request.correlationId,
  });
}

function buildIdentityReason(identity: import("./contracts").AgentIdentityCheck, code: string): string {
  const agentId = "agent";
  if (code === "IDENTITY_UNKNOWN_AGENT") {
    return "Agent is not registered in the agent registry.";
  }
  if (code === "IDENTITY_VERSION_MISMATCH") {
    return "Declared agent version does not match the registered version.";
  }
  if (code === "IDENTITY_DISABLED") {
    return "Agent is disabled (enabled=false).";
  }
  if (code === "IDENTITY_ACTION_NOT_ALLOWED") {
    return "Action is not permitted for this agent.";
  }
  if (code === "IDENTITY_TOOL_NOT_ALLOWED") {
    return "Tool is not permitted for this agent.";
  }
  return "Tool/action incompatibility with the closed action catalog.";
}

function deriveIntentionKeyForRequest(
  request: AgentRuntimeRequest,
  decision: PolicyDecisionRecord
): string {
  return deriveIntentionKey({
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    requestId: request.requestId,
    evaluationId: decision.evaluationId,
  });
}

function buildIdentityContext(
  request: AgentRuntimeRequest,
  decision: PolicyDecisionRecord
): Record<string, unknown> {
  return {
    tool: request.requestedTool,
    action: request.requestedAction,
    inputReference: request.inputReference,
    targetTable: request.targetTable ?? null,
    targetType: request.targetType,
    targetId: request.targetId,
    requestedRisk: request.riskContext.requestedRisk,
    riskFloor: request.riskContext.riskFloor,
    memoryScope: Array.from(request.memoryScope),
    decision: decision.decision,
    policyVersion: decision.policyVersion,
  };
}

async function resolveApprovalState(
  provider: ApprovalProvider,
  decision: PolicyDecision,
  request: AgentRuntimeRequest
): Promise<import("./types").ApprovalDecisionState> {
  try {
    return await provider.resolve({
      requiresApproval: decision.decision === "REQUIRES_APPROVAL",
      approvalId: null,
    });
  } catch (error) {
    // Falha ao resolver aprovação = nunca aprova; default deny.
    return "PENDING";
  }
}

export type { RuntimeResult };
