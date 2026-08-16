/**
 * Bloco 15 — Fase B — Policy Engine (Avaliador Determinístico).
 *
 * Este módulo define APENAS o contrato declarativo da avaliação de política:
 * tipos de entrada/saída, catálogo fechado de reason codes e versão do engine.
 *
 * REGRAS DE CONTRATO:
 * - O engine AVALIA; nunca EXECUTA. ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL.
 * - DEFAULT DENY: qualquer caminho não coberto resulta em DENY.
 * - Reason codes são um catálogo fechado e versionado; nenhum código aberto.
 * - A parte determinística da decisão (decision/reason_code/checks) não depende
 *   de hora, random, estado global mutável, rede, banco ou LLM.
 * - evaluatedAt é informativo e NÃO altera a decisão.
 *
 * Dependencies: somente contratos declarativos da Fase A (server/agentRegistry).
 */

import {
  AgentActionName,
  AgentMemoryScope,
  AgentRiskLevel,
  AgentTableName,
  AgentToolName,
} from "../agentRegistry/types";

/** Decisão possível do Policy Engine (catálogo fechado). */
export type PolicyDecisionValue = "ALLOW" | "DENY" | "REQUIRES_APPROVAL";

/** Reason codes do Policy Engine — catálogo fechado e versionado (POLICY_ENGINE_REASON_CODE_VERSION = "1.0").
 *  Os nomes preservam a terminologia da Fase 0 (BLOCO15_DESIGN_REVIEW.md, seção 5):
 *  agent_unknown, version_mismatch, policy_version_mismatch, action_unknown,
 *  action_not_permitted, risk_exceeds_max, default_deny, approval_required.
 *  Novos códigos da Fase B (exigidos pelo prompt): request_invalid, tool_unknown,
 *  tool_not_allowed, tool_action_mismatch, table_unknown, table_not_allowed,
 *  memory_scope_unknown, memory_scope_not_allowed, action_risk_mismatch,
 *  agent_disabled, context_invalid, policy_engine_error. */
export type PolicyReasonCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_DISABLED"
  | "AGENT_VERSION_MISMATCH"
  | "POLICY_VERSION_MISMATCH"
  | "TOOL_NOT_ALLOWED"
  | "ACTION_NOT_ALLOWED"
  | "TABLE_NOT_ALLOWED"
  | "RISK_EXCEEDS_MAX"
  | "MEMORY_SCOPE_NOT_ALLOWED"
  | "TOOL_ACTION_MISMATCH"
  | "ACTION_RISK_MISMATCH"
  | "APPROVAL_REQUIRED"
  | "CONTEXT_INVALID"
  | "REQUEST_INVALID"
  | "POLICY_ENGINE_ERROR"
  // mapeamento para a terminologia da Fase 0 (usado em explanations compatíveis):
  | "TOOL_UNKNOWN"
  | "ACTION_UNKNOWN"
  | "TABLE_UNKNOWN"
  | "MEMORY_SCOPE_UNKNOWN"
  | "RISK_UNKNOWN"
  | "VERSION_MISMATCH"
  | "AGENT_UNKNOWN"
  | "POLICY_ALLOW";

/** Catálogo fechado de reason codes. */
export const POLICY_REASON_CODE_CATALOG: ReadonlyArray<PolicyReasonCode> = Object.freeze([
  "AGENT_NOT_FOUND",
  "AGENT_DISABLED",
  "AGENT_VERSION_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "TOOL_NOT_ALLOWED",
  "ACTION_NOT_ALLOWED",
  "TABLE_NOT_ALLOWED",
  "RISK_EXCEEDS_MAX",
  "MEMORY_SCOPE_NOT_ALLOWED",
  "TOOL_ACTION_MISMATCH",
  "ACTION_RISK_MISMATCH",
  "APPROVAL_REQUIRED",
  "CONTEXT_INVALID",
  "REQUEST_INVALID",
  "POLICY_ENGINE_ERROR",
  "TOOL_UNKNOWN",
  "ACTION_UNKNOWN",
  "TABLE_UNKNOWN",
  "MEMORY_SCOPE_UNKNOWN",
  "RISK_UNKNOWN",
  "VERSION_MISMATCH",
  "AGENT_UNKNOWN",
  "POLICY_ALLOW",
]);

/** Resultado individual de cada verificação da cadeia de 8. */
export type CheckResult = "PASS" | "FAIL";

/** Resultados das 8 verificações, na ordem da cadeia (Fase 0, seção 5). */
export interface PolicyEvaluationChecks {
  request: CheckResult;
  agent: CheckResult;
  enabled: CheckResult;
  version: CheckResult;
  tool: CheckResult;
  action: CheckResult;
  scope: CheckResult;
  risk: CheckResult;
}

/** Estado declarativo de aprovação humana — somente leitura, NÃO cria
 *  PendingApproval, NÃO chama Operator, NÃO persiste (Fase B). */
export type ApprovalState = "NONE" | "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

/** Requisição de avaliação de política. Solicitação DECLARATIVA; não executa nada. */
export interface PolicyRequest {
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  tool: AgentToolName | string;
  action: AgentActionName | string;
  targetTable: AgentTableName | string;
  risk: AgentRiskLevel | string;
  memoryScope: AgentMemoryScope | string;
  /** Contexto opcional e explicável da solicitação (descrição determinística). */
  context?: string;
  /** Estado de aprovação humana quando a ação exige aprovação (Fase B: só leitura). */
  approvalState?: ApprovalState;
}

/** Decisão estruturada e explicável do Policy Engine. */
export interface PolicyDecision {
  decision: PolicyDecisionValue;
  reasonCode: PolicyReasonCode;
  /** Explicação determinística, sem texto gerado por LLM, sem "provavelmente". */
  reason: string;
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  tool: string;
  action: string;
  risk: string;
  targetTable: string;
  memoryScope: string;
  checks: PolicyEvaluationChecks;
  /** Timestamp informativo; NÃO participa da parte determinística da decisão. */
  evaluatedAt: string;
  /** Versão do Policy Engine que produziu a decisão. */
  policyEngineVersion: string;
}

/** Injeção opcional de relógio para testes determinísticos.
 *  Production callers usam o relógio real; testes injetam timestamp fixo. */
export type ClockProvider = () => string;

/** Versão do Policy Engine (versionamento semântico congelado, padrão Bloco 14). */
export const POLICY_ENGINE_VERSION = "1.0";

/** Versão do catálogo de reason codes (muda APENAS quando o catálogo mudar). */
export const POLICY_ENGINE_REASON_CODE_VERSION = "1.0";
