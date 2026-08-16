/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Fórmulas versionadas (FASE A).
 *
 * Cada função é pura e determinística: mesmo input + mesma versão = mesmo output.
 * Nenhuma função muta dados; nenhuma acessa banco; nenhuma executa ação.
 */
import {
  AnalysisWindow,
  CONFIDENCE_MODEL_VERSION,
  CONFIDENCE_SCORE_BY_LEVEL,
  ConfidenceFactors,
  ConfidenceResult,
  DivergenceReport,
  EVIDENCE_SATURATION_COUNT,
  MAGNITUDE_SATURATION_DELTA,
  OUTLIER_IQR_MULTIPLIER,
  OUTLIER_MEDIAN_BAND,
  PRIORITY_HIGH_THRESHOLD,
  PRIORITY_MEDIUM_THRESHOLD,
  PRIORITY_MODEL_VERSION,
  PRIORITY_WEIGHTS,
  PriorityBreakdown,
  PriorityLevel,
  RECENCY_MAX_AGE_DAYS,
  REVIEW_DEADLINE_HOURS,
  SIGNAL_CATEGORY_BY_TYPE,
  SOURCE_DIVERGENCE_BAND,
  SignalCategory,
  SignalConfidence,
  SignalType,
  windowDurationMs,
} from "./types";

// ============================================================================
// Baseline por mediana da janela anterior (Design Review, aprovado)
// ============================================================================
/**
 * Baseline numérico: mediana dos valores da janela ANTERIOR à janela atual.
 * Retorna null quando não há valores suficientes (o chamador deve então
 * declarar INSUFFICIENT_EVIDENCE — nunca imputar baseline).
 *
 * Regra de corte: baseline window = [evaluatedAt - 2*duração, evaluatedAt - duração].
 * Janelas fechadas em UTC garantem determinismo.
 */
export function computeBaseline(
  values: Array<{ value: number; observedAt: string }>,
  window: AnalysisWindow,
  evaluatedAt: Date,
  minValues = 1,
): number | null {
  if (window === "lifetime") {
    return null;
  }
  const duration = windowDurationMs(window);
  const windowStart = new Date(evaluatedAt.getTime() - 2 * duration);
  const windowEnd = new Date(evaluatedAt.getTime() - duration);
  const inWindow = values
    .map((v) => v.value)
    .filter((_, i) => {
      const t = new Date(values[i].observedAt).getTime();
      return t >= windowStart.getTime() && t < windowEnd.getTime();
    });
  if (inWindow.length < minValues) return null;
  return median(inWindow);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error("median(): lista vazia — não calcular baseline.");
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ============================================================================
// Delta (percentual e absoluto)
// ============================================================================
/**
 * Delta percentual. baseline 0, null ou negativo → sem delta calculável
 * (fabricar "queda garantida" é proibido). Retorna null.
 */
export function computePercentDelta(current: number, baseline: number | null): number | null {
  if (baseline === null || baseline === 0 || baseline < 0) return null;
  return (current - baseline) / baseline;
}

export function formatPercentDelta(delta: number | null): string {
  if (delta === null) return "sem baseline disponível";
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1).replace(".", ",")}%`;
}

export function formatAbsoluteDelta(current: number, baseline: number | null): string {
  if (baseline === null) return "sem baseline disponível";
  const diff = current - baseline;
  const sign = diff >= 0 ? "+" : "";
  return `R$ ${sign}${diff.toFixed(2).replace(".", ",")}`;
}

// ============================================================================
// 6. Confiança — categorical + WORST WINS (confidence_model_v1)
// ============================================================================
/**
 * Deriva a confiança do sinal a partir de fatores observáveis.
 * Ordem "pior wins": o fator mais restritivo domina.
 */
export function deriveConfidence(factors: ConfidenceFactors): ConfidenceResult {
  const applied: string[] = [];

  let level: SignalConfidence = "HIGH";

  if (factors.recordCount < 1) {
    level = "INSUFFICIENT_EVIDENCE";
    applied.push("sem registros (recordCount<1)");
  } else if (factors.recordCount < 3 || factors.singleSource) {
    level = "MEDIUM";
    applied.push(
      factors.recordCount < 3
        ? "menos de 3 registros"
        : "fonte única sem confirmação",
    );
  }

  const restrictFromHigh: (msg: string) => void = (msg) => {
    if (level === "HIGH") level = "LOW";
    else if (level === "MEDIUM") level = "LOW";
    applied.push(msg);
  };

  if (factors.ageDays > 7) {
    restrictFromHigh(`evidência com ${factors.ageDays.toFixed(0)} dias (>7d)`);
  }

  if (factors.unresolvedContradiction) {
    restrictFromHigh("contradição entre fontes não resolvida");
  }

  const weakCollection = factors.collectionConfidence.some(
    (c) => c === "LOW" || c === "INCONCLUSIVE",
  );
  if (weakCollection) {
    restrictFromHigh("qualidade de coleta LOW/INCONCLUSIVE");
  }

  if (level === "HIGH" && factors.recordCount > 0) {
    applied.push(
      `base: ${factors.recordCount} registros, sem contradição, recência ok`,
    );
  }

  return { confidence: level, confidenceBasis: applied.join("; ") };
}

export function confidenceToScore(confidence: SignalConfidence): number {
  return CONFIDENCE_SCORE_BY_LEVEL[confidence];
}

// ============================================================================
// 5. Prioridade — priority_model_v1
// ============================================================================
/**
 * M*0.30 + C*0.25 + R*0.20 + I*0.15 + E*0.10
 * magnitude satura em 20% de delta; recência zera após 14 dias;
 * evidência satura com 5 registros independentes.
 */
export function computePriority(params: {
  deltaAbs: number | null;
  confidence: SignalConfidence;
  ageDays: number;
  category: SignalCategory;
  recordCount: number;
}): PriorityBreakdown {
  const M =
    params.deltaAbs !== null
      ? Math.min(1, Math.abs(params.deltaAbs) / MAGNITUDE_SATURATION_DELTA)
      : 0;
  const C = confidenceToScore(params.confidence);
  const R = Math.max(0, 1 - params.ageDays / RECENCY_MAX_AGE_DAYS);
  const I = impactForCategory(params.category);
  const E = Math.min(1, params.recordCount / EVIDENCE_SATURATION_COUNT);

  let score =
    M * PRIORITY_WEIGHTS.magnitude +
    C * PRIORITY_WEIGHTS.confidence +
    R * PRIORITY_WEIGHTS.recency +
    I * PRIORITY_WEIGHTS.impact +
    E * PRIORITY_WEIGHTS.evidence;

  let level: PriorityLevel;
  if (params.confidence === "INSUFFICIENT_EVIDENCE") {
    score = 0;
    level = "NO_ACTION";
  } else if (score >= PRIORITY_HIGH_THRESHOLD) {
    level = "HIGH";
  } else if (score >= PRIORITY_MEDIUM_THRESHOLD) {
    level = "MEDIUM";
  } else {
    level = "LOW";
  }

  return {
    magnitude: round3(M),
    confidence: round3(C),
    recency: round3(R),
    impact: round3(I),
    evidence: round3(E),
    score: round3(score),
    level,
    modelVersion: PRIORITY_MODEL_VERSION,
  };
}

export function impactForCategory(category: SignalCategory): number {
  return { price: 0.9, availability: 0.8, interest: 0.6, source: 0.4, freshness: 0.3 }[
    category
  ];
}

export function reviewDeadlineMs(priority: PriorityLevel): number {
  const hours =
    priority === "HIGH"
      ? REVIEW_DEADLINE_HOURS.HIGH
      : priority === "MEDIUM"
        ? REVIEW_DEADLINE_HOURS.MEDIUM
        : priority === "LOW"
          ? REVIEW_DEADLINE_HOURS.LOW
          : REVIEW_DEADLINE_HOURS.MEDIUM;
  return hours * 60 * 60 * 1000;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ============================================================================
// 13. Divergência entre fontes — banda ±10% da mediana (D-6)
// ============================================================================
/**
 * Não escolhe arbitrariamente uma fonte. Usa a mediana, reporta quais
 * fontes convergem e quais divergem. Divergência é um sinal próprio.
 */
export function analyzeDivergence(
  sources: Array<{ source: string; value: number }>,
  band = SOURCE_DIVERGENCE_BAND,
): DivergenceReport {
  const values = sources.map((s) => s.value);
  const med = median(values);
  const bandMin = med * (1 - band);
  const bandMax = med * (1 + band);
  const convergent: Array<{ source: string; value: number }> = [];
  const divergent: Array<{ source: string; value: number }> = [];
  for (const s of sources) {
    if (s.value >= bandMin && s.value <= bandMax) convergent.push(s);
    else divergent.push(s);
  }
  return {
    median: med,
    bandMin,
    bandMax,
    convergentSources: convergent,
    divergentSources: divergent,
    diverges: divergent.length > 0,
  };
}

// ============================================================================
// 14. Outliers — IQR 1,5x e banda ±50% da mediana (D-6)
// ============================================================================
export interface OutlierVerdict {
  /** O valor é anômalo frente ao histórico? */
  isOutlier: boolean;
  /** Regra que o detectou. */
  rule: "iqr" | "median_band" | "none";
  median: number;
  low: number;
  high: number;
}

/**
 * Intervalo [Q1-1,5*IQR, Q3+1,5*IQR] ou ±50% da mediana histórica.
 * Um outlier isolado NUNCA vira oportunidade automática: exige
 * confirmação em segunda fonte independente.
 */
export function analyzeOutlier(
  value: number,
  history: number[],
): OutlierVerdict {
  if (history.length < 2) {
    return { isOutlier: false, rule: "none", median: median(history), low: 0, high: 0 };
  }
  const sorted = [...history].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const iqrLow = q1 - OUTLIER_IQR_MULTIPLIER * iqr;
  const iqrHigh = q3 + OUTLIER_IQR_MULTIPLIER * iqr;
  const med = median(sorted);
  const bandLow = med * (1 - OUTLIER_MEDIAN_BAND);
  const bandHigh = med * (1 + OUTLIER_MEDIAN_BAND);

  const insideIqr = value >= iqrLow && value <= iqrHigh;
  const insideBand = value >= bandLow && value <= bandHigh;

  if (!insideIqr || !insideBand) {
    return {
      isOutlier: true,
      rule: insideIqr ? "median_band" : "iqr",
      median: med,
      low: Math.max(iqrLow, bandLow),
      high: Math.min(iqrHigh, bandHigh),
    };
  }
  return { isOutlier: false, rule: "none", median: med, low: iqrLow, high: iqrHigh };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// ============================================================================
// 12. Regras de insuficiência — decisão consolidada
// ============================================================================
export interface InsufficientEvidenceCheck {
  insufficient: boolean;
  reasons: string[];
}

/**
 * Gatilhos aprovados: <1 registro; métrica inexistente; janela sem dados;
 * baseline ausente quando obrigatório; divergência sem regra de desempate;
 * dados mais antigos que o limite de frescor.
 */
export function checkEvidenceSufficiency(params: {
  recordCount: number;
  metricExists: boolean;
  hasBaseline: boolean;
  baselineRequired: boolean;
  maxAgeDays?: number | null;
  freshnessDaysLimit?: number;
}): InsufficientEvidenceCheck {
  const reasons: string[] = [];
  if (params.recordCount < 1) reasons.push("nenhum registro na janela");
  if (!params.metricExists) reasons.push("métrica inexistente");
  if (params.baselineRequired && !params.hasBaseline) {
    reasons.push("baseline obrigatório ausente");
  }
  if (
    params.maxAgeDays !== null &&
    params.maxAgeDays !== undefined &&
    params.freshnessDaysLimit !== undefined &&
    params.maxAgeDays > params.freshnessDaysLimit
  ) {
    reasons.push(`evidência com ${params.maxAgeDays.toFixed(0)}d > limite de frescor ${params.freshnessDaysLimit}d`);
  }
  return { insufficient: reasons.length > 0, reasons };
}

// ============================================================================
// 15. Observação antiga — OBSERVATION_STALE (D-7)
// ============================================================================
export const FRESHNESS_LIMIT_DAYS = 7;

export interface StalenessCheck {
  stale: boolean;
  ageDays: number;
}

/**
 * Última observação do produto mais antiga que o limite de frescor.
 * Produz RISK de manutenção ("evidência desatualizada") — NUNCA significa
 * produto ruim, indisponível ou perda comercial.
 */
export function checkStaleness(lastObservedAt: string | null, evaluatedAt: Date): StalenessCheck {
  if (lastObservedAt === null) {
    return { stale: true, ageDays: Infinity };
  }
  const ageMs = evaluatedAt.getTime() - new Date(lastObservedAt).getTime();
  const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
  return { stale: ageDays > FRESHNESS_LIMIT_DAYS, ageDays };
}

// ============================================================================
// Utility: categoria do sinal
// ============================================================================
export function categoryOf(signalType: SignalType): SignalCategory {
  return SIGNAL_CATEGORY_BY_TYPE[signalType];
}

export { CONFIDENCE_MODEL_VERSION, PRIORITY_MODEL_VERSION };
