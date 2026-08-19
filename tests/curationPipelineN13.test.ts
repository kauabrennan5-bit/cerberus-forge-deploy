// ============================================================================
// Bloco N13 — Fase 3: integração ao pipeline real + persistência governada.
//
// GATES VALIDADOS:
// A) PASS          → candidato elegível para N14; nenhuma ação comercial.
// B) BLOCKED(REVIEW) → pipeline para no N13.
// C) FAIL(REJECT)  → pipeline para no N13.
// D) Replay        → mesma decisão, mesmo assessment_id, mesmo digest,
//                     nenhum registro duplicado indevido.
// E) Persistência  → candidate_assessment com filter_version n13:curator_v1
//                     (payload de insert inspecionado por spy).
// F) Isolamento    → nenhuma tabela comercial tocada além do contrato.
// G) N14           → NÃO chamado automaticamente (sem dependência N14).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCurationGate,
} from "../server/commercial/curation/pipelineGate";
import {
  setCuratorNowProvider,
  resetCuratorNowProvider,
} from "../server/commercial/curation/service";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import { setCandidateAssessmentClient } from "../server/repositories/candidateAssessmentRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";
import { makeMockSupabaseClient } from "./curationMocks";
import type { PipelineGateResult } from "../server/commercial/curation/pipelineGate";

function assertGateOk(result: Awaited<ReturnType<typeof runCurationGate>> | { gate: string; error: string }): asserts result is PipelineGateResult {
  assert.ok(!("error" in (result as { gate?: string; error?: string })), "não deve falhar no service");
}

const FIXED_NOW = "2026-08-19T02:00:00.000Z";
const VALID_CANDIDATE_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_EVIDENCE_ID = "evd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const baseCandidate = {
  candidate_id: VALID_CANDIDATE_ID,
  marketplace: "Mercado Livre",
  source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
  external_listing_id: "MLB-1456580521",
  status: "DISCOVERED",
  funnel_stage: "INTAKE",
  metadata: { provenance: "n10:telegram:url" },
};

const baseEvidence = [
  {
    evidence_id: VALID_EVIDENCE_ID,
    candidate_id: VALID_CANDIDATE_ID,
    research_id: "rsr-test",
    kind: "FIELD",
    field_name: "title",
    field_state: "KNOWN",
    isContradicted: false,
  },
  {
    evidence_id: "evd-cccccccccccccccccccccccccccccccc",
    candidate_id: VALID_CANDIDATE_ID,
    research_id: "rsr-test",
    kind: "FIELD",
    field_name: "price",
    field_state: "KNOWN",
    isContradicted: false,
  },
];

test.afterEach(() => {
  resetCuratorNowProvider();
  setCandidatesClientForTests(null);
  setCandidateAssessmentClient(null);
  setCandidateEvidenceClientForTests(null);
});

// ---------------------------------------------------------------------------
// A) PASS — evidência coerente → elegível para N14, sem ação comercial
// ---------------------------------------------------------------------------
test("N13 Fase 3 A) PASS — elegível para N14, sem efeito comercial", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate(VALID_CANDIDATE_ID);
  assertGateOk(result);
  assert.equal(result.gate, "pass", "veredicto estrutural completo deve dar gate=pass");
  assert.equal(result.verdict, "PASS");
  assert.equal(result.eligibleForN14, true, "PASS marca o candidato como elegível para N14");
  assert.equal(result.outcome, "evaluated");
  assert.equal(result.assessmentId, `cur-${VALID_CANDIDATE_ID.slice(4)}`);
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.service.outcome, "evaluated");
});

// ---------------------------------------------------------------------------
// B) BLOCKED — ausência de evidência → REVIEW, pipeline para
// ---------------------------------------------------------------------------
test("N13 Fase 3 B) BLOCKED — sem evidência → gate=review (para)", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: [] as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate(VALID_CANDIDATE_ID);
  assertGateOk(result);
  assert.equal(result.gate, "review", "informação insuficiente PARA o pipeline");
  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.eligibleForN14, false, "BLOCKED NÃO dá elegibilidade");
  assert.equal(result.assessmentId, `cur-${VALID_CANDIDATE_ID.slice(4)}`);
});

// ---------------------------------------------------------------------------
// C) FAIL — estado de entrada inválido → REJECT, pipeline para
// ---------------------------------------------------------------------------
test("N13 Fase 3 C) FAIL — estado inválido → gate=reject (para)", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const rejectedCandidate = { ...baseCandidate, status: "REJECTED" };
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: rejectedCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate(VALID_CANDIDATE_ID);
  assertGateOk(result);
  assert.equal(result.gate, "reject", "falha estrutural PARA o pipeline");
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.eligibleForN14, false, "FAIL NÃO dá elegibilidade");
  assert.equal(result.assessmentId, `cur-${VALID_CANDIDATE_ID.slice(4)}`);
});

// ---------------------------------------------------------------------------
// D) Replay idempotente — mesma decisão, mesmo assessment_id/digest,
//    sem registro duplicado indevido
// ---------------------------------------------------------------------------
test("N13 Fase 3 D) Replay — mesma decisão, id, digest; sem duplicado", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const first = await runCurationGate(VALID_CANDIDATE_ID);
  const second = await runCurationGate(VALID_CANDIDATE_ID);
  assertGateOk(first);
  assertGateOk(second);

  assert.equal(first.verdict, second.verdict, "mesma decisão");
  assert.equal(first.assessmentId, second.assessmentId, "mesmo assessment_id");
  assert.equal(first.digest, second.digest, "mesmo digest");
  assert.equal(first.gate, second.gate, "mesmo gate");
  assert.equal(second.service.outcome, "identical_duplicate", "replay relatado como identical_duplicate");
});

// ---------------------------------------------------------------------------
// E) Persistência governada — filter_version = n13:curator_v1.
//    Spy captura o payload do insert da tabela candidate_assessment.
// ---------------------------------------------------------------------------
test("N13 Fase 3 E) Persistência — filter_version n13:curator_v1", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const persistedRows: unknown[] = [];

  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  // Envolver o client em um spy: inspecionar insert() e repassar ao mock real.
  const spyClient = {
    from(table: string) {
      const realFrom = (mock.client as { from: (t: string) => unknown }).from(table);
      if (table === "candidate_assessment") {
        return {
          insert(row?: unknown): unknown {
            if (row) persistedRows.push(row);
            return (realFrom as { insert: () => unknown }).insert();
          },
          eq() {
            return (realFrom as { eq: () => unknown }).eq();
          },
          order() {
            return (realFrom as { order: () => unknown }).order();
          },
          limit() {
            return (realFrom as { limit: () => unknown }).limit();
          },
          select() {
            return (realFrom as { select: () => unknown }).select();
          },
          maybeSingle() {
            return (realFrom as { maybeSingle: () => unknown }).maybeSingle();
          },
          range() {
            return (realFrom as { range: () => unknown }).range();
          },
          single() {
            return (realFrom as { single: () => unknown }).single();
          },
        };
      }
      return realFrom;
    },
  };
  setCandidatesClientForTests(spyClient as never);
  setCandidateAssessmentClient(spyClient as never);
  setCandidateEvidenceClientForTests(spyClient as never);

  await runCurationGate(VALID_CANDIDATE_ID);

  assert.ok(persistedRows.length > 0, "insert da tabela candidate_assessment executado");
  const lastRow = persistedRows[persistedRows.length - 1] as Record<string, unknown>;
  assert.equal(lastRow.filter_version, "n13:curator_v1", "filter_version governado pelo contrato");
  assert.equal(lastRow.candidate_id, VALID_CANDIDATE_ID);
  assert.equal(typeof lastRow.idempotency_key, "string", "idempotency_key persistido");
  assert.match(String(lastRow.idempotency_key), /^sha256:[a-f0-9]{64}$/, "idempotency_key determinístico sha256");
});

// ---------------------------------------------------------------------------
// F) Isolamento — o gate NÃO toca products, affiliate_links, jobs, publish
// ---------------------------------------------------------------------------
test("N13 Fase 3 F) Isolamento — apenas reads de candidates/evidence e persist de assessment", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const touchedTables: string[] = [];
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  const isolatedClient = {
    from(table: string) {
      touchedTables.push(table);
      return (mock.client as { from: (t: string) => unknown }).from(table);
    },
  };
  setCandidatesClientForTests(isolatedClient as never);
  setCandidateAssessmentClient(isolatedClient as never);
  setCandidateEvidenceClientForTests(isolatedClient as never);

  await runCurationGate(VALID_CANDIDATE_ID);
  const allowed = new Set(["candidates", "candidate_evidence", "candidate_assessment"]);
  const forbidden = touchedTables.filter((table) => !allowed.has(table));
  assert.deepEqual(forbidden, [], "nenhuma tabela comercial tocada (products, affiliate_links, job_queue)");
  assert.ok(touchedTables.includes("candidates"));
  assert.ok(touchedTables.includes("candidate_evidence"));
  assert.ok(touchedTables.includes("candidate_assessment"), "persistência SOMENTE pelo contrato candidate_assessment");
});

// ---------------------------------------------------------------------------
// G) N14 — sem dependência, sem chamada automática
// ---------------------------------------------------------------------------
test("N13 Fase 3 G) N14 NÃO é chamado automaticamente", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate(VALID_CANDIDATE_ID);
  assertGateOk(result);
  assert.equal(result.eligibleForN14, true);
  // Nenhuma ação N14 foi disparada: o resultado contém apenas a decisão
  // e os metadados do serviço N13 (sem job, sem publish, sem link).
  assert.equal(result.service.ok, true);
  assert.equal(result.service.outcome, "evaluated");
  assert.equal(result.criteria.length, 8, "8 critérios estruturais avaliados");
  assert.equal(
    result.criteria.filter((criterion) => criterion.result === "checked").length,
    8,
    "todos checked → gate pass",
  );
});

// ---------------------------------------------------------------------------
// Hardening: candidato inexistente → pipeline para (fail-closed)
// ---------------------------------------------------------------------------
test("N13 Fase 3 H) Fail-closed do gate — candidato inexistente para o fluxo", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidateNotFound: true },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate(VALID_CANDIDATE_ID);
  assert.ok("error" in result, "ausência do candidato PARA o pipeline (fail-closed)");
  const err = result as { gate: string; error: string };
  assert.equal(err.gate, "review");
  assert.match(err.error, /curadoria_indisponivel/);
});

// ---------------------------------------------------------------------------
// Hardening: dados inválidos (ID malformado) → para o fluxo antes de avaliar
// ---------------------------------------------------------------------------
test("N13 Fase 3 I) Dados inválidos — ID malformado → para o fluxo", async () => {
  setCuratorNowProvider(() => FIXED_NOW);
  const mock = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: baseCandidate as never }, evidence: baseEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mock.client as never);
  setCandidateAssessmentClient(mock.client as never);
  setCandidateEvidenceClientForTests(mock.client as never);

  const result = await runCurationGate("nao-can-123");
  assert.ok("error" in result, "ID malformado PARA o pipeline");
  const err = result as { gate: string; error: string };
  assert.equal(err.gate, "review");
  assert.match(err.error, /curadoria_indisponivel/);
});
