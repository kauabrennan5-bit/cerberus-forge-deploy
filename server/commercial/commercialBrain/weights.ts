// ============================================================================
// Bloco N14 — Registry central e versionado de pesos do score comercial.
//
// GOVERNANÇA:
// - NENHUM número mágico é espalhado pelo código: o score usa SOMENTE
//   este registry.
// - A soma dos pesos base = 1.0000 (validada em runtime no boot do
//   registry).
// - Pesos são BASELINE determinístico inicial: NÃO são otimizados
//   empiricamente e NÃO representam o peso econômico real do negócio
//   (ver COMMERCIAL_BRAIN_WEIGHTS_NOTE no contract).
// - Versionamento: qualquer mudança de peso gera uma NOVA versão
//   (cb_weights_v2, ...) com o registry anterior preservado — o
//   CommercialDecision carrega weightsVersion para auditoria.
// ============================================================================
import {
  COMMERCIAL_BRAIN_WEIGHTS_NOTE,
  COMMERCIAL_BRAIN_WEIGHTS_VERSION,
  type SignalCategory,
} from "./contract";

export interface DimensionWeights {
  weightsVersion: typeof COMMERCIAL_BRAIN_WEIGHTS_VERSION;
  note: typeof COMMERCIAL_BRAIN_WEIGHTS_NOTE;
  /** Frações por dimensão avaliável. Soma = 1.0000. */
  weights: Readonly<Record<SignalCategory, number>>;
  /** Penalização máxima de risco (multiplicador do score normalizado). */
  maxRiskPenaltyMultiplier: number;
  /** Fração mínima de dimensões KNOWN para aceitar um score (INSUFFICIENT
   *  quando abaixo). Expresso em número de dimensões (das 6). */
  minDimensionsKnown: number;
  /** Limiares de banda sobre o score final (após penalty). */
  bandHighMin: number;
  bandLowMax: number;
}

/**
 * Registry v1: pesos iniciais baseline (não empiricamente otimizados).
 *
 * price        0.25 — atratividade por preço comprovado.
 * commission   0.25 — margem por comissão do provider afiliado.
 * seller       0.20 — reputação do vendedor (rating comprovado).
 * market       0.15 — proxies de mercado com evidência real.
 * availability 0.15 — disponibilidade comprovada.
 * competition  0.00 — SOMENTE com evidência real e proveniente; na
 *                      ausência (UNKNOWN) a dimensão é excluída do score
 *                      (weight 0) e NÃO penaliza: UNKNOWN ≠ 0.
 */
export const COMMERCIAL_BRAIN_WEIGHTS_V1: DimensionWeights = {
  weightsVersion: COMMERCIAL_BRAIN_WEIGHTS_VERSION,
  note: COMMERCIAL_BRAIN_WEIGHTS_NOTE,
  weights: {
    price: 0.25,
    commission: 0.25,
    seller: 0.2,
    market: 0.15,
    availability: 0.15,
    competition: 0,
  },
  maxRiskPenaltyMultiplier: 0.5,
  minDimensionsKnown: 2,
  bandHighMin: 0.75,
  bandLowMax: 0.4,
} as const;

export const DIMENSION_WEIGHTS_REGISTRY: ReadonlyArray<DimensionWeights> = [
  COMMERCIAL_BRAIN_WEIGHTS_V1,
] as const;

let activeWeights: DimensionWeights = COMMERCIAL_BRAIN_WEIGHTS_V1;

export function getDimensionWeights(): DimensionWeights {
  return activeWeights;
}

/** Apenas para testes governados: trocar o registry ativo. */
export function setDimensionWeightsForTests(next: DimensionWeights): void {
  activeWeights = next;
}
export function resetDimensionWeightsForTests(): void {
  activeWeights = COMMERCIAL_BRAIN_WEIGHTS_V1;
}

export function validateDimensionWeights(weights: DimensionWeights): string | null {
  const entries = Object.entries(weights.weights);
  if (entries.length === 0) {
    return "weights_empty";
  }
  const sum = entries.reduce((acc, [, v]) => acc + (typeof v === "number" ? v : Number.NaN), 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-6) {
    return "weights_sum_must_be_1";
  }
  if (weights.maxRiskPenaltyMultiplier <= 0 || weights.maxRiskPenaltyMultiplier > 1) {
    return "invalid_max_risk_penalty";
  }
  if (weights.minDimensionsKnown < 1) {
    return "invalid_min_dimensions";
  }
  if (weights.bandLowMax < 0 || weights.bandHighMin > 1 || weights.bandHighMin <= weights.bandLowMax) {
    return "invalid_band_thresholds";
  }
  return null;
}
