// ============================================================================
// Bloco N9 — Contrato do Ciclo Comercial + Commercial Decision Gate v1.
// O N9 é ORQUESTRADOR: não substitui, duplica nem reinterpreta nenhum bloco.
// Toda etapa invoca o serviço/contrato existente dos Blocos N1–N8.
//
// Fronteiras de governança (imutáveis por contrato):
//   CANDIDATE != FACT CANÔNICO    (registro N1 não toca products)
//   ASSESSMENT != ACTION          (N4 classifica; decisão é separada)
//   ACQUISITION != REGISTRATION   (N8 grava DRAFT/UNVALIDATED no N6)
//   REGISTRATION != PUBLICATION   (resolver N7 só fornece dados)
//   DECISION != ACTION            (documento ≠ execução; só o executor N5 executa)
//   UNKNOWN != CONFIRMED          (nenhum UNKNOWN é convertido)
//   IDENTITY_UNCERTAIN != CONFIRMED (never converter; sempre bloquear)
//
// REGRAS ABSOLUTAS:
//   - o N9 NUNCA escreve em products (só o executor N5 cria produto canônico);
//   - o N9 NUNCA chama /promote, promoteToProduct ou funções legadas;
//   - o N9 NUNCA transforma recommendation em action (gate intermediário);
//   - o N9 NUNCA inventa valores ausentes (UNKNOWN permanece explícito);
//   - o N9 NUNCA registra credenciais, tokens ou secrets (somente IDs e códigos).
// ============================================================================

// Versão do contrato do ciclo (migration + serviço).
export const CYCLE_CONTRACT_VERSION = "n9-cycle-v1" as const;
// Versão do documento de decisão (decision version).
export const DECISION_VERSION = "commercial_decision_v1" as const;
// Versão do decision gate (regras nomeadas).
export const DECISION_GATE_VERSION = "commercial_decision_v1" as const;

// ---------------------------------------------------------------------------
// Máquina de estados do ciclo (S1–S8 + decisão + execução)
// ---------------------------------------------------------------------------
export const CYCLE_STATUSES = [
  "OPEN",
  "S1_DISCOVERY",
  "S2_CANDIDATE",
  "S3_RESEARCH",
  "S4_ASSESSMENT",
  "S5_ACQUISITION",
  "S6_RESOLUTION",
  "S7_DECISION",
  "S8_PUBLICATION",
  "DECISION_ALLOWED",
  "DECISION_BLOCKED",
  "EXECUTED",
  "EXECUTION_FAILED",
  "FAILED",
  "CLOSED",
] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const CYCLE_STAGES = [
  "DISCOVERY",
  "CANDIDATE",
  "RESEARCH",
  "ASSESSMENT",
  "ACQUISITION",
  "RESOLUTION",
  "DECISION",
  "PUBLICATION",
] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];

// Catálogo fechado de marketplaces do N2 (alinhado a MarketplaceSource).
export const CYCLE_MARKETPLACES = ["mercadolivre", "shopee"] as const;
export type CycleMarketplace = (typeof CYCLE_MARKETPLACES)[number];

// ---------------------------------------------------------------------------
// Blocking rules nomeadas (commercial_decision_v1)
// ---------------------------------------------------------------------------
export const BLOCKING_RULES = [
  "BLOCK_NO_ACTION",
  "BLOCK_CONTRADICTION",
  "BLOCK_COLLECTION_FAILED",
  "BLOCK_UNKNOWN_CRITICAL",
  "BLOCK_IDENTITY_UNCERTAIN",
  "BLOCK_AFFILIATE_MISSING",
  "BLOCK_NOT_APPROVED",
  "BLOCK_RESOLUTION_ERROR",
] as const;
export type BlockingRule = (typeof BLOCKING_RULES)[number];

// Rules nomeadas que o gate declara como passadas (para rastreabilidade).
export const PASSED_RULES = [
  "PASS_RECOMMENDATION_ACTIONABLE",
  "PASS_CONTRADICTIONS_CLEAR",
  "PASS_COLLECTION_OK",
  "PASS_UNKNOWN_CRITICAL_CLEAR",
  "PASS_IDENTITY_CONFIRMED",
  "PASS_AFFILIATE_LINK_AVAILABLE",
  "PASS_CANDIDATE_APPROVED",
  "PASS_QUERIES_OK",
] as const;
export type PassedRule = (typeof PASSED_RULES)[number];

// ---------------------------------------------------------------------------
// Documento de decisão
// ---------------------------------------------------------------------------
export const DECISION_OUTCOMES = ["DECISION_ALLOWED", "DECISION_BLOCKED"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface CycleDecisionDocument {
  readonly decisionId: string;
  readonly cycleId: string;
  readonly candidateId: string;
  readonly decision: DecisionOutcome;
  readonly decisionVersion: string;
  readonly blockingRules: ReadonlyArray<BlockingRule>;
  readonly passedRules: ReadonlyArray<PassedRule>;
  readonly assessmentId: string | null;
  readonly classification: string | null;
  readonly recommendation: string | null;
  readonly priority: string | null;
  readonly unknownsCount: number;
  readonly contradictionsCount: number;
  readonly collectionFailed: boolean;
  readonly identityConfidence: string | null;
  readonly resolutionStatus: string | null;
  readonly priceState: string | null;
  readonly affiliateState: string | null;
  readonly requireAffiliateLink: boolean;
  readonly rationale: string;
  readonly inputDigest: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Resultado consolidado do gate (entrada de dados — sem score novo)
// ---------------------------------------------------------------------------
export interface GateInput {
  readonly candidateId: string;
  readonly candidateStatus: string | null;
  readonly recommendation: string | null;
  readonly classification: string | null;
  readonly priority: string | null;
  readonly unknownsCount: number;
  readonly unknownCriticalPrice: boolean;
  readonly unknownCriticalTitle: boolean;
  readonly contradictionsCount: number;
  readonly collectionFailed: boolean;
  readonly identityConfidence: string | null;
  readonly resolutionStatus: string | null;
  readonly requireAffiliateLink: boolean;
  readonly resolutionError: boolean;
  readonly errorReason: string | null;
}

export interface GateDecision {
  readonly outcome: DecisionOutcome;
  readonly blockingRules: ReadonlyArray<BlockingRule>;
  readonly passedRules: ReadonlyArray<PassedRule>;
  readonly rationale: string;
  readonly ruleNotes: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Resultados de etapas do ciclo (discriminated unions — fail-closed)
// ---------------------------------------------------------------------------
export type StageResult =
  | { readonly stage: CycleStage; readonly ok: true; readonly result: string; readonly evidenceRef: string; readonly blockingCode?: string | null; readonly rationale?: string; readonly detail?: Readonly<Record<string, unknown>> }
  | { readonly stage: CycleStage; readonly ok: false; readonly result: string; readonly blockingCode: string | null; readonly rationale: string; readonly evidenceRef: string; readonly recoverable?: boolean };

export interface CycleTransitionRequest {
  readonly cycleId: string;
  readonly stage: CycleStage;
  readonly input: Readonly<Record<string, unknown>>;
}

export type CycleStepResult = {
  ok: boolean;
  stage: CycleStage;
  status: CycleStatus;
  result: string;
  evidenceRef: string;
  blockingCode: string | null;
  rationale: string;
  detail?: Readonly<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Estado consolidado de um ciclo (consulta render-only)
// ---------------------------------------------------------------------------
export interface CycleStateSummary {
  readonly cycleId: string;
  readonly status: CycleStatus;
  readonly marketplace: CycleMarketplace;
  readonly sourceUrl: string;
  readonly candidateId: string | null;
  readonly researchId: string | null;
  readonly assessmentId: string | null;
  readonly acquisitionRef: string | null;
  readonly affiliateLinkId: string | null;
  readonly resolutionStatus: string | null;
  readonly decisionId: string | null;
  readonly decision: DecisionOutcome | null;
  readonly blockingRules: ReadonlyArray<BlockingRule>;
  readonly executionId: string | null;
  readonly productId: string | null;
  readonly steps: ReadonlyArray<{
    readonly stage: CycleStage;
    readonly result: string;
    readonly blockingCode: string | null;
    readonly rationale: string;
    readonly createdAt: string;
  }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}
