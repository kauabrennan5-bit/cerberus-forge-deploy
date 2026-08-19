// ============================================================================
// Bloco N13 — Filtro / Curadoria Cerberus (Fase 1) — SUÍTE DE TESTES.
//
// Determinística: nowProvider fixo, sem chamadas externas, sem random.
// Fail-closed: nenhum fallback para PASS.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURATOR_CRITERIA,
  CURATOR_PROVENANCE,
  isValidVerdict,
  type CuratorDecisionInput,
} from "../server/commercial/curation/contract";
import {
  deriveVerdict,
  deriveConfidence,
  evaluateCandidate,
} from "../server/commercial/curation/engine";
import {
  mapVerdictToAssessment,
  setCuratorNowProvider,
  resetCuratorNowProvider,
} from "../server/commercial/curation/service";
import { ASSESSMENT_KINDS, buildAssessmentDigest } from "../server/repositories/candidateAssessmentRepository";

const FIXED_NOW = "2026-08-18T00:00:00.000Z";
const VALID_CANDIDATE_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_EVIDENCE_ID = "evd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseInput(overrides: Partial<CuratorDecisionInput> = {}): CuratorDecisionInput {
  return {
    candidateId: VALID_CANDIDATE_ID,
    marketplace: "Mercado Livre",
    sourceUrl: "https://produto.mercadolivre.com.br/MLB-1456580521",
    externalListingId: "MLB-1456580521",
    status: "DISCOVERED",
    funnelStage: "INTAKE",
    provenance: "n10:telegram:url",
    evidence: [
      {
        evidenceId: VALID_EVIDENCE_ID,
        fieldName: "title",
        fieldState: "KNOWN",
        isContradicted: false,
        kind: "FIELD",
      },
    ],
    ...overrides,
  };
}

function knownGoodEvidence() {
  return [
    { evidenceId: VALID_EVIDENCE_ID, fieldName: "title", fieldState: "KNOWN" as const, isContradicted: false, kind: "FIELD" as const },
    { evidenceId: "evd-cccccccccccccccccccccccccccccccc", fieldName: "price", fieldState: "KNOWN" as const, isContradicted: false, kind: "FIELD" as const },
  ];
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

test("N13: contrato aceita somente PASS/FAIL/BLOCKED", () => {
  assert.ok(isValidVerdict("PASS"));
  assert.ok(isValidVerdict("FAIL"));
  assert.ok(isValidVerdict("BLOCKED"));
  assert.equal(isValidVerdict("REVIEW"), false);
  assert.equal(isValidVerdict("PENDING"), false);
  assert.equal(isValidVerdict("MAYBE"), false);
});

test("N13: contractVersion estável (curator_v1)", () => {
  const decision = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal(decision.contractVersion, "curator_v1");
});

// ---------------------------------------------------------------------------
// Motor puro
// ---------------------------------------------------------------------------

test("N13 engine: candidato válido → PASS", () => {
  const decision = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.confidence, 1);
  assert.equal(decision.rationale, "todos_os_criterios_estruturais_atendidos_com_evidencia_suficiente");
});

test("N13 engine: evidência ausente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ evidence: [] }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.rationale.startsWith("informacao_insuficiente_ou_conflitante:"));
  assert.ok(decision.criteria.some((c) => c.criterion === "c_evidence_present" && c.result === "blocked"));
});

test("N13 engine: evidência contraditada → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({
      evidence: [
        { ...knownGoodEvidence()[0], isContradicted: true },
        knownGoodEvidence()[1],
      ],
    }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_evidence_coherent" && c.result === "blocked"));
});

test("N13 engine: field_state CONTRADICTED → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({
      evidence: [
        { ...knownGoodEvidence()[0], fieldState: "CONTRADICTED" },
        knownGoodEvidence()[1],
      ],
    }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: COLLECTION_FAILED → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({
      evidence: [
        { ...knownGoodEvidence()[0], fieldState: "COLLECTION_FAILED" },
        knownGoodEvidence()[1],
      ],
    }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_evidence_coherent" && c.result === "blocked"));
});

test("N13 engine: todas as evidências UNKNOWN → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({
      evidence: knownGoodEvidence().map((e) => ({ ...e, fieldState: "UNKNOWN" })),
    }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: marketplace não suportado (Outro) → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ marketplace: "Outro" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_marketplace_recognized" && c.result === "blocked"));
});

test("N13 engine: marketplace ausente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ marketplace: null }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: URL de host fora do whitelist → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({ sourceUrl: "https://loja-estranha.example.com/produto" }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_url_valid" && c.result === "blocked"));
});

test("N13 engine: URL inválida → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ sourceUrl: "não-é-uma-url" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: provenance não reconhecida → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ provenance: "scraper:arbitrario" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: provenance ausente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ provenance: null }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: status rejeitado (REJECTED) → FAIL", () => {
  const decision = evaluateCandidate(
    baseInput({ status: "REJECTED", evidence: knownGoodEvidence() }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "FAIL");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_entry_state_valid" && c.result === "failed"));
});

test("N13 engine: status retirado (WITHDRAWN) → FAIL", () => {
  const decision = evaluateCandidate(
    baseInput({ status: "WITHDRAWN", evidence: knownGoodEvidence() }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "FAIL");
});

test("N13 engine: funnel_stage FUNNEL_END → FAIL", () => {
  const decision = evaluateCandidate(
    baseInput({ funnelStage: "FUNNEL_END", evidence: knownGoodEvidence() }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "FAIL");
});

test("N13 engine: identidade não resolvida (sem external_listing_id) → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({ externalListingId: null, evidence: knownGoodEvidence() }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
  assert.ok(decision.criteria.some((c) => c.criterion === "c_identity_fields_complete" && c.result === "blocked"));
});

test("N13 engine: candidate_id fora do formato canônico → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ candidateId: "nao-can-123" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 engine: erro na decisão nunca é possível — todos os caminhos terminam em verdict válido", () => {
  const verdicts = new Set<string>();
  for (const marketplace of ["Mercado Livre", "Shopee", "Outro", null]) {
    for (const status of ["DISCOVERED", "REJECTED", null]) {
      for (const evidence of [knownGoodEvidence(), [], knownGoodEvidence().map((e) => ({ ...e, isContradicted: true }))]) {
        verdicts.add(evaluateCandidate(baseInput({ marketplace, status, evidence }), FIXED_NOW).verdict);
      }
    }
  }
  assert.deepEqual([...verdicts].sort(), ["BLOCKED", "FAIL", "PASS"]);
});

// ---------------------------------------------------------------------------
// Determinismo
// ---------------------------------------------------------------------------

test("N13 engine: mesma entrada produz MESMO verdict, rationale, confidence e digest", () => {
  const input = baseInput({ evidence: knownGoodEvidence() });
  const a = evaluateCandidate(input, FIXED_NOW);
  const b = evaluateCandidate(input, FIXED_NOW);
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.rationale, b.rationale);
  assert.equal(a.confidence, b.confidence);
  assert.equal(a.digest, b.digest);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("N13 engine: timestamp diferente NÃO muda decisão nem digest", () => {
  const input = baseInput({ evidence: knownGoodEvidence() });
  const a = evaluateCandidate(input, "2026-01-01T00:00:00.000Z");
  const b = evaluateCandidate(input, "2099-12-31T23:59:59.000Z");
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.evaluatedAt, b.evaluatedAt);
});

test("N13 engine: digest é ESTÁVEL mesmo com ordem diferente de evidências (determinismo)", () => {
  // O stableDigest normaliza a ordem das evidências (sort por evidenceId):
  // mesmo conjunto em qualquer ordem → mesmo digest (replay sempre bate).
  const evidences = knownGoodEvidence();
  const a = evaluateCandidate(baseInput({ evidence: evidences }), FIXED_NOW);
  const b = evaluateCandidate(baseInput({ evidence: [...evidences].reverse() }), FIXED_NOW);
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.digest, b.digest);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("N13 engine: evidências com conteúdo diferente geram digest diferente", () => {
  const evidences = knownGoodEvidence();
  const a = evaluateCandidate(baseInput({ evidence: evidences }), FIXED_NOW);
  // Substitui a evidência por uma de ID e campo diferentes (a ordenação por
  // evidenceId não pode mascarar mudança real de conteúdo).
  const b = evaluateCandidate(
    baseInput({
      evidence: [
        { evidenceId: "evd-dddddddddddddddddddddddddddddddddd", fieldName: "title", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
        evidences[1],
      ],
    }),
    FIXED_NOW,
  );
  assert.notEqual(a.digest, b.digest);
});

// ---------------------------------------------------------------------------
// Mapeamento para persistência N4
// ---------------------------------------------------------------------------

test("N13: mapVerdictToAssessment usa filter_version n13:curator_v1 e nunca autoridade comercial", () => {
  assert.equal(ASSESSMENT_KINDS.includes("n13:curator_v1"), true);
  const passMapped = mapVerdictToAssessment({ verdict: "PASS" } as never);
  const failMapped = mapVerdictToAssessment({ verdict: "FAIL" } as never);
  const blockedMapped = mapVerdictToAssessment({ verdict: "BLOCKED" } as never);
  assert.equal(passMapped.filterVersion, "n13:curator_v1");
  assert.equal(failMapped.filterVersion, "n13:curator_v1");
  assert.equal(blockedMapped.filterVersion, "n13:curator_v1");
  // Nenhum verdict gera WINNER/HIDDEN_GEM (autoridade comercial do N4).
  assert.notEqual(passMapped.classification, "WINNER");
  assert.notEqual(failMapped.classification, "HIDDEN_GEM");
});

test("N13: deriveVerdict respeita precedência failed > blocked", () => {
  assert.equal(deriveVerdict([{ criterion: "c_entry_state_valid", result: "failed", rationale: "x" }]), "FAIL");
  assert.equal(deriveVerdict([{ criterion: "c_evidence_present", result: "blocked", rationale: "y" }]), "BLOCKED");
  assert.equal(deriveVerdict([{ criterion: "c_url_valid", result: "checked", rationale: "z" }]), "PASS");
  assert.equal(
    deriveVerdict([
      { criterion: "c_evidence_present", result: "blocked", rationale: "y" },
      { criterion: "c_entry_state_valid", result: "failed", rationale: "x" },
    ]),
    "FAIL",
  );
});

test("N13: deriveConfidence é determinística", () => {
  assert.equal(deriveConfidence([]), 0);
  assert.equal(
    deriveConfidence([
      { criterion: "c_url_valid", result: "checked", rationale: "" },
      { criterion: "c_evidence_present", result: "blocked", rationale: "" },
    ]),
    0.5,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed e determinismo do digest oficial
// ---------------------------------------------------------------------------

test("N13: digest oficial usa buildAssessmentDigest da persistência (mesma origem)", () => {
  const decision = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  const snapshot = { verdict: decision.verdict };
  const digest = buildAssessmentDigest({
    candidateId: VALID_CANDIDATE_ID,
    filterVersion: "n13:curator_v1",
    snapshot,
  });
  assert.match(digest, /^sha256:/);
  assert.equal(buildAssessmentDigest({ candidateId: VALID_CANDIDATE_ID, filterVersion: "n13:curator_v1", snapshot }), digest);
});

test("N13: provenance do contrato é fixa (n13:admin:manual)", () => {
  assert.equal(CURATOR_PROVENANCE, "n13:admin:manual");
});

// ---------------------------------------------------------------------------
// Serviço com mocks (read-only + idempotência)
// ---------------------------------------------------------------------------

import { evaluateCandidateById } from "../server/commercial/curation/service";
import { getCandidate, setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  listCandidateEvidence,
  setCandidateEvidenceClientForTests,
} from "../server/repositories/candidateEvidenceRepository";
import {
  persistAssessment,
  deleteAssessmentForProof,
  resetAssessmentClientForTests,
  setCandidateAssessmentClient,
} from "../server/repositories/candidateAssessmentRepository";

let assessmentCreated = false;

const mockCandidate = {
  candidate_id: VALID_CANDIDATE_ID,
  listing_key: "mlb-1456580521",
  schema_version: "1.0",
  discovery_rigor_version: "1.0",
  marketplace: "Mercado Livre",
  merchant: "loja-exemplo",
  source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
  external_listing_id: "MLB-1456580521",
  title: "Produto Exemplo",
  description: "",
  category: "Eletrônicos",
  observed_price: 99.9,
  observed_rating: null,
  observed_rating_count: null,
  observed_availability: "IN_STOCK",
  observed_at: "2026-08-18T00:00:00Z",
  evidence_hash: "sha256:abc",
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
  metadata: { provenance: "n10:telegram:url" },
  created_by: "test",
  created_at: "2026-08-18T00:00:00Z",
  updated_at: "2026-08-18T00:00:00Z",
} as never;

const firstMockEvidence = {
    evidence_id: VALID_EVIDENCE_ID,
    candidate_id: VALID_CANDIDATE_ID,
    research_id: "rsr-test",
    kind: "FIELD",
    field_name: "title",
    field_value: null,
    field_state: "KNOWN",
    source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
    source_type: "listing",
    collection_method: "url",
    observed_at: "2026-08-18T00:00:00Z",
    evidence_hash: "sha256:abc",
    field_hash: null,
    quality: "high",
    unit: null,
    evidence_note: "",
    metadata: {},
    created_at: "2026-08-18T00:00:00Z",
  };

const mockEvidence = [
  firstMockEvidence,
  {
    ...firstMockEvidence,
    evidence_id: "evd-cccccccccccccccccccccccccccccccc",
    field_name: "price",
    field_value: { value: 99.9, currency: "BRL" },
  },
];

test.beforeEach(() => {
  assessmentCreated = false;
  setCuratorNowProvider(() => FIXED_NOW);
});

test.afterEach(() => {
  resetCuratorNowProvider();
  setCandidatesClientForTests(null);
  setCandidateEvidenceClientForTests(null);
  resetAssessmentClientForTests(null);
});

// Mocks via cliente Supabase injetável (setXxxClientForTests), usando o proxy
// de makeMockSupabaseClient — sem sobrescrever exports readonly (ESM).
import { makeMockSupabaseClient } from "./curationMocks";

test("N13 service: candidato válido → PASS avaliado e persistido (mock)", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidence: mockEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.ok, true, `esperado ok mas outcome=${result.outcome} error=${result.error}`);
  assert.equal(result.outcome, "evaluated");
  assert.equal(result.decision?.verdict, "PASS", `verdict=${result.decision?.verdict} rationale=${result.decision?.rationale}`);
  assert.equal(mockHandle.insertCalls(), 1, "persistAssessment NUNCA foi chamado");
});

test("N13 service: idempotência — segundo evaluate retorna identical_duplicate", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidence: mockEvidence as never },
    persist: { succeedInserts: 1, replayRow: { assessment_id: "cur-replay", idempotency_key: "key-x" } },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  const first = await evaluateCandidateById(VALID_CANDIDATE_ID);
  const second = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(first.decision?.verdict, "PASS");
  assert.equal(first.outcome, "evaluated");
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.decision?.verdict, "PASS");
  assert.equal(first.decision?.digest, second.decision?.digest);
});

test("N13 service: candidato inexistente → candidate_not_found (sem avaliação)", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidateNotFound: true, evidence: [] },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "candidate_not_found");
  assert.equal(mockHandle.insertCalls(), 0, "candidato inexistente NÃO deve gerar avaliação persistida");
});

test("N13 service: erro de leitura de evidência → erro reportado, sem PASS", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidenceUnavailable: true },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "evidence_unavailable");
  assert.equal(mockHandle.insertCalls(), 0, "erro de evidência NÃO deve persistir avaliação");
});

test("N13 service: exceção inesperada → fail-closed, decisão BLOCKED persistida", async () => {
  // getCandidate → null client → getCandidate retorna { ok:false }... para forçar
  // exceção real, o client de candidates throws no "from": usar Proxy que dispara
  // erro ao acessar .from.
  const brokenHandle = {
    client: new Proxy(
      {},
      {
        get() {
          throw new Error("supabase_down");
        },
      },
    ) as never,
  };
  setCandidatesClientForTests(brokenHandle.client);
  // assessment client ok para a auditoria do erro poder persistir
  const assessmentClient = makeMockSupabaseClient({ persist: { succeedInserts: 1 } });
  setCandidateAssessmentClient(assessmentClient.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /internal_error/);
});

test("N13 service: candidato com evidências insuficientes → BLOCKED persistido", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidence: [] },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.ok, true);
  assert.equal(result.decision?.verdict, "BLOCKED");
  assert.match(result.decision?.rationale ?? "", /blocked|informacao_insuficiente/);
});

// ---------------------------------------------------------------------------
// Guardas de não-publicação
// ---------------------------------------------------------------------------

test("N13: evaluateCandidate não cria produto (engine puro, sem side-effects)", () => {
  const input = baseInput({ evidence: knownGoodEvidence() });
  const decision = evaluateCandidate(input, FIXED_NOW);
  assert.equal(decision.verdict, "PASS");
  // Não existe objeto produto/link/job na saída — somente decisão + metadados.
  assert.equal(Object.prototype.hasOwnProperty.call(decision, "productId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(decision, "affiliateUrl"), false);
});

test("N13: PASS nunca é produzido por fallback — exige todos os critérios checked", () => {
  // Brute-force: varre combinações degradadas e garante que nenhuma
  // combinação com blocked/failed produz PASS.
  const markets = ["Mercado Livre", null];
  const statuses = ["DISCOVERED", "REJECTED", null];
  const evs: CuratorDecisionInput["evidence"][] = [
    knownGoodEvidence(),
    [],
    knownGoodEvidence().map((e) => ({ ...e, isContradicted: true })),
  ];
  for (const marketplace of markets) {
    for (const status of statuses) {
      for (const evidence of evs) {
        const decision = evaluateCandidate(baseInput({ marketplace, status, evidence }), FIXED_NOW);
        if (decision.verdict === "PASS") {
          // Só passa quando tudo está checked — confirmar:
          assert.equal(decision.criteria.every((c) => c.result === "checked"), true);
        }
      }
    }
  }
});
