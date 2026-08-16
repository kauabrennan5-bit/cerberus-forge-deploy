/**
 * Tests — Bloco 17 — `statistical_rigor_v1`.
 *
 * Cobertura obrigatória (evidence-first):
 *   1. Derivação da amostra mínima (reprodutível, determinística, erro em
 *      parâmetros inválidos).
 *   2. Gate de confiança: abaixo do mínimo NUNCA passa de LOW; sem regra,
 *      delega sem inventar.
 *   3. Benjamini-Hochberg: monotonicidade, survives/não-survive, FDR alvo.
 *   4. z-test de duas proporções: detecção, sem-efeito, sem-variação.
 *   5. deriveConfidenceV2: worst wins integrado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BASELINE_PROPORTION,
  DEFAULT_FDR,
  DEFAULT_MDE_RELATIVE,
  DEFAULT_POWER,
  DEFAULT_ALPHA,
  STATISTICAL_RIGOR_VERSION,
  adjustForMultipleComparisons,
  applyMinimumSampleGate,
  deriveConfidenceV2,
  deriveMinSampleSize,
  twoProportionZTest,
} from "../server/commercialBrain/statisticalRigor";

// ============================================================================
// 1. Derivação da amostra mínima
// ============================================================================
describe("deriveMinSampleSize", () => {
  it("deriva n determinístico com parâmetros default", () => {
    const a = deriveMinSampleSize();
    const b = deriveMinSampleSize();
    assert.equal(a.nPerVariant, b.nPerVariant);
    assert.equal(a.nTotal, a.nPerVariant * 2);
    // Referência de projeto: pA=0.02, pB=0.03 (MDE relativo +50%),
    // α=0.05 bilateral, power=0.8. Validado no caso de referência abaixo.
    assert.equal(a.params.alpha, DEFAULT_ALPHA);
    assert.equal(a.params.power, DEFAULT_POWER);
    assert.equal(a.params.mdeRelative, DEFAULT_MDE_RELATIVE);
    assert.equal(a.params.baselineProportion, DEFAULT_BASELINE_PROPORTION);
    assert.equal(a.rigorVersion, STATISTICAL_RIGOR_VERSION);
    assert.ok(a.nPerVariant > 0 && Number.isInteger(a.nPerVariant));
  });

  it("n cresce com MDE menor (efeito menor exige mais amostra)", () => {
    const big = deriveMinSampleSize({ mdeRelative: 0.5 });
    const small = deriveMinSampleSize({ mdeRelative: 0.25 });
    assert.ok(small.nPerVariant > big.nPerVariant);
  });

  it("n cresce com power maior", () => {
    const p80 = deriveMinSampleSize({ power: 0.8 });
    const p90 = deriveMinSampleSize({ power: 0.9 });
    assert.ok(p90.nPerVariant > p80.nPerVariant);
  });

  it("n cresce com alpha menor (significância mais rigorosa)", () => {
    const a05 = deriveMinSampleSize({ alpha: 0.05 });
    const a01 = deriveMinSampleSize({ alpha: 0.01 });
    assert.ok(a01.nPerVariant > a05.nPerVariant);
  });

  it("rejeita parâmetros inválidos sem produzir número silencioso", () => {
    assert.throws(() => deriveMinSampleSize({ mdeRelative: -0.5 }));
    assert.throws(() => deriveMinSampleSize({ alpha: 0 }));
    assert.throws(() => deriveMinSampleSize({ power: 1 }));
    assert.throws(() => deriveMinSampleSize({ baselineProportion: 0 }));
    assert.throws(() => deriveMinSampleSize({ baselineProportion: 1 }));
  });

  it("rejeita baseline × MDE que estouraria pB >= 1", () => {
    assert.throws(() =>
      deriveMinSampleSize({ baselineProportion: 0.95, mdeRelative: 0.5 }),
    );
  });

  it("baseline maior reduz n (mais cliques esperados = menos amostra)", () => {
    const low = deriveMinSampleSize({ baselineProportion: 0.02 });
    const high = deriveMinSampleSize({ baselineProportion: 0.1 });
    assert.ok(high.nPerVariant < low.nPerVariant);
  });

  it("resultado esperado para o caso de referência do cockpit", () => {
    // Caso de referência declarado no projeto: pA=0.02, pB=0.03 (MDE
    // relativo +50%), α=0.05 bilateral, power=0.8.
    // Derivação documentada: z(α/2)=1.959964, z(β)=0.841621, pBar=0.025
    //   n = [zα·√(2p̄(1−p̄)) + zβ·√(pA(1−pA)+pB(1−pB))]² / (pB−pA)²
    //   n = [1.959964·0.2208 + 0.841621·0.1921]² / 0.0001 ≈ 3825.3 → 3826
    const ref = deriveMinSampleSize();
    assert.equal(ref.nPerVariant, 3826);
    assert.equal(ref.nTotal, 7652);
    assert.equal(ref.params.baselineProportion, 0.02);
    assert.equal(ref.params.mdeRelative, 0.5);
  });

  it("documenta os parâmetros de projeto no resultado (reprodutibilidade)", () => {
    const ref = deriveMinSampleSize({ alpha: 0.01, power: 0.9 });
    assert.equal(ref.params.alpha, 0.01);
    assert.equal(ref.params.power, 0.9);
  });
});

// ============================================================================
// 2. Gate de confiança — amostra mínima
// ============================================================================
describe("applyMinimumSampleGate", () => {
  it("abaixo do mínimo, confiança NUNCA passa de LOW (worst wins)", () => {
    for (const n of [0, 1, 2, 100]) {
      const r = applyMinimumSampleGate(n, 1000);
      assert.ok(
        r.confidence === "LOW" || r.confidence === "INSUFFICIENT_EVIDENCE",
        `n=${n} deveria ser LOW teto`,
      );
    }
  });

  it("sem registros com regra ativa retorna INSUFFICIENT_EVIDENCE", () => {
    const r = applyMinimumSampleGate(0, 100);
    assert.equal(r.confidence, "INSUFFICIENT_EVIDENCE");
    assert.equal(r.rule, "minimum_sample_unmet");
  });

  it("regra atingida retorna MEDIUM (o v1 decide o HIGH)", () => {
    const r = applyMinimumSampleGate(1600, 1547);
    assert.equal(r.confidence, "MEDIUM");
    assert.equal(r.rule, "minimum_sample_met");
    assert.match(r.confidenceBasis, /1600\/1547/);
  });

  it("sem regra definida, delega sem inventar (não aplica teto)", () => {
    const r = applyMinimumSampleGate(5, null);
    assert.equal(r.rule, "no_sample_rule");
    assert.equal(r.confidence, "INSUFFICIENT_EVIDENCE");
  });

  it("explica quantas amostras faltam", () => {
    const r = applyMinimumSampleGate(100, 1547);
    assert.match(r.confidenceBasis, /1447 a menos/);
    assert.match(r.confidenceBasis, /100\/1547/);
  });
});

// ============================================================================
// 3. Benjamini-Hochberg — múltiplas comparações
// ============================================================================
describe("adjustForMultipleComparisons", () => {
  it("lista vazia retorna sem erro e sem itens", () => {
    const r = adjustForMultipleComparisons([]);
    assert.equal(r.nComparisons, 0);
    assert.deepEqual(r.adjusted, []);
    assert.equal(r.fdr, DEFAULT_FDR);
  });

  it("preserva a ordem original de entrada (proveniência)", () => {
    const r = adjustForMultipleComparisons([
      { subjectId: "p-1", rawPValue: 0.4 },
      { subjectId: "p-2", rawPValue: 0.01 },
      { subjectId: "p-3", rawPValue: 0.2 },
    ]);
    assert.deepEqual(
      r.adjusted.map((a) => a.subjectId),
      ["p-1", "p-2", "p-3"],
    );
  });

  it("ajustados são monotônicos e ≤ 1", () => {
    const r = adjustForMultipleComparisons([
      { subjectId: "p-1", rawPValue: 0.05 },
      { subjectId: "p-2", rawPValue: 0.01 },
      { subjectId: "p-3", rawPValue: 0.9 },
    ]);
    for (const a of r.adjusted) assert.ok(a.adjustedPValue <= 1);
    // Ordem crescente de rawPValue deve produzir adjusted não-decrescente.
    const ordered = [...r.adjusted].sort(
      (a, b) => a.rawPValue - b.rawPValue,
    );
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(ordered[i - 1].adjustedPValue <= ordered[i].adjustedPValue);
    }
  });

  it("p pequeno em 12 comparações não sobrevive a FDR 0.1 (BH rigoroso)", () => {
    // p=0.01 em m=12 → adjusted ≈ 0.01*12/1 = 0.12 > 0.10 → não sobrevive.
    const r = adjustForMultipleComparisons(
      [
        { subjectId: "hot", rawPValue: 0.01 },
        ...Array.from({ length: 11 }, (_, i) => ({
          subjectId: `cold-${i}`,
          rawPValue: 0.8 - i * 0.05,
        })),
      ],
      0.1,
    );
    const hot = r.adjusted.find((a) => a.subjectId === "hot")!;
    assert.ok(hot.adjustedPValue > 0.1);
    assert.equal(hot.survivesCorrection, false);
  });

  it("p suficientemente pequeno sobrevive à correção", () => {
    // p=0.001 em m=12 → adjusted ≈ 0.012 ≤ 0.10 → sobrevive.
    const r = adjustForMultipleComparisons(
      [
        { subjectId: "hot", rawPValue: 0.001 },
        ...Array.from({ length: 11 }, (_, i) => ({
          subjectId: `cold-${i}`,
          rawPValue: 0.9 - i * 0.05,
        })),
      ],
      0.1,
    );
    const hot = r.adjusted.find((a) => a.subjectId === "hot")!;
    assert.ok(hot.adjustedPValue <= 0.1);
    assert.equal(hot.survivesCorrection, true);
  });

  it("clampa p-value fora de [0,1] sem distorcer a lista", () => {
    const r = adjustForMultipleComparisons([
      { subjectId: "p-1", rawPValue: -5 },
      { subjectId: "p-2", rawPValue: 1.5 },
    ]);
    assert.equal(r.adjusted[0].rawPValue, 0);
    assert.equal(r.adjusted[1].rawPValue, 1);
  });

  it("rejeita FDR fora de (0,1]", () => {
    assert.throws(() => adjustForMultipleComparisons([], 0));
    assert.throws(() => adjustForMultipleComparisons([], 1.1));
  });

  it("FDR maior permite mais sobreviventes", () => {
    const items = [
      { subjectId: "p-1", rawPValue: 0.03 },
      ...Array.from({ length: 5 }, (_, i) => ({
        subjectId: `cold-${i}`,
        rawPValue: 0.9 - i * 0.1,
      })),
    ];
    const loose = adjustForMultipleComparisons(items, 0.2);
    const strict = adjustForMultipleComparisons(items, 0.05);
    const looseSurvive = loose.adjusted.filter((a) => a.survivesCorrection).length;
    const strictSurvive = strict.adjusted.filter((a) => a.survivesCorrection).length;
    assert.ok(looseSurvive >= strictSurvive);
  });
});

// ============================================================================
// 4. z-test de duas proporções
// ============================================================================
describe("twoProportionZTest", () => {
  it("detecta diferença clara entre variantes", () => {
    const r = twoProportionZTest({ clicksA: 10, nA: 1000, clicksB: 60, nB: 1000 });
    assert.ok(r.pValue < 0.001);
    assert.equal(r.pA, 0.01);
    assert.equal(r.pB, 0.06);
    assert.ok(r.z > 0);
  });

  it("não detecta diferença quando as proporções são iguais", () => {
    const r = twoProportionZTest({ clicksA: 20, nA: 1000, clicksB: 20, nB: 1000 });
    assert.ok(Math.abs(r.z) < 1e-9);
    // Sem diferença, p-value bilateral = 1 (aproximação da erf: tolerância 1e-6).
    assert.ok(Math.abs(r.pValue - 1) < 1e-6);
  });

  it("sem variação observada (ambas zero) retorna p=1 sem crash", () => {
    const r = twoProportionZTest({ clicksA: 0, nA: 500, clicksB: 0, nB: 500 });
    assert.equal(r.pValue, 1);
    assert.equal(r.z, 0);
  });

  it("rejeita variante sem exposições (denominador obrigatório)", () => {
    assert.throws(() =>
      twoProportionZTest({ clicksA: 0, nA: 0, clicksB: 10, nB: 100 }),
    );
  });

  it("é determinístico (mesmo input = mesmo output)", () => {
    const a = twoProportionZTest({ clicksA: 5, nA: 200, clicksB: 15, nB: 200 });
    const b = twoProportionZTest({ clicksA: 5, nA: 200, clicksB: 15, nB: 200 });
    assert.equal(a.pValue, b.pValue);
    assert.equal(a.z, b.z);
    assert.equal(a.rigorVersion, STATISTICAL_RIGOR_VERSION);
  });
});

// ============================================================================
// 5. deriveConfidenceV2 — worst wins integrado
// ============================================================================
describe("deriveConfidenceV2", () => {
  it("sem amostra mínima definida, delega sem teto", () => {
    const r = deriveConfidenceV2({ recordCount: 5, minSampleRequired: null });
    assert.equal(r.confidence, "HIGH");
    assert.match(r.confidenceBasis, /sem teste simultâneo/);
  });

  it("abaixo do mínimo, teto LOW mesmo com p corrigido sobrevindo", () => {
    const r = deriveConfidenceV2({
      recordCount: 10,
      minSampleRequired: 1547,
      correctedPValue: 0.001,
      fdr: 0.1,
    });
    assert.equal(r.confidence, "LOW");
    assert.match(r.confidenceBasis, /10\/1547/);
  });

  it("p corrigido acima do FDR rebaixa para LOW mesmo com amostra cheia", () => {
    const r = deriveConfidenceV2({
      recordCount: 2000,
      minSampleRequired: 1547,
      correctedPValue: 0.2,
      fdr: 0.1,
    });
    assert.equal(r.confidence, "LOW");
    assert.match(r.confidenceBasis, /sobrevive à correção BH/);
    assert.match(r.confidenceBasis, /0\.2/);
  });

  it("amostra cheia + sobrevive BH mantém HIGH", () => {
    const r = deriveConfidenceV2({
      recordCount: 2000,
      minSampleRequired: 1547,
      correctedPValue: 0.005,
      fdr: 0.1,
    });
    assert.equal(r.confidence, "HIGH");
  });

  it("exibe a amostra observada no basis (auditoria)", () => {
    const r = deriveConfidenceV2({
      recordCount: 14,
      minSampleRequired: 1547,
    });
    assert.match(r.confidenceBasis, /14\/1547/);
    assert.match(r.confidenceBasis, /1533 a menos/);
  });
});
