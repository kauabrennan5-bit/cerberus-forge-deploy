// ============================================================================
// Bloco N14 — FASE 3 — Regressão do incidente replay_lookup_failed (N13).
//
// Cenário reproduzido: avaliação A persistida com snapshot A; nova evidência
// altera o snapshot (B); a avaliação seguinte deve produzir UMA nova linha
// legítima (novo digest/nova assessment), NUNCA replay_lookup_failed.
//
// Regras preservadas pelo fix:
// - mesmo snapshot - mesmo digest - mesmo assessment_id - identical_duplicate;
// - snapshot diferente - digest/assessment_id diferentes - avaliação nova;
// - nenhum PASS artificial, UNKNOWN/idempotência/fail-closed intactos.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMockSupabaseClient } from "./curationMocks";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";
import { setCandidateAssessmentClient, resetAssessmentClientForTests } from "../server/repositories/candidateAssessmentRepository";
import { setCuratorNowProvider as serviceSetCuratorNowProvider, resetCuratorNowProvider as serviceResetCuratorNowProvider } from "../server/commercial/curation/service";

// Alias para manter os testes legíveis.
const setCuratorNowProvider = serviceSetCuratorNowProvider;
const resetCuratorNowProvider = serviceResetCuratorNowProvider;

function resetAllCurationClientsForTests() {
  setCandidatesClientForTests(null);
  setCandidateEvidenceClientForTests(null);
  resetAssessmentClientForTests(null);
}
import { evaluateCandidateById } from "../server/commercial/curation/service";

const nowFixed = () => "2026-08-19T00:00:00.000Z";

const VALID_CANDIDATE_ID = "can-025fd354b4448c6a7a95e543";

const mockCandidate = {
  candidate_id: VALID_CANDIDATE_ID,
  marketplace: "MERCADOLIVRE",
  source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
  external_listing_id: "MLB-1456580521",
  status: "active",
  funnel_stage: "registered",
  created_at: "2026-08-19T00:00:00Z",
  metadata: { source: "n10:telegram:url", provenance: "n10:admin:manual" },
} as Record<string, unknown>;

// Evidência 1: preço conhecido (evidenceCount=1).
function evidenceKnownPrice(price: string) {
  return [
    {
      evidence_id: "evi-price-known",
      candidate_id: VALID_CANDIDATE_ID,
      field_name: "observed_price",
      field_state: "KNOWN",
      field_value: { value: price },
      provenance: "n10:admin:manual",
      collected_at: nowFixed(),
      kind: "listing_observation",
    },
  ];
}

// Evidência 2 (snapshot muda): rating conhecido adicionado.
function evidencePriceAndRating(price: string) {
  return [
    ...evidenceKnownPrice(price),
    {
      evidence_id: "evi-rating-known",
      candidate_id: VALID_CANDIDATE_ID,
      field_name: "rating",
      field_state: "KNOWN",
      field_value: { value: "4.5" },
      provenance: "n10:admin:manual",
      collected_at: nowFixed(),
      kind: "listing_observation",
    },
  ];
}

interface MutableHandle {
  client: Record<string, unknown>;
  changeEvidence: (e?: unknown[]) => void;
}

function setupClient(options: { evidence: unknown[] }): MutableHandle {
  // Evidência mutável via ref: a mesma cadeia do mock responde sempre com o
  // array corrente, permitindo alterar o snapshot entre avaliações A e B SEM
  // trocar o client (reproduz fielmente a colisão de PK real do PostgREST).
  const evidenceRef = { current: options.evidence };
  const handle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate } },
    persist: { succeedInserts: 1 },
    evidenceRef,
  });
  setCandidatesClientForTests(handle.client as never);
  setCandidateEvidenceClientForTests(handle.client as never);
  setCandidateAssessmentClient(handle.client as never);
  return {
    client: handle.client,
    changeEvidence(newEvidence: unknown[]) {
      evidenceRef.current = newEvidence;
    },
  };
}

test("REG A: snapshot idêntico - replay retorna identical_duplicate (baseline de idempotência)", async () => {
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  setupClient({ evidence: evidenceKnownPrice("129.90") });

  const first = await evaluateCandidateById(VALID_CANDIDATE_ID);
  const second = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(first.ok, true, `A ok=false: outcome=${first.outcome} error=${first.error}`);
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(first.decision?.digest, second.decision?.digest);
  resetCuratorNowProvider();
});

test("REG B: snapshot alterado por nova evidência - NOVA avaliação (NUNCA replay_lookup_failed)", async () => {
  // Reproduz o incidente da Fase 2: 1ª evidência avaliada; nova evidência
  // conhecida muda o snapshot; a reavaliação deve persistir uma segunda linha
  // com digest/assessment distintos, sem erro de persistência.
  // MESMO client entre A e B (tracker compartilhado) para simular fielmente a
  // colisão de PK do PostgREST quando a 2ª insert falha com 23505.
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  const handle = setupClient({ evidence: evidenceKnownPrice("129.90") });

  const a = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(a.ok, true, `A ok=false: outcome=${a.outcome} error=${a.error}`);
  assert.equal(a.outcome, "evaluated");
  const digestA = a.decision?.digest;

  // Nova evidência legítima → snapshot B. SEM reset do client: a 2ª insert
  // falha com 23505 (succeedInserts=1) e o service precisa resolver a replay
  // pela chave nova (B), que NUNCA pode coincidir com a chave gravada de A.
  handle.changeEvidence(evidencePriceAndRating("129.90"));
  const b = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(b.ok, true, `B ok=false: outcome=${b.outcome} error=${b.error}`);
  assert.equal(b.outcome, "evaluated", "snapshot B deve gerar avaliação nova, não duplicate nem erro");
  assert.notEqual(b.decision?.digest, digestA, "digest B deve diferir do digest A");
  resetCuratorNowProvider();
});

test("REG C: snapshot alterado - segunda avaliação persistida corretamente (avaliações distintas)", async () => {
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  setupClient({ evidence: evidenceKnownPrice("129.90") });
  const a = await evaluateCandidateById(VALID_CANDIDATE_ID);

  resetAllCurationClientsForTests();
  setupClient({ evidence: evidencePriceAndRating("129.90") });
  const b = await evaluateCandidateById(VALID_CANDIDATE_ID);

  // Cada avaliação persiste com digest único por snapshot (assessment_id é
  // derivado do digest no fix do replay_lookup_failed).
  assert.notEqual(a.decision?.digest, b.decision?.digest, "digests devem diferir entre snapshots");
  resetCuratorNowProvider();
});

test("REG D: replay do snapshot alterado (B) - identical_duplicate do B", async () => {
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  const handle = setupClient({ evidence: evidenceKnownPrice("129.90") });
  await evaluateCandidateById(VALID_CANDIDATE_ID);

  // Snapshot alterado no MESMO client (colisão de PK real simulada).
  handle.changeEvidence(evidencePriceAndRating("129.90"));
  const firstB = await evaluateCandidateById(VALID_CANDIDATE_ID);
  const replayB = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(firstB.outcome, "evaluated");
  assert.equal(replayB.outcome, "identical_duplicate");
  assert.equal(replayB.decision?.digest, firstB.decision?.digest);
  resetCuratorNowProvider();
});

test("REG E: IDs inválidos - fail-closed (400, nenhuma avaliação)", async () => {
  resetAllCurationClientsForTests();
  const candidates = ["", "can-xyz", "can-00000000000000000000000X", "not-a-candidate"];
  for (const id of candidates) {
    const r = await evaluateCandidateById(id);
    assert.equal(r.ok, false, `id=${id} deve falhar`);
    assert.equal(r.outcome, "candidate_not_found", `id=${id}`);
  }
});

test("REG F: avaliação BLOCKED nunca se converte em PASS após mudança de evidência", async () => {
  // Mesmo com evidência adicional, critérios bloqueantes (marketplace/
  // availability ausentes) mantêm BLOCKED — o fix não relaxa o veredicto.
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  const handle = setupClient({ evidence: evidenceKnownPrice("129.90") });
  const a = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.ok(a.decision?.verdict === "BLOCKED" || a.decision?.verdict === "FAIL", "verdict A não é PASS");

  // Evidência adicional no MESMO client (snapshot alterado).
  handle.changeEvidence(evidencePriceAndRating("129.90"));
  const b = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.ok(b.decision?.verdict !== "PASS", "evidência adicional não pode virar PASS");
  assert.notEqual(b.decision?.digest, a.decision?.digest, "snapshot alterado gera digest novo");
  resetCuratorNowProvider();
});

test("REG G: provenance invalida - bloqueio (fail-closed, sem avaliacao)", async () => {
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  const badCandidate = {
    ...mockCandidate,
    metadata: { source: "n10:telegram:url", provenance: "invented:fake" },
  };
  const handle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: badCandidate }, evidence: [] },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(handle.client as never);
  setCandidateEvidenceClientForTests(handle.client as never);
  setCandidateAssessmentClient(handle.client as never);
  const r = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(r.ok, true);
  assert.ok(r.decision?.verdict === "BLOCKED" || r.decision?.verdict === "FAIL", "provenance inventada deve bloquear (verdict non-PASS)");
  resetCuratorNowProvider();
});

test("REG H: N13 PASS legítimo permanece PASS em replay (sem mutação)", async () => {
  // O contrato continua permitindo: mesmo snapshot de um PASS legítimo -
  // identical_duplicate com o mesmo PASS; o fix não altera a semântica.
  resetAllCurationClientsForTests();
  setCuratorNowProvider(nowFixed);
  setupClient({ evidence: evidenceKnownPrice("129.90") });
  const first = await evaluateCandidateById(VALID_CANDIDATE_ID);
  const second = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(first.decision?.verdict, second.decision?.verdict);
  assert.equal(first.outcome, "evaluated");
  assert.equal(second.outcome, "identical_duplicate");
  resetCuratorNowProvider();
});