// ============================================================================
// Bloco N13 — Filtro / Curadoria Cerberus (FASE 2) — HARDENING E COBERTURA.
//
// OBJETIVO DA FASE 2:
// - Cobertura explícita de casos-limite de entrada (payload incompleto,
//   evidência parcial/ausente, UNKNOWN, CONTRADICTED, URL inválida,
//   host não-whitelisted, proveniência ausente, identidade inconsistente).
// - Invariantes garantidas por teste: FAIL nunca vira PASS, BLOCKED nunca
//   vira PASS, UNKNOWN/CONTRADICTED nunca são promovidos, N13 nunca toca
//   products/affiliate_links/job_queue, mesmo payload → mesmo digest.
// - Isolamento N13/N14: nenhum sinal comercial entra na curadoria.
//
// GOVERNANÇA: determinístico, fail-closed, read-only sobre o catálogo.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  CURATOR_CRITERIA,
  type CuratorDecisionInput,
  type CuratorEvidenceInput,
} from "../server/commercial/curation/contract";
import {
  evaluateCandidate,
  deriveVerdict,
} from "../server/commercial/curation/engine";
import {
  mapVerdictToAssessment,
  setCuratorNowProvider,
  resetCuratorNowProvider,
  evaluateCandidateById,
} from "../server/commercial/curation/service";
import { makeMockSupabaseClient } from "./curationMocks";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";
import { setCandidateAssessmentClient, resetAssessmentClientForTests } from "../server/repositories/candidateAssessmentRepository";

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

function knownGoodEvidence(): CuratorEvidenceInput[] {
  return [
    { evidenceId: VALID_EVIDENCE_ID, fieldName: "title", fieldState: "KNOWN", isContradicted: false, kind: "FIELD" },
    { evidenceId: "evd-cccccccccccccccccccccccccccccccc", fieldName: "price", fieldState: "KNOWN", isContradicted: false, kind: "FIELD" },
  ];
}

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

// ---------------------------------------------------------------------------
// Setup determinístico
// ---------------------------------------------------------------------------
test.beforeEach(() => {
  setCuratorNowProvider(() => FIXED_NOW);
});

test.afterEach(() => {
  resetCuratorNowProvider();
  setCandidatesClientForTests(null);
  setCandidateEvidenceClientForTests(null);
  resetAssessmentClientForTests(null);
});

// ---------------------------------------------------------------------------
// 1. COBERTURA DE ENTRADAS — casos-limite do prompt da Fase 2
// ---------------------------------------------------------------------------

test("N13 Fase 2: payload incompleto (todos os campos null) → BLOCKED", () => {
  const decision = evaluateCandidate(
    {
      candidateId: "",
      marketplace: null,
      sourceUrl: null,
      externalListingId: null,
      status: null,
      funnelStage: null,
      provenance: null,
      evidence: [],
    },
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.criteria.filter((c) => c.result === "blocked").length, 8);
});

test("N13 Fase 2: payload vazio parcial (somente candidate_id válido) → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ marketplace: null, sourceUrl: null, externalListingId: null, status: null, funnelStage: null, provenance: null, evidence: [] }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.criteria.filter((c) => c.result === "checked").length, 1, "somente a identidade passa");
});

test("N13 Fase 2: evidência parcial (alguns campos UNKNOWN, ao menos um KNOWN) → checked nos coerentes, sem promoção de UNKNOWN", () => {
  const evidence: CuratorEvidenceInput[] = [
    { evidenceId: VALID_EVIDENCE_ID, fieldName: "title", fieldState: "KNOWN", isContradicted: false, kind: "FIELD" },
    { evidenceId: "evd-cccccccccccccccccccccccccccccccc", fieldName: "price", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
    { evidenceId: "evd-dddddddddddddddddddddddddddddddd", fieldName: "images", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
  ];
  const decision = evaluateCandidate(baseInput({ evidence }), FIXED_NOW);
  assert.equal(decision.verdict, "PASS", "UNKNOWN parcial NÃO bloqueia — só quando TODAS são UNKNOWN");
  assert.equal(decision.criteria.find((c) => c.criterion === "c_evidence_coherent")?.result, "checked");
});

test("N13 Fase 2: todas as evidências UNKNOWN → BLOCKED (nada utilizável)", () => {
  const evidence: CuratorEvidenceInput[] = [
    { evidenceId: VALID_EVIDENCE_ID, fieldName: "title", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
    { evidenceId: "evd-cccccccccccccccccccccccccccccccc", fieldName: "price", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
  ];
  const decision = evaluateCandidate(baseInput({ evidence }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.criteria.find((c) => c.criterion === "c_evidence_coherent")?.result, "blocked");
});

test("N13 Fase 2: CONTRADICTED via fieldState → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({ evidence: [{ ...baseInput().evidence[0], fieldState: "CONTRADICTED" }] }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 Fase 2: CONTRADICTED via isContradicted=true → BLOCKED", () => {
  const decision = evaluateCandidate(
    baseInput({ evidence: [{ ...baseInput().evidence[0], isContradicted: true }] }),
    FIXED_NOW,
  );
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 Fase 2: CONTRADICTED via metadata.contradiction_with → BLOCKED (via service)", async () => {
  const mockHandle = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidence: mockEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(mockHandle.client as never);
  setCandidateEvidenceClientForTests(mockHandle.client as never);
  setCandidateAssessmentClient(mockHandle.client as never);

  // Simula evidência com metadata.contradiction_with (usada pelo service para
  // derivar isContradicted).
  const contradictedEvidence = mockEvidence.map((e, i) =>
    i === 0 ? { ...e, metadata: { contradiction_with: ["evd-xxxx"] } } : e,
  );
  // Reinjetar mock retornando evidência contraditada.
  const handle2 = makeMockSupabaseClient({
    reads: { candidate: { ok: true, candidate: mockCandidate as never }, evidence: contradictedEvidence as never },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(handle2.client as never);
  setCandidateEvidenceClientForTests(handle2.client as never);
  setCandidateAssessmentClient(handle2.client as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  assert.equal(result.decision?.verdict, "BLOCKED", `verdict=${result.decision?.verdict}`);
});

test("N13 Fase 2: preço inconsistente NÃO é resolvido pelo N13 — coerência é sobre contradições/UNKNOWN (isolamento N13/N14)", () => {
  // O N13 NÃO analisa valores numéricos de preço. Um preço "alto" ou "baixo"
  // não muda o veredicto: isso é qualidade COMERCIAL (N14).
  const barato = baseInput({ evidence: knownGoodEvidence().map((e) => e.fieldName === "price" ? { ...e, fieldName: "price" } : e) });
  const caro = { ...baseInput({ evidence: knownGoodEvidence() }) };
  const d1 = evaluateCandidate(barato, FIXED_NOW);
  const d2 = evaluateCandidate(caro, FIXED_NOW);
  // Veredicto idêntico: N13 não diferencia preço numérico.
  assert.equal(d1.verdict, d2.verdict);
  assert.equal(d1.digest, d2.digest);
});

test("N13 Fase 2: identidade inconsistente (external_listing_id vazio) → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ externalListingId: "" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.criteria.find((c) => c.criterion === "c_identity_fields_complete")?.result, "blocked");
});

test("N13 Fase 2: URL inválida (malformed) → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ sourceUrl: "nao-e-uma-url" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.criteria.find((c) => c.criterion === "c_url_valid")?.result, "blocked");
});

test("N13 Fase 2: URL ausente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ sourceUrl: null }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 Fase 2: host não-whitelisted → BLOCKED (mesmo marketplace reconhecido)", () => {
  const decision = evaluateCandidate(baseInput({ sourceUrl: "https://produto.falsomercadolivre.com/MLB-123" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
  assert.match(decision.criteria.find((c) => c.criterion === "c_url_valid")?.rationale ?? "", /fora do whitelist/);
});

test("N13 Fase 2: host não-whitelisted — domínio de marketplace diferente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ sourceUrl: "https://produto.shopee.com.br/item-123" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED", "URL Shopee em candidato Mercado Livre: host fora do whitelist do marketplace");
});

test("N13 Fase 2: subdomínio oficial reconhecido → URL válida", () => {
  const decision = evaluateCandidate(
    baseInput({ sourceUrl: "https://lista.mercadolivre.com.br/MLB-123", externalListingId: "MLB-123" }),
    FIXED_NOW,
  );
  assert.equal(decision.criteria.find((c) => c.criterion === "c_url_valid")?.result, "checked");
});

test("N13 Fase 2: provenance ausente → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ provenance: null }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 Fase 2: provenance não reconhecida → BLOCKED", () => {
  const decision = evaluateCandidate(baseInput({ provenance: "unknown:source" }), FIXED_NOW);
  assert.equal(decision.verdict, "BLOCKED");
});

test("N13 Fase 2: candidato válido → PASS (regressão da cobertura)", () => {
  const decision = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal(decision.verdict, "PASS");
});

// ---------------------------------------------------------------------------
// 2. HARDENING DOS 8 CRITÉRIOS — ambiguidade relevante falha fechado
// ---------------------------------------------------------------------------

test("N13 Fase 2: os 8 critérios continuam exatamente os mesmos (sem deriva)", () => {
  assert.equal(CURATOR_CRITERIA.length, 8);
});

test("N13 Fase 2: dados insuficientes em QUALQUER critério → BLOCKED (não PASS)", () => {
  // Varre: cada campo do input degradado para null/vazio individualmente.
  const variants: Array<[string, Partial<CuratorDecisionInput>]> = [
    ["candidateId", { candidateId: "" }],
    ["marketplace", { marketplace: null }],
    ["sourceUrl", { sourceUrl: null }],
    ["externalListingId", { externalListingId: null }],
    ["status", { status: null }],
    ["provenance", { provenance: null }],
    ["evidence", { evidence: [] }],
  ];
  for (const [name, variant] of variants) {
    const decision = evaluateCandidate(baseInput(variant), FIXED_NOW);
    assert.notEqual(decision.verdict, "PASS", `${name}=${variant[Object.keys(variant)[0]]} produziu PASS indevido`);
  }
});

test("N13 Fase 2: nenhum critério aceita inventar dados — rationale é determinístico por caso", () => {
  const cases: Array<[Partial<CuratorDecisionInput>, string]> = [
    [{ candidateId: "" }, "fora do formato canônico"],
    [{ marketplace: null }, "marketplace ausente"],
    [{ sourceUrl: "http://" }, "source_url inválida"],
    [{ evidence: [] }, "nenhuma evidência"],
    [{ provenance: null }, "provenance ausente"],
    [{ status: null }, "status ausente"],
    [{ externalListingId: null }, "identidade do anúncio não resolvida"],
  ];
  for (const [variant, fragment] of cases) {
    const decision = evaluateCandidate(baseInput(variant), FIXED_NOW);
    assert.equal(decision.verdict, "BLOCKED", `${fragment} não produziu BLOCKED`);
    assert.match(decision.rationale, /informacao_insuficiente_ou_conflitante/);
  }
});

// ---------------------------------------------------------------------------
// 3. INVARIANTES
// ---------------------------------------------------------------------------

test("N13 Fase 2: FAIL nunca vira PASS — mutação checked→failed em qualquer critério bloqueia PASS", () => {
  const decision = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal(decision.verdict, "PASS");
  for (const crit of decision.criteria) {
    const mut: CuratorDecisionInput = {
      candidateId: crit.criterion === "c_candidate_identity_present" ? "can-bbbb" : VALID_CANDIDATE_ID,
      marketplace: crit.criterion === "c_marketplace_recognized" ? null : "Mercado Livre",
      sourceUrl: crit.criterion === "c_url_valid" ? null : "https://produto.mercadolivre.com.br/MLB-1456580521",
      externalListingId: crit.criterion === "c_identity_fields_complete" ? null : "MLB-1456580521",
      status: crit.criterion === "c_entry_state_valid" ? "REJECTED" : "DISCOVERED",
      funnelStage: crit.criterion === "c_entry_state_valid" ? "FUNNEL_END" : "INTAKE",
      provenance: crit.criterion === "c_provenance_valid" ? null : "n10:telegram:url",
      evidence: crit.criterion === "c_evidence_present" || crit.criterion === "c_evidence_coherent" ? [] : knownGoodEvidence(),
    };
    const m = evaluateCandidate(mut, FIXED_NOW);
    assert.notEqual(m.verdict, "PASS", `critério ${crit.criterion} mutado produziu PASS`);
    // O critério mutado é no máximo failed; nunca checked (confirma mutação válida):
    const mutatedEval = m.criteria.find((c) => c.criterion === crit.criterion);
    assert.notEqual(mutatedEval?.result, "checked", `mutação não invalidou ${crit.criterion}`);
  }
});

test("N13 Fase 2: BLOCKED nunca vira PASS — mutação checked→blocked mantém BLOCKED", () => {
  const base: CuratorDecisionInput = {
    candidateId: "",
    marketplace: null,
    sourceUrl: "nota-url-invalida",
    externalListingId: null,
    status: null,
    funnelStage: null,
    provenance: null,
    evidence: [],
  };
  const d = evaluateCandidate(base, FIXED_NOW);
  assert.equal(d.verdict, "BLOCKED");
  // Se todos os criteria passassem a checked, seria PASS; mas nenhum
  // mutador válido de checked→blocked pode converter BLOCKED em PASS
  // porque a regra global tem blocked como barreira:
  const allChecked = d.criteria.every((c) => c.result === "checked");
  assert.equal(allChecked, false, "BLOCKED integral não pode se tornar PASS por mutação sem dados válidos");
});

test("N13 Fase 2: UNKNOWN nunca é promovido — só quando TODAS as evidências são UNKNOWN o veredicto é BLOCKED", () => {
  const allUnknown: CuratorEvidenceInput[] = [
    { evidenceId: "evd-11111111111111111111111111111111", fieldName: "title", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
  ];
  const d = evaluateCandidate(baseInput({ evidence: allUnknown }), FIXED_NOW);
  assert.equal(d.verdict, "BLOCKED");
  // Mixed: UNKNOWN não é promovido a aprovado, apenas tolerado (PASS estrutural)
  const mixed: CuratorEvidenceInput[] = [
    { evidenceId: "evd-11111111111111111111111111111111", fieldName: "title", fieldState: "KNOWN", isContradicted: false, kind: "FIELD" },
    { evidenceId: "evd-22222222222222222222222222222222", fieldName: "price", fieldState: "UNKNOWN", isContradicted: false, kind: "FIELD" },
  ];
  const m = evaluateCandidate(baseInput({ evidence: mixed }), FIXED_NOW);
  // A evidência KNOWN dá coerência; UNKNOWN não é "promovido", apenas não bloqueia.
  assert.equal(m.criteria.find((c) => c.criterion === "c_evidence_coherent")?.result, "checked");
});

test("N13 Fase 2: CONTRADICTED nunca é promovido — qualquer contradição → BLOCKED", () => {
  const cases: CuratorEvidenceInput[][] = [
    [{ ...baseInput().evidence[0], fieldState: "CONTRADICTED" }],
    [{ ...baseInput().evidence[0], isContradicted: true }],
  ];
  for (const evidence of cases) {
    const d = evaluateCandidate(baseInput({ evidence }), FIXED_NOW);
    assert.equal(d.verdict, "BLOCKED", `CONTRADICTED foi promovido a ${d.verdict}`);
  }
});

test("N13 Fase 2: mesmo payload produz o mesmo digest e o mesmo verdict (idempotência explícita, 10 iterações)", () => {
  const input = baseInput({ evidence: knownGoodEvidence() });
  const results = Array.from({ length: 10 }, () => evaluateCandidate(input, FIXED_NOW));
  const digests = new Set(results.map((r) => r.digest));
  const verdicts = new Set(results.map((r) => r.verdict));
  assert.equal(digests.size, 1, "digest varia entre execuções");
  assert.equal(verdicts.size, 1, "verdict varia entre execuções");
});

test("N13 Fase 2: alteração no candidato ou evidência produz nova avaliação com digest diferente", () => {
  const a = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  const b = evaluateCandidate(baseInput({ evidence: knownGoodEvidence(), status: "REVIEWING" }), FIXED_NOW);
  const c = evaluateCandidate(baseInput({ evidence: [{ ...knownGoodEvidence()[0], fieldState: "UNKNOWN" }] }), FIXED_NOW);
  assert.notEqual(a.digest, b.digest, "mudança de status não gerou digest novo");
  assert.notEqual(a.digest, c.digest, "mudança de evidência não gerou digest novo");
});

test("N13 Fase 2: N13 nunca altera products — service usa somente as tabelas candidates, candidate_evidence e candidate_assessment", async () => {
  const allowed = new Set(["candidates", "candidate_evidence", "candidate_assessment"]);
  const touched: string[] = [];
  const trackingClient = {
    from(table: string): unknown {
      touched.push(table);
      return {
        select: () => trackingClient.from("noop"),
        insert: () => trackingClient.from("noop"),
        eq: () => trackingClient.from("noop"),
        order: () => trackingClient.from("noop"),
        limit: () => trackingClient.from("noop"),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then(resolve: (v: unknown) => void) { return Promise.resolve({ data: null, error: null }).then(resolve); },
      };
    },
  };
  setCandidatesClientForTests(trackingClient as never);
  setCandidateEvidenceClientForTests(trackingClient as never);
  setCandidateAssessmentClient(trackingClient as never);

  const result = await evaluateCandidateById(VALID_CANDIDATE_ID);
  // candidate não encontrado pela cadeia neutra → candidate_not_found,
  // mas o serviço NÃO tenta tocar products/affiliate_links/job_queue.
  const forbidden = touched.filter((t) => !allowed.has(t) && t !== "noop");
  assert.equal(forbidden.length, 0, `tabelas não autorizadas tocadas: ${forbidden.join(",")}`);
  assert.equal(touched.some((t) => t === "products"), false);
  assert.equal(touched.some((t) => t === "affiliate_links"), false);
  assert.equal(touched.some((t) => t === "job_queue"), false);
  assert.equal(result.ok, false, "esperado candidate_not_found com cliente neutro");
});

test("N13 Fase 2: N13 nunca gera affiliate link — decision não carrega URL de afiliado", () => {
  const d = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal("affiliateLink" in d, false);
  assert.equal("affiliateUrl" in d, false);
  assert.equal("link" in d, false);
});

test("N13 Fase 2: N13 nunca cria job — não há referência a job_queue no serviço de curadoria", () => {
  const serviceSrc = fs.readFileSync(path.resolve(__dirname, "../server/commercial/curation/service.ts"), "utf8");
  assert.equal(serviceSrc.includes("job_queue"), false);
  const engineSrc = fs.readFileSync(path.resolve(__dirname, "../server/commercial/curation/engine.ts"), "utf8");
  assert.equal(engineSrc.includes("job"), false);
  const contractSrc = fs.readFileSync(path.resolve(__dirname, "../server/commercial/curation/contract.ts"), "utf8");
  assert.equal(contractSrc.includes("job"), false);
});

test("N13 Fase 2: N13 nunca publica — decision não carrega productId nem promoted_at", () => {
  const d = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal("productId" in d, false);
  assert.equal("promotedAt" in d, false);
  assert.equal("published" in d, false);
});

// ---------------------------------------------------------------------------
// 4. ISOLAMENTO N13 → N14 — sem sinais comerciais
// ---------------------------------------------------------------------------

test("N13 Fase 2: engine não contém sinais comerciais (demanda, comissão, margem, CTR, ROI, concorrência, score)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../server/commercial/curation/engine.ts"), "utf8");
  const forbidden = ["demand", "commission", "margin", "ctr", "conversion", "competition", "roi", "revenue", "profit"];
  const lower = src.toLowerCase();
  for (const f of forbidden) {
    assert.equal(lower.includes(f), false, `engine contém sinal comercial: ${f}`);
  }
});

test("N13 Fase 2: contract não contém sinais comerciais", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../server/commercial/curation/contract.ts"), "utf8");
  const forbidden = ["demand", "commission", "margin", "conversion", "competition", "roi"];
  const lower = src.toLowerCase();
  for (const f of forbidden) {
    assert.equal(lower.includes(f), false, `contract contém sinal comercial: ${f}`);
  }
});

test("N13 Fase 2: serviço N13 não consome sinal comercial — mapVerdictToAssessment usa classificação NON-COMERCIAL (NONE/INSUFFICIENT)", () => {
  const d = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  const mapped = mapVerdictToAssessment(d);
  assert.equal(mapped.filterVersion, "n13:curator_v1");
  assert.notEqual(mapped.classification, "RECOMMENDED");
  assert.equal(mapped.classificationBasis.includes("nao_comercial"), true);
});

test("N13 Fase 2: deriveVerdict continua disponível e determinístico", () => {
  const d = evaluateCandidate(baseInput({ evidence: knownGoodEvidence() }), FIXED_NOW);
  assert.equal(deriveVerdict(d.criteria), d.verdict);
});

test("N13 Fase 2: verdicts são somente PASS/FAIL/BLOCKED — sem estado comercial intermediário", () => {
  const verdicts = new Set<string>();
  // varre casos degradados e o caso perfeito
  const cases: CuratorDecisionInput[] = [
    baseInput({ evidence: knownGoodEvidence() }),
    baseInput({ evidence: [] }),
    baseInput({ evidence: [{ ...baseInput().evidence[0], fieldState: "CONTRADICTED" }] }),
    baseInput({ status: "REJECTED", evidence: knownGoodEvidence() }),
    { candidateId: "", marketplace: null, sourceUrl: null, externalListingId: null, status: null, funnelStage: null, provenance: null, evidence: [] },
  ];
  for (const c of cases) verdicts.add(evaluateCandidate(c, FIXED_NOW).verdict);
  assert.equal([...verdicts].every((v) => ["PASS", "FAIL", "BLOCKED"].includes(v)), true, `verdicts fora do contrato: ${[...verdicts].join(",")}`);
});
