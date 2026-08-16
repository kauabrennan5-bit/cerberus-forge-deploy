/**
 * Bloco 15 — Fase B — Policy Engine (Avaliador Determinístico).
 *
 * POLICY ENGINE != EXECUTION · POLICY != AUTHORITY · PERMISSION != ACTION ·
 * ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL · MEMORY != AUTHORITY.
 *
 * Este módulo é uma FUNÇÃO PURA: mesma entrada produz sempre a mesma decisão
 * (decision/reason_code/checks). O campo evaluatedAt é informativo e não
 * participa da parte determinística da decisão; um ClockProvider pode ser
 * injetado para testes determinísticos.
 *
 * NÃO executa, não enfileira, não envia, não altera estado, não importa
 * Supabase/Express/Telegram/Operator/jobQueue/lifecycle/autoHeal/LLM.
 *
 * Cadeia de verificações (Fase 0, seção 5, adaptada):
 *   1. request válido (campos obrigatórios e tipos do catálogo)
 *   2. agent existe
 *   3. versões compatíveis (agentVersion + policyVersion)
 *   4. tool permitida (catálogo + agente)
 *   5. action permitida + compatível com tool + piso de risco da action
 *   6. target/memory scope permitidos
 *   7. risco permitido (requestedRisk <= agent.maxRisk)
 *   8. regra de aprovação (Fase 0): REQUIRES_APPROVAL quando a política
 *      determina (RUN_RECOVERY/PUBLISH_PRODUCT) ou approvalState=PENDING.
 *      Na ausência de regra explícita: DENY.
 *   9. agent habilitado (gating operacional; agente pode ser auditado como
 *      contratualmente válido mesmo desligado — o status operacional é o
 *      último filtro antes do ALLOW)
 *   Fallback: qualquer caminho não coberto → DENY (default_deny).
 *
 * Todos os reason codes e checks são declarados em catálogo fechado
 * (types.ts). Este módulo NÃO executa, não enfileira, não envia, não altera
 * estado, não importa Supabase/Express/Telegram/Operator/jobQueue/lifecycle.
 */

import {
  AGENT_ACTION_CATALOG,
  AGENT_ACTION_MIN_RISK,
  AGENT_MEMORY_SCOPE_CATALOG,
  AGENT_RISK_ORDER,
  AGENT_REGISTRY_POLICY_VERSION,
  AGENT_TABLE_CATALOG,
  AGENT_TOOL_CATALOG,
  type AgentActionName,
  type AgentMemoryScope,
  type AgentRiskLevel,
  type AgentTableName,
  type AgentToolName,
} from "../agentRegistry/types";
import { getAgent } from "../agentRegistry/agents";
import { ACTION_TOOL_MAP } from "./toolActionMap";
import {
  ApprovalState,
  ClockProvider,
  POLICY_ENGINE_VERSION,
  PolicyDecision,
  PolicyReasonCode,
  PolicyRequest,
  type PolicyEvaluationChecks,
} from "./types";

function defaultClock(): string {
  return new Date().toISOString();
}

export function riskIndex(risk: AgentRiskLevel): number {
  const index = AGENT_RISK_ORDER.indexOf(risk);
  if (index === -1) {
    throw new Error(`risk_unknown: ${risk}`);
  }
  return index;
}

function fullChecks(result: PolicyEvaluationChecks): PolicyEvaluationChecks {
  return Object.freeze({ ...result });
}

/** Avalia uma solicitação declarativa contra o contrato do agente e a política.
 *  Função pura: nenhuma escrita, nenhuma rede, nenhum estado global mutável. */
export function evaluatePolicy(
  request: PolicyRequest,
  clock: ClockProvider = defaultClock
): PolicyDecision {
  const baseDecision = {
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    policyVersion: request.policyVersion,
    tool: request.tool,
    action: request.action,
    risk: request.risk,
    targetTable: request.targetTable,
    memoryScope: request.memoryScope,
    evaluatedAt: clock(),
    policyEngineVersion: POLICY_ENGINE_VERSION,
  };

  try {
    // ---- 1. request válido -------------------------------------------------
    const checks1: PolicyEvaluationChecks = {
      request: "FAIL",
      agent: "FAIL",
      version: "FAIL",
      enabled: "FAIL",
      tool: "FAIL",
      action: "FAIL",
      scope: "FAIL",
      risk: "FAIL",
    };
    if (
      request.agentId === undefined ||
      request.agentVersion === undefined ||
      request.policyVersion === undefined ||
      request.tool === undefined ||
      request.action === undefined ||
      request.targetTable === undefined ||
      request.risk === undefined ||
      request.memoryScope === undefined
    ) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "REQUEST_INVALID",
        reason: `Request missing required fields; required: agentId, agentVersion, policyVersion, tool, action, targetTable, risk, memoryScope.`,
        checks: fullChecks(checks1),
      };
    }
    if (
      typeof request.agentId !== "string" ||
      request.agentId.length === 0 ||
      typeof request.agentVersion !== "string" ||
      request.agentVersion.length === 0 ||
      typeof request.policyVersion !== "string" ||
      request.policyVersion.length === 0 ||
      typeof request.tool !== "string" ||
      request.tool.length === 0 ||
      typeof request.action !== "string" ||
      request.action.length === 0 ||
      typeof request.targetTable !== "string" ||
      request.targetTable.length === 0 ||
      typeof request.risk !== "string" ||
      request.risk.length === 0 ||
      typeof request.memoryScope !== "string" ||
      request.memoryScope.length === 0
    ) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "REQUEST_INVALID",
        reason: "Request contains empty or non-string required fields.",
        checks: fullChecks(checks1),
      };
    }
    if (
      request.context !== undefined &&
      (typeof request.context !== "string" || request.context.length === 0)
    ) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "CONTEXT_INVALID",
        reason: "Context is invalid: must be a non-empty string when provided.",
        checks: fullChecks(checks1),
      };
    }
    if (
      request.approvalState !== undefined &&
      (["NONE", "PENDING", "APPROVED", "REJECTED", "EXPIRED"] as ApprovalState[]).indexOf(
        request.approvalState
      ) === -1
    ) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "CONTEXT_INVALID",
        reason: `Approval state is invalid: ${String(request.approvalState)}. Valid: NONE, PENDING, APPROVED, REJECTED, EXPIRED.`,
        checks: fullChecks(checks1),
      };
    }
    // Vocabulário de risco fechado: validar ANTES de qualquer uso de riskIndex
    // (checks 5 e 8) para que risco inválido vire REQUEST_INVALID em vez de
    // exceção interna capturada pelo default-deny.
    if (
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].indexOf(String(request.risk)) === -1
    ) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "RISK_UNKNOWN",
        reason: `Risk "${request.risk}" is not in the closed risk vocabulary (LOW|MEDIUM|HIGH|CRITICAL).`,
        checks: fullChecks(checks1),
      };
    }
    checks1.request = "PASS";
    // ---- 2. agent existe ---------------------------------------------------
    const agent = getAgent(request.agentId);
    if (!agent) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "AGENT_NOT_FOUND",
        reason: `Agent "${request.agentId}" is not registered in the agent registry.`,
        checks: fullChecks({ ...checks1, agent: "FAIL" }),
      };
    }
    checks1.agent = "PASS";

    // ---- 3. versões compatíveis (identidade antes do status — evita que
    //         declaração falsa de versão fique atrás do status do agente) -----
    if (request.agentVersion !== agent.version) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "AGENT_VERSION_MISMATCH",
        reason: `Agent "${request.agentId}" declared version "${request.agentVersion}" does not match registered version "${agent.version}". No fallback to latest or previous versions.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "FAIL" }),
      };
    }
    if (request.policyVersion !== AGENT_REGISTRY_POLICY_VERSION) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "POLICY_VERSION_MISMATCH",
        reason: `Declared policy version "${request.policyVersion}" does not match the current registry policy version "${AGENT_REGISTRY_POLICY_VERSION}". No fallback to other versions.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "FAIL" }),
      };
    }
    checks1.version = "PASS";

    // ---- 4. tool permitida -------------------------------------------------
    const declaredTool = request.tool as AgentToolName;
    if (AGENT_TOOL_CATALOG.indexOf(declaredTool) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "TOOL_UNKNOWN",
        reason: `Tool "${request.tool}" is not in the closed tool catalog.`,
        checks: fullChecks({
          ...checks1,
          agent: "PASS",
          version: "PASS",
          tool: "FAIL",
        }),
      };
    }
    if (agent.allowedTools.indexOf(declaredTool) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "TOOL_NOT_ALLOWED",
        reason: `Tool "${request.tool}" is not permitted for agent "${request.agentId}" (allowed: ${agent.allowedTools.join(", ") || "none"}).`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "FAIL" }),
      };
    }
    checks1.tool = "PASS";

    // ---- 6. action permitida + compatível com tool -------------------------
    const declaredAction = request.action as AgentActionName;
    if (AGENT_ACTION_CATALOG.indexOf(declaredAction) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "ACTION_UNKNOWN",
        reason: `Action "${request.action}" is not in the closed action catalog.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "FAIL" }),
      };
    }
    if (agent.allowedActions.indexOf(declaredAction) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "ACTION_NOT_ALLOWED",
        reason: `Action "${request.action}" is not permitted for agent "${request.agentId}" (allowed: ${agent.allowedActions.join(", ") || "none"}).`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "FAIL" }),
      };
    }
    // Compatibilidade tool/action (duplo gate): a action declarada deve
    // pertencer à ÚNICA tool que a realiza.
    if (ACTION_TOOL_MAP[declaredAction] !== declaredTool) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "TOOL_ACTION_MISMATCH",
        reason: `Action "${request.action}" is compatible with tool "${ACTION_TOOL_MAP[declaredAction]}", not with declared tool "${request.tool}".`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "FAIL" }),
      };
    }
    // Risco mínimo da action vs risco solicitado: o risco declarado não pode
    // ser menor que o piso da ação (ação de risco MEDIUM pedida como LOW é spoofing).
    const minActionRisk = AGENT_ACTION_MIN_RISK[declaredAction];
    if (riskIndex(request.risk as AgentRiskLevel) < riskIndex(minActionRisk)) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "ACTION_RISK_MISMATCH",
        reason: `Action "${request.action}" has minimum risk "${minActionRisk}"; requested risk "${request.risk}" is below the action floor.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "FAIL" }),
      };
    }
    checks1.action = "PASS";

    // ---- 7. target/memory scope permitidos ---------------------------------
    const declaredTable = request.targetTable as AgentTableName;
    if (AGENT_TABLE_CATALOG.indexOf(declaredTable) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "TABLE_UNKNOWN",
        reason: `Target table "${request.targetTable}" is not in the closed table catalog. Absence is not a wildcard.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "FAIL" }),
      };
    }
    if (agent.allowedTables.indexOf(declaredTable) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "TABLE_NOT_ALLOWED",
        reason: `Target table "${request.targetTable}" is not permitted for agent "${request.agentId}" (allowed: ${agent.allowedTables.join(", ") || "none"}).`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "FAIL" }),
      };
    }
    const declaredMemoryScope = request.memoryScope as AgentMemoryScope;
    if (AGENT_MEMORY_SCOPE_CATALOG.indexOf(declaredMemoryScope) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "MEMORY_SCOPE_UNKNOWN",
        reason: `Memory scope "${request.memoryScope}" is not in the closed memory scope catalog.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "FAIL" }),
      };
    }
    if (agent.memoryScope.indexOf(declaredMemoryScope) === -1) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "MEMORY_SCOPE_NOT_ALLOWED",
        reason: `Memory scope "${request.memoryScope}" is not permitted for agent "${request.agentId}" (allowed: ${agent.memoryScope.join(", ") || "none"}).`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "FAIL" }),
      };
    }
    checks1.scope = "PASS";
    // ---- 8. risco permitido -------------------------------------------------
    const declaredRisk = request.risk as AgentRiskLevel;
    if (riskIndex(declaredRisk) > riskIndex(agent.maxRisk)) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "RISK_EXCEEDS_MAX",
        reason: `Requested risk "${request.risk}" exceeds agent "${request.agentId}" maximum "${agent.maxRisk}".`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "FAIL" }),
      };
    }
    checks1.risk = "PASS";

    // ---- 8. regra de aprovação (Fase 0) -------------------------------------
    // Regra definida na Fase 0: REQUIRES_APPROVAL quando (a) o approvalState
    // informado é PENDING ou (b) a política determina aprovação obrigatória.
    // Critério de política definido na Fase 0: actions cujo mecanismo
    // existente exige aprovação humana (RUN_RECOVERY exige ADMIN_APPROVAL no
    // safeAutoHealEngine; PUBLISH_PRODUCT exige approve() no pipeline). Na
    // ausência de regra explícita: DENY.
    const requiresApprovalByPolicy =
      declaredAction === "RUN_RECOVERY" || declaredAction === "PUBLISH_PRODUCT";

    if (request.approvalState === "PENDING") {
      return {
        ...baseDecision,
        decision: "REQUIRES_APPROVAL",
        reasonCode: "APPROVAL_REQUIRED",
        reason: `Action "${request.action}" requires human approval; approval is pending. Declarative only — no PendingApproval created, no Telegram sent, no Operator called, no job created, no action executed, no approval persisted.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      };
    }
    if (requiresApprovalByPolicy && request.approvalState !== "APPROVED") {
      return {
        ...baseDecision,
        decision: "REQUIRES_APPROVAL",
        reasonCode: "APPROVAL_REQUIRED",
        reason: `Action "${request.action}" requires human approval per policy; approval state is ${request.approvalState ?? "NONE"}. Declarative only — no PendingApproval created, no Telegram sent, no Operator called, no job created, no action executed, no approval persisted.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      };
    }
    if (request.approvalState === "REJECTED" || request.approvalState === "EXPIRED") {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "APPROVAL_REQUIRED",
        reason: `Action "${request.action}" requires human approval; approval was ${request.approvalState.toLowerCase()}.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS" }),
      };
    }

    // ---- 9. agent habilitado (gating operacional — último filtro) ----------
    // Todos os agentes da Fase A são enabled=false e DRAFT; a avaliação é
    // puramente declarativa. O agente pode ser auditado como contratualmente
    // válido mesmo desligado; o status operacional é o último filtro.
    if (!agent.enabled) {
      return {
        ...baseDecision,
        decision: "DENY",
        reasonCode: "AGENT_DISABLED",
        reason: `Agent "${request.agentId}" is disabled (enabled=false). Declarative status only; no execution occurred.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS", enabled: "FAIL" }),
      };
    }
    checks1.enabled = "PASS";

    // Todos os checks passaram, aprovação atendida quando exigida → ALLOW.
    // ALLOW é uma DECISÃO DECLARATIVA: não executa, não cria job, não publica.
    return {
      ...baseDecision,
      decision: "ALLOW",
      reasonCode: "POLICY_ALLOW",
      reason: `Action "${request.action}" with tool "${request.tool}" on "${request.targetTable}" is within the declared contract of agent "${request.agentId}" and current policy. Declarative only — no execution occurred.`,
        checks: fullChecks({ ...checks1, agent: "PASS", version: "PASS", tool: "PASS", action: "PASS", scope: "PASS", risk: "PASS", enabled: "PASS" }),
    };
  } catch (error) { console.error("CATCH:", error.message, error.stack); 
    // Nenhum caminho deve cair em ALLOW por exceção. Erro interno → DENY.
    return {
      ...baseDecision,
      decision: "DENY",
      reasonCode: "POLICY_ENGINE_ERROR",
      reason: `Policy engine encountered an internal evaluation error; default deny applied.`,
      checks: fullChecks({
        request: "FAIL",
        agent: "FAIL",
        enabled: "FAIL",
        version: "FAIL",
        tool: "FAIL",
        action: "FAIL",
        scope: "FAIL",
        risk: "FAIL",
      }),
    };
  }
}
