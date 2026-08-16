import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANALYSIS_WINDOWS,
  COMMERCIAL_BRAIN_VERSION,
  CONFIDENCE_MODEL_VERSION,
  CONFIDENCE_SCORE_BY_LEVEL,
  PRIORITY_MODEL_VERSION,
  EVIDENCE_MODEL_VERSION,
  validateArtifactId,
  assertCleanCommercialVocabulary,
  OPPORTUNITY_SIGNAL_TYPES,
  RISK_SIGNAL_TYPES,
  REVIEW_DEADLINE_HOURS,
  windowDurationMs,
  type Signal,
  type Evidence,
  type ConfidenceFactors,
} from "../server/commercialBrain/types";

import {
  median,
  computeBaseline,
  computePercentDelta,
  formatPercentDelta,
  formatAbsoluteDelta,
  deriveConfidence,
  confidenceToScore,
  computePriority,
  analyzeDivergence,
  analyzeOutlier,
  checkEvidenceSufficiency,
  checkStaleness,
  categoryOf,
  reviewDeadlineMs,
} from "../server/commercialBrain/formulas";

import {
  decideOpportunity,
  decideRisk,
  buildOpportunity,
  buildRisk,
  buildRecommendation,
  buildEvidence,
  defaultSuggestedAction,
  computePriorityBreakdownFromSignal,
  validateSignalId,
  validateRecommendationId,
} from "../server/commercialBrain/rules";

// ----------------------------------------------------------------------------
// Fixtures determinísticas (nunca usam dados de produção)
// ----------------------------------------------------------------------------
const EVALUATED_AT = "2026-08-15T20:00:00.000Z";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: "sig-20260815-1",
    analysisVersion: COMMERCIAL_BRAIN_VERSION,
    signalType: "PRICE_IMPROVEMENT",
    category: "price",
    productId: "REF-008",
    productRef: "REF-008",
    metric: "observed_price_brl",
    currentValue: "R$ 69,00",
    baselineValue: "R$ 79,00",
    delta: "-12,7%",
    window: "7d",
    baselineWindow: "7d",
    evidenceRefs: [
      { sourceType: "price_observation", sourceTable: "product_price_observed", sourceIds: ["obs-1", "obs-2"] },
    ],
    confidence: "HIGH",
    confidenceBasis: "base: 2 registros, sem contradição, recência ok",
    detectedAt: EVALUATED_AT,
    inputSnapshot: {
      subject: "REF-008",
      window: "7d",
      displayTz: "America/Sao_Paulo",
      recordCount: 2,
      evaluatedAt: EVALUATED_AT,
    },
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: "ev-1",
    sourceType: "price_observation",
    sourceTable: "product_price_observed",
    sourceIds: ["obs-1"],
    metric: "observed_price_brl",
    value: "R$ 69,00",
    baseline: "R$ 79,00",
    window: "7d",
    observedAt: EVALUATED_AT,
    evidenceVersion: EVIDENCE_MODEL_VERSION,
    ...overrides,
  };
}

const nowFn = () => EVALUATED_AT;

// ============================================================================
// 1. Signal válido
// ============================================================================
describe("Signal — contrato", () => {
  it("ids seguem o padrão sig-YYYYMMDD-N e são validados", () => {
    assert.ok(validateSignalId("sig-20260815-1").ok);
    assert.ok(validateSignalId("sig-20260815-42").ok);
    assert.equal(validateSignalId("rec-20260815-1").ok, false); // prefixo errado
    assert.equal(validateArtifactId("sig-2026-1", "sig").ok, false);
  });

  it("carrega analysis_version em todos os artefatos", () => {
    const s = makeSignal();
    assert.equal(s.analysisVersion, "commercial_brain_v1");
    assert.equal(COMMERCIAL_BRAIN_VERSION, "commercial_brain_v1");
    assert.equal(PRIORITY_MODEL_VERSION, "priority_model_v1");
    assert.equal(CONFIDENCE_MODEL_VERSION, "confidence_model_v1");
    assert.equal(EVIDENCE_MODEL_VERSION, "evidence_model_v1");
  });

  it("catálogo fechado de signal_types separa oportunidades e riscos", () => {
    assert.deepEqual(OPPORTUNITY_SIGNAL_TYPES, [
      "PRICE_IMPROVEMENT",
      "PRICE_BELOW_CANONICAL",
      "AVAILABILITY_IMPROVEMENT",
      "SOURCE_CONVERGENCE",
      "INTEREST_ABOVE_BASELINE",
    ]);
    assert.deepEqual(RISK_SIGNAL_TYPES, [
      "PRICE_DETERIORATION",
      "AVAILABILITY_RISK",
      "SOURCE_DIVERGENCE",
      "PRICE_OUTLIER",
      "INTEREST_BELOW_BASELINE",
      "OBSERVATION_STALE",
    ]);
    assert.equal(OPPORTUNITY_SIGNAL_TYPES.filter((t) => RISK_SIGNAL_TYPES.includes(t)).length, 0);
  });
});

// ============================================================================
// 2. Evidence rastreável (ponteiro, nunca raw content)
// ============================================================================
describe("Evidence — rastreabilidade", () => {
  it("buildEvidence produz ponteiro versionado com fields completos", () => {
    const ev = buildEvidence({
      evidenceId: "ev-1",
      sourceType: "price_observation",
      sourceTable: "product_price_observed",
      sourceIds: ["obs-1"],
      metric: "observed_price_brl",
      value: "R$ 69,00",
      baseline: "R$ 79,00",
      window: "7d",
      observedAt: EVALUATED_AT,
    });
    assert.equal(ev.sourceTable, "product_price_observed");
    assert.equal(ev.evidenceVersion, EVIDENCE_MODEL_VERSION);
    assert.equal(ev.value, "R$ 69,00");
    assert.equal(ev.baseline, "R$ 79,00");
  });

  it("vocabulário comercial não sustentado é rejeitado", () => {
    assert.ok(assertCleanCommercialVocabulary("interesse acima da baseline").ok);
    assert.equal(assertCleanCommercialVocabulary("aumenta a receita").ok, false);
    assert.equal(assertCleanCommercialVocabulary("garante lucro").ok, false);
    assert.equal(assertCleanCommercialVocabulary("ROI de 15%").ok, false);
  });
});

// ============================================================================
// 3/4. Opportunity e Risk — critérios objetivos
// ============================================================================
describe("Opportunity — critérios", () => {
  it("qualifica quando: tipo no catálogo, >=2 registros, HIGH/MEDIUM, recência ok", () => {
    const decision = decideOpportunity({ signal: makeSignal(), lastEvidenceAgeDays: 1 });
    assert.equal(decision.qualified, true);
    assert.equal(decision.status, "ACTIVE");
  });

  it("PARKED com tipo fora do catálogo de oportunidades", () => {
    const decision = decideOpportunity({
      signal: makeSignal({ signalType: "PRICE_DETERIORATION" }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, false);
    assert.equal(decision.status, "PARKED");
  });

  it("PARKED com registros insuficientes (<2)", () => {
    const decision = decideOpportunity({
      signal: makeSignal({
        evidenceRefs: [{ sourceType: "click", sourceTable: "product_clicks", sourceIds: ["c1"] }],
      }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, false);
  });

  it("PARKED com confidence LOW/INSUFFICIENT_EVIDENCE", () => {
    const decision = decideOpportunity({
      signal: makeSignal({ confidence: "LOW" }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, false);
    assert.equal(decision.status, "PARKED");
  });

  it("PARKED com evidência antiga (>7d)", () => {
    const decision = decideOpportunity({
      signal: makeSignal(),
      lastEvidenceAgeDays: 10,
    });
    assert.equal(decision.qualified, false);
  });

  it("exceção honesta: PRICE_BELOW_CANONICAL qualifica com 1 registro", () => {
    const decision = decideOpportunity({
      signal: makeSignal({
        signalType: "PRICE_BELOW_CANONICAL",
        evidenceRefs: [{ sourceType: "price_observation", sourceTable: "product_price_observed", sourceIds: ["obs-1"] }],
      }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, true);
  });

  it("buildOpportunity retorna null quando desqualificado", () => {
    const opp = buildOpportunity({
      opportunityId: "opp-20260815-1",
      signal: makeSignal({ confidence: "LOW" }),
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.equal(opp, null);
  });

  it("buildOpportunity retorna artefato completo quando qualificado", () => {
    const opp = buildOpportunity({
      opportunityId: "opp-20260815-1",
      signal: makeSignal(),
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.notEqual(opp, null);
    assert.equal(opp!.status, "ACTIVE");
    assert.equal(opp!.priority.modelVersion, PRIORITY_MODEL_VERSION);
    assert.equal(opp!.createdAt, EVALUATED_AT);
  });
});

describe("Risk — critérios", () => {
  it("qualifica AVAILABILITY_RISK com 1 registro", () => {
    const decision = decideRisk({
      signal: makeSignal({ signalType: "AVAILABILITY_RISK" }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, true);
    assert.equal(decision.status, "ACTIVE");
  });

  it("OBSERVATION_STALE qualifica mesmo sem evidência recente (risco de manutenção)", () => {
    const decision = decideRisk({
      signal: makeSignal({ signalType: "OBSERVATION_STALE", evidenceRefs: [] }),
      lastEvidenceAgeDays: 30,
    });
    assert.equal(decision.qualified, true);
    assert.match(decision.criteria[1], /evidência desatualizada/);
  });

  it("RETIRED com tipo fora do catálogo de riscos", () => {
    const decision = decideRisk({
      signal: makeSignal({ signalType: "PRICE_IMPROVEMENT" }),
      lastEvidenceAgeDays: 1,
    });
    assert.equal(decision.qualified, false);
  });

  it("RETIRED com evidência antiga (>7d) para riscos de produto", () => {
    const decision = decideRisk({
      signal: makeSignal({ signalType: "AVAILABILITY_RISK" }),
      lastEvidenceAgeDays: 10,
    });
    assert.equal(decision.qualified, false);
  });

  it("buildRisk retorna artefato com confidence_basis obrigatório", () => {
    const risk = buildRisk({
      riskId: "risk-20260815-1",
      signal: makeSignal({ signalType: "AVAILABILITY_RISK", confidence: "LOW", confidenceBasis: "registro único" }),
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.notEqual(risk, null);
    assert.match(risk!.confidenceBasis, /registro único/);
  });
});

// ============================================================================
// 5. Priority — fórmula versionada
// ============================================================================
describe("Priority — priority_model_v1", () => {
  it("aplica M*0.30 + C*0.25 + R*0.20 + I*0.15 + E*0.10", () => {
    const p = computePriority({
      deltaAbs: 0.127,
      confidence: "HIGH",
      ageDays: 1,
      category: "price",
      recordCount: 2,
    });
    // M=min(1,0.127/0.20)=0.635; C=1.0; R=1-1/14=0.929; I=0.9; E=2/5=0.4
    const expected =
      Math.round(Math.min(1, 0.127 / 0.2) * 1000) / 1000 * 0.3 +
      1.0 * 0.25 +
      Math.round(Math.max(0, 1 - 1 / 14) * 1000) / 1000 * 0.2 +
      0.9 * 0.15 +
      (2 / 5) * 0.1;
    assert.equal(p.score, Math.round(expected * 1000) / 1000);
    assert.equal(p.level, "HIGH");
    assert.equal(p.modelVersion, PRIORITY_MODEL_VERSION);
  });

  it("INSUFFICIENT_EVIDENCE força score 0 e NO_ACTION", () => {
    const p = computePriority({
      deltaAbs: 0.5,
      confidence: "INSUFFICIENT_EVIDENCE",
      ageDays: 0,
      category: "price",
      recordCount: 100,
    });
    assert.equal(p.score, 0);
    assert.equal(p.level, "NO_ACTION");
  });

  it("faixas: >=0.75 HIGH, >=0.45 MEDIUM, <0.45 LOW", () => {
    assert.equal(computePriority({ deltaAbs: 0.2, confidence: "HIGH", ageDays: 0, category: "price", recordCount: 5 }).level, "HIGH");
    assert.equal(computePriority({ deltaAbs: 0, confidence: "LOW", ageDays: 10, category: "source", recordCount: 1 }).level, "LOW");
  });

  it("recência zera após 14 dias", () => {
    const p = computePriority({
      deltaAbs: 0.2,
      confidence: "HIGH",
      ageDays: 14,
      category: "price",
      recordCount: 5,
    });
    assert.equal(p.recency, 0);
  });

  it("magnitude satura em 20% de delta", () => {
    const p = computePriority({
      deltaAbs: 0.99,
      confidence: "HIGH",
      ageDays: 0,
      category: "price",
      recordCount: 5,
    });
    assert.equal(p.magnitude, 1);
  });

  it("delta null zera magnitude sem falhar", () => {
    const p = computePriority({
      deltaAbs: null,
      confidence: "HIGH",
      ageDays: 0,
      category: "interest",
      recordCount: 3,
    });
    assert.equal(p.magnitude, 0);
    assert.ok(p.level === "HIGH" || p.level === "MEDIUM");
  });

  it("computePriorityBreakdownFromSignal deriva do signal completo", () => {
    const signal = makeSignal();
    const p = computePriorityBreakdownFromSignal(signal);
    assert.equal(p.modelVersion, PRIORITY_MODEL_VERSION);
    assert.ok(p.score > 0);
  });
});

// ============================================================================
// 6. Confidence — categorical + WORST WINS
// ============================================================================
describe("Confidence — confidence_model_v1", () => {
  it("HIGH com base sólida (>=3 registros, sem contradição, recente)", () => {
    const r = deriveConfidence({
      recordCount: 5,
      singleSource: false,
      collectionConfidence: ["HIGH", "HIGH", "MEDIUM"],
      ageDays: 2,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "HIGH");
  });

  it("MEDIUM com fonte única sem confirmação", () => {
    const r = deriveConfidence({
      recordCount: 4,
      singleSource: true,
      collectionConfidence: ["HIGH"],
      ageDays: 1,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "MEDIUM");
  });

  it("MEDIUM com <3 registros", () => {
    const r = deriveConfidence({
      recordCount: 2,
      singleSource: false,
      collectionConfidence: ["HIGH", "HIGH"],
      ageDays: 1,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "MEDIUM");
  });

  it("LOW com evidência >7d", () => {
    const r = deriveConfidence({
      recordCount: 5,
      singleSource: false,
      collectionConfidence: ["HIGH"],
      ageDays: 8,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "LOW");
  });

  it("LOW com contradição não resolvida", () => {
    const r = deriveConfidence({
      recordCount: 5,
      singleSource: false,
      collectionConfidence: ["HIGH"],
      ageDays: 1,
      unresolvedContradiction: true,
    });
    assert.equal(r.confidence, "LOW");
  });

  it("LOW com coleta LOW/INCONCLUSIVE", () => {
    const r = deriveConfidence({
      recordCount: 5,
      singleSource: false,
      collectionConfidence: ["HIGH", "INCONCLUSIVE"],
      ageDays: 1,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "LOW");
  });

  it("INSUFFICIENT_EVIDENCE sem registros", () => {
    const r = deriveConfidence({
      recordCount: 0,
      singleSource: false,
      collectionConfidence: [],
      ageDays: 0,
      unresolvedContradiction: false,
    });
    assert.equal(r.confidence, "INSUFFICIENT_EVIDENCE");
    assert.equal(confidenceToScore("INSUFFICIENT_EVIDENCE"), 0);
  });

  it("worst wins: idade alta + contradição ainda LOW, nunca sobe", () => {
    const r = deriveConfidence({
      recordCount: 5,
      singleSource: false,
      collectionConfidence: ["HIGH"],
      ageDays: 20,
      unresolvedContradiction: true,
    });
    assert.equal(r.confidence, "LOW");
  });

  it("confidence_basis registra os fatores aplicados", () => {
    const r = deriveConfidence({
      recordCount: 1,
      singleSource: true,
      collectionConfidence: ["LOW"],
      ageDays: 10,
      unresolvedContradiction: true,
    });
    assert.match(r.confidenceBasis, /menos de 3 registros|fonte única/);
    assert.match(r.confidenceBasis, />7d/);
    assert.match(r.confidenceBasis, /contradição/);
    assert.match(r.confidenceBasis, /LOW\/INCONCLUSIVE/);
    assert.equal(r.confidence, "LOW");
  });
});

// ============================================================================
// 7. Recommendation — artefato estruturado sem execução
// ============================================================================
describe("Recommendation — RECOMMENDATION != ACTION", () => {
  it("gera artefato completo com todos os campos obrigatórios", () => {
    const rec = buildRecommendation({
      recommendationId: "rec-20260815-1",
      signal: makeSignal(),
      evidence: [makeEvidence()],
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.equal(rec.analysisVersion, "commercial_brain_v1");
    assert.equal(rec.scoringVersion, "priority_model_v1");
    assert.equal(rec.confidenceVersion, "confidence_model_v1");
    assert.equal(rec.subjectRef, "REF-008");
    assert.ok(rec.reviewDeadline > rec.createdAt);
    assert.equal(rec.priority, "HIGH");
    assert.ok(rec.baselineStatement.length > 0);
  });

  it("ids seguem rec-YYYYMMDD-N", () => {
    assert.ok(validateRecommendationId("rec-20260815-7").ok);
    assert.equal(validateRecommendationId("sig-20260815-7").ok, false);
  });

  it("review_deadline respeita D-5: 48h HIGH / 7d MEDIUM / 14d LOW", () => {
    assert.equal(REVIEW_DEADLINE_HOURS.HIGH, 48);
    assert.equal(REVIEW_DEADLINE_HOURS.MEDIUM, 7 * 24);
    assert.equal(REVIEW_DEADLINE_HOURS.LOW, 14 * 24);

    const recHigh = buildRecommendation({
      recommendationId: "rec-20260815-2",
      signal: makeSignal(),
      evidence: [makeEvidence()],
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    const deadlineMs = new Date(recHigh.reviewDeadline).getTime() - new Date(nowFn()).getTime();
    assert.equal(deadlineMs, 48 * 60 * 60 * 1000);
  });

  it("OBSERVATION_STALE vira recomendação de manutenção", () => {
    const rec = buildRecommendation({
      recommendationId: "rec-20260815-3",
      signal: makeSignal({ signalType: "OBSERVATION_STALE" }),
      evidence: [],
      lastEvidenceAgeDays: 30,
      now: nowFn,
    });
    assert.equal(rec.type, "maintenance");
    assert.equal(rec.category, "OBSERVATION_STALE");
    assert.equal(rec.subjectRef, "REF-008");
  });

  it("sinal com confidence INSUFFICIENT_EVIDENCE força NO_ACTION", () => {
    const rec = buildRecommendation({
      recommendationId: "rec-20260815-3b",
      signal: makeSignal({ confidence: "INSUFFICIENT_EVIDENCE" }),
      evidence: [makeEvidence()],
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.equal(rec.priority, "NO_ACTION");
    assert.equal(rec.priorityScore, 0);
  });

  it("vocabulary gate bloqueia sugestão com vocabulário de receita/lucro", () => {
    assert.throws(() =>
      buildRecommendation({
        recommendationId: "rec-20260815-4",
        signal: makeSignal({ confidenceBasis: "garante lucro" }),
        evidence: [makeEvidence()],
        lastEvidenceAgeDays: 1,
        now: nowFn,
      }),
    );
    assert.throws(() =>
      buildRecommendation({
        recommendationId: "rec-20260815-5",
        signal: makeSignal({ currentValue: "aumenta a receita" }),
        evidence: [makeEvidence()],
        lastEvidenceAgeDays: 1,
        now: nowFn,
      }),
    );
  });

  it("defaultSuggestedAction cobre todos os signal_types sem executar nada", () => {
    for (const t of [...OPPORTUNITY_SIGNAL_TYPES, ...RISK_SIGNAL_TYPES]) {
      const action = defaultSuggestedAction(makeSignal({ signalType: t }));
      assert.ok(action.length > 10);
      assert.ok(assertCleanCommercialVocabulary(action).ok, `vocabulário proibido em ${t}`);
    }
  });
});

// ============================================================================
// 11/12. Baseline e delta
// ============================================================================
describe("Baseline — mediana da janela anterior", () => {
  it("computa a mediana da janela anterior corretamente", () => {
    // avaliada 2026-08-15; janela 7d; baseline window = 2026-08-01..2026-08-08
    const values = [
      { value: 80, observedAt: "2026-08-02T10:00:00Z" },
      { value: 78, observedAt: "2026-08-03T10:00:00Z" },
      { value: 82, observedAt: "2026-08-05T10:00:00Z" },
      { value: 100, observedAt: "2026-08-12T10:00:00Z" }, // dentro da janela atual, ignorada
    ];
    const baseline = computeBaseline(values, "7d", new Date(EVALUATED_AT));
    assert.equal(baseline, 80); // mediana de [78,80,82]
  });

  it("retorna null sem valores suficientes (sem imputação)", () => {
    const baseline = computeBaseline([], "7d", new Date(EVALUATED_AT));
    assert.equal(baseline, null);
  });

  it("lifetime não tem baseline temporal", () => {
    assert.equal(computeBaseline([{ value: 5, observedAt: "2026-01-01Z" }], "lifetime", new Date(EVALUATED_AT)), null);
  });

  it("delta percentual com baseline válida", () => {
    const delta = computePercentDelta(184, 134);
    assert.ok(delta !== null && Math.abs(delta - (184 - 134) / 134) < 1e-9);
    assert.match(formatPercentDelta(delta), /\+37,3%/);
  });

  it("delta nulo quando baseline é 0 (proibido fabricar queda garantida)", () => {
    assert.equal(computePercentDelta(100, 0), null);
    assert.equal(formatPercentDelta(null), "sem baseline disponível");
  });

  it("delta absoluto formatado em BRL", () => {
    assert.match(formatAbsoluteDelta(69, 79), /−?R\$/);
    assert.match(formatAbsoluteDelta(69, null), /sem baseline/);
  });
});

// ============================================================================
// 13. Janelas temporais
// ============================================================================
describe("Janelas temporais", () => {
  it("janelas fixas com duração determinística em UTC", () => {
    assert.deepEqual(ANALYSIS_WINDOWS, ["24h", "7d", "30d", "lifetime"]);
    assert.equal(windowDurationMs("24h"), 24 * 3600 * 1000);
    assert.equal(windowDurationMs("7d"), 7 * 24 * 3600 * 1000);
    assert.equal(windowDurationMs("30d"), 30 * 24 * 3600 * 1000);
    assert.equal(windowDurationMs("lifetime"), Infinity);
  });
});

// ============================================================================
// 12. Insufficient evidence
// ============================================================================
describe("Insufficient evidence — regras", () => {
  it("detecta ausência de baseline obrigatório", () => {
    const r = checkEvidenceSufficiency({
      recordCount: 2,
      metricExists: true,
      hasBaseline: false,
      baselineRequired: true,
    });
    assert.equal(r.insufficient, true);
    assert.match(r.reasons[0], /baseline obrigatório ausente/);
  });

  it("detecta métrica inexistente e janela vazia", () => {
    assert.equal(checkEvidenceSufficiency({ recordCount: 0, metricExists: true, hasBaseline: true, baselineRequired: true }).insufficient, true);
    assert.equal(checkEvidenceSufficiency({ recordCount: 5, metricExists: false, hasBaseline: true, baselineRequired: true }).insufficient, true);
  });

  it("detecta dados antigos além do frescor", () => {
    const r = checkEvidenceSufficiency({
      recordCount: 3,
      metricExists: true,
      hasBaseline: true,
      baselineRequired: false,
      maxAgeDays: 15,
      freshnessDaysLimit: 7,
    });
    assert.equal(r.insufficient, true);
    assert.match(r.reasons[0], /frescor/);
  });

  it("suficiente quando tudo ok", () => {
    const r = checkEvidenceSufficiency({
      recordCount: 3,
      metricExists: true,
      hasBaseline: true,
      baselineRequired: true,
      maxAgeDays: 2,
      freshnessDaysLimit: 7,
    });
    assert.equal(r.insufficient, false);
  });
});

// ============================================================================
// 13. Divergência entre fontes — banda ±10%
// ============================================================================
describe("Divergência — banda ±10% (D-6)", () => {
  it("convergência: todas dentro da banda da mediana", () => {
    const r = analyzeDivergence([
      { source: "Shopee", value: 69 },
      { source: "ML", value: 72 },
      { source: "Shopee2", value: 70 },
    ]);
    assert.equal(r.diverges, false);
    assert.equal(r.median, 70);
    assert.equal(r.convergentSources.length, 3);
  });

  it("divergência registrada com mediana preservada (exemplo R$69/R$89/R$72)", () => {
    const r = analyzeDivergence([
      { source: "Shopee", value: 69 },
      { source: "MercadoLivre", value: 89 },
      { source: "Shopee2", value: 72 },
    ]);
    assert.equal(r.diverges, true);
    assert.equal(r.median, 72);
    assert.equal(r.divergentSources.length, 1);
    assert.equal(r.divergentSources[0].source, "MercadoLivre");
    assert.equal(r.convergentSources.length, 2);
  });

  it("banda exata de ±10% da mediana", () => {
    const r = analyzeDivergence([{ source: "A", value: 100 }, { source: "B", value: 110 }]);
    assert.equal(r.median, 105);
    assert.equal(r.bandMin, 105 * 0.9);
    assert.equal(r.bandMax, 105 * 1.1);
    assert.equal(r.diverges, false); // 110 está dentro da banda de 105 ± 10%
  });

  it("banda exata de ±10% com valor claramente fora (mediana conhecida)", () => {
    const r = analyzeDivergence([
      { source: "A", value: 100 },
      { source: "B", value: 100 },
      { source: "B", value: 100 },
      { source: "C", value: 130 },
    ]);
    assert.equal(r.median, 100);
    assert.equal(r.diverges, true);
    assert.equal(r.divergentSources.length, 1);
  });
});

// ============================================================================
// 14. Outliers — IQR e banda mediana
// ============================================================================
describe("Outliers — IQR 1,5x / banda ±50% (D-6)", () => {
  it("detecta outlier de preço (histórico 70–80, observação 1)", () => {
    const v = analyzeOutlier(1, [70, 72, 75, 78, 80]);
    assert.equal(v.isOutlier, true);
  });

  it("não detecta valor dentro do padrão", () => {
    const v = analyzeOutlier(74, [70, 72, 75, 78, 80]);
    assert.equal(v.isOutlier, false);
  });

  it("histórico curto não acusa outlier (sem conclusão fabricada)", () => {
    const v = analyzeOutlier(1, [75]);
    assert.equal(v.isOutlier, false);
  });
});

// ============================================================================
// 15. Observação antiga — OBSERVATION_STALE (D-7)
// ============================================================================
describe("Observação antiga — risco de manutenção (D-7)", () => {
  it("stale quando última observação > 7 dias", () => {
    const r = checkStaleness("2026-08-01T00:00:00Z", new Date("2026-08-15T00:00:00Z"));
    assert.equal(r.stale, true);
  });

  it("não stale dentro do limite", () => {
    const r = checkStaleness("2026-08-13T00:00:00Z", new Date("2026-08-15T00:00:00Z"));
    assert.equal(r.stale, false);
  });

  it("null (nunca observado) = stale com idade infinita", () => {
    const r = checkStaleness(null, new Date("2026-08-15T00:00:00Z"));
    assert.equal(r.stale, true);
    assert.equal(r.ageDays, Infinity);
  });
});

// ============================================================================
// Determinismo e versionamento
// ============================================================================
describe("Determinismo e versionamento", () => {
  it("mesmo input + mesma versão = mesmo output (reexecução idêntica)", () => {
    const signal = makeSignal();
    const run = () => ({
      p: computePriorityBreakdownFromSignal(signal),
      rec: buildRecommendation({
        recommendationId: "rec-20260815-9",
        signal,
        evidence: [makeEvidence()],
        lastEvidenceAgeDays: 1,
        now: nowFn,
      }),
    });
    const a = run();
    const b = run();
    assert.deepEqual(a.p, b.p);
    assert.equal(a.rec.priorityScore, b.rec.priorityScore);
    assert.equal(a.rec.confidence, b.rec.confidence);
  });

  it("nenhum artefato escapa sem version", () => {
    const rec = buildRecommendation({
      recommendationId: "rec-20260815-10",
      signal: makeSignal(),
      evidence: [makeEvidence()],
      lastEvidenceAgeDays: 1,
      now: nowFn,
    });
    assert.ok(rec.analysisVersion);
    assert.ok(rec.scoringVersion);
    assert.ok(rec.confidenceVersion);
    assert.equal(rec.evidence[0].evidenceVersion, EVIDENCE_MODEL_VERSION);
  });
});

// ============================================================================
// Ausência de mutação e ausência de execução (contrato, não runtime de banco)
// ============================================================================
describe("Ausência de mutação / execução", () => {
  it("módulos do contrato não expõem nenhuma função de mutação ou execução", async () => {
    const types = await import("../server/commercialBrain/types");
    const formulas = await import("../server/commercialBrain/formulas");
    const rules = await import("../server/commercialBrain/rules");

    const allExports = Object.keys({ ...types, ...formulas, ...rules });
    const bannedPatterns = [/execute/i, /mutate/i, /publish/i, /apply/i, /approve/i, /runAction/i];
    const violating = allExports.filter((name) =>
      bannedPatterns.some((re) => re.test(name)),
    );
    assert.deepEqual(violating, [], `exports com caráter de execução: ${violating.join(",")}`);
  });

  it("CONFIDENCE_SCORE_BY_LEVEL cobre as quatro categorias sem percentuais arbitrários", () => {
    assert.deepEqual(CONFIDENCE_SCORE_BY_LEVEL, {
      HIGH: 1.0,
      MEDIUM: 0.6,
      LOW: 0.3,
      INSUFFICIENT_EVIDENCE: 0.0,
    });
  });
});

// ----------------------------------------------------------------------------
// categoryOf cobre todos os tipos
// ----------------------------------------------------------------------------
describe("categoryOf", () => {
  it("mapeia todos os signal_types", () => {
    const types: import("../server/commercialBrain/types").SignalType[] = [
      ...OPPORTUNITY_SIGNAL_TYPES,
      ...RISK_SIGNAL_TYPES,
    ];
    for (const t of types) {
      assert.ok(["price", "availability", "source", "interest", "freshness"].includes(categoryOf(t)));
    }
  });
});
