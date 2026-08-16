/**
 * Bloco 16 — Fase A — Contratos formais do Agent Runtime.
 *
 * AgentRuntimeRequest, ExecutionPlan, ExecutionResult, ExecutionIntent e
 * PolicyDecisionRecord. Tudo é dado; nenhuma execução, nenhuma ferramenta,
 * nenhuma persistência. O runtime NÃO possui autoridade própria: a autoridade
 * continua Agent Registry + Policy Engine + Operator/Approval + Job Queue.
 */
import type {
  AgentActionName,
  AgentDefinition,
  AgentMemoryScope,
  AgentRiskLevel,
  AgentTableName,
  AgentToolName,
} from "../agentRegistry/types";
import type { PolicyDecisionValue, PolicyReasonCode } from "../policyEngine/types";
import type {
  ApprovalContract,
  ArtifactContract,
  BudgetContract,
  ExecutionLifecycleState,
  RequestedBy,
  ExecutionTargetType,
} from "./types";

/**
 * Requisição formal do Agent Runtime. Nenhum campo crítico é opcional.
 *
 * - agent_id arbitrário fora do Registry é rejeitado na validação (IDENTITY).
 * - requested_by é o namespace do Operator (D-3): sem alterar o registry.
 * - memory_scope declarado é o escopo que a execução PEDIRÁ (não o permitido);
 *   a validação exige requested ⊆ allowed.
 */
export interface AgentRuntimeRequest {
  agentId: string;
  agentVersion: string;
  requestId: string;
  correlationId: string;
  /** Derivado de agentId+agentVersion+request+evaluationId — única intenção = única execução. */
  idempotencyKey: string;
  requestedAction: AgentActionName;
  requestedTool: AgentToolName;
  targetType: ExecutionTargetType;
  /** Id do recurso-alvo (ref de produto, observation id, job id etc.), vazio quando NONE. */
  targetId: string;
  /**
   * Tabela-alvo explícita (extensão da Fase C). Quando declarada, é validada
   * contra AGENT_TABLE_CATALOG + allowedTables do agente; quando ausente e a
   * tabela canônica da action for unívoca para o agente, é derivada
   * deterministicamente. Ausência ambígua é rejeitada (default deny).
   */
  targetTable?: import("../agentRegistry/types").AgentTableName;
  /** Referência ao input (nunca o input bruto). */
  inputReference: string;
  memoryScope: ReadonlyArray<AgentMemoryScope>;
  requestedAt: string;
  requestedBy: RequestedBy;
  riskContext: {
    requestedRisk: AgentRiskLevel;
    riskFloor: AgentRiskLevel | null;
  };
  budgetContext: BudgetContract;
  approvalContext: {
    requiresApproval: boolean;
    approvalId: string | null;
  };
}

/**
 * Registro da decisão consumida do Policy Engine. O runtime nunca transforma
 * DENY → ALLOW nem REQUIRES_APPROVAL → ALLOW.
 */
export interface PolicyDecisionRecord {
  decision: PolicyDecisionValue;
  reasonCode: PolicyReasonCode;
  reason: string;
  risk: AgentRiskLevel;
  policyVersion: string;
  agentVersion: string;
  tool: AgentToolName;
  action: AgentActionName;
  evaluationId: string;
  timestamp: string;
}

/**
 * ExecutionPlan: artefato de intenção autorizada depois da análise de policy.
 * NÃO executa nada.
 */
export interface ExecutionPlan {
  /** Id determinístico/seguro da execução (extensão do contrato na Fase C). */
  executionId: string;
  /** Chave de intenção: mesma intenção = mesma identidade de execução. */
  intentionKey: string;
  requestId: string;
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  tool: AgentToolName;
  action: AgentActionName;
  risk: AgentRiskLevel;
  approvalState: ApprovalContract["state"];
  inputReference: string;
  outputSchemaVersion: string;
  budget: BudgetContract;
  createdAt: string;
  correlationId: string;
  /** Lifecycle state corrente do plano (máquina fechada da Fase A). */
  lifecycleState: ExecutionLifecycleState;
  /** Requisito de aprovação declarado pelo engine (NOT_REQUIRED / REQUIRED). */
  approvalRequirement: "NOT_REQUIRED" | "REQUIRED";
  /** Digest determinístico do input (nunca o input bruto). */
  inputFingerprint: string;
  /** Versão do schema do plano (extensão do contrato na Fase C). */
  schemaVersion: string;
}

/**
 * ExecutionResult: fecha o loop iniciado pelo Decision Journal (D-8: o
 * fechamento com execution_id será escrito no journal por fase futura;
 * aqui o contrato apenas define o artefato).
 */
export interface ExecutionResult {
  /** Execution id determinístico/seguro. */
  executionId: string;
  requestId: string;
  agentId: string;
  tool: AgentToolName;
  action: AgentActionName;
  status: ExecutionLifecycleState;
  startedAt: string | null;
  finishedAt: string | null;
  /** Referência determinística ao resultado (job id / artifact id / none). */
  resultReference: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  correlationId: string;
}

/**
 * ExecutionIntent: intenção de execução validada e pronta para ser entregue
 * a um executor futuro (fora desta fase). Carrega o plan + a decisão.
 */
export interface ExecutionIntent {
  plan: ExecutionPlan;
  decision: PolicyDecisionRecord;
  request: AgentRuntimeRequest;
}

/** Transição de lifecycle com horário; default deny para transições inválidas. */
export interface LifecycleTransition {
  from: ExecutionLifecycleState;
  to: ExecutionLifecycleState;
  at: string;
  requestedBy: RequestedBy;
}

/**
 * Visão de execução completa para auditoria. Responde a todas as perguntas
 * de proveniência (seção 12 do design review) sem depender de logs livres.
 */
export interface ExecutionAuditView {
  state: ExecutionLifecycleState;
  request: AgentRuntimeRequest;
  plan: ExecutionPlan | null;
  decision: PolicyDecisionRecord | null;
  approval: ApprovalContract | null;
  result: ExecutionResult | null;
  artifact: ArtifactContract | null;
  transitions: ReadonlyArray<LifecycleTransition>;
}

/** Registro imutável de validação de schema por artifact_type (D-7). */
export interface ArtifactSchemaValidation {
  artifactType: string;
  schemaVersion: string;
  valid: boolean;
  rejectedFields: ReadonlyArray<string>;
}

/** Registro de agente validado contra o registry (identidade determinística). */
export interface AgentIdentityCheck {
  ok: boolean;
  definition: AgentDefinition | undefined;
  /** Agente conhecido? */
  known: boolean;
  /** Versão bate com o registry? */
  versionMatch: boolean;
  /** Agente habilitado? */
  enabled: boolean;
  /** Action no allowedActions do registry? */
  actionAllowed: boolean;
  /** Tool no allowedTools do registry? */
  toolAllowed: boolean;
  /** Tool/action compatível com o ACTION_TOOL_MAP? */
  toolActionCompatible: boolean;
}

/**
 * RuntimeResult: resultado estruturado do Runtime (Fase C).
 * NUNCA retorna SUCCEEDED se nada foi executado.
 */
export interface RuntimeResult {
  executionId: string;
  intentionKey: string;
  decision: PolicyDecisionValue;
  lifecycleState: ExecutionLifecycleState;
  policyEvaluation: PolicyDecisionRecord | null;
  executionPlan: ExecutionPlan | null;
  reason: string;
  reasonCode: string;
  deterministic: boolean;
  executorStatus: "NOT_CONNECTED" | "SKIPPED" | "EXECUTED";
  correlationId: string;
}

export type { AgentActionName, AgentRiskLevel, AgentTableName, AgentToolName };
