/**
 * Cerberus Finds Archive — Bloco 17 — Rigor Estatístico
 * Módulo `statistical_rigor_v1` (PRÉ-REQUISITO do cockpit comercial).
 *
 * Regras aprovadas no Bloco 17:
 *   1. Amostra mínima DERIVADA (não pré-aprovada): n por experimento vem de
 *      tamanho de efeito assumido (MDE), poder estatístico (1-β) e nível de
 *      significância (α), para o teste escolhido — teste z de duas
 *      proporções (taxa de clique entre duas variantes).
 *   2. Abaixo da amostra mínima, confidence NUNCA passa de LOW.
 *   3. Múltiplas comparações: quando uma lista de oportunidades é avaliada
 *      simultaneamente, aplicar Benjamini-Hochberg (controle de FDR) sobre
 *      os p-values antes de classificar qualquer item como "elevado".
 *
 * Fronteiras:
 *   CLICKE != EXPOSURE — o sistema não registra exposições (denominador
 *   canônico de CTR). Cliques isolados são contagens de interesse (proxy),
 *   nunca taxa de clique real. O módulo trata contagens de clique como
 *   taxa de clique aproximada SOMENTE quando o design do experimento
 *   declara o denominador (exposições) ou usa grupos de tamanho igual.
 *
 * Pura e determinística: mesmo input = mesmo output. Sem mutação, sem banco.
 */

import {
  CONFIDENCE_SCORE_BY_LEVEL,
  SignalConfidence,
} from "./types";

export const STATISTICAL_RIGOR_VERSION = "statistical_rigor_v1" as const;
export type StatisticalRigorVersion = typeof STATISTICAL_RIGOR_VERSION;

// ============================================================================
// Parâmetros de projeto do teste (declarados ANTES de qualquer experimento)
// ============================================================================
/** Nível de significância (probabilidade de falso positivo por teste). */
export const DEFAULT_ALPHA = 0.05 as const;
/** Poder estatístico desejado (1 − β; probabilidade de detectar o MDE se real). */
export const DEFAULT_POWER = 0.8 as const;
/** FDR alvo para a correção de múltiplas comparações (Benjamini-Hochberg). */
export const DEFAULT_FDR = 0.1 as const;
/** Delta mínimo relevante RELATIVO (proporção B − proporção A) / proporção A.
 *  +50% relativo = se A clica 2%, B precisa clicar ≥ 3% para ser "elevação
 *  comercialmente relevante" em vez de ruído estatístico. */
export const DEFAULT_MDE_RELATIVE = 0.5 as const;
/** Proporção base implícita usada quando o experimento não declara baseline.
 *  2% é ponto de partida conservador p/ cliques em tráfego frio; um
 *  experimento pode declarar seu próprio baseline (mais bem informado
 *  → n menor). */
export const DEFAULT_BASELINE_PROPORTION = 0.02 as const;

export interface SampleSizeParams {
  alpha?: number;
  power?: number;
  mdeRelative?: number;
  baselineProportion?: number;
}

export interface SampleSizeResult {
  /** n por variante (arredondado para cima). */
  nPerVariant: number;
  /** n total do experimento (2 variantes). */
  nTotal: number;
  /** Parâmetros usados — garante reprodutibilidade da derivação. */
  params: { alpha: number; power: number; mdeRelative: number; baselineProportion: number };
  /** Versão do modelo de derivação. */
  rigorVersion: StatisticalRigorVersion;
}

// ============================================================================
// 1. Derivação da amostra mínima — teste z de duas proporções
// ============================================================================
/**
 * Inversa da normal padrão — aproximação de Abramowitz & Stegun 26.2.23
 * (precisão ~4.5e-4, suficiente para design de experimento).
 */
function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const sign = p < 0.5 ? -1 : 1;
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  return sign * (t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t));
}

/**
 * Deriva o tamanho de amostra mínimo por variante para detectar um efeito
 * relativo (MDE) numa taxa de clique, com poder e α declarados.
 *
 * Fórmula (teste z bilateral de duas proporções, varianças sob H0 e H1):
 *   n = [ z_(α/2)√(2·p̄·(1−p̄)) + z_(β)√(pA(1−pA) + pB(1−pB)) ]² / (pB−pA)²
 * com pB = pA·(1 + mdeRelative).
 *
 * Se mdeRelative ≤ 0 ou baseline fora de (0,1), lança erro — parâmetros
 * de design inválidos nunca produzem número silencioso.
 */
export function deriveMinSampleSize(
  params: SampleSizeParams = {},
): SampleSizeResult {
  const alpha = params.alpha ?? DEFAULT_ALPHA;
  const power = params.power ?? DEFAULT_POWER;
  const mdeRelative = params.mdeRelative ?? DEFAULT_MDE_RELATIVE;
  const baselineProportion = params.baselineProportion ?? DEFAULT_BASELINE_PROPORTION;

  if (!(alpha > 0 && alpha < 1)) throw new Error("alpha fora de (0,1)");
  if (!(power > 0 && power < 1)) throw new Error("power fora de (0,1)");
  if (!(mdeRelative > 0)) throw new Error("mdeRelative deve ser > 0 (efeito positivo)");
  if (!(baselineProportion > 0 && baselineProportion < 1)) {
    throw new Error("baselineProportion fora de (0,1)");
  }

  const pA = baselineProportion;
  const pB = pA * (1 + mdeRelative);
  if (pB >= 1) throw new Error("pB >= 1 com este baseline/MDE — declare baseline menor ou MDE menor");
  const pBar = (pA + pB) / 2;

  const zAlpha = normInv(1 - alpha / 2); // bilateral
  const zBeta = normInv(power);

  const n = Math.pow(
    zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) +
      zBeta * Math.sqrt(pA * (1 - pA) + pB * (1 - pB)),
    2,
  ) / Math.pow(pB - pA, 2);

  const nPerVariant = Math.ceil(n);
  return {
    nPerVariant,
    nTotal: nPerVariant * 2,
    params: { alpha, power, mdeRelative, baselineProportion },
    rigorVersion: STATISTICAL_RIGOR_VERSION,
  };
}

// ============================================================================
// 2. Gate de confiança — amostra mínima travada em LOW
// ============================================================================
export interface SampleGateCheck {
  /** Confiança resultante após o gate estatístico. */
  confidence: SignalConfidence;
  /** Motivo do rebaixamento (ou base de sustento). */
  confidenceBasis: string;
  /** Regra aplicada. */
  rule: "minimum_sample_unmet" | "minimum_sample_met" | "no_sample_rule";
}

/**
 * Gate aprovado no Bloco 17: se `recordCount < minSampleRequired`, a
 * confiança NUNCA sobe acima de LOW — independentemente de qualquer outro
 * fator favorável (worst wins sobre o confidence model v1/v2).
 *
 * Quando minSampleRequired é null/0 (não há regra de amostra aplicável),
 * delega intacto — este gate não inventa regra onde não existe.
 */
export function applyMinimumSampleGate(
  recordCount: number,
  minSampleRequired: number | null,
): SampleGateCheck {
  if (minSampleRequired === null || minSampleRequired <= 0) {
    return {
      confidence: "INSUFFICIENT_EVIDENCE",
      confidenceBasis: "nenhuma regra de amostra aplicável — sem amostra mínima definida",
      rule: "no_sample_rule",
    };
  }
  if (recordCount < minSampleRequired) {
    const missing = minSampleRequired - recordCount;
    return {
      confidence: recordCount < 1 ? "INSUFFICIENT_EVIDENCE" : "LOW",
      confidenceBasis:
        `amostra ${recordCount}/${minSampleRequired} (${missing} a menos) — ` +
        `abaixo da amostra mínima derivada; confiança limitada a ${recordCount < 1 ? "INSUFFICIENT_EVIDENCE" : "LOW"}`,
      rule: "minimum_sample_unmet",
    };
  }
  return {
    confidence: "MEDIUM",
    confidenceBasis: `amostra ${recordCount}/${minSampleRequired} — mínimo estatístico atingido`,
    rule: "minimum_sample_met",
  };
}

// ============================================================================
// 3. Correção para múltiplas comparações — Benjamini-Hochberg (FDR)
// ============================================================================
export interface MultipleComparisonItem {
  /** Identificador do item comparado (produto/ref). */
  subjectId: string;
  /** p-value bruto do teste (ex: z-test de proporções A vs baseline). */
  rawPValue: number;
}

export interface MultipleComparisonResult {
  /** FDR alvo usado. */
  fdr: number;
  /** Número de comparações corrigidas. */
  nComparisons: number;
  /** Itens corrigidos (com p-value ajustado). */
  adjusted: Array<{
    subjectId: string;
    rawPValue: number;
    adjustedPValue: number;
    /** Sob controle de FDR, significativo? (adjusted <= fdr). */
    survivesCorrection: boolean;
  }>;
  rigorVersion: StatisticalRigorVersion;
}

/**
 * Benjamini-Hochberg step-up sobre lista de p-values: ordena, aplica
 * adjusted[i] = min(p[i]·m/i, 1), monotoniza (adjusted não-decrescente de
 * baixo para cima) e compara contra o FDR alvo.
 *
 * Regra do cockpit (Bloco 17): um item SÓ aparece como "oportunidade com
 * sinal elevado" na lista se sobreviver à correção. Itens com p-value bruto
 * "bom" mas que não sobrevivem são exibidos como NÃO corrigidos (não
 * confiáveis em comparação simultânea).
 */
export function adjustForMultipleComparisons(
  items: MultipleComparisonItem[],
  fdr: number = DEFAULT_FDR,
): MultipleComparisonResult {
  if (!(fdr > 0 && fdr <= 1)) throw new Error("fdr fora de (0,1]");
  const m = items.length;
  if (m === 0) {
    return {
      fdr,
      nComparisons: 0,
      adjusted: [],
      rigorVersion: STATISTICAL_RIGOR_VERSION,
    };
  }

  const ordered = [...items]
    .map((it) => ({ ...it, rawPValue: Math.max(0, Math.min(1, it.rawPValue)) }))
    .sort((a, b) => a.rawPValue - b.rawPValue);

  const adjusted = ordered.map((it, i) => ({
    subjectId: it.subjectId,
    rawPValue: it.rawPValue,
    /** BH: p·(m/i), com i começando em 1. */
    adjustedPValue: Math.min(1, (it.rawPValue * m) / (i + 1)),
    survivesCorrection: false,
  }));

  // Monotonização: adjusted deve ser não-decrescente do maior p ao menor.
  for (let i = adjusted.length - 2; i >= 0; i--) {
    if (adjusted[i].adjustedPValue > adjusted[i + 1].adjustedPValue) {
      adjusted[i].adjustedPValue = adjusted[i + 1].adjustedPValue;
    }
  }

  for (const a of adjusted) {
    a.survivesCorrection = a.adjustedPValue <= fdr;
  }

  // Retornar na ordem original de entrada, preservando proveniência.
  const byId = new Map(adjusted.map((a) => [a.subjectId, a]));
  const restored = items.map((it) => {
    const a = byId.get(it.subjectId)!;
    return {
      subjectId: a.subjectId,
      rawPValue: a.rawPValue,
      adjustedPValue: a.adjustedPValue,
      survivesCorrection: a.survivesCorrection,
    };
  });

  return {
    fdr,
    nComparisons: m,
    adjusted: restored,
    rigorVersion: STATISTICAL_RIGOR_VERSION,
  };
}

// ============================================================================
// 4. Teste z de duas proporções (estatística do experimento)
// ============================================================================
export interface ProportionTestResult {
  /** z-statistic. */
  z: number;
  /** p-value bilateral. */
  pValue: number;
  /** Propores observadas. */
  pA: number;
  pB: number;
  rigorVersion: StatisticalRigorVersion;
}

/**
 * z-test bilateral de duas proporções (pooled sob H0).
 * Exige n >= 1 em cada variante; p deve estar em [0,1].
 * Não executa nada; apenas calcula.
 */
export function twoProportionZTest(params: {
  clicksA: number;
  nA: number;
  clicksB: number;
  nB: number;
}): ProportionTestResult {
  const { clicksA, nA, clicksB, nB } = params;
  if (nA < 1 || nB < 1) throw new Error("cada variante exige n >= 1 exposição");
  const pA = clicksA / nA;
  const pB = clicksB / nB;
  const pPool = (clicksA + clicksB) / (nA + nB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB));
  if (se === 0) {
    // Sem variação observada (ambas 0 ou ambas 1) — sem teste possível.
    return { z: 0, pValue: 1, pA, pB, rigorVersion: STATISTICAL_RIGOR_VERSION };
  }
  const z = (pB - pA) / se;
  // p-value bilateral via função erro (erf): P(|Z| > |z|) = 2·(1 − Φ(|z|))
  const pValue = 2 * (1 - normCDF(Math.abs(z)));
  return { z, pValue, pA, pB, rigorVersion: STATISTICAL_RIGOR_VERSION };
}

function normCDF(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Aproximação de Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7)
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// ============================================================================
// 5. Confiança agregada do cockpit (confidence_model_v2)
// ============================================================================
export interface AggregatedConfidenceParams {
  recordCount: number;
  minSampleRequired: number | null;
  /** p-value corrigido do item na comparação simultânea (BH). */
  correctedPValue?: number | null;
  /** FDR alvo da correção aplicada. */
  fdr?: number;
}

/**
 * confidence_model_v2 = worst wins sobre:
 *   v1 (record count / fonte única / idade / contradição)  →  gate de
 *   amostra mínima (LOW teto)  →  sobrevivência à correção BH.
 *
 * O cockpit NUNCA exibe confiança sem o dado bruto: o chamador deve exibir
 * "confiança: X — baseado em N cliques / D dias" junto com o minSampleRequired.
 */
export function deriveConfidenceV2(params: AggregatedConfidenceParams): {
  confidence: SignalConfidence;
  confidenceBasis: string;
} {
  const gate = applyMinimumSampleGate(params.recordCount, params.minSampleRequired);
  const maxConfidence: SignalConfidence =
    gate.rule === "minimum_sample_unmet"
      ? gate.confidence
      : "HIGH";

  let level: SignalConfidence = maxConfidence;
  const basis: string[] = [];

  if (params.correctedPValue !== null && params.correctedPValue !== undefined) {
    const fdr = params.fdr ?? DEFAULT_FDR;
    if (params.correctedPValue > fdr) {
      if (level === "HIGH") level = "LOW";
      basis.push(
        `não sobrevive à correção BH (p corrigido ${params.correctedPValue.toFixed(4)} > FDR ${fdr})`,
      );
    } else {
      basis.push(`sobrevive à correção BH (p corrigido ${params.correctedPValue.toFixed(4)} ≤ FDR ${fdr})`);
    }
  } else {
    basis.push("sem teste simultâneo aplicado (análise isolada)");
  }

  if (gate.rule === "minimum_sample_unmet") {
    basis.push(gate.confidenceBasis);
  } else if (gate.rule === "minimum_sample_met") {
    basis.push(gate.confidenceBasis);
  }

  return { confidence: level, confidenceBasis: basis.join("; ") };
}

/** Pontuação de confiança para compatibilidade com priority_model_v1. */
export function confidenceV2ToScore(confidence: SignalConfidence): number {
  return CONFIDENCE_SCORE_BY_LEVEL[confidence];
}
