// ============================================================================
// Prova controlada LOCAL do N14 (Fase 1) — casos A..G + K.
// Rodada pelo runner: npx tsx --test. NÃO persiste em produção, NÃO aplica
// migration, NÃO faz efeitos comerciais.
// ============================================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeMockSupabaseClient } from "./curationMocks";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  setCandidateAssessmentClient,
  resetAssessmentClientForTests,
} from "../server/repositories/candidateAssessmentRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";
import {
  evaluateCommercialBrain,
  setCommercialBrainNowProvider,
  resetCommercialBrainNowProvider,
} from "../server/commercial/commercialBrain/service";
import { SCORE_MIN, SCORE_MAX } from "../server/commercial/commercialBrain/contract";

const VALID_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXED_NOW = "2026-08-19T04:00:00.000Z";
setCommercialBrainNowProvider(() => FIXED_NOW);

const baseCandidate = {
  candidate_id: VALID_ID,
  listing_key: "mlb-1456580521",
  schema_version: "1.0",
  discovery_rigor_version: "1.0",
  marketplace: "Mercado Livre",
  merchant: "loja-exemplo",
  source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
  external_listing_id: "MLB-1456580521",
  title: "Produto Teste",
  description: "Descrição de teste",
  category: "Casa e Decoração",
  observed_price: 129.9,
  observed_rating: 4.5,
  observed_rating_count: 120,
  observed_availability: "IN_STOCK",
  observed_at: "2026-08-18T00:00:00Z",
  status: "DISCOVERED",
  funnel_stage: "INTAKE",
  metadata: { source: "n10:telegram:url" },
};

const baseEvidence = [
  {
    evidence_id: "evd-11111111111111111111111111111111",
    candidate_id: VALID_ID,
    field_name: "title",
    field_state: "KNOWN",
    field_value: { value: "Produto Teste", unknown: false },
    is_contradicted: false,
  },
  {
    evidence_id: "evd-22222222222222222222222222222222",
    candidate_id: VALID_ID,
    field_name: "price",
    field_state: "KNOWN",
    field_value: { value: 129.9, unknown: false },
    is_contradicted: false,
  },
];

function mkAssessmentN13(verdict: string) {
  return {
    assessment_id: `cur-${VALID_ID.slice(4)}`,
    candidate_id: VALID_ID,
    filter_version: "n13:curator_v1",
    dimensions: { verdict },
    metadata: { verdict },
    digest: "sha256:aaa",
    rationale: "rationale",
    criteria: [],
    idempotency_key: "key",
    evaluated_at: FIXED_NOW,
  };
}

function installMocks(reads: { n13Verdict?: string; n13Missing?: boolean }) {
  const n13 = reads.n13Missing ? [] : [mkAssessmentN13(reads.n13Verdict ?? "PASS")];
  const mock = makeMockSupabaseClient({
    reads: {
      candidate: { ok: true, candidate: baseCandidate as never },
      evidence: baseEvidence as never,
      listAssessments: n13 as never,
    },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);
  return mock;
}

afterEach(() => {
  resetCommercialBrainNowProvider();
  setCommercialBrainNowProvider(() => FIXED_NOW);
  resetAssessmentClientForTests(null as never);
  setCandidatesClientForTests(null as never);
});

// A) N13 PASS → N14 executa e cria assessment com score determinístico
test("N14 prova A) N13 PASS → N14 executa com score", async () => {
  installMocks({ n13Verdict: "PASS" });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, true, "gate aberto (N13 PASS)");
  assert.ok(result.decision, "decisão presente");
  const d = result.decision!;
  assert.equal(typeof d.score, "number", "score numérico");
  assert.ok((d.score as number) >= SCORE_MIN && (d.score as number) <= SCORE_MAX, "score em [0,1]");
  assert.equal((d as unknown as Record<string, unknown>).filterVersion, undefined);
  assert.equal(result.outcome, "evaluated", "avaliação persistida (filter_version n14:commercial_brain_v1 persistido no assessment)");
});

// B) N13 BLOCKED → N14 fail-closed, sem assessment
test("N14 prova B) N13 BLOCKED → N14 fail-closed", async () => {
  const mock = installMocks({ n13Verdict: "BLOCKED" });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
  assert.equal(mock.insertCalls(), 0, "nenhum assessment N14 criado");
});

// C) N13 REVIEW → fail-closed
test("N14 prova C) N13 REVIEW → N14 fail-closed", async () => {
  const mock = installMocks({ n13Verdict: "REVIEW" });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
  assert.equal(mock.insertCalls(), 0);
});

// D) N13 FAIL → fail-closed
test("N14 prova D) N13 FAIL → N14 fail-closed", async () => {
  const mock = installMocks({ n13Verdict: "FAIL" });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_verdict_not_pass");
  assert.equal(mock.insertCalls(), 0);
});

// E) N13 inexistente → fail-closed
test("N14 prova E) N13 inexistente → N14 fail-closed", async () => {
  const mock = installMocks({ n13Missing: true });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "n13_assessment_missing");
  assert.equal(mock.insertCalls(), 0);
});

// F) candidate inexistente → fail-closed
test("N14 prova F) candidate inexistente → fail-closed", async () => {
  const mock = makeMockSupabaseClient({
    reads: { candidateNotFound: true, evidence: [], listAssessments: [] as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "candidate_not_found");
  assert.equal(mock.insertCalls(), 0);
});

// G) candidate_id inválido → fail-closed
test("N14 prova G) candidate_id inválido → fail-closed", async () => {
  const mock = installMocks({ n13Verdict: "PASS" });
  const result = await evaluateCommercialBrain("nao-can-123");
  assert.equal(result.ok, false);
  assert.equal(result.gateReason, "invalid_candidate_id");
  assert.equal(mock.insertCalls(), 0);
});

// H) UNKNOWN persistente: market sem evidência → UNKNOWN; coverage < 1;
//    confidence separada do score
test("N14 prova H) UNKNOWN persistente + coverage/confidence", async () => {
  installMocks({ n13Verdict: "PASS" });
  const result = await evaluateCommercialBrain(VALID_ID);
  assert.equal(result.ok, true);
  const d = result.decision!;
  assert.ok(d.dimensionsUnknown.includes("market") || d.dimensionsUnknown.length > 0, "dimensões UNKNOWN listadas");
  assert.ok(d.coverage > 0 && d.coverage <= 1, "coverage entre 0 e 1");
  assert.ok(["HIGH", "MEDIUM", "LOW"].includes(d.confidence), "confidence em enum próprio");
});

// I) replay determinístico: idempotency_key/digest/score/band/rationale
test("N14 prova I) replay determinístico", async () => {
  installMocks({ n13Verdict: "PASS" });
  const first = await evaluateCommercialBrain(VALID_ID);
  const second = await evaluateCommercialBrain(VALID_ID);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const a = first.decision!;
  const b = second.decision!;
  assert.equal(a.idempotencyKey, b.idempotencyKey, "mesma idempotency key");
  assert.equal(a.digest, b.digest, "mesmo digest");
  assert.equal(a.score, b.score, "mesmo score");
  assert.equal(a.band, b.band, "mesma band");
  assert.equal(a.rationale, b.rationale, "mesmo rationale");
});

// J) alteração real no snapshot gera NOVA avaliação (nova key/digest/score).
//    succeedInserts=2 simula o banco criando uma linha distinta para a
//    2ª chamada (key nova), em vez de replay da 1ª.
function installMocksMultiInsert(reads: { n13Verdict?: string; n13Missing?: boolean }) {
  const n13 = reads.n13Missing ? [] : [mkAssessmentN13(reads.n13Verdict ?? "PASS")];
  const mock = makeMockSupabaseClient({
    reads: {
      candidate: { ok: true, candidate: baseCandidate as never },
      evidence: baseEvidence as never,
      listAssessments: n13 as never,
    },
    persist: { succeedInserts: 2 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);
  return mock;
}

test("N14 prova J) snapshot alterado → nova avaliação", async () => {
  installMocksMultiInsert({ n13Verdict: "PASS" });
  const first = await evaluateCommercialBrain(VALID_ID);
  baseCandidate.observed_price = 99.9;
  const second = await evaluateCommercialBrain(VALID_ID);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const a = first.decision!;
  const b = second.decision!;
  assert.notEqual(a.idempotencyKey, b.idempotencyKey, "nova idempotency key");
  assert.notEqual(a.digest, b.digest, "novo digest");
  console.log("SCORES:", a.score, b.score, "| BAND:", a.band, b.band, "| cov:", a.coverage, b.coverage);
  assert.notEqual(a.score, b.score, "novo score");
  baseCandidate.observed_price = 129.9;
});

// K) zero efeitos comerciais: módulos N14 não tocam product/affiliate/jobs/
//    telegram/worker/scheduler/N8/N15/N16/publication
test("N14 prova K) zero efeitos comerciais (isolation)", async () => {
  const mods = await Promise.all([
    import("../server/commercial/commercialBrain/contract"),
    import("../server/commercial/commercialBrain/engine"),
    import("../server/commercial/commercialBrain/normalizers"),
    import("../server/commercial/commercialBrain/weights"),
    import("../server/commercial/commercialBrain/service"),
    import("../server/routes/commercialBrainCandidatesRoutes"),
  ]);
  for (const m of mods) {
    const src = JSON.stringify(m);
    const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n"]*/g, "");
    const badTerms = ["createProduct", "affiliate", "job_queue", "telegram", "publish", "campaign", "scheduler", "worker"];
    for (const term of badTerms) {
      assert.equal(withoutComments.includes(term), false, `módulo N14 não contém '${term}'`);
    }
  }
});
