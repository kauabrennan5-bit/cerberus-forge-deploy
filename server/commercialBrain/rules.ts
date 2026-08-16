/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Regras de decisão (FASE A).
 *
 * Aplica os critérios objetivos aprovados para transformar sinais em
 * oportunidades/risks e produzir recomendações. Nenhuma função executa
 * a suggested_action; RECOMMENDATION != ACTION.
 */
import {
  assertCleanCommercialVocabulary,
  Opportunity,
  OpportunityStatus,
  OPPORTUNITY_SIGNAL_TYPES,
  RISK_SIGNAL_TYPES,
  RiskFinding,
  RiskStatus,
  Evidence,
  EvidenceModelVersion,
  EVIDENCE_MODEL_VERSION,
  Recommendation,
  RecommendationCost,
  RecommendationImpact,
  RecommendationRisk,
  RecommendationType,
  REVIEW_DEADLINE_HOURS,
  Signal,
  validateArtifactId,
} from "./types";
import {
  categoryOf,
  computePriority,
  deriveConfidence,
  reviewDeadlineMs,
} from "./formulas";
import type { PriorityBreakdown } from "./types";

export { categoryOf };

// ============================================================================
// Oportunidade — critérios objetivos (seção 8 do Design Review)
// ============================================================================
export const OPPORTUNITY_MIN_RECORDS_DEFAULT = 2;
export const OPPORTUNITY_FRESHNESS_DAYS = 7;

export interface OpportunityDecisionInput {
  signal: Signal;
  lastEvidenceAgeDays: number;
}

/**
 * Critérios V1: sinal do catálogo de oportunidades + N registros +
 * baseline declarado quando exigido + confidence HIGH/MEDIUM + recência ok.
 * O sinal PRICE_BELOW_CANONICAL é a exceção honesta: 1 observação válida
 * basta, pois a referência é o preço canônico (sempre presente).
 */
export function decideOpportunity(input: OpportunityDecisionInput): {
  qualified: boolean;
  status: OpportunityStatus;
  criteria: string[];
} {
  const { signal } = input;
  const criteria: string[] = [];

  const isOpportunityType = OPPORTUNITY_SIGNAL_TYPES.includes(signal.signalType);
  if (!isOpportunityType) {
    return { qualified: false, status: "PARKED", criteria: ["signal_type fora do catálogo de oportunidades"] };
  }

  const minRecords =
    signal.signalType === "PRICE_BELOW_CANONICAL" ? 1 : OPPORTUNITY_MIN_RECORDS_DEFAULT;
  const enoughEvidence = signal.evidenceRefs.reduce(
    (sum, ref) => sum + ref.sourceIds.length,
    0,
  ) >= minRecords;
  if (!enoughEvidence) {
    return {
      qualified: false,
      status: "PARKED",
      criteria: [`registros insuficientes (${minRecords} exigidos)`],
    };
  }

  const confidenceOk =
    signal.confidence === "HIGH" || signal.confidence === "MEDIUM";
  if (!confidenceOk) {
    return {
      qualified: false,
      status: "PARKED",
      criteria: [`confidence ${signal.confidence} (exigido HIGH/MEDIUM)`],
    };
  }

  const recent = input.lastEvidenceAgeDays <= OPPORTUNITY_FRESHNESS_DAYS;
  if (!recent) {
    return {
      qualified: false,
      status: "PARKED",
      criteria: [`evidência com ${input.lastEvidenceAgeDays.toFixed(0)}d > ${OPPORTUNITY_FRESHNESS_DAYS}d`],
    };
  }

  criteria.push(
    `signal_type ${signal.signalType} no catálogo`,
    `>= ${minRecords} registros de evidência`,
    `confidence ${signal.confidence} (HIGH/MEDIUM)`,
    `recência <= ${OPPORTUNITY_FRESHNESS_DAYS}d (${input.lastEvidenceAgeDays.toFixed(0)}d)`,
  );
  return { qualified: true, status: "ACTIVE", criteria };
}

export function buildOpportunity(params: {
  opportunityId: string;
  signal: Signal;
  lastEvidenceAgeDays: number;
  now: () => string;
}): Opportunity | null {
  const { signal } = params;
  const decision = decideOpportunity({
    signal,
    lastEvidenceAgeDays: params.lastEvidenceAgeDays,
  });
  if (!decision.qualified) return null;
  if (signal.productId === null) return null;

  return {
    opportunityId: params.opportunityId,
    signalId: signal.signalId,
    signalType: signal.signalType,
    productId: signal.productId,
    productRef: signal.productRef || signal.productId,
    evidenceRefs: signal.evidenceRefs,
    confidence: signal.confidence,
    confidenceBasis: signal.confidenceBasis,
    priority: computePriorityBreakdownFromSignal(signal),
    status: decision.status as OpportunityStatus,
    createdAt: params.now(),
    criteria: decision.criteria,
  };
}

// ============================================================================
// Risco — critérios simétricos (seção 9 do Design Review)
// ============================================================================
export const RISK_FRESHNESS_DAYS = 7;

export interface RiskDecisionInput {
  signal: Signal;
  lastEvidenceAgeDays: number;
}

export function decideRisk(input: RiskDecisionInput): {
  qualified: boolean;
  status: RiskStatus;
  criteria: string[];
} {
  const { signal } = input;
  const criteria: string[] = [];

  const isRiskType = RISK_SIGNAL_TYPES.includes(signal.signalType);
  if (!isRiskType) {
    return { qualified: false, status: "RETIRED", criteria: ["signal_type fora do catálogo de riscos"] };
  }

  const hasEvidence = signal.evidenceRefs.some((ref) => ref.sourceIds.length >= 1);
  if (!hasEvidence && signal.signalType !== "OBSERVATION_STALE") {
    return { qualified: false, status: "RETIRED", criteria: ["sem evidência mínima de 1 registro"] };
  }

  const freshnessLimit =
    signal.signalType === "OBSERVATION_STALE" ? Infinity : RISK_FRESHNESS_DAYS;
  const recent = input.lastEvidenceAgeDays <= freshnessLimit;
  if (!recent && signal.signalType !== "OBSERVATION_STALE") {
    return {
      qualified: false,
      status: "RETIRED",
      criteria: [`evidência com ${input.lastEvidenceAgeDays.toFixed(0)}d > ${RISK_FRESHNESS_DAYS}d`],
    };
  }

  criteria.push(
    `signal_type ${signal.signalType} no catálogo de riscos`,
    signal.signalType === "OBSERVATION_STALE"
      ? "risco de manutenção por evidência desatualizada (não significa produto indisponível)"
      : ">= 1 registro de evidência",
  );
  if (signal.confidence === "LOW") {
    criteria.push("confidence LOW mantida com confidence_basis obrigatório");
  }
  return { qualified: true, status: "ACTIVE", criteria };
}

export function buildRisk(params: {
  riskId: string;
  signal: Signal;
  lastEvidenceAgeDays: number;
  now: () => string;
}): RiskFinding | null {
  const { signal } = params;
  const decision = decideRisk({ signal, lastEvidenceAgeDays: params.lastEvidenceAgeDays });
  if (!decision.qualified) return null;
  if (signal.productId === null) return null;

  return {
    riskId: params.riskId,
    signalId: signal.signalId,
    signalType: signal.signalType,
    productId: signal.productId,
    productRef: signal.productRef || signal.productId,
    evidenceRefs: signal.evidenceRefs,
    confidence: signal.confidence,
    confidenceBasis: signal.confidenceBasis,
    priority: computePriorityBreakdownFromSignal(signal),
    status: decision.status as RiskStatus,
    createdAt: params.now(),
    criteria: decision.criteria,
  };
}

// ============================================================================
// Recomendação — artefato estruturado, sem execução
// ============================================================================
export interface BuildRecommendationParams {
  recommendationId: string;
  signal: Signal;
  evidence: Evidence[];
  lastEvidenceAgeDays: number;
  now: () => string;
}

export function buildRecommendation(params: BuildRecommendationParams): Recommendation {
  const { signal, evidence } = params;
  const priority = computePriorityBreakdownFromSignal(signal);

  const type: RecommendationType =
    signal.signalType === "OBSERVATION_STALE"
      ? "maintenance"
      : OPPORTUNITY_SIGNAL_TYPES.includes(signal.signalType)
        ? "opportunity"
        : priority.level === "NO_ACTION"
          ? "maintenance"
          : "risk";

  const impact = impactLevelFromCategory(categoryOf(signal.signalType));
  const cost: RecommendationCost = "LOW";
  const risk: RecommendationRisk =
    signal.signalType === "PRICE_OUTLIER" || signal.signalType === "SOURCE_DIVERGENCE"
      ? "MEDIUM"
      : "LOW";

  const suggestedAction = defaultSuggestedAction(signal);
  const vocabularyChecks = [
    assertCleanCommercialVocabulary(suggestedAction),
    assertCleanCommercialVocabulary(signal.confidenceBasis),
    assertCleanCommercialVocabulary(signal.baselineValue),
    assertCleanCommercialVocabulary(signal.currentValue),
    assertCleanCommercialVocabulary(signal.delta),
  ];
  const violated = vocabularyChecks.find((c) => !c.ok);
  if (violated && !violated.ok) {
    throw new Error(
      `Recomendação contém vocabulário comercial não sustentado: "${violated.found}"`,
    );
  }

  const reviewDeadlineMs_ = reviewDeadlineMs(priority.level);
  const deadline = new Date(new Date(params.now()).getTime() + reviewDeadlineMs_);

  return {
    recommendationId: params.recommendationId,
    analysisVersion: signal.analysisVersion,
    scoringVersion: priority.modelVersion,
    confidenceVersion: "confidence_model_v1",
    subject: signal.productId || "portfolio",
    subjectRef: signal.productRef || signal.productId || "portfolio",
    type,
    category: signal.signalType,
    suggestedAction,
    evidence,
    confidence: signal.confidence,
    confidenceBasis: signal.confidenceBasis,
    impact,
    cost,
    risk,
    priorityScore: priority.score,
    priority: priority.level,
    baselineStatement: signal.baselineValue,
    reviewDeadline: deadline.toISOString(),
    createdAt: params.now(),
  };
}

export function defaultSuggestedAction(signal: Signal): string {
  const ref = signal.productRef || signal.productId || signal.signalId;
  switch (signal.signalType) {
    case "PRICE_IMPROVEMENT":
      return `considerar destacar ${ref}: preço observado melhor que a referência na janela declarada.`;
    case "PRICE_BELOW_CANONICAL":
      return `revisar destaque editorial de ${ref}: observação abaixo do preço canônico.`;
    case "PRICE_DETERIORATION":
      return `auditar a evolução de preço de ${ref}: sinal de deterioração na janela declarada.`;
    case "PRICE_OUTLIER":
      return `verificar plausibilidade do preço de ${ref} antes de qualquer ação: outlier sem confirmação.`;
    case "AVAILABILITY_IMPROVEMENT":
      return `considerar reavaliar ${ref}: disponibilidade favorável sustentada na janela.`;
    case "AVAILABILITY_RISK":
      return `auditar disponibilidade de ${ref}: indício de indisponibilidade na janela.`;
    case "SOURCE_CONVERGENCE":
      return `múltiplas fontes concordam sobre ${ref}: informação consistente para avaliação.`;
    case "SOURCE_DIVERGENCE":
      return `auditar as fontes de ${ref}: divergência registrada — não usar valor divergente como referência.`;
    case "INTEREST_ABOVE_BASELINE":
      return `considerar prioridade editorial de ${ref}: interesse acima da baseline na janela.`;
    case "INTEREST_BELOW_BASELINE":
      return `acompanhar ${ref}: interesse abaixo da baseline na janela.`;
    case "INTEREST_NO_BASELINE":
      return `aguardar histórico de ${ref} para comparação; sem baseline não há conclusão.`;
    case "OBSERVATION_STALE":
      return `atualizar observações de ${ref}: evidência desatualizada — sem conclusão sobre o produto.`;
  }
}

function impactLevelFromCategory(category: ReturnType<typeof categoryOf>): RecommendationImpact {
  return category === "price" || category === "availability" ? "MEDIUM" : "LOW";
}

export function computePriorityBreakdownFromSignal(signal: Signal): PriorityBreakdown {
  const ageDays =
    signal.evidenceRefs.length > 0
      ? signalAgeDays(signal)
      : Infinity;
  const recordCount = signal.evidenceRefs.reduce(
    (sum, ref) => sum + ref.sourceIds.length,
    0,
  );
  return computePriority({
    deltaAbs: parseNumericDelta(signal.delta),
    confidence: signal.confidence,
    ageDays: Number.isFinite(ageDays) ? ageDays : 30,
    category: signal.category,
    recordCount,
  });
}

function signalAgeDays(signal: Signal): number {
  // O snapshot guarda o horário de avaliação; usar o próprio detectedAt como recência.
  const detected = new Date(signal.detectedAt).getTime();
  const evaluated = new Date(signal.inputSnapshot.evaluatedAt).getTime();
  return Math.max(0, (evaluated - detected) / (24 * 60 * 60 * 1000));
}

function parseNumericDelta(delta: string): number | null {
  const match = delta.match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);
  if (!match) return null;
  return parseFloat(match[1].replace(",", ".")) / 100;
}

// ============================================================================
// Evidência — construção do ponteiro (evidence_model_v1)
// ============================================================================
export function buildEvidence(params: {
  evidenceId: string;
  sourceType: Evidence["sourceType"];
  sourceTable: string;
  sourceIds: string[];
  metric: string;
  value: string;
  baseline: string;
  window: Evidence["window"];
  observedAt: string;
  note?: string;
}): Evidence {
  return {
    evidenceId: params.evidenceId,
    sourceType: params.sourceType,
    sourceTable: params.sourceTable,
    sourceIds: params.sourceIds,
    metric: params.metric,
    value: params.value,
    baseline: params.baseline,
    window: params.window,
    observedAt: params.observedAt,
    note: params.note,
    evidenceVersion: EVIDENCE_MODEL_VERSION,
  };
}

// ============================================================================
// Derivação de confiança do signal a partir dos fatores
// ============================================================================
export function deriveSignalConfidence(
  factors: Parameters<typeof deriveConfidence>[0],
): { confidence: Signal["confidence"]; confidenceBasis: string } {
  const result = deriveConfidence(factors);
  return { confidence: result.confidence, confidenceBasis: result.confidenceBasis };
}

// ============================================================================
// Validações de contrato (usadas também nos gates)
// ============================================================================
export function validateSignalId(id: string) {
  return validateArtifactId(id, "sig");
}

export function validateRecommendationId(id: string) {
  return validateArtifactId(id, "rec");
}

export { REVIEW_DEADLINE_HOURS as REVIEW_DEADLINE_CONSTANTS };
