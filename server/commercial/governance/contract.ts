/**
 * Bloco N15 — Aprovação + Execução Governada
 * Contrato versionado: governance_v1
 *
 * N15 autoriza; N15 NÃO executa.
 *
 * N15 transforma o resultado do N14 (avaliação comercial) em uma
 * GOVERNANCE DECISION sobre o que pode ou não avançar para execução.
 *
 * Regras centrais:
 * - N13 = qualidade estrutural; N14 = atratividade comercial;
 *   N15 = autorização governada.
 * - Fail-closed: qualquer requisito ausente, inconsistente, expirado,
 *   não autorizado ou não comprovado → BLOCKED/REVIEW — nunca APPROVED
 *   por inferência.
 * - A decisão é DERIVADA pelo servidor. Nunca aceitar approved=true,
 *   is_actionable=true ou recommendation textual vindos do cliente.
 * - APPROVED nesta fase significa apenas "esta ação está autorizada";
 *   NÃO significa "execute a ação".
 * - O fluxo obrigatório permanece: CANDIDATE → N13 PASS → N14 válido →
 *   N15 policy evaluation → GOVERNANCE DECISION.
 */

export const GOVERNANCE_CONTRACT_VERSION = "governance_v1";

// ==========================================================================
// Ações governadas — catálogo versionado.
// São DECLARAÇÕES de intenção nesta fase; N15 não executa nenhuma delas.
// ==========================================================================

export const GOVERNANCE_ACTIONS = [
  "PUBLISH",
  "ACQUIRE_AFFILIATE",
  "DISTRIBUTE",
  "ADVERTISE",
] as const;
export type GovernanceAction = (typeof GOVERNANCE_ACTIONS)[number];

export function isGovernanceAction(value: unknown): value is GovernanceAction {
  return (
    typeof value === "string" &&
    (GOVERNANCE_ACTIONS as ReadonlyArray<string>).includes(value)
  );
}

// ==========================================================================
// Status da decisão — três estados, sem quarto status sem necessidade.
// ==========================================================================

export const GOVERNANCE_STATUSES = ["APPROVED", "REVIEW", "BLOCKED"] as const;
export type GovernanceStatus = (typeof GOVERNANCE_STATUSES)[number];

export function isGovernanceStatus(value: unknown): value is GovernanceStatus {
  return (
    typeof value === "string" &&
    (GOVERNANCE_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

// ==========================================================================
// Reason codes — determinísticos e versionados.
// ==========================================================================

export const GOVERNANCE_REASON_CODES = [
  // requisitos satisfeitos
  "all_requirements_met",
  // falhas de gate (fail-closed)
  "candidate_missing",
  "candidate_id_invalid",
  "n13_assessment_missing",
  "n13_verdict_not_pass",
  "n14_assessment_missing",
  "n14_score_invalid",
  "n14_band_invalid",
  "score_out_of_range",
  "evidence_insufficient",
  "provenance_invalid",
  "risk_unacceptable",
  "assessment_stale",
  "score_at_least_min",
  "publish_previously_authorized",
  "channel_allowed",
  "explicit_authorization_scope",
  "conflicting_state",
  "action_not_allowed",
  "operator_authorization_missing",
  "unknown_action",
  "unknown_policy",
  "internal_error",
] as const;
export type GovernanceReasonCode = (typeof GOVERNANCE_REASON_CODES)[number];

// ==========================================================================
// Contexto de autorização — estabelecido e validado pelo servidor.
// O cliente pode enviar um authorization_context, mas o servidor ignora
// qualquer conteúdo e estabelece o próprio (fail-closed na ausência).
// ==========================================================================

export interface AuthorizationContext {
  actor_type: "admin" | "operator";
  actor_id: string;
  authorization_source: "admin_password";
  authorization_scope: GovernanceAction[];
}

// ==========================================================================
// Fonte das avaliações de origem (referências, nunca cópias).
// ==========================================================================

export interface GovernanceSourceAssessments {
  n13: {
    assessment_id: string;
    verdict: string;
    digest: string;
    confidence: number | null;
  } | null;
  n14: {
    assessment_id: string;
    band: string;
    score: number | null;
    digest: string;
    classification_basis: string;
  } | null;
}

// ==========================================================================
// Decisão de governança.
// ==========================================================================

export interface GovernanceDecision {
  decision_id: string;
  candidate_id: string;
  action: GovernanceAction;
  status: GovernanceStatus;
  policy_version: string;
  decision_digest: string;
  decided_at: string;
  expires_at: string | null;
  reasons: Array<{ code: GovernanceReasonCode; message: string }>;
  requirements: Array<{
    requirement: string;
    satisfied: boolean;
    detail: string | null;
  }>;
  evidence_refs: string[];
  risk_flags: Array<{ flag: string; severity: "low" | "medium" | "high" }>;
  authorization_context: AuthorizationContext | null;
  source_assessments: GovernanceSourceAssessments;
}

// ==========================================================================
// Requisito de política — declaração declarativa no registry.
// ==========================================================================

export interface PolicyRequirementSpec {
  /** Nome canônico do requisito (chave ordenável do registry). */
  requirement: string;
  /** Requisito é obrigatório para esta ação? */
  required: boolean;
  /** Threshold específico por ação, se aplicável (ex.: min_score). */
  threshold?: Record<string, number | string>;
  /** Descrição humana do requisito. */
  description: string;
}

export interface ActionPolicySpec {
  action: GovernanceAction;
  /** Requisito que bloqueia imediatamente (hard gate). */
  hard_gates: string[];
  /** Requisitos verificáveis desta ação. */
  requirements: PolicyRequirementSpec[];
  /** TTL (horas) de freshness das avaliações de origem. */
  n13_ttl_hours: number;
  n14_ttl_hours: number;
  /** Score mínimo (0..1) para APPROVED nesta ação. */
  min_score: number;
  /** Risco máximo aceitável (0..1). */
  max_risk: number;
  /** Status quando assessment de origem está stale. */
  stale_status: "REVIEW" | "BLOCKED";
}

export interface GovernancePolicyRegistry {
  version: string;
  actions: Record<GovernanceAction, ActionPolicySpec>;
  /** Requisito padrão aplicado a todas as ações. */
  base_requirements: string[];
}
