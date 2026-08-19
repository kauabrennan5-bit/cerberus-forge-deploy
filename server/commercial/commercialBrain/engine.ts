// ============================================================================
// Bloco N14 — Motor de score comercial (função pura, determinística).
//
// GOVERNANÇA:
// - SEM efeitos: sem I/O, sem chamadas externas, sem horário no output
//   computável (normalizedScore usa SOMENTE sinais e pesos).
// - score ≠ approval ≠ publication ≠ affiliate eligibility.
// - UNKNOWN ≠ 0: dimensões UNKNOWN/CONFLICT são EXCLUÍDAS do score; a
//   cobertura reflete a ausência (coverage = dimensões KNOWN / 6).
// - INSUFFICIENT: menos de MIN_DIMENSIONS_KNOWN dimensões KNOWN →
//   band INSUFFICIENT mesmo que exista score matemático parcial
//   (score parcial NÃO é reportado como band comercial).
// - CONFLITOS: dois sinais KNOWN da mesma dimensão em estados
//   opostos → conflict=true; a dimensão conflitante sai do score
//   e entra em dimensionsUnknown; o rationale explica.
// - RISK PENALTY: multiplicador explícito visível no output (provenance
//   UNKNOWN, dados antigos, conflitos, faixa inválida) — nunca
//   desaparece dentro do score sem registro.
// - Bandas: score normalizado final (após penalty) →
//   ≥0.75 HIGH · (0.40, 0.75) MEDIUM · <0.40 (e ≥2 dimensões KNOWN)
//   LOW · INSUFFICIENT quando coverage insuficiente.
// ============================================================================
import { createHash } from "crypto";
import {
  BAND_HIGH_MIN,
  BAND_LOW_MAX,
  COMMERCIAL_BRAIN_CONTRACT_VERSION,
  COMMERCIAL_BRAIN_PROVENANCE,
  COMMERCIAL_BRAIN_WEIGHTS_VERSION,
  MAX_RISK_PENALTY_MULTIPLIER,
  MIN_DIMENSIONS_KNOWN,
  type CommercialDecision,
  type CommercialSignal,
  type SignalCategory,
} from "./contract";
import { getDimensionWeights, validateDimensionWeights } from "./weights";
import type { NormalizedSignal, PriceRangeBounds } from "./normalizers";

/** Faixa de preço plausível por categoria (min, max). Usada para normalizar
 * o preço RELATIVO à faixa de mercado da categoria: preço no mínimo = 1
 * (melhor), no máximo = 0. A faixa NUNCA é inventada: se ausente ou
 * inválida, o preço usa a normalização absoluta (0-20.000.000) e continua
 * praticamente insensível a variações — o rationale registra
 * `price_range:unknown` para auditoria. */
export interface NormalizedSignals {
  price: NormalizedSignal & { priceRange?: PriceRangeBounds | null };
  commission: NormalizedSignal;
  availability: NormalizedSignal;
  seller: NormalizedSignal;
  market: NormalizedSignal;
  competition: NormalizedSignal;
}

export interface ScoringDimensions {
  price: number | null;
  commission: number | null;
  availability: number | null;
  seller: number | null;
  market: number | null;
  competition: number | null;
}

export interface RiskFactorsInput {
  /** Sinais sem provenance rastreável (fora da avaliação principal). */
  unprovenancedDimensions: ReadonlyArray<string>;
  /** Data de referência UTC ISO para checar idade dos sinais. */
  referenceDateIso: string | null;
  /** Sinais por dimensão para checar idade e valor. */
  signals: NormalizedSignals;
  /** Conflitos detectados pelo avaliador. */
  conflictDimensions: ReadonlyArray<string>;
  /** Fatores adicionais injetados pela camada de service (ex.:
   *  candidate sem provenance de discovery reconhecida). */
  additionalFactors: ReadonlyArray<string>;
}

/**
 * Normaliza um valor por dimensão para 0-1 dentro do domínio próprio.
 * - price: 0-20.000.000 → 1 no mínimo absoluto... 0 no teto; quando
 *   `options.priceRange` está presente e válido (faixa da categoria,
 *   nunca inventada), normaliza RELATIVO à faixa: min=1, max=0, clampado
 *   nos extremos. Sem faixa válida, preserva a normalização absoluta.
 * - commission: fração direta (maior = melhor).
 * - availability: 0/1 direto.
 * - seller: rating 0-5 → /5.
 * - market: saturação logarítmica simples (review/sales comprovados):
 *   1-log10(...)/8 até 1 (saturação determinística documentada).
 * - competition: 0-∞ concorrentes → 1/(1+v) (menos concorrência = melhor).
 */
export interface DimensionNormalizationOptions {
  /** Faixa de preço por categoria (apenas price). */
  priceRange?: PriceRangeBounds | null;
}

export function normalizeDimensionValue(
  category: SignalCategory,
  value: number,
  options?: DimensionNormalizationOptions,
): number {
  switch (category) {
    case "price": {
      const range = options?.priceRange ?? null;
      if (
        range !== null &&
        range !== undefined &&
        typeof range.min === "number" &&
        typeof range.max === "number" &&
        Number.isFinite(range.min) &&
        Number.isFinite(range.max) &&
        range.min < range.max &&
        range.min >= 0 &&
        range.max <= 20_000_000
      ) {
        if (value <= range.min) return 1;
        if (value >= range.max) return 0;
        return 1 - (value - range.min) / (range.max - range.min);
      }
      return 1 - value / 20_000_000;
    }
    case "commission":
      return value;
    case "availability":
      return value;
    case "seller":
      return value / 5;
    case "market":
      return Math.min(1, Math.log10(1 + value) / 8);
    case "competition":
      return 1 / (1 + value);
  }
}

/**
 * Detecta contradições entre os sinais normalizados.
 * Conflitos canônicos desta versão:
 * - availability KNOWN=IN_STOCK junto com seller price null com
 *   evidence de OUT_OF_STOCK (não aplicável sem dado extra nesta versão).
 * - market value > 0 E seller rating == 0 (produto sem nenhuma
 *   reputação mas com movimentação comprovada — contradição de mercado).
 * - availability KNOWN=OUT_OF_STOCK com market value > 0
 *   (movimento comprovado em produto indisponível).
 * Qualquer extensão futura de conflito DEVE ser adicionada aqui com
 * rationale canônico novo (determinismo do rationale depende disso).
 */
export function detectConflicts(signals: NormalizedSignals): ReadonlyArray<string> {
  const conflictDimensions: string[] = [];
  const availabilityKnown = signals.availability.signal.value !== null;
  const marketKnown = signals.market.signal.value !== null && signals.market.signal.value > 0;
  const sellerKnown = signals.seller.signal.value !== null;
  const sellerZero = sellerKnown && signals.seller.signal.value === 0;
  const availabilityOutOfStock = availabilityKnown && signals.availability.signal.value === 0;
  if (sellerZero && marketKnown) {
    conflictDimensions.push("seller", "market");
  }
  if (availabilityOutOfStock && marketKnown) {
    if (!conflictDimensions.includes("availability")) conflictDimensions.push("availability");
    if (!conflictDimensions.includes("market")) conflictDimensions.push("market");
  }
  return conflictDimensions;
}

/**
 * Fatores de risco explícitos visíveis no output.
 * Retorna multiplicador de risco (0.5-1.0) e os fatores canônicos.
 */
export function computeRiskFactors(input: RiskFactorsInput): {
  multiplier: number;
  factors: ReadonlyArray<string>;
} {
  const factors: string[] = [];
  if (input.conflictDimensions.length > 0) {
    factors.push(`conflict_dimensions:${[...input.conflictDimensions].sort().join(",")}`);
  }
  for (const dim of input.unprovenancedDimensions) {
    factors.push(`unprovenanced_dimension:${dim}`);
  }
  // Dados antigos: mais de 90 dias entre observedAt e a referência.
  if (input.referenceDateIso) {
    const ref = new Date(input.referenceDateIso).getTime();
    if (!Number.isNaN(ref)) {
      for (const [category, s] of Object.entries(input.signals) as [SignalCategory, NormalizedSignal][]) {
        if (s.signal.status === "KNOWN" && s.signal.observedAt) {
          const ageDays = (ref - new Date(s.signal.observedAt).getTime()) / 86_400_000;
          if (Number.isFinite(ageDays) && ageDays > 90) {
            factors.push(`stale_signal:${category}:${Math.round(ageDays)}d`);
          }
        }
      }
    }
  }
  for (const additional of input.additionalFactors) {
    if (additional.trim().length > 0) factors.push(additional.trim());
  }
  const uniqueFactors = Array.from(new Set(factors));
  // Cada fator reduz o multiplicador em 10%, piso no limite máximo.
  const multiplier = Math.max(
    MAX_RISK_PENALTY_MULTIPLIER,
    1 - uniqueFactors.length * 0.1,
  );
  return { multiplier, factors: uniqueFactors };
}

export interface ScoringInput {
  candidateId: string;
  signals: NormalizedSignals;
  /** Data UTC ISO de referência usada pelo risco (NÃO entra no digest? —
   *  SIM entra: referência é parte do snapshot — o mesmo snapshot deve
   *  incluir a mesma referência para idempotência). */
  referenceDateIso: string | null;
  /** Fatores de risco externos injetados (ex.: provenance do candidato). */
  additionalRiskFactors: ReadonlyArray<string>;
  /** now UTC ISO — metadado fora do digest apenas como evaluatedAt. */
  nowIso: string;
}

export interface ScoreComponents {
  rawScore: number;
  weightedSum: number;
  weightTotal: number;
  normalizedScore: number;
  penaltyMultiplier: number;
  finalScore: number;
  dimensionsUsed: ReadonlyArray<string>;
  dimensionsUnknown: ReadonlyArray<string>;
  dimensionsKnown: number;
  coverage: number;
  conflictDimensions: ReadonlyArray<string>;
  riskFactors: ReadonlyArray<string>;
}

/**
 * scoreComponents — núcleo determinístico do motor.
 * - Dimensões KNOWN com conflitos → excluídas (vão para dimensionsUnknown).
 * - Dimensões UNKNOWN → excluídas; NÃO valem 0.
 * - Score = média ponderada das dimensões avaliáveis (pesos renormalizados
 *   pela cobertura, SOMANDO 1 dentro das avaliáveis — o registry de
 *   pesos tem sum=1 e a competition v1 weight=0).
 * - Penalty aplicado DEPOIS da normalização; o multiplicador fica visível.
 */
export function scoreComponents(input: {
  signals: NormalizedSignals;
  conflictDimensions: ReadonlyArray<string>;
  riskMultiplier: number;
}): ScoreComponents {
  const weights = getDimensionWeights().weights;
  const entries = Object.entries(weights) as [SignalCategory, number][];
  const dimensionsUsed: string[] = [];
  const dimensionsUnknown: string[] = [];
  const dimensionsKnown = entries.filter(
    ([cat]) =>
      input.signals[cat].signal.status === "KNOWN" &&
      input.signals[cat].normalizedValue !== null &&
      !input.conflictDimensions.includes(cat),
  ).length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [category, weight] of entries) {
    const s = input.signals[category];
    const known =
      s.signal.status === "KNOWN" &&
      s.normalizedValue !== null &&
      !input.conflictDimensions.includes(category);
    if (known) {
      dimensionsUsed.push(category);
      const normalized = normalizeDimensionValue(
        category,
        s.normalizedValue,
        category === "price"
          ? { priceRange: (s as NormalizedSignals["price"]).priceRange ?? null }
          : undefined,
      );
      weightedSum += weight * normalized;
      weightTotal += weight;
    } else {
      dimensionsUnknown.push(category);
    }
  }
  // coverage = fração de dimensões avaliáveis sobre o total (6).
  const coverage = weightTotal > 0 ? dimensionsKnown / entries.length : 0;
  // normalizado sobre a cobertura real (mesmo peso total < 1 quando
  // competition v1=0). weightTotal nunca é 0 quando known>0.
  const normalizedScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const finalScore = Number(
    (Math.round(normalizedScore * input.riskMultiplier * 10_000) / 10_000).toFixed(4),
  );
  return {
    rawScore: weightedSum,
    weightedSum,
    weightTotal,
    normalizedScore,
    penaltyMultiplier: input.riskMultiplier,
    finalScore: Math.min(1, Math.max(0, finalScore)),
    dimensionsUsed: [...dimensionsUsed].sort(),
    dimensionsUnknown: [...dimensionsUnknown].sort(),
    dimensionsKnown,
    coverage,
    conflictDimensions: [...input.conflictDimensions].sort(),
    riskFactors: [],
  };
}

export function buildBand(components: ScoreComponents): {
  band: CommercialDecision["band"];
  confidence: CommercialDecision["confidence"];
} {
  // INSUFFICIENT bloqueia a interpretação comercial do score, mesmo que
  // exista score matemático parcial.
  if (components.dimensionsKnown < MIN_DIMENSIONS_KNOWN) {
    return { band: "INSUFFICIENT", confidence: "LOW" };
  }
  let confidence: CommercialDecision["confidence"] = "HIGH";
  if (components.conflictDimensions.length > 0) confidence = "MEDIUM";
  if (components.penaltyMultiplier < 1) confidence = components.penaltyMultiplier <= 0.6 ? "LOW" : "MEDIUM";
  if (components.finalScore >= BAND_HIGH_MIN) {
    return { band: "HIGH", confidence };
  }
  if (components.finalScore > BAND_LOW_MAX) {
    return { band: "MEDIUM", confidence };
  }
  return { band: "LOW", confidence };
}

/**
 * rationale canônico: concatenação estável de cláusulas por dimensão,
 * ordenada por categoria (price → commission → availability → market →
 * seller → competition) + cláusulas de risco. Determinístico para o
 * mesmo input.
 */
export function buildRationale(components: ScoreComponents, signals: NormalizedSignals): string {
  const clauses: string[] = [];
  const order: SignalCategory[] = [
    "price",
    "commission",
    "availability",
    "market",
    "seller",
    "competition",
  ];
  for (const category of order) {
    const s = signals[category];
    if (components.dimensionsUsed.includes(category)) {
      let note = s.signal.note ?? `${category}_known`;
      if (category === "price") {
        const priceSignal = s as NormalizedSignals["price"];
        // Faixa da categoria ausente → normalização absoluta usada;
        // auditar explicitamente no rationale (determinístico).
        note = (priceSignal.priceRange ?? null) === null ? "price_range:unknown" : `${note};price_range:${priceSignal.priceRange.min}-${priceSignal.priceRange.max}`;
      }
      clauses.push(`used:${category}:${note}`);
    } else if (components.conflictDimensions.includes(category)) {
      clauses.push(`conflict:${category}:excluded_from_score`);
    } else {
      clauses.push(`unknown:${category}:${s.signal.note ?? s.signal.status}`);
    }
  }
  if (components.conflictDimensions.length > 0) {
    clauses.push(
      `conflict_summary:dimensoes_em_conflito=${[...components.conflictDimensions].join(",")}`,
    );
  }
  if (components.riskFactors.length > 0) {
    clauses.push(`risk:${[...components.riskFactors].join(";")}`);
  }
  if (components.dimensionsKnown < MIN_DIMENSIONS_KNOWN) {
    clauses.push(
      `insufficient:dimensoes_conhecidas=${components.dimensionsKnown};minimo=${MIN_DIMENSIONS_KNOWN}`,
    );
  }
  return clauses.join(";");
}

export function buildDecisionDigest(params: {
  candidateId: string;
  contractVersion: string;
  weightsVersion: string;
  components: ScoreComponents;
  referenceDateIso: string | null;
}): string {
  const serialized = JSON.stringify({
    candidateId: params.candidateId,
    contractVersion: params.contractVersion,
    weightsVersion: params.weightsVersion,
    score: params.components.finalScore,
    bandBasis: {
      dimensionsUsed: params.components.dimensionsUsed,
      dimensionsUnknown: params.components.dimensionsUnknown,
      conflictDimensions: params.components.conflictDimensions,
      penaltyMultiplier: params.components.penaltyMultiplier,
      coverage: params.components.coverage,
    },
    referenceDateIso: params.referenceDateIso,
  });
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

/**
 * evaluateCommercialSignals — avaliação comercial pura de um candidato
 * com sinais já normalizados (pela camada normalizers).
 */
export function evaluateCommercialSignals(input: ScoringInput): CommercialDecision {
  const weightsRegistry = getDimensionWeights();
  const weightsError = validateDimensionWeights(weightsRegistry);
  if (weightsError) {
    throw new Error(`invalid_weights_registry:${weightsError}`);
  }
  const conflictDimensions = detectConflicts(input.signals);
  const riskResult = computeRiskFactors({
    unprovenancedDimensions: [],
    referenceDateIso: input.referenceDateIso,
    signals: input.signals,
    conflictDimensions,
    additionalFactors: input.additionalRiskFactors,
  });
  const components = scoreComponents({
    signals: input.signals,
    conflictDimensions,
    riskMultiplier: riskResult.multiplier,
  });
  components.riskFactors = riskResult.factors;
  const { band, confidence } = buildBand(components);
  const rationale = buildRationale(components, input.signals);
  const digest = buildDecisionDigest({
    candidateId: input.candidateId,
    contractVersion: COMMERCIAL_BRAIN_CONTRACT_VERSION,
    weightsVersion: weightsRegistry.weightsVersion,
    components,
    referenceDateIso: input.referenceDateIso,
  });
  return {
    contractVersion: COMMERCIAL_BRAIN_CONTRACT_VERSION,
    weightsVersion: weightsRegistry.weightsVersion,
    candidateId: input.candidateId,
    score: band === "INSUFFICIENT" ? null : components.finalScore,
    coverage: components.coverage,
    band,
    confidence,
    conflict: conflictDimensions.length > 0,
    conflictDimensions: components.conflictDimensions,
    dimensionsUsed: components.dimensionsUsed,
    dimensionsUnknown: components.dimensionsUnknown,
    riskPenalty: riskResult.multiplier,
    riskFactors: components.riskFactors,
    rationale,
    digest,
    idempotencyKey: `cb-${digest.slice(7)}`,
    evaluatedAt: input.nowIso,
  };
}
