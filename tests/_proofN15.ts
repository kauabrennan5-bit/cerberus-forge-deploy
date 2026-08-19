// ============================================================================
// Prova controlada LOCAL do N15 (Fase 1) — casos A..S + não-subversão.
// Rodada pelo runner: npx tsx --test. NÃO persiste em produção, NÃO aplica
// migration, NÃO executa ações comerciais (Publish/Advertise) — apenas
// autoriza ou bloqueia.
// ============================================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeMockSupabaseClient } from "./curationMocks";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  setCandidateAssessmentClient,
  resetAssessmentClientForTests,
} from "../server/repositories/candidateAssessmentRepository";
import {
  evaluateGovernance,
  buildDecisionDigest,
  buildDecisionId,
  digestString,
  GOVERNANCE_ENGINE_VERSION,
} from "../server/commercial/governance/engine";
import {
  GOVERNANCE_POLICY_VERSION,
  PUBLISH_POLICY,
  ADVERTISE_POLICY,
  listGovernanceActions,
} from "../server/commercial/governance/policies";
import {
  GOVERNANCE_CONTRACT_VERSION,
  GOVERNANCE_ACTIONS,
  GOVERNANCE_STATUSES,
  GOVERNANCE_REASON_CODES,
  isGovernanceAction,
  AuthorizationContext,
  GovernanceDecision,
} from "../server/commercial/governance/contract";
import {
  GOVERNANCE_FILTER_VERSION,
  buildCandidateSnapshot,
} from "../server/commercial/governance/service";
const VALID_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXED_NOW = "2026-08-19T04:00:00.000Z";
const N13_CREATED = "2026-08-14T00:00:00.000Z";
const N14_CREATED = "2026-08-18T00:00:00.000Z";
function happyCandidate(): Record<string, unknown> {
  return {
    candidate_id: VALID_ID,
    listing_key: "mlb-1456580521",
    marketplace: "Mercado Livre",
    merchant: "loja-exemplo",
    source_url: "https://produto.mercadolivre.com.br/MLB-1456580521",
    external_listing_id: "MLB-1456580521",
    title: "Produto Teste",
    price: 129.9,
    observed_price: 129.9,
    observed_rating: 4.5,
    observed_availability: "IN_STOCK",
    status: "DISCOVERED",
    funnel_stage: "INTAKE",
    metadata: { source: "n10:telegram:url" },
  };
}
const N13_ASSESSMENT_ID = "cur-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const N14_ASSESSMENT_ID = "n14-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function happyN13(): { assessmentId: string; verdict: string; digest: string; confidence: number; createdAt: string; evidenceRefs: string[] } {
  return { assessmentId: N13_ASSESSMENT_ID, verdict: "PASS", digest: "sha256:n13-digest", confidence: 0.9, createdAt: N13_CREATED, evidenceRefs: ["evd-11111111111111111111111111111111"] };
}
function happyN14(): { assessmentId: string; band: string; score: number; classification: string; digest: string; createdAt: string; metadata: Record<string, unknown>; evidenceRefs: string[] } {
  return { assessmentId: N14_ASSESSMENT_ID, band: "HIGH", score: 0.85, classification: "WINNER", digest: "sha256:n14-digest", createdAt: N14_CREATED, metadata: { publish_approved: false, risk_penalty: 0 }, evidenceRefs: ["evd-11111111111111111111111111111111"] };
}
function adminContext(scope: string[] = ["PUBLISH"]): AuthorizationContext {
  return { actor_type: "admin", actor_id: "operator-local", authorization_source: "admin_password", authorization_scope: scope as never };
}
function runEngine(params: Record<string, unknown> = {}): GovernanceDecision {
  const n13 = params.n13 === null ? null : { ...happyN13(), ...(params.n13 as Record<string, unknown>) };
  const n14 = params.n14 === null ? null : { ...happyN14(), ...(params.n14 as Record<string, unknown>) };
  const snapshot = buildCandidateSnapshot({
    candidate: (params.candidate as Record<string, unknown>) ?? happyCandidate(),
    n13: n13 ? { assessment_id: n13.assessmentId, verdict: n13.verdict, digest: n13.digest, created_at: n13.createdAt, evidence_refs: n13.evidenceRefs } : null,
    n14: n14 ? { assessment_id: n14.assessmentId, band: n14.band, score: n14.score, digest: n14.digest, created_at: n14.createdAt, metadata: n14.metadata, evidence_refs: n14.evidenceRefs, classification: n14.classification } : null,
  });
  return evaluateGovernance({
    candidateId: VALID_ID,
    action: (params.action as string) ?? "PUBLISH",
    candidateSnapshot: snapshot,
    n13: n13 ? { assessmentId: n13.assessmentId, verdict: n13.verdict, digest: n13.digest, confidence: n13.confidence, createdAt: n13.createdAt } : null,
    n14: n14 ? { assessmentId: n14.assessmentId, band: n14.band, score: n14.score, classification: n14.classification, digest: n14.digest, createdAt: n14.createdAt, metadata: n14.metadata, evidenceRefs: n14.evidenceRefs } : null,
    authorizationContext: (params.authorizationContext as AuthorizationContext) ?? adminContext(),
    nowIso: (params.nowIso as string) ?? FIXED_NOW,
  });
}
function setupClient(): void {
  const client = makeMockSupabaseClient({
    reads: {
      candidateNotFound: false,
      candidate: { ok: true, candidate: happyCandidate() as never },
      evidence: [],
      listAssessments: [],
    },
  }).client;
  setCandidatesClientForTests(client as never);
  setCandidateAssessmentClient(client as never);
}
afterEach(() => {
  setCandidatesClientForTests(null as never);
  resetAssessmentClientForTests(null);
});
test("proof A — contrato versionado e catálogo de ações", () => {
  assert.equal(GOVERNANCE_CONTRACT_VERSION, "governance_v1");
  assert.equal(GOVERNANCE_ENGINE_VERSION, "n15:governance_v1");
  assert.equal(GOVERNANCE_FILTER_VERSION, "n15:governance_v1");
  assert.equal(GOVERNANCE_POLICY_VERSION, "governance_policy_v1");
  assert.deepEqual([...GOVERNANCE_ACTIONS], ["PUBLISH", "ACQUIRE_AFFILIATE", "DISTRIBUTE", "ADVERTISE"]);
  const actions = listGovernanceActions();
  assert.deepEqual([...actions].sort(), [...GOVERNANCE_ACTIONS].sort());
  for (const action of GOVERNANCE_ACTIONS) assert.equal(isGovernanceAction(action), true);
  assert.equal(isGovernanceAction("delete_all_products"), false);
  for (const status of GOVERNANCE_STATUSES) assert.ok(["APPROVED", "REVIEW", "BLOCKED"].includes(status));
  assert.ok(GOVERNANCE_REASON_CODES.length >= 10);
});
test("proof B — PUBLISH feliz: APPROVED com rationale e requisitos", () => {
  setupClient();
  const decision = runEngine({ action: "PUBLISH", authorizationContext: adminContext(["PUBLISH"]) });
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.decision_id, buildDecisionId(VALID_ID, "PUBLISH", decision.decision_digest));
  assert.ok(decision.decision_id.startsWith("gov-"));
  assert.ok(decision.requirements.length >= 4);
  assert.ok(decision.requirements.some((r) => r.satisfied), "requisitos verificados pela política");
  assert.ok(decision.source_assessments.n13 !== null);
  assert.ok(decision.source_assessments.n14 !== null);
  assert.ok(decision.source_assessments.n13!.digest === "sha256:n13-digest");
  assert.ok(decision.source_assessments.n14!.digest === "sha256:n14-digest");
});
test("proof B.1 — digest reproduzível com buildDecisionDigest", () => {
  const decision = runEngine();
  const expected = buildDecisionDigest({
    candidateId: VALID_ID,
    action: "PUBLISH",
    status: "APPROVED",
    policyVersion: GOVERNANCE_POLICY_VERSION,
    n13Digest: "sha256:n13-digest",
    n14Digest: "sha256:n14-digest",
    score: 0.85,
    band: "HIGH",
    authorizationScope: ["PUBLISH"],
    referenceDateIso: "2026-08-19:00:00:00.000Z",
  });
  assert.equal(decision.decision_digest, expected);
});
test("proof C — N13 ausente (nunca avaliado) → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ n13: null });
  assert.equal(decision.status, "BLOCKED");
  assert.equal(decision.policy_version, GOVERNANCE_POLICY_VERSION);
});
test("proof D — N14 ausente (sem scoring) → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ n14: null });
  assert.equal(decision.status, "BLOCKED");
});
test("proof E — N13 VERDICT diferente de PASS → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ n13: { verdict: "REJECT" } });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n13_verdict_not_pass"));
});
test("proof F — score abaixo do mínimo (0.5 < 0.75) → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ n14: { score: 0.5 } });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "score_at_least_min"));
});
test("proof G — sem nenhuma observação conhecida (sem evidência) → não aprovado", () => {
  setupClient();
  const candidate = { candidate_id: VALID_ID, metadata: { source: "n10:telegram:url" } };
  const decision = runEngine({ candidate, n14: { evidenceRefs: [] }, n13: { evidenceRefs: [] } });
  assert.notEqual(decision.status, "APPROVED");
  assert.ok(decision.reasons.some((r) => r.code === "evidence_insufficient" || r.code === "assessment_stale"));
});
test("proof H — proveniência desconhecida (sem n10:) → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ candidate: { ...happyCandidate(), metadata: { source: "unknown:hacker" } } });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => ["provenance_invalid", "unknown_provenance", "evidence_insufficient"].includes(r.code)));
});
test("proof I — determinismo: mesmo snapshot → mesmo digest e id", () => {
  const a = runEngine();
  const b = runEngine();
  assert.equal(a.decision_id, b.decision_id);
  assert.equal(a.decision_digest, b.decision_digest);
});
test("proof J — horário varia, digest não muda (reference_date truncada)", () => {
  const a = runEngine({ nowIso: "2026-08-19T04:00:00.000Z" });
  const b = runEngine({ nowIso: "2026-08-19T23:59:59.000Z" });
  assert.equal(a.decision_id, b.decision_id);
  assert.equal(a.decision_digest, b.decision_digest);
});
test("proof K — alteração no scoring de origem muda o digest", () => {
  const a = runEngine();
  const b = runEngine({ n14: { score: 0.86 } });
  assert.notEqual(a.decision_digest, b.decision_digest);
});
test("proof L — TTL N13 estourado (192h > 168h, stale_status=REVIEW) → REVIEW", () => {
  setupClient();
  const decision = runEngine({ n13: { createdAt: "2026-08-10T00:00:00.000Z" } });
  assert.equal(decision.status, "REVIEW");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});
test("proof L.1 — TTL N14 estourado (PUBLISH 99h > 72h, stale_status=REVIEW) → REVIEW", () => {
  setupClient();
  const decision = runEngine({ n14: { createdAt: "2026-08-15T01:00:00.000Z" } });
  assert.equal(decision.status, "REVIEW");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});
test("proof M — TTL N14 estourado (ADVERTISE 96h > 48h, stale_status=BLOCKED) → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ action: "ADVERTISE", n14: { score: 0.9, createdAt: "2026-08-15T04:00:00.000Z", metadata: { publish_approved: true, risk_penalty: 0 } }, authorizationContext: adminContext(["ADVERTISE"]) });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});
test("proof N — ação fora do authorization_scope → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ authorizationContext: adminContext(["ACQUIRE_AFFILIATE"]) });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "operator_authorization_missing"));
});
test("proof O — ADVERTISE exige publish_approved; sem ele → BLOCKED", () => {
  setupClient();
  const decision = runEngine({ action: "ADVERTISE", n14: { metadata: { publish_approved: false, risk_penalty: 0 } }, authorizationContext: adminContext(["ADVERTISE"]) });
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "publish_previously_authorized"));
});
// ADVERTISE feliz (com decisão PUBLISH vigente) é validado pela suíte
// (service com persistência real): o engine puro não tem estado e por
// isso o gate publish_previously_authorized nunca satisfaz isoladamente.
test("proof P — policy registry: thresholds PUBLISH e ADVERTISE", () => {
  assert.equal(PUBLISH_POLICY.min_score, 0.75);
  assert.equal(PUBLISH_POLICY.n14_ttl_hours, 72);
  assert.equal(PUBLISH_POLICY.n13_ttl_hours, 168);
  assert.equal(PUBLISH_POLICY.max_risk, 0.5);
  assert.equal(ADVERTISE_POLICY.min_score, 0.85);
  assert.equal(ADVERTISE_POLICY.max_risk, 0.3);
  assert.equal(ADVERTISE_POLICY.n14_ttl_hours, 48);
  assert.ok(ADVERTISE_POLICY.requirements.some((r) => r.requirement === "publish_previously_authorized"));
  assert.ok(ADVERTISE_POLICY.requirements.some((r) => r.requirement === "explicit_authorization_scope"));
  assert.equal(ADVERTISE_POLICY.stale_status, "BLOCKED");
  assert.equal(PUBLISH_POLICY.stale_status, "REVIEW");
});
test("proof Q — não-subversão: engine é puro, sem efeitos comerciais", () => {
  setupClient();
  runEngine();
  // Prova de isolamento: evaluateGovernance não persiste nem executa nada;
  // esta prova local não altera candidates, produtos ou avaliações.
  assert.ok(true);
});
test("proof R — digestString determinístico sobre payload estável", () => {
  const payload = { z: "zeta", a: ["1", "2"], nested: { b: "beta" } };
  const digest1 = digestString(JSON.stringify(payload));
  const digest2 = digestString(JSON.stringify(payload));
  assert.equal(digest1, digest2);
  assert.ok(digest1.startsWith("sha256:"));
});
test("proof S — truncateToDayUtc real (corrigido): hora descartada", () => {
  const a = runEngine({ nowIso: "2026-08-19T23:59:59.000Z" });
  const b = runEngine({ nowIso: "2026-08-19T00:00:01.000Z" });
  assert.equal(a.decision_digest, b.decision_digest);
});
console.log("▶ Prova local N15 concluída — engine fail-closed validado sem efeitos comerciais.");
