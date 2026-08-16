/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Contrato de tipos (FASE A).
 *
 * Fronteiras conceituais absolutas:
 *   PRODUCT ≠ OBSERVATION ≠ SIGNAL ≠ RECOMMENDATION ≠ ACTION
 *   MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO
 *   SIGNAL != REVENUE · RECOMMENDATION != ACTION
 *
 * Este módulo define SOMENTE artefatos analíticos. Ele não contém handlers
 * de execução, não grava em products e não cria autoridade.
 */

// ============================================================================
// 10. Versionamento
// ============================================================================
/**
 * Constância de versão da lógica. Qualquer mudança de fórmula, peso,
 * banda, catálogo de sinais ou regra de desempate exige nova versão.
 * Versões nunca são substituídas silenciosamente.
 */
export const COMMERCIAL_BRAIN_VERSION = "commercial_brain_v1" as const;
export const PRIORITY_MODEL_VERSION = "priority_model_v1" as const;
export const CONFIDENCE_MODEL_VERSION = "confidence_model_v1" as const;
export const EVIDENCE_MODEL_VERSION = "evidence_model_v1" as const;

export type CommercialBrainVersion = typeof COMMERCIAL_BRAIN_VERSION;
export type PriorityModelVersion = typeof PRIORITY_MODEL_VERSION;
export type ConfidenceModelVersion = typeof CONFIDENCE_MODEL_VERSION;
export type EvidenceModelVersion = typeof EVIDENCE_MODEL_VERSION;

// ============================================================================
// 11. Janelas temporais
// ============================================================================
/**
 * Toda análise temporal declara sua janela. "lifetime" cobre todas as
 * observações registradas (usado quando não há baseline temporal).
 */
export type AnalysisWindow = "24h" | "7d" | "30d" | "lifetime";
export const ANALYSIS_WINDOWS: AnalysisWindow[] = ["24h", "7d", "30d", "lifetime"];

/** Duração em milissegundos de cada janela (exclui lifetime). */
export function windowDurationMs(window: AnalysisWindow): number {
  switch (window) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "lifetime":
      return Infinity;
  }
}

/** Timezone de exibição padrão (Brasil). A análise opera sempre em UTC. */
export const DISPLAY_TIMEZONE = "America/Sao_Paulo" as const;

// ============================================================================
// 12. Regras de insuficiência de evidência — níveis de confiança
// ============================================================================
export type SignalConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_EVIDENCE";
export const SIGNAL_CONFIDENCES: SignalConfidence[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "INSUFFICIENT_EVIDENCE",
];

/** Níveis de prioridade resultantes. NO_ACTION é produzido quando a
 *  evidência é insuficiente, independentemente dos demais fatores. */
export type PriorityLevel = "HIGH" | "MEDIUM" | "LOW" | "NO_ACTION";

// ============================================================================
// 6. Confidence — regra WORST WINS
// ============================================================================
export interface ConfidenceFactors {
  /** Quantidade de registros independentes que sustentam o sinal. */
  recordCount: number;
  /** Existe fonte única sem confirmação? */
  singleSource: boolean;
  /** Qualidade de coleta (confidence das observações do Bloco 13). */
  collectionConfidence: Array<"HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE">;
  /** Dias desde a evidência mais recente. */
  ageDays: number;
  /** Há contradição não resolvida entre fontes na janela? */
  unresolvedContradiction: boolean;
}

export interface ConfidenceResult {
  confidence: SignalConfidence;
  /** Fatores que aplicaram o rebaixamento; garante auditabilidade. */
  confidenceBasis: string;
}

// ============================================================================
// 1. Signal
// ============================================================================
/**
 * Catálogo fechado V1. Expansão = nova versão do cérebro.
 * Categorias: price | availability | source | interest | freshness
 */
export type SignalType =
  | "PRICE_IMPROVEMENT"
  | "PRICE_DETERIORATION"
  | "PRICE_BELOW_CANONICAL"
  | "PRICE_OUTLIER"
  | "AVAILABILITY_RISK"
  | "AVAILABILITY_IMPROVEMENT"
  | "SOURCE_CONVERGENCE"
  | "SOURCE_DIVERGENCE"
  | "INTEREST_ABOVE_BASELINE"
  | "INTEREST_BELOW_BASELINE"
  | "INTEREST_NO_BASELINE"
  | "OBSERVATION_STALE";

export const OPPORTUNITY_SIGNAL_TYPES: SignalType[] = [
  "PRICE_IMPROVEMENT",
  "PRICE_BELOW_CANONICAL",
  "AVAILABILITY_IMPROVEMENT",
  "SOURCE_CONVERGENCE",
  "INTEREST_ABOVE_BASELINE",
];

export const RISK_SIGNAL_TYPES: SignalType[] = [
  "PRICE_DETERIORATION",
  "AVAILABILITY_RISK",
  "SOURCE_DIVERGENCE",
  "PRICE_OUTLIER",
  "INTEREST_BELOW_BASELINE",
  "OBSERVATION_STALE",
];

export type SignalCategory = "price" | "availability" | "source" | "interest" | "freshness";
export const SIGNAL_CATEGORY_BY_TYPE: Record<SignalType, SignalCategory> = {
  PRICE_IMPROVEMENT: "price",
  PRICE_DETERIORATION: "price",
  PRICE_BELOW_CANONICAL: "price",
  PRICE_OUTLIER: "price",
  AVAILABILITY_RISK: "availability",
  AVAILABILITY_IMPROVEMENT: "availability",
  SOURCE_CONVERGENCE: "source",
  SOURCE_DIVERGENCE: "source",
  INTEREST_ABOVE_BASELINE: "interest",
  INTEREST_BELOW_BASELINE: "interest",
  INTEREST_NO_BASELINE: "interest",
  OBSERVATION_STALE: "freshness",
};

/** Impacto padrão por categoria, usado no scoring de prioridade (fator I). */
export const DEFAULT_IMPACT_BY_CATEGORY: Record<SignalCategory, number> = {
  price: 0.9,
  availability: 0.8,
  interest: 0.6,
  source: 0.4,
  freshness: 0.3,
};

/** Ponteiro de evidência: aponta para registros reais, nunca copia raw content. */
export interface EvidenceRef {
  sourceType:
    | "product"
    | "price_observation"
    | "availability_observation"
    | "source_observation"
    | "click"
    | "catalog";
  sourceTable: string;
  sourceIds: string[];
}

export interface Signal {
  signalId: string;
  analysisVersion: CommercialBrainVersion;
  signalType: SignalType;
  category: SignalCategory;
  productId: string | null;
  productRef?: string;
  metric: string;
  currentValue: string;
  baselineValue: string;
  delta: string;
  window: AnalysisWindow;
  baselineWindow: AnalysisWindow | null;
  evidenceRefs: EvidenceRef[];
  confidence: SignalConfidence;
  confidenceBasis: string;
  detectedAt: string;
  /** Resumo dos parâmetros de entrada; garante reprodutibilidade. */
  inputSnapshot: {
    subject: string;
    window: AnalysisWindow;
    displayTz: string;
    recordCount: number;
    evaluatedAt: string;
  };
}

// ============================================================================
// 2. Evidence
// ============================================================================
export interface Evidence {
  evidenceId: string;
  sourceType: EvidenceRef["sourceType"];
  sourceTable: string;
  sourceIds: string[];
  metric: string;
  value: string;
  baseline: string;
  window: AnalysisWindow;
  observedAt: string;
  note?: string;
  evidenceVersion: EvidenceModelVersion;
}

// ============================================================================
// 5. Priority — priority_model_v1
// ============================================================================
/**
 * Fórmula V1 aprovada no Design Review:
 *   priority_score = M*0.30 + C*0.25 + R*0.20 + I*0.15 + E*0.10
 * Com INSUFFICIENT_EVIDENCE → score = 0 (NO_ACTION), sempre.
 */
export const PRIORITY_WEIGHTS = {
  magnitude: 0.3,
  confidence: 0.25,
  recency: 0.2,
  impact: 0.15,
  evidence: 0.1,
} as const;

/** Limite de saturação do delta (20% satura magnitude em 1.0). */
export const MAGNITUDE_SATURATION_DELTA = 0.2;
/** Dias após os quais a recência zera. */
export const RECENCY_MAX_AGE_DAYS = 14;
/** Registros independentes que saturam o fator de evidência. */
export const EVIDENCE_SATURATION_COUNT = 5;
/** Confiança → componente C do scoring. */
export const CONFIDENCE_SCORE_BY_LEVEL: Record<SignalConfidence, number> = {
  HIGH: 1.0,
  MEDIUM: 0.6,
  LOW: 0.3,
  INSUFFICIENT_EVIDENCE: 0.0,
};
export const PRIORITY_HIGH_THRESHOLD = 0.75;
export const PRIORITY_MEDIUM_THRESHOLD = 0.45;

export interface PriorityBreakdown {
  magnitude: number;
  confidence: number;
  recency: number;
  impact: number;
  evidence: number;
  score: number;
  level: PriorityLevel;
  modelVersion: PriorityModelVersion;
}

// ============================================================================
// 12/13/14. Baseline, divergência e outlier
// ============================================================================
/** Banda de tolerância de divergência entre fontes (aprovada: ±10%). */
export const SOURCE_DIVERGENCE_BAND = 0.1;

/** Fatores de outlier (aprovados no Design Review). */
export const OUTLIER_MEDIAN_BAND = 0.5; // ±50% da mediana histórica
export const OUTLIER_IQR_MULTIPLIER = 1.5;

export interface DivergenceReport {
  /** Mediana dos valores na janela. */
  median: number;
  bandMin: number;
  bandMax: number;
  convergentSources: Array<{ source: string; value: number }>;
  divergentSources: Array<{ source: string; value: number }>;
  diverges: boolean;
}

// ============================================================================
// 3/4. Opportunity e Risk
// ============================================================================
export type OpportunityStatus = "ACTIVE" | "PARKED" | "RETIRED";
export type RiskStatus = "ACTIVE" | "ACKNOWLEDGED" | "RETIRED";

export interface Opportunity {
  opportunityId: string;
  signalId: string;
  signalType: SignalType;
  productId: string;
  productRef: string;
  evidenceRefs: EvidenceRef[];
  confidence: SignalConfidence;
  confidenceBasis: string;
  priority: PriorityBreakdown;
  status: OpportunityStatus;
  createdAt: string;
  /** Critérios objetivos satisfeitos (ver regras do contrato). */
  criteria: string[];
}

export interface RiskFinding {
  riskId: string;
  signalId: string;
  signalType: SignalType;
  productId: string;
  productRef: string;
  evidenceRefs: EvidenceRef[];
  confidence: SignalConfidence;
  confidenceBasis: string;
  priority: PriorityBreakdown;
  status: RiskStatus;
  createdAt: string;
  criteria: string[];
}

// ============================================================================
// 7. Recommendation
// ============================================================================
export type RecommendationType = "opportunity" | "risk" | "maintenance";
export type RecommendationImpact = "HIGH" | "MEDIUM" | "LOW";
export type RecommendationCost = "HIGH" | "MEDIUM" | "LOW";
export type RecommendationRisk = "HIGH" | "MEDIUM" | "LOW";

/** Prazos de revisão aprovados (D-5). Defaults analíticos, não schedulers. */
export const REVIEW_DEADLINE_HOURS = {
  HIGH: 48,
  MEDIUM: 7 * 24,
  LOW: 14 * 24,
} as const;

export interface Recommendation {
  recommendationId: string;
  analysisVersion: CommercialBrainVersion;
  scoringVersion: PriorityModelVersion;
  confidenceVersion: ConfidenceModelVersion;
  subject: string;
  subjectRef: string;
  type: RecommendationType;
  category: SignalType;
  suggestedAction: string;
  evidence: Evidence[];
  confidence: SignalConfidence;
  confidenceBasis: string;
  impact: RecommendationImpact;
  cost: RecommendationCost;
  risk: RecommendationRisk;
  priorityScore: number;
  priority: PriorityLevel;
  baselineStatement: string;
  reviewDeadline: string;
  createdAt: string;
}

// ============================================================================
// 8. Analysis
// ============================================================================
export interface AnalysisInput {
  /** product_id do sujeito ou 'portfolio' para análise de portfólio. */
  subject: string;
  window: AnalysisWindow;
  displayTz?: string;
  evaluatedAt: string;
}

export interface AnalysisOutput {
  analysisId: string;
  analysisVersion: CommercialBrainVersion;
  scoringVersion: PriorityModelVersion;
  confidenceVersion: ConfidenceModelVersion;
  evidenceVersion: EvidenceModelVersion;
  input: AnalysisInput;
  signals: Signal[];
  opportunities: Opportunity[];
  risks: RiskFinding[];
  recommendations: Recommendation[];
  producedAt: string;
}

// ============================================================================
// 9. Validation helpers (contrato testável)
// ============================================================================
/**
 * Valida um id de artefato no formato <prefixo>-<YYYYMMDD>-<sequencial>.
 * O prefixo identifica a família do artefato e impede colisões de tipo.
 */
export function validateArtifactId(id: string, prefix: string): { ok: boolean; error?: string } {
  const re = new RegExp(`^${prefix}-\\d{8}-\\d{1,10}$`);
  if (!re.test(id)) {
    return { ok: false, error: `Id inválido: "${id}" não segue o padrão ${prefix}-YYYYMMDD-N.` };
  }
  return { ok: true };
}

export const SIGNAL_ID_PREFIX = "sig";
export const OPPORTUNITY_ID_PREFIX = "opp";
export const RISK_ID_PREFIX = "risk";
export const RECOMMENDATION_ID_PREFIX = "rec";

/** Proibição lexical de vocabulário comercial não sustentado. */
export const BANNED_COMMERCIAL_TERMS = [
  "venda realizada",
  "vendas realizadas",
  "receita",
  "lucro",
  "rentabilidade",
  "roi",
  "conversão em",
  "faturamento",
  "ganho financeiro",
];

export function assertCleanCommercialVocabulary(text: string): { ok: boolean; found?: string } {
  const lower = text.toLowerCase();
  for (const term of BANNED_COMMERCIAL_TERMS) {
    if (lower.includes(term)) {
      return { ok: false, found: term };
    }
  }
  return { ok: true };
}
