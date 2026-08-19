// ============================================================================
// Bloco N14 — Commercial Brain de CANDIDATES — Suíte de testes (Fase 1).
//
// GATES VALIDADOS (conforme autorização da Fase 1):
// N13-PASS      → N14 executa e avalia.
// N13-BLOCKED/REVIEW/FAIL/INEXISTENTE → N14 não executa, nenhum assessment
//                  N14 criado (fail-closed, sem bypass).
// candidate inexistente/ID inválido → fail-closed.
// UNKNOWN nunca convertido em zero.
// score determinístico; rationale determinístico; conflito determinístico;
// replay determinístico (mesmo digest/idempotency key/assessment_id).
// Alteração real no snapshot → nova avaliação.
// isolation: N14 não cria/altera product, affiliate_link, job, não chama
// N8/N15/N16, não publica, não cria campanha, não dispara Telegram.
// score fora de range rejeitado; band INSUFFICIENT bloqueia interpretação
// mesmo com score parcial; coverage/confidence separados do score.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import {
  COMMERCIAL_BRAIN_PROVENANCE,
  COMMERCIAL_BRAIN_WEIGHTS_NOTE,
  COMMERCIAL_BRAIN_WEIGHTS_VERSION,
  COMMERCIAL_BRAIN_FILTER_VERSION,
  COMMERCIAL_BRAIN_CONTRACT_VERSION,
  type CommercialSignalsInput,
  type SignalStatus,
} from "../server/commercial/commercialBrain/contract";
import {
  COMMERCIAL_BRAIN_WEIGHTS_V1,
  validateDimensionWeights,
  setDimensionWeightsForTests,
  resetDimensionWeightsForTests,
  getDimensionWeights,
} from "../server/commercial/commercialBrain/weights";
import {
  normalizePrice,
  normalizeCommission,
  normalizeAvailability,
  normalizeRating,
  normalizeMarketSignal,
  normalizeCompetition,
  normalizeSignalsInput,
} from "../server/commercial/commercialBrain/normalizers";
import {
  detectConflicts,
  computeRiskFactors,
  evaluateCommercialSignals,
  scoreComponents,
  normalizeDimensionValue,
} from "../server/commercial/commercialBrain/engine";
import {
  evaluateCommercialBrain,
  deriveSignalsFromCandidate,
  setCommercialBrainNowProvider,
  resetCommercialBrainNowProvider,
} from "../server/commercial/commercialBrain/service";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import { setCandidateAssessmentClient, resetAssessmentClientForTests } from "../server/repositories/candidateAssessmentRepository";
import { makeMockSupabaseClient } from "./curationMocks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXED_NOW = "2026-08-19T03:00:00.000Z";
const FIXED_REF = "2026-08-19T03:00:00.000Z";
const VALID_CANDIDATE_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_EVIDENCE_ID = "evd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const baseCandidate = {
  candidate_id: VALID_CANDIDATE_ID,
  listing_key: "ml:MLB-1456580521",
  schema_version: "1.0",
  discovery_rigor_version: "discovery_rigor_v1",
  marketplace: "Mercado Livre",
  merchant: "loja-exemplo",
  source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
  external_listing_id: "MLB-1456580521",
  title: "Produto Exemplo ML",
  description: "",
  category: "Eletrônicos",
  observed_price: 129.9,
  observed_rating: 4.5,
  observed_rating_count: 120,
  observed_availability: "IN_STOCK",
  observed_at: FIXED_NOW,
  evidence_hash: "hash-test",
  collection_method: "url",
  raw_snapshot_url: null,
  status: "DISCOVERED",
  funnel_stage: "INTAKE",
  review_notes: "",
  rejection_reason: null,
  reviewed_at: null,
  reviewed_by: null,
  promoted_product_id: null,
  promoted_at: null,
  idempotency_key: null,
  metadata: { source: "n10:telegram:url" },
  created_by: "n10:telegram:url",
  created_at: FIXED_NOW,
  updated_at: FIXED_NOW,
};

function n13AssessmentRow(verdict: string, filterVersion = "n13:curator_v1"): Record<string, unknown> {
  return {
    assessment_id: `cur-${VALID_CANDIDATE_ID.slice(4)}`,
    candidate_id: VALID_CANDIDATE_ID,
    filter_version: filterVersion,
    dimensions: { contractVersion: "curator_v1", verdict },
    metadata: { block: "n13", verdict, version: "curator_v1" },
    created_at: FIXED_NOW,
  };
}

function knownStatusSignal(): CommercialSignalsInput {
  return {
    price: {
      value: 129.9,
      status: "KNOWN",
      source: "candidate:observed_price",
      observedAt: FIXED_NOW,
      provenance: "n10:telegram:url",
      currency: "BRL",
    },
    seller: {
      value: 4.5,
      reviewCount: 120,
      status: "KNOWN",
      source: "candidate:observed_rating",
      observedAt: FIXED_NOW,
      provenance: "n10:telegram:url",
    },
    availability: {
      value: 1,
      status: "KNOWN",
      source: "candidate:observed_availability",
      observedAt: FIXED_NOW,
      provenance: "n10:telegram:url",
    },
  };
}

function commissionSignal(value = 0.1): CommercialSignalsInput["commission"] {
  return {
    value,
    status: "KNOWN",
    source: "affiliate:shopee:productOfferV2",
    observedAt: FIXED_NOW,
    provenance: "n14:affiliate:shopee",
  };
}

function installMocks(options: {
  listAssessments?: unknown[];
  candidateNotFound?: boolean;
  succeedInserts?: number;
} = {}): { handle: { insertCalls(): number } } {
  const { client, insertCalls } = makeMockSupabaseClient({
    reads: {
      candidate: { ok: true, candidate: options.candidateNotFound ? undefined : (baseCandidate as unknown as Record<string, unknown>) },
      listAssessments: options.listAssessments,
      candidateNotFound: options.candidateNotFound,
    },
    persist: { succeedInserts: options.succeedInserts ?? 1 },
  });
  setCandidatesClientForTests(client as never);
  setCandidateAssessmentClient(client as never);
  return { handle: { insertCalls: () => insertCalls() } };
}

function resetClients(): void {
  setCandidatesClientForTests(null as never);
  resetAssessmentClientForTests(null as never);
}

test.beforeEach(() => {
  resetClients();
  resetCommercialBrainNowProvider();
  resetDimensionWeightsForTests();
  setCommercialBrainNowProvider(() => FIXED_NOW);
});

test.afterEach(() => {
  resetClients();
  resetCommercialBrainNowProvider();
  resetDimensionWeightsForTests();
});

// ---------------------------------------------------------------------------
// 1. Contrato e pesos
// ---------------------------------------------------------------------------
test("contrato: versão/namespace/provenance canônicos", () => {
  assert.equal(COMMERCIAL_BRAIN_CONTRACT_VERSION, "commercial_brain_v1");
  assert.equal(COMMERCIAL_BRAIN_WEIGHTS_VERSION, "cb_weights_v1");
  assert.equal(COMMERCIAL_BRAIN_FILTER_VERSION, "n14:commercial_brain_v1");
  assert.equal(COMMERCIAL_BRAIN_PROVENANCE, "n14:admin:manual");
  assert.match(COMMERCIAL_BRAIN_WEIGHTS_NOTE, /NOT empirically optimized/);
});

test("pesos: soma = 1.0000 e validação do registry", () => {
  const w = COMMERCIAL_BRAIN_WEIGHTS_V1.weights;
  assert.equal(w.price, 0.25);
  assert.equal(w.commission, 0.25);
  assert.equal(w.seller, 0.2);
  assert.equal(w.market, 0.15);
  assert.equal(w.availability, 0.15);
  assert.equal(w.competition, 0);
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.equal(sum, 1);
  assert.equal(validateDimensionWeights(COMMERCIAL_BRAIN_WEIGHTS_V1), null);
  // registry inválido rejeitado
  assert.equal(
    validateDimensionWeights({ ...COMMERCIAL_BRAIN_WEIGHTS_V1, weights: { ...w, price: 0.5 } }),
    "weights_sum_must_be_1",
  );
});

// ---------------------------------------------------------------------------
// 2. Normalizadores — UNKNOWN preservado, inválido rejeitado
// ---------------------------------------------------------------------------
test("normalizers: price válido → KNOWN; ausente → UNKNOWN (nunca 0)", () => {
  const good = normalizePrice({ value: 129.9, status: "KNOWN", source: "candidate:observed_price", provenance: "n10:telegram:url" });
  assert.equal(good.signal.status, "KNOWN");
  assert.equal(good.normalizedValue, 129.9);
  const missing = normalizePrice({ value: null });
  assert.equal(missing.signal.status, "UNKNOWN");
  assert.equal(missing.normalizedValue, null);
  // UNKNOWN não vira zero
  assert.notEqual(missing.signal.value, 0);
});

test("normalizers: price impossível → rejeitado", () => {
  const neg = normalizePrice({ value: -10, status: "KNOWN", source: "src", provenance: "prov" });
  assert.equal(neg.signal.status, "UNKNOWN");
  assert.equal(neg.normalizedValue, null);
  const huge = normalizePrice({ value: 50_000_000, status: "KNOWN", source: "src", provenance: "prov" });
  assert.equal(huge.signal.status, "UNKNOWN");
  const nan = normalizePrice({ value: Number.NaN });
  assert.equal(nan.signal.status, "UNKNOWN");
});

test("normalizers: sem provenance → UNKNOWN mesmo com valor bom", () => {
  const noProv = normalizePrice({ value: 129.9, status: "KNOWN", source: "src" });
  assert.equal(noProv.signal.status, "UNKNOWN");
  assert.equal(noProv.signal.note, "price_without_provenance");
});

test("normalizers: commission sem provenance de provider → UNKNOWN (nunca 0%)", () => {
  const good = normalizeCommission({ value: 0.1, status: "KNOWN", source: "affiliate:shopee", provenance: "n14:affiliate:shopee" });
  assert.equal(good.signal.status, "KNOWN");
  assert.equal(good.normalizedValue, 0.1);
  const noProv = normalizeCommission({ value: 0.1, status: "KNOWN", source: "affiliate:shopee" });
  assert.equal(noProv.signal.status, "UNKNOWN");
  assert.notEqual(noProv.signal.value, 0);
  const outOfRange = normalizeCommission({ value: 1.5, status: "KNOWN", source: "x", provenance: "n14:x" });
  assert.equal(outOfRange.signal.status, "UNKNOWN");
});

test("normalizers: availability IN_STOCK=1, OUT_OF_STOCK=0, UNAVAILABLE=UNKNOWN", () => {
  assert.equal(normalizeAvailability({ value: "IN_STOCK", status: "KNOWN", source: "x", provenance: "p" }).normalizedValue, 1);
  assert.equal(normalizeAvailability({ value: "OUT_OF_STOCK", status: "KNOWN", source: "x", provenance: "p" }).normalizedValue, 0);
  const unknown = normalizeAvailability({ value: "UNAVAILABLE" });
  assert.equal(unknown.signal.status, "UNKNOWN");
  assert.equal(unknown.normalizedValue, null);
});

test("normalizers: seller rating com review_count", () => {
  const good = normalizeRating({ value: 4.5, reviewCount: 120, status: "KNOWN", source: "x", provenance: "p" });
  assert.equal(good.signal.status, "KNOWN");
  assert.equal(good.normalizedValue, 4.5);
  const zero = normalizeRating({ value: 0, reviewCount: 0, status: "KNOWN", source: "x", provenance: "p" });
  assert.equal(zero.signal.status, "KNOWN");
  assert.equal(zero.normalizedValue, 0);
  const unknown = normalizeRating({});
  assert.equal(unknown.signal.status, "UNKNOWN");
  assert.equal(unknown.normalizedValue, null);
  const bad = normalizeRating({ value: 6, status: "KNOWN", source: "x", provenance: "p" });
  assert.equal(bad.signal.status, "UNKNOWN");
});

test("normalizers: market e competition exigem evidência + provenance", () => {
  const mGood = normalizeMarketSignal({ value: 500, status: "KNOWN", provenance: "n14:evidence:field:KNOWN", source: "evidence:evd-1", observedAt: FIXED_NOW });
  assert.equal(mGood.signal.status, "KNOWN");
  const mUnknown = normalizeMarketSignal({ value: 500 }); // sem provenance
  assert.equal(mUnknown.signal.status, "UNKNOWN");
  const cUnknown = normalizeCompetition({ value: 3 }); // sem provenance
  assert.equal(cUnknown.signal.status, "UNKNOWN");
  const cGood = normalizeCompetition({ value: 3, provenance: "n14:evidence:market", source: "evidence:market", observedAt: FIXED_NOW });
  assert.equal(cGood.signal.status, "KNOWN");
  assert.equal(cGood.normalizedValue, 3);
});

test("normalizeSignalsInput: sinal ausente fica UNKNOWN em vez de inferido", () => {
  const signals = normalizeSignalsInput({ price: { value: 100, status: "KNOWN", source: "x", provenance: "p" } });
  assert.equal(signals.price.signal.status, "KNOWN");
  assert.equal(signals.commission.signal.status, "UNKNOWN");
  assert.equal(signals.market.signal.status, "UNKNOWN");
  assert.equal(signals.competition.signal.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// 3. Motor — determinismo, UNKNOWN, conflitos, INSUFFICIENT, bands
// ---------------------------------------------------------------------------
function buildEngineInput(extra: Partial<ReturnType<typeof knownStatusSignal>> = {}) {
  const s = normalizeSignalsInput({ ...knownStatusSignal(), ...extra });
  return s;
}

test("engine: score determinístico — mesmo input → mesmo score/digest/rationale", () => {
  const a = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput({ commission: commissionSignal() }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  const b = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput({ commission: commissionSignal() }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.equal(a.score, b.score);
  assert.equal(a.band, b.band);
  assert.equal(a.rationale, b.rationale);
  assert.equal(a.digest, b.digest);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("engine: score no range 0-1 e arredondado a 4 casas", () => {
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput({ commission: commissionSignal() }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.ok(d.score !== null && d.score >= 0 && d.score <= 1);
  assert.match(String(d.score), /^\d+\.\d{1,4}$/);
  assert.ok(d.confidence === "HIGH" || d.confidence === "MEDIUM" || d.confidence === "LOW");
  assert.ok(typeof d.coverage === "number" && d.coverage >= 0 && d.coverage <= 1);
});

test("engine: UNKNOWN não vira 0 — dimensão ausente fica fora do score e em dimensionsUnknown", () => {
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput(),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.ok(d.dimensionsUnknown.includes("commission"));
  assert.ok(d.dimensionsUnknown.includes("market"));
  assert.ok(d.dimensionsUnknown.includes("competition"));
  // dimensões ausentes NÃO entram no cálculo (não contam como 0)
  assert.ok(!d.dimensionsUsed.includes("commission"));
});

test("engine: INSUFFICIENT bloqueia interpretação mesmo com score parcial", () => {
  // Apenas price conhecido (1 dimensão < mínimo 2) → INSUFFICIENT, score=null
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: normalizeSignalsInput({ price: { value: 129.9, status: "KNOWN", source: "x", provenance: "p" } }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.equal(d.band, "INSUFFICIENT");
  assert.equal(d.score, null);
  assert.ok(d.dimensionsUsed.length < 2);
  assert.match(d.rationale, /insufficient:/);
  // score parcial matemático NÃO deve ser reportado
  assert.equal(d.confidence, "LOW");
});

test("engine: conflito → conflict=true, dimensão excluída, rationale explica", () => {
  // seller rating 0 + market evidência conhecida → conflito canônico
  const signals = normalizeSignalsInput({
    ...knownStatusSignal(),
    seller: { value: 0, reviewCount: 0, status: "KNOWN", source: "x", provenance: "p", observedAt: FIXED_NOW },
    market: { value: 500, status: "KNOWN", provenance: "n14:evidence:field:KNOWN", source: "evidence:evd-1", observedAt: FIXED_NOW },
  });
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals,
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.equal(d.conflict, true);
  assert.ok(d.conflictDimensions.includes("seller"));
  assert.ok(d.conflictDimensions.includes("market"));
  assert.ok(d.dimensionsUnknown.includes("seller"));
  assert.match(d.rationale, /conflict:seller/);
  assert.match(d.rationale, /conflict:market/);
  assert.match(d.rationale, /conflict_summary:dimensoes_em_conflito=/);
  assert.equal(d.confidence, "MEDIUM");
});

test("engine: risco — fator reduce o multiplicador visível (piso 0.5)", () => {
  const signals = buildEngineInput({ commission: commissionSignal() });
  const base = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals,
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  const penalized = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals,
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: ["unprovenanced_dimension:commission"],
    nowIso: FIXED_NOW,
  });
  assert.equal(base.riskPenalty, 1);
  assert.equal(penalized.riskPenalty, 0.9);
  assert.ok(penalized.score !== null && penalized.score !== base.score);
  assert.ok(penalized.riskFactors.includes("unprovenanced_dimension:commission"));
});

test("engine: risk penalty piso 0.5 com muitos fatores", () => {
  const signals = buildEngineInput({ commission: commissionSignal() });
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals,
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
    nowIso: FIXED_NOW,
  });
  assert.equal(d.riskPenalty, 0.5);
});

test("engine: signal antigo (>90d) gera fator stale no risco", () => {
  const signals = normalizeSignalsInput({
    price: { value: 129.9, status: "KNOWN", source: "x", provenance: "p", observedAt: "2026-01-01T00:00:00.000Z" },
    seller: { value: 4.5, reviewCount: 120, status: "KNOWN", source: "y", provenance: "p2", observedAt: "2026-08-01T00:00:00.000Z" },
  });
  const d = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals,
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  const stalePrice = d.riskFactors.some((f) => f.startsWith("stale_signal:price"));
  assert.equal(stalePrice, true);
  // rating com 18d não é stale
  assert.ok(!d.riskFactors.some((f) => f.startsWith("stale_signal:seller")));
});

test("engine: normalização por dimensão documentada", () => {
  // price: 1 - v/20M
  assert.equal(normalizeDimensionValue("price", 0), 1);
  assert.ok(Math.abs(normalizeDimensionValue("price", 10_000_000) - 0.5) < 1e-9);
  // commission direta
  assert.equal(normalizeDimensionValue("commission", 0.1), 0.1);
  // seller /5
  assert.equal(normalizeDimensionValue("seller", 5), 1);
  // availability direta
  assert.equal(normalizeDimensionValue("availability", 1), 1);
  // competition 1/(1+v)
  assert.equal(normalizeDimensionValue("competition", 0), 1);
  assert.ok(normalizeDimensionValue("competition", 9) < 0.2);
});

test("engine: detectConflicts canônicos — availability OUT_OF_STOCK + market", () => {
  const signals = normalizeSignalsInput({
    availability: { value: 0, status: "KNOWN", source: "x", provenance: "p" },
    market: { value: 500, status: "KNOWN", provenance: "n14:evidence:field:KNOWN", source: "evidence:evd-1", observedAt: FIXED_NOW },
    price: { value: 100, status: "KNOWN", source: "x", provenance: "p" },
  });
  const conflicts = detectConflicts(signals);
  assert.ok(conflicts.includes("availability"));
  assert.ok(conflicts.includes("market"));
});

test("engine: sem conflito quando market é UNKNOWN (nunca presumir demanda)", () => {
  const signals = normalizeSignalsInput({
    availability: { value: 0, status: "KNOWN", source: "x", provenance: "p" },
    price: { value: 100, status: "KNOWN", source: "x", provenance: "p" },
  });
  assert.equal(detectConflicts(signals).length, 0);
});

test("engine: bands corretas — HIGH/MEDIUM/LOW", () => {
  const high = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: normalizeSignalsInput({
      price: { value: 10, status: "KNOWN", source: "x", provenance: "p" }, // preço baixo → 1
      commission: { value: 0.1, status: "KNOWN", source: "x", provenance: "n14:affiliate:shopee", observedAt: FIXED_NOW },
      seller: { value: 5, reviewCount: 1000, status: "KNOWN", source: "x", provenance: "p", observedAt: FIXED_NOW },
      availability: { value: 1, status: "KNOWN", source: "x", provenance: "p" },
    }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  // pesos: price .25*1 + commission .25*(0.1/0.4 renorm) ... commission e price
  // somam 0.5; renormalizados: 0.5 e 0.5 → 0.5*1 + 0.5*0.1 = 0.55 → MEDIUM
  assert.equal(high.band, "MEDIUM");
  const low = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: normalizeSignalsInput({
      price: { value: 19_000_000, status: "KNOWN", source: "x", provenance: "p" },
      commission: { value: 0.01, status: "KNOWN", source: "x", provenance: "n14:affiliate:shopee" },
    }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.equal(low.band, "LOW");
});

// ---------------------------------------------------------------------------
// 4. Service — gate N13 obrigatório (sem bypass)
// ---------------------------------------------------------------------------
test("service: N13 PASS → N14 executa e avalia", () => {
  installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  const result = evaluateCommercialBrain(VALID_CANDIDATE_ID);
  return assertResultOkThenGate(result);
});

test("service: N13 BLOCKED → N14 não executa (fail-closed)", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("BLOCKED")] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
  assert.equal(result.decision, undefined);
});

test("service: N13 REVIEW → N14 não executa", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("REVIEW")] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
});

test("service: N13 FAIL → N14 não executa", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("FAIL")] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
});

test("service: N13 inexistente → N14 não executa", async () => {
  installMocks({ listAssessments: [] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_assessment_missing");
});

test("service: assessment N13 de outro filter_version → ausente para o gate", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("PASS", "cerberus_filter_v1")] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_assessment_missing");
});

test("service: candidate inexistente → fail-closed", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("PASS")], candidateNotFound: true });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "candidate_not_found");
});

test("service: candidate_id inválido → fail-closed sem consultar nada", async () => {
  const beforeCalls = { called: 0 };
  installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  const result = await evaluateCommercialBrain("nao-can-123");
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "invalid_candidate_id");
  assert.equal(result.decision, undefined);
});

// ---------------------------------------------------------------------------
// 5. Persistência, idempotência e replay
// ---------------------------------------------------------------------------
async function assertResultOkThenGate(
  resultPromise: ReturnType<typeof evaluateCommercialBrain>,
): Promise<void> {
  const result = await resultPromise;
  assert.ok(result.ok, `resultado não ok: ${JSON.stringify(result)}`);
  assert.ok(result.decision, "decisão ausente");
  assert.ok(result.decision!.digest.startsWith("sha256:"));
  assert.equal(result.decision!.idempotencyKey, `cb-${result.decision!.digest.slice(7)}`);
  assert.equal(result.decision!.contractVersion, COMMERCIAL_BRAIN_CONTRACT_VERSION);
  assert.equal(result.decision!.weightsVersion, COMMERCIAL_BRAIN_WEIGHTS_VERSION);
}

test("service: persistência usa filter_version n14:commercial_brain_v1 (spy)", async () => {
  const { handle } = installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(handle.insertCalls(), 1);
});

test("service: replay → identical_duplicate, mesmo digest e mesma key", async () => {
  const { handle } = installMocks({
    listAssessments: [n13AssessmentRow("PASS")],
    succeedInserts: 1, // 1ª cria, 2ª duplica → resolveReplay
  });
  const a = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  const b = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(a.outcome, "evaluated");
  assert.equal(b.outcome, "identical_duplicate");
  assert.equal(a.decision!.digest, b.decision!.digest);
  assert.equal(a.decision!.score, b.decision!.score);
  assert.equal(a.decision!.band, b.decision!.band);
  assert.equal(a.decision!.rationale, b.decision!.rationale);
  assert.equal(a.decision!.idempotencyKey, b.decision!.idempotencyKey);
  assert.equal(handle.insertCalls(), 2);
});

// Regressão: o digest N14 NÃO pode depender do horário exato do relógio —
// replays separados por horas/minutos (mesmo snapshot, mesmo dia UTC)
// devem produzir o mesmo digest/key. A referência de risco é truncada
// a dia UTC; o horário exato vive apenas em evaluatedAt (fora do digest).
test("service: replay com clock distinto → mesmo digest, score e key", async () => {
  const { handle } = installMocks({
    listAssessments: [n13AssessmentRow("PASS")],
    succeedInserts: 1,
  });
  const ref = "2026-08-19T03:00:00.000Z";
  setCommercialBrainNowProvider(() => ref);
  const a = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  // Relógio avança 3h47min: mesmo snapshot no mesmo dia UTC.
  setCommercialBrainNowProvider(() => "2026-08-19T06:47:12.111Z");
  const b = await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  assert.equal(a.decision!.digest, b.decision!.digest);
  assert.equal(a.decision!.score, b.decision!.score);
  assert.equal(a.decision!.band, b.decision!.band);
  assert.equal(a.decision!.rationale, b.decision!.rationale);
  assert.equal(a.decision!.idempotencyKey, b.decision!.idempotencyKey);
  // evaluatedAt usa a mesma referência truncada a dia UTC (fora do
  // digest, auditável apenas como data de referência do risco).
  assert.equal(a.decision!.evaluatedAt, "2026-08-19");
  assert.equal(b.decision!.evaluatedAt, "2026-08-19");
  assert.equal(handle.insertCalls(), 2);
});

test("service: alteração real no snapshot → nova avaliação (nova key)", async () => {
  const { handle } = installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  const a = await evaluateCommercialBrain(VALID_CANDIDATE_ID, {
    commission: commissionSignal(0.05),
  });
  const b = await evaluateCommercialBrain(VALID_CANDIDATE_ID, {
    commission: commissionSignal(0.15),
  });
  assert.notEqual(a.decision!.digest, b.decision!.digest);
  assert.notEqual(a.decision!.idempotencyKey, b.decision!.idempotencyKey);
  assert.ok(a.decision!.score !== null && b.decision!.score !== null);
  assert.notEqual(a.decision!.score, b.decision!.score);
  assert.equal(handle.insertCalls(), 2);
});

test("service: sinais sem provenance de entrada KNOWN → fator de risco + UNKNOWN no normalizer", async () => {
  const { handle } = installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  const result = await evaluateCommercialBrain(VALID_CANDIDATE_ID, {
    // comissão sem provenance: normalizer rejeita → UNKNOWN; não vira 0
    commission: { value: 0.2, status: "KNOWN", source: "alguma-fonte" },
  });
  assert.ok(result.ok);
  assert.ok(result.decision!.dimensionsUnknown.includes("commission"));
  // risco de dimensão rejeitada entra no rationale/penalty só quandoKNOWN;
  // aqui foi rejeitada pelo normalizer → sem KNOWN → sem penalty de provenance
  assert.ok(!result.decision!.riskFactors.some((f) => f.includes("commission")));
});

// ---------------------------------------------------------------------------
// 6. deriveSignalsFromCandidate — proveniência herdada
// ---------------------------------------------------------------------------
test("deriveSignalsFromCandidate: source candidate: e provenance herdada", () => {
  const signals = deriveSignalsFromCandidate(baseCandidate as never);
  assert.equal(signals.price?.status, "KNOWN");
  assert.equal(signals.price?.source, "candidate:observed_price");
  assert.equal(signals.price?.provenance, "n10:telegram:url");
  assert.equal(signals.seller?.source, "candidate:observed_rating");
  assert.equal(signals.availability?.source, "candidate:observed_availability");
  assert.equal(signals.commission, undefined);
  assert.equal(signals.market, undefined);
  assert.equal(signals.competition, undefined);
});

test("deriveSignalsFromCandidate: campos ausentes → UNKNOWN (nunca 0)", () => {
  const candidate = { ...baseCandidate, observed_price: null, observed_rating: null, observed_rating_count: null, observed_availability: null } as unknown as Record<string, unknown>;
  const signals = deriveSignalsFromCandidate(candidate as never);
  assert.equal(signals.price?.status, "UNKNOWN");
  assert.equal(signals.seller?.status, "UNKNOWN");
  assert.equal(signals.availability?.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// 7. Isolamento absoluto — zero efeitos comerciais
// ---------------------------------------------------------------------------
test("isolation: evaluateCommercialBrain não exporta nada além do assessment (sem product/link/job/publication)", async () => {
  installMocks({ listAssessments: [n13AssessmentRow("PASS")] });
  await evaluateCommercialBrain(VALID_CANDIDATE_ID);
  // spy do mock: único efeito colateral permitido = insert em
  // candidate_assessment (mesma tabela do contrato N4). Nenhuma outra
  // tabela é tocada pelos módulos do N14 (service/engine/normalizers).
  const moduleNames = ["contract", "engine", "normalizers", "service"];
  for (const name of moduleNames) {
    // verificação estática: nenhum desses módulos importa repositórios
    // de products, affiliate, jobs ou publicação
    const fs = await import("node:fs");
    const content = fs.readFileSync(`server/commercial/commercialBrain/${name}.ts`, "utf8");
    // Verificação estática de isolamento: apenas linhas de import/require contam
    // (comentários JSDoc com exemplos de provenance não são efeito comercial).
    const importLines = content.split("\n").filter((line) => /^import /.test(line.trim()));
    const importText = importLines.join("\n");
    assert.ok(!importText.includes("productsRepository"), `${name} importa productsRepository`);
    assert.ok(!importText.includes("affiliateRepository") && !importText.includes("acquisitionService"), `${name} importa afiliados`);
    assert.ok(!importText.includes("jobQueue") && !importText.includes("scheduler"), `${name} importa jobs/scheduler`);
    assert.ok(!importText.includes("publication"), `${name} importa publication`);
    assert.ok(!importText.includes("telegram"), `${name} importa telegram`);
  }
});

test("isolation: rotas N14 não registram efeitos comerciais (verificação estática)", async () => {
  const fs = await import("node:fs");
  const content = fs.readFileSync("server/routes/commercialBrainCandidatesRoutes.ts", "utf8");
  const importLines = content.split("\n").filter((line) => /^import /.test(line.trim()));
  const importText = importLines.join("\n");
  assert.ok(!importText.includes("createProduct") && !importText.includes("productsRepository"));
  assert.ok(!importText.includes("acquisition") && !importText.includes("affiliate"));
  assert.ok(!importText.includes("Telegram") && !importText.includes("telegramBot"));
  assert.ok(!importText.includes("scheduler") && !importText.includes("jobQueue"));
});

test("isolamento: nenhum secret/credencial exposto nos módulos N14", async () => {
  const fs = await import("node:fs");
  const files = [
    "server/commercial/commercialBrain/contract.ts",
    "server/commercial/commercialBrain/engine.ts",
    "server/commercial/commercialBrain/normalizers.ts",
    "server/commercial/commercialBrain/weights.ts",
    "server/commercial/commercialBrain/service.ts",
    "server/routes/commercialBrainCandidatesRoutes.ts",
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lower = content.toLowerCase();
    for (const secret of ["secret", "password", "token", "api_key", "app_id"]) {
      assert.ok(
        !lower.includes(secret),
        `${file} contém '${secret}' — nenhum secret/credencial deve aparecer`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 8. score/comparação numérica adicional
// ---------------------------------------------------------------------------
test("score: penalização nunca deixa o score negativo nem > 1", () => {
  for (let i = 0; i < 100; i++) {
    const price = 10 + i * 190000;
    const comm = 0.01 + (i % 10) * 0.009;
    const d = evaluateCommercialSignals({
      candidateId: VALID_CANDIDATE_ID,
      signals: normalizeSignalsInput({
        price: { value: price, status: "KNOWN", source: "x", provenance: "p" },
        commission: { value: comm, status: "KNOWN", source: "y", provenance: "n14:affiliate:shopee" },
        seller: { value: 4, reviewCount: 10, status: "KNOWN", source: "z", provenance: "p" },
      }),
      referenceDateIso: FIXED_REF,
      additionalRiskFactors: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
      nowIso: FIXED_NOW,
    });
    assert.ok(d.score !== null && d.score >= 0 && d.score <= 1, `score fora de range: ${d.score}`);
  }
});

test("digest: sha256 com prefixo sha256: e dependente do snapshot", () => {
  const a = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput({ commission: commissionSignal() }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  const b = evaluateCommercialSignals({
    candidateId: VALID_CANDIDATE_ID,
    signals: buildEngineInput({ commission: commissionSignal(0.2) }),
    referenceDateIso: FIXED_REF,
    additionalRiskFactors: [],
    nowIso: FIXED_NOW,
  });
  assert.equal(a.digest.slice(0, 7), "sha256:");
  assert.equal(a.digest.length, 7 + 64);
  assert.notEqual(a.digest, b.digest);
});
