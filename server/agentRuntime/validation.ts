/**
 * Bloco 16 — Fase A — Validação determinística do Agent Runtime.
 *
 * Funções puras: nenhum efeito colateral, nenhuma persistência, nenhum
 * acesso a banco, nenhuma ferramenta. Todas as regras são default deny:
 * qualquer caminho não coberto retorna DENY.
 */
import type { PolicyDecision } from "../policyEngine/types";
import {
  AGENT_ACTION_CATALOG,
  AGENT_MEMORY_SCOPE_CATALOG,
  AGENT_TOOL_CATALOG,
  AGENT_RISK_ORDER,
  type AgentRiskLevel,
} from "../agentRegistry/types";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  APPROVAL_DECISION_STATES,
  EXECUTION_LIFECYCLE_STATES,
  type ApprovalDecisionState,
  type BudgetCheck,
  type ExecutionLifecycleState,
  type MemoryScopeCheck,
} from "./types";
import type {
  AgentIdentityCheck,
  AgentRuntimeRequest,
  LifecycleTransition,
} from "./contracts";
import { ACTION_TOOL_MAP } from "../policyEngine/toolActionMap";

/** Catálogo fechado de reason codes do runtime (complementa o catálogo do engine). */
export const RUNTIME_REASON_CODES = Object.freeze([
  "REQUEST_VALID",
  "REQUEST_INVALID",
  "IDENTITY_UNKNOWN_AGENT",
  "IDENTITY_VERSION_MISMATCH",
  "IDENTITY_DISABLED",
  "IDENTITY_ACTION_NOT_ALLOWED",
  "IDENTITY_TOOL_NOT_ALLOWED",
  "TOOL_ACTION_MISMATCH",
  "SCOPE_NOT_SUBSET",
  "SCOPE_UNKNOWN",
  "BUDGET_UNALLOCATED",
  "BUDGET_EXHAUSTED",
  "TRANSITION_FORBIDDEN",
  "APPROVAL_EXPIRED",
  "APPROVAL_STATE_INVALID",
  "IDEMPOTENCY_VIOLATION",
  "ARTIFACT_SCHEMA_INVALID",
  "PLAN_CREATED_EXECUTOR_NOT_CONNECTED",
  "PLAN_CREATED_PROOF_EXECUTED",
]);

/**
 * Transições de lifecycle permitidas. Default deny: qualquer par (from, to)
 * fora desta tabela é rejeitado.
 */
export const TRANSITION_TABLE: ReadonlyArray<
  readonly [ExecutionLifecycleState, ExecutionLifecycleState]
> = Object.freeze([
  ["REQUESTED", "POLICY_EVALUATED"],
  ["POLICY_EVALUATED", "DENIED"],
  ["POLICY_EVALUATED", "WAITING_APPROVAL"],
  ["POLICY_EVALUATED", "APPROVED"],
  ["POLICY_EVALUATED", "PLANNED"],
  ["WAITING_APPROVAL", "APPROVED"],
  ["WAITING_APPROVAL", "REJECTED"],
  ["WAITING_APPROVAL", "EXPIRED"],
  ["APPROVED", "PLANNED"],
  ["APPROVED", "CANCELLED"],
  ["PLANNED", "RUNNING"],
  ["PLANNED", "CANCELLED"],
  ["RUNNING", "SUCCEEDED"],
  ["RUNNING", "FAILED"],
  ["RUNNING", "TIMED_OUT"],
  ["RUNNING", "CANCELLED"],
]);

/** Verificação determinística de transição de lifecycle. */
export function canTransition(
  from: ExecutionLifecycleState,
  to: ExecutionLifecycleState
): boolean {
  return TRANSITION_TABLE.some(pair => pair[0] === from && pair[1] === to);
}

/**
 * Identidade do agente contra o registry (somente leitura, deterministicamente
 * sem efeitos). Verifica: conhecido, versão, habilitado, action/tool permitidas,
 * compatibilidade tool↔action do ACTION_TOOL_MAP.
 */
export function checkAgentIdentity(
  request: Pick<
    AgentRuntimeRequest,
    "agentId" | "agentVersion" | "requestedAction" | "requestedTool"
  >,
  registryLookup: (agentId: string) => import("../agentRegistry/types").AgentDefinition | undefined
): AgentIdentityCheck {
  const definition = registryLookup(request.agentId);
  const known = definition !== undefined;
  const versionMatch = known && definition.version === request.agentVersion;
  const enabled = known && definition.enabled === true;
  const actionAllowed =
    known && definition.allowedActions.includes(request.requestedAction);
  const toolAllowed =
    known && definition.allowedTools.includes(request.requestedTool);
  const mappedTool = ACTION_TOOL_MAP[request.requestedAction];
  const toolActionCompatible =
    mappedTool !== undefined && mappedTool === request.requestedTool;
  return Object.freeze({
    ok:
      known &&
      versionMatch &&
      enabled &&
      actionAllowed &&
      toolAllowed &&
      toolActionCompatible,
    definition,
    known,
    versionMatch,
    enabled,
    actionAllowed,
    toolAllowed,
    toolActionCompatible,
  });
}

/**
 * Validação estrutural da requisição. Campos críticos obrigatórios, catálogos
 * fechados e valores dentro dos domínios definidos. Default deny.
 */
export function validateRequest(request: AgentRuntimeRequest): {
  ok: boolean;
  reasonCode: (typeof RUNTIME_REASON_CODES)[number];
  field: string | null;
} {
  const nonEmpty = (value: string): boolean => value.trim().length > 0;

  const critical: ReadonlyArray<readonly [() => boolean, string]> = Object.freeze([
    [() => nonEmpty(request.agentId), "agentId"],
    [() => nonEmpty(request.agentVersion), "agentVersion"],
    [() => nonEmpty(request.requestId), "requestId"],
    [() => nonEmpty(request.correlationId), "correlationId"],
    [() => nonEmpty(request.idempotencyKey), "idempotencyKey"],
    [() => nonEmpty(request.inputReference), "inputReference"],
    [() => nonEmpty(request.requestedAt), "requestedAt"],
  ]);

  for (const [check, field] of critical) {
    if (!check()) {
      return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field });
    }
  }

  if (!AGENT_TOOL_CATALOG.includes(request.requestedTool)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "requestedTool" });
  }
  if (!AGENT_ACTION_CATALOG.includes(request.requestedAction)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "requestedAction" });
  }
  if (!isKnownRisk(request.riskContext.requestedRisk)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "riskContext.requestedRisk" });
  }
  if (
    request.riskContext.riskFloor !== null &&
    !isKnownRisk(request.riskContext.riskFloor)
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: "REQUEST_INVALID",
      field: "riskContext.riskFloor",
    });
  }
  if (
    !["operator", "operator-admin", "system"].includes(request.requestedBy)
  ) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "requestedBy" });
  }

  for (const scope of request.memoryScope) {
    if (!AGENT_MEMORY_SCOPE_CATALOG.includes(scope)) {
      return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "memoryScope" });
    }
  }

  if (!isNonNegativeFiniteNumber(request.budgetContext.tokenBudget)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "budgetContext.tokenBudget" });
  }
  if (!isNonNegativeFiniteNumber(request.budgetContext.timeBudgetMs)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "budgetContext.timeBudgetMs" });
  }
  if (!isNonNegativeFiniteNumber(request.budgetContext.toolCallBudget)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "budgetContext.toolCallBudget" });
  }
  if (!isNonNegativeFiniteNumber(request.budgetContext.costBudget)) {
    return Object.freeze({ ok: false, reasonCode: "REQUEST_INVALID", field: "budgetContext.costBudget" });
  }

  return Object.freeze({ ok: true, reasonCode: "REQUEST_VALID", field: null });
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isKnownRisk(value: string): value is AgentRiskLevel {
  return AGENT_RISK_ORDER.includes(value as AgentRiskLevel);
}

/**
 * Memory scope: requested ⊆ allowed. Default deny — qualquer escopo fora do
 * permitido resulta em DENY (SCOPE_NOT_SUBSET). Não cria acesso real ao banco.
 */
export function checkMemoryScope(
  allowed: ReadonlyArray<string>,
  requested: ReadonlyArray<import("../agentRegistry/types").AgentMemoryScope>
): MemoryScopeCheck {
  const denied = requested.filter(scope => !allowed.includes(scope));
  return Object.freeze({ ok: denied.length === 0, deniedScopes: Object.freeze(denied) });
}

/**
 * Budget contract (D-1): 0 = sem orçamento alocado → fail-closed.
 * Nenhum campo zero é aceitável para execução; o runtime reage com DENY
 * (BUDGET_UNALLOCATED) e NUNCA aumenta o budget por conta própria.
 */
export function checkBudget(budget: import("./types").BudgetContract): BudgetCheck {
  if (budget.tokenBudget <= 0) {
    return Object.freeze({ ok: false, exhaustedField: "tokenBudget" });
  }
  if (budget.timeBudgetMs <= 0) {
    return Object.freeze({ ok: false, exhaustedField: "timeBudgetMs" });
  }
  if (budget.toolCallBudget <= 0) {
    return Object.freeze({ ok: false, exhaustedField: "toolCallBudget" });
  }
  if (budget.costBudget <= 0) {
    return Object.freeze({ ok: false, exhaustedField: "costBudget" });
  }
  return Object.freeze({ ok: true, exhaustedField: null });
}

/**
 * O runtime jamais transforma DENY → ALLOW nem REQUIRES_APPROVAL → ALLOW.
 * Esta função é o guardião dessa invariante: uma decisão só pode seguir o
 * fluxo ALLOW → execução planejável; REQUIRES_APPROVAL → approval flow;
 * DENY termina em DENIED.
 */
export function guardDecisionFlow(
  decision: Pick<PolicyDecision, "decision">,
  currentApprovalState: ApprovalDecisionState
): { flowValid: boolean; blocked: boolean } {
  if (decision.decision === "DENY") {
    return Object.freeze({ flowValid: true, blocked: true });
  }
  if (decision.decision === "REQUIRES_APPROVAL") {
    if (currentApprovalState === "APPROVED") {
      return Object.freeze({ flowValid: true, blocked: false });
    }
    if (currentApprovalState === "NOT_REQUIRED" || currentApprovalState === "PENDING") {
      return Object.freeze({ flowValid: true, blocked: true });
    }
    // REJECTED ou EXPIRED bloqueiam; o fluxo exige reavaliação.
    return Object.freeze({ flowValid: true, blocked: true });
  }
  // ALLOW: aprovação não é necessária; estado NOT_REQUIRED.
  if (currentApprovalState === "NOT_REQUIRED") {
    return Object.freeze({ flowValid: true, blocked: false });
  }
  // ALLOW com outro estado de aprovação = inconsistência; default deny.
  return Object.freeze({ flowValid: false, blocked: true });
}

/**
 * Idempotência (contrato): a mesma intenção (mesma idempotency_key) só pode
 * resultar em uma execução legítima. A comparação de intenção usa a chave
 * determinística fornecida pelo chamador — a deduplicação por conteúdo
 * canônico é responsabilidade da camada de persistência (herda o padrão
 * canonicalJson do journal).
 */
export function deriveIntentionKey(parts: {
  agentId: string;
  agentVersion: string;
  requestId: string;
  evaluationId: string;
}): string {
  // Derivação determinística via JSON estável dos campos (mesma ordem sempre).
  const payload = JSON.stringify({
    agentId: parts.agentId,
    agentVersion: parts.agentVersion,
    requestId: parts.requestId,
    evaluationId: parts.evaluationId,
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash << 5) - hash + payload.charCodeAt(i);
    hash |= 0;
  }
  return `int-${Math.abs(hash).toString(36)}-${payload.length.toString(36)}`;
}

/** Validade de estado de aprovação declarado. */
export function isApprovalDecisionState(
  value: string
): value is ApprovalDecisionState {
  return APPROVAL_DECISION_STATES.includes(value as ApprovalDecisionState);
}

/** Validade de estado de lifecycle declarado. */
export function isLifecycleState(value: string): value is ExecutionLifecycleState {
  return EXECUTION_LIFECYCLE_STATES.includes(value as ExecutionLifecycleState);
}

/** Registro do contrato (para auditoria e versionamento). */
export const runtimeContractVersion = AGENT_RUNTIME_CONTRACT_VERSION;
