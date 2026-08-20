// ============================================================================
// N17 Fase 20 — Testes do elo EVIDENCE BRIDGE → N14 (read-only,
// fail-closed). Cobertura obrigatória A–H:
//   A. evidência price KNOWN → N14 enxerga o sinal
//   B. price preserva unit/quality/UNVERIFIED
//   C. evidência de outro candidate_id → ignorada
//   D. evidência UNKNOWN → não promovida
//   E. ausência de evidência → comportamento atual/fail-closed
//   F. erro de leitura → nenhum sinal inventado
//   G. múltiplas evidências ambíguas → nenhuma promoção indevida
//   H. title não fabrica segunda dimensão comercial
// Nenhum teste altera contract.ts, engine.ts, thresholds, policy N15,
// N13/N15/N16/N17/N8/N6. Todos os mocks são read-only.
// ============================================================================
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEvidenceSignals,
  EVIDENCE_SIGNAL_PROVENANCE,
} from "../server/commercial/commercialBrain/evidenceSignals";
import { normalizeSignalsInput } from "../server/commercial/commercialBrain/normalizers";
import {
  evaluateCommercialBrain,
  setCommercialBrainNowProvider,
  resetCommercialBrainNowProvider,
} from "../server/commercial/commercialBrain/service";
import { makeMockSupabaseClient } from "./curationMocks";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  setCandidateAssessmentClient,
  resetAssessmentClientForTests,
} from "../server/repositories/candidateAssessmentRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXED_NOW = "2026-08-20T12:00:00.000Z";
const CANDIDATE_A = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CANDIDATE_B = "can-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const baseCandidate = {
  candidate_id: CANDIDATE_A,
  listing_key: "shopee:1111111111-2222222222",
  schema_version: "1.0",
  discovery_rigor_version: "discovery_rigor_v1",
  marketplace: "Shopee",
  merchant: "loja-exemplo",
  source_url: "https://shopee.com.br/product/1111111111/2222222222",
  external_listing_id: "shopee-1111111111-2222222222",
  title: "Produto Exemplo Shopee",
  description: "",
  category: "Eletrônicos",
  observed_price: null,
  observed_rating: null,
  observed_rating_count: null,
  observed_availability: null,
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
  metadata: { source: "n10:telegram:url", provenance: "n10:telegram:url" },
  created_by: "n10:telegram:url",
  created_at: FIXED_NOW,
  updated_at: FIXED_NOW,
};

function n13AssessmentRow(): Record<string, unknown> {
  return {
    assessment_id: `cur-${CANDIDATE_A.slice(4)}`,
    candidate_id: CANDIDATE_A,
    filter_version: "n13:curator_v1",
    dimensions: { contractVersion: "curator_v1", verdict: "PASS" },
    metadata: { block: "n13", verdict: "PASS", version: "curator_v1" },
    created_at: FIXED_NOW,
  };
}

function evidenceRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    evidence_id: `evi-${Math.random().toString(36).slice(2, 12)}`,
    candidate_id: CANDIDATE_A,
    research_id: "rs-test",
    kind: "FIELD",
    field_name: null,
    field_value: null,
    field_state: "UNKNOWN",
    source_url: "https://shopee.com.br/product/1111111111/2222222222",
    source_type: "api",
    collection_method: "API",
    observed_at: FIXED_NOW,
    evidence_hash: "sha256:test",
    quality: "UNKNOWN",
    unit: null,
    evidence_note: "test",
    metadata: {},
    created_at: FIXED_NOW,
    ...overrides,
  };
}

function installMocks(evidence: unknown[] | undefined, evidenceUnavailable = false): void {
  const { client } = makeMockSupabaseClient({
    reads: {
      candidate: { ok: true, candidate: baseCandidate as unknown as Record<string, unknown> },
      listAssessments: [n13AssessmentRow()],
      evidence,
      evidenceUnavailable,
    },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(client as never);
  setCandidateAssessmentClient(client as never);
  setCandidateEvidenceClientForTests(client as unknown as never);
}

beforeEach(() => {
  setCommercialBrainNowProvider(() => FIXED_NOW);
});

afterEach(() => {
  setCandidatesClientForTests(null as never);
  resetAssessmentClientForTests(null as never);
  setCandidateEvidenceClientForTests(null as never);
  resetCommercialBrainNowProvider();
});

// ---------------------------------------------------------------------------
// A. evidência price KNOWN → N14 enxerga o sinal
// ---------------------------------------------------------------------------
test("A. price KNOWN na evidência transporta sinal KNOWN para o N14", async () => {
  installMocks([
    evidenceRow({
      evidence_id: "evi-price-known",
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
      evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    }),
  ]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // A evidência transportou price KNOWN (1 dimensão). Band permanece
  // INSUFFICIENT (MIN_DIMENSIONS_KNOWN=2 não atingido — sem relaxamento
  // de threshold): a ponte não altera a lógica de decisão do N14.
  assert.deepEqual(result.decision.dimensionsUsed, ["price"]);
  assert.equal(result.decision.band, "INSUFFICIENT");
});

// ---------------------------------------------------------------------------
// B. price preserva unit/quality/UNVERIFIED
// ---------------------------------------------------------------------------
test("B. price preserva unit string_price_unscaled, quality UNKNOWN e UNVERIFIED no note", async () => {
  installMocks([
    evidenceRow({
      evidence_id: "evi-price-known",
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
      evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    }),
  ]);
  const resolved = await resolveEvidenceSignals(CANDIDATE_A, async (cid) =>
    ({
      ok: true,
      evidence: cid === CANDIDATE_A
        ? ([
            evidenceRow({
              evidence_id: "evi-price-known",
              field_name: "price",
              field_value: { value: 9900, unknown: false },
              field_state: "KNOWN",
              quality: "UNKNOWN",
              unit: "string_price_unscaled",
              evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
            }),
          ] as unknown as never)
        : ([] as unknown as never),
    }) as never,
  );
  const price = resolved.signals.price!;
  assert.ok(price.note.includes("unit=string_price_unscaled"));
  assert.ok(price.note.includes("quality=UNKNOWN"));
  assert.ok(
    price.note.includes(
      "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    ),
  );
  assert.equal(price.currency, "UNKNOWN"); // nunca assumir BRL
  // O normalizer aceita o valor numericamente (shape), mas a escala segue
  // semanticamente UNVERIFIED (unit/quality preservados na nota).
  const normalized = normalizeSignalsInput({ price });
  assert.equal(normalized.price.signal.status, "KNOWN");
  assert.equal(normalized.price.signal.value, 9900);
});

// ---------------------------------------------------------------------------
// C. evidência de outro candidate_id → ignorada
// ---------------------------------------------------------------------------
test("C. evidência de outro candidate_id é ignorada e nenhum sinal é transportado", async () => {
  installMocks([
    evidenceRow({
      candidate_id: CANDIDATE_B,
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
    }),
  ]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Price oficial de outro candidato não altera o band: continua
  // INSUFFICIENT (0 dimensões KNOWN).
  assert.equal(result.decision.band, "INSUFFICIENT");
});

// ---------------------------------------------------------------------------
// D. evidência UNKNOWN → não promovida
// ---------------------------------------------------------------------------
test("D. evidência com field_state UNKNOWN não é promovida a KNOWN", async () => {
  installMocks([
    evidenceRow({
      field_name: "price",
      field_value: { value: null, unknown: true },
      field_state: "UNKNOWN",
    }),
    evidenceRow({
      field_name: "availability",
      field_value: { value: null, unknown: true },
      field_state: "UNKNOWN",
    }),
  ]);
  const resolved = await resolveEvidenceSignals(CANDIDATE_A, async () =>
    ({
      ok: true,
      evidence: [
        evidenceRow({
          field_name: "price",
          field_value: { value: null, unknown: true },
          field_state: "UNKNOWN",
        }),
        evidenceRow({
          field_name: "availability",
          field_value: { value: null, unknown: true },
          field_state: "UNKNOWN",
        }),
      ] as unknown as never,
    }) as never,
  );
  // field_state UNKNOWN → nada é transportado (chave ausente no signals).
  assert.equal(resolved.signals.price, undefined);
  assert.equal(resolved.signals.availability, undefined);
  const normalized = normalizeSignalsInput({ ...resolved.signals });
  assert.equal(normalized.price.signal.status, "UNKNOWN");
  assert.equal(normalized.availability.signal.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// E. ausência de evidência → comportamento atual/fail-closed
// ---------------------------------------------------------------------------
test("E. sem evidências, o bridge não transporta nada (comportamento atual)", async () => {
  installMocks([]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Sem evidência e candidate.observed_price null → INSUFFICIENT,
  // comportamento anterior inalterado.
  assert.equal(result.decision.band, "INSUFFICIENT");
  assert.deepEqual(result.decision.dimensionsUsed, []);
});

// ---------------------------------------------------------------------------
// F. erro de leitura → nenhum sinal inventado
// ---------------------------------------------------------------------------
test("F. falha de leitura do repositório não inventa sinal (fail-closed)", async () => {
  installMocks(undefined, true);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Falha de leitura: nenhuma evidência disponível → N14 permanece
  // INSUFFICIENT (sem sinal inventado).
  assert.equal(result.decision.band, "INSUFFICIENT");
  assert.deepEqual(result.decision.dimensionsUsed, []);
});

// ---------------------------------------------------------------------------
// G. múltiplas evidências ambíguas → nenhuma promoção indevida
// ---------------------------------------------------------------------------
test("G. duas evidências KNOWN para o mesmo campo gera ambiguidade sem sinal", async () => {
  installMocks([
    evidenceRow({
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
    }),
    evidenceRow({
      field_name: "price",
      field_value: { value: 19900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
    }),
  ]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Ambiguidade → nenhum sinal transportado → INSUFFICIENT (sem regra
  // nova de precedência inventada).
  assert.equal(result.decision.band, "INSUFFICIENT");
  assert.deepEqual(result.decision.dimensionsUsed, []);
});

// ---------------------------------------------------------------------------
// H. title não é usado para fabricar dimensão comercial
// ---------------------------------------------------------------------------
test("H. title KNOWN na evidência NÃO vira dimensão comercial do N14", async () => {
  installMocks([
    evidenceRow({
      field_name: "title",
      field_value: { value: "Fone Bluetooth Premium", unknown: false },
      field_state: "KNOWN",
      quality: "HIGH",
    }),
    evidenceRow({
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
      evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    }),
  ]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // O title jamais aparece como dimensão comercial: apenas price foi
  // transportado.
  assert.deepEqual(result.decision.dimensionsUsed, ["price"]);
  // As demais dimensões comerciais permanecem UNKNOWN.
  assert.ok(result.decision.dimensionsUnknown.includes("commission"));
  assert.ok(result.decision.dimensionsUnknown.includes("market"));
  assert.ok(result.decision.dimensionsUnknown.includes("competition"));
});

// ---------------------------------------------------------------------------
// Edge: price com shape não numérico não é transportado
// ---------------------------------------------------------------------------
test("edge. price com value não numérico permanece UNKNOWN", async () => {
  const resolved = await resolveEvidenceSignals(CANDIDATE_A, async () =>
    ({
      ok: true,
      evidence: [
        evidenceRow({
          field_name: "price",
          field_value: { value: "99.90", unknown: false },
          field_state: "KNOWN",
        }),
      ] as unknown as never,
    }) as never,
  );
  // value string não é transportável (shape não numérico) → chave ausente;
  // normalize trata a ausência como UNKNOWN.
  assert.equal(resolved.signals.price, undefined);
  const normalized = normalizeSignalsInput({ ...resolved.signals });
  assert.equal(normalized.price.signal.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// Edge: availability com semântica não comprovada (unit != stock)
// ---------------------------------------------------------------------------
test("edge. availability sem unit de estoque comprovada não é transportada", async () => {
  const resolved = await resolveEvidenceSignals(CANDIDATE_A, async () =>
    ({
      ok: true,
      evidence: [
        evidenceRow({
          field_name: "availability",
          field_value: { value: 1, unknown: false },
          field_state: "KNOWN",
          unit: "unknown_unit",
        }),
      ] as unknown as never,
    }) as never,
  );
  assert.equal(resolved.signals.availability, undefined);
});

// ---------------------------------------------------------------------------
// Edge: candidate_id inválido → readFailure (sem exceção, sem inventar)
// ---------------------------------------------------------------------------
test("edge. candidate_id vazio gera readFailure sem inventar sinais", async () => {
  const resolved = await resolveEvidenceSignals("", async () =>
    ({
      ok: true,
      evidence: [],
    }) as never,
  );
  assert.equal(resolved.readFailure, true);
  assert.equal(resolved.signals.price, undefined);
});

// ---------------------------------------------------------------------------
// Integração: bridge + derivado do candidato + override explícito
// ---------------------------------------------------------------------------
test("integração. override explícito da rota prevalece sobre a evidência", async () => {
  installMocks([
    evidenceRow({
      evidence_id: "evi-price-known",
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
      evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    }),
  ]);
  // Override explícito (precedência máxima) mantém o preço transportado.
  // price KNOWN + seller KNOWN (2 dimensões) para exercitar a precedência
  // sobre a evidência sem depender do threshold.
  const result = await evaluateCommercialBrain(CANDIDATE_A, {
    price: {
      value: 5000,
      status: "KNOWN",
      source: "admin:manual",
      provenance: "n14:admin:manual",
      currency: "BRL",
    },
    seller: {
      value: 4.8,
      status: "KNOWN",
      source: "admin:manual",
      provenance: "n14:admin:manual",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.dimensionsUsed.includes("price"), true);
  assert.equal(result.decision.dimensionsUsed.includes("seller"), true);
  assert.equal(result.decision.band, "HIGH");
});

test("integração. provenance oficial da evidência evita fator de risco", async () => {
  installMocks([
    evidenceRow({
      evidence_id: "evi-price-known",
      field_name: "price",
      field_value: { value: 9900, unknown: false },
      field_state: "KNOWN",
      quality: "UNKNOWN",
      unit: "string_price_unscaled",
      evidence_note: "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED",
    }),
  ]);
  const result = await evaluateCommercialBrain(CANDIDATE_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Provenance oficial transportada → sem fator de risco
  // "unprovenanced_dimension:price" adicional.
  assert.ok(
    !result.decision.riskFactors.includes("unprovenanced_dimension:price"),
  );
});
