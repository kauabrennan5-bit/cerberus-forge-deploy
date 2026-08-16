/**
 * Bloco 16 — Fase A — Contrato do Agent Runtime (tipos puros).
 *
 * MÓDULO DE CONTRATO PURO: sem Supabase, sem Express, sem Telegram,
 * sem Operator runtime, sem Job Queue runtime, sem SafeAutoHeal,
 * sem LLM e sem filesystem. Importa apenas tipos/contratos estáticos
 * da governança existente (Agent Registry e Policy Engine).
 *
 * AGENT != AUTHORITY · LLM != AUTHORITY · MEMORY != AUTHORITY
 * OBSERVATION != FACT CANÔNICO · RECOMMENDATION != ACTION
 */
import type {
  AgentActionName,
  AgentMemoryScope,
  AgentRiskLevel,
  AgentToolName,
} from "../agentRegistry/types";

/** Versão do contrato do Agent Runtime (muda somente com mudança do contrato). */
export const AGENT_RUNTIME_CONTRACT_VERSION = "1.0";

/**
 * Estados de lifecycle de uma execução do runtime.
 *
 * REQUESTED → POLICY_EVALUATED → DENIED (fim)
 *                              → WAITING_APPROVAL → APPROVED → PLANNED → RUNNING →
 *                                  SUCCEEDED | FAILED | TIMED_OUT | CANCELLED
 *                              → (approval REJECTED) → REJECTED (fim)
 *                              → (approval EXPIRED) → EXPIRED (fim)
 */
export type ExecutionLifecycleState =
  | "REQUESTED"
  | "POLICY_EVALUATED"
  | "DENIED"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "PLANNED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

/** Catálogo fechado dos estados de lifecycle. */
export const EXECUTION_LIFECYCLE_STATES: ReadonlyArray<ExecutionLifecycleState> =
  Object.freeze([
    "REQUESTED",
    "POLICY_EVALUATED",
    "DENIED",
    "WAITING_APPROVAL",
    "APPROVED",
    "PLANNED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "TIMED_OUT",
    "CANCELLED",
    "REJECTED",
    "EXPIRED",
  ]);

/** Estados de aprovação humana (herda o catálogo do Policy Engine). */
export type ApprovalDecisionState =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED";

export const APPROVAL_DECISION_STATES: ReadonlyArray<ApprovalDecisionState> =
  Object.freeze(["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED", "EXPIRED"]);

/** Tipos de target aceitos pelo contrato. */
export type ExecutionTargetType =
  | "PRODUCT"
  | "OBSERVATION"
  | "SIGNAL"
  | "JOB"
  | "EVENT"
  | "NONE";

/** Origem autorizada de uma requisição do runtime (D-3: Operator como namespace, sem alterar o registry). */
export type RequestedBy = "operator" | "operator-admin" | "system";

/** Referência a conteúdo de artifact (nunca o conteúdo bruto). */
export type ArtifactContentReference =
  | { kind: "by-ref"; ref: string }
  | { kind: "none" };

/** Proveniência completa de um artifact. */
export interface ArtifactProvenance {
  /** Avaliação de policy que autorizou a origem do conteúdo. */
  evaluationId: string | null;
  /** Identificadores imutáveis dos inputs usados. */
  inputRefs: ReadonlyArray<string>;
  /** Evidências que sustentam a confiança declarada. */
  evidenceRefs: ReadonlyArray<string>;
  /** Agente e versão que produziu. */
  agentId: string;
  agentVersion: string;
}

/** Contrato de orçamento (D-1: 0 = sem orçamento alocado → fail-closed). */
export interface BudgetContract {
  tokenBudget: number;
  timeBudgetMs: number;
  toolCallBudget: number;
  /** 0 = sem orçamento alocado (impossível executar até alocação explícita). */
  costBudget: number;
}

/** Resultado da verificação de orçamento. */
export interface BudgetCheck {
  ok: boolean;
  exhaustedField:
    | "tokenBudget"
    | "timeBudgetMs"
    | "toolCallBudget"
    | "costBudget"
    | null;
}

/** Contrato de memory scope: requested ⊆ allowed, default deny. */
export interface MemoryScopeContract {
  allowed: ReadonlyArray<AgentMemoryScope>;
  requested: ReadonlyArray<AgentMemoryScope>;
}

/** Resultado da verificação de memory scope. */
export interface MemoryScopeCheck {
  ok: boolean;
  deniedScopes: ReadonlyArray<AgentMemoryScope>;
}

/** Estado de approval vinculado ao plan de execução (D-4). */
export interface ApprovalContract {
  approvalId: string | null;
  executionId: string;
  requestId: string;
  agentId: string;
  tool: AgentToolName;
  action: AgentActionName;
  risk: AgentRiskLevel;
  policyEvaluationId: string;
  createdAt: string;
  expiresAt: string | null;
  state: ApprovalDecisionState;
}

/** Contrato de referência a artifact produzido por um agente (D-5: referência, sem storage). */
export interface ArtifactContract {
  artifactId: string | null;
  artifactType: string | null;
  schemaVersion: string;
  agentId: string;
  agentVersion: string;
  createdAt: string | null;
  correlationId: string;
  contentReference: ArtifactContentReference;
  confidence: number | null;
  provenance: ArtifactProvenance;
}

/** Contrato do Tool Adapter (interface — executores reais ficam fora desta fase). */
export interface ToolAdapterContract {
  toolId: AgentToolName;
  version: string;
  supportedActions: ReadonlyArray<AgentActionName>;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  risk: AgentRiskLevel;
}

/** Reexportação de catálogos estáticos da governança (somente leitura). */
export {
  AGENT_MEMORY_SCOPE_CATALOG,
  AGENT_RISK_ORDER,
} from "../agentRegistry/types";
export type {
  AgentActionName,
  AgentDefinition,
  AgentMemoryScope,
  AgentRiskLevel,
  AgentTableName,
  AgentToolName,
} from "../agentRegistry/types";
export type { ApprovalState, PolicyReasonCode } from "../policyEngine/types";
