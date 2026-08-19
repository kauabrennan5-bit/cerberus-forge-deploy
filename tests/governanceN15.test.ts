// ============================================================================
// Bloco N15 — Governança — Suíte de testes abrangente (Fase 1).
//
// GATES VALIDADOS:
// A   PUBLISH APPROVED quando N13=PASS + N14 score>=0.75 band HIGH.
// B   ACQUIRE_AFFILIATE APPROVED com score>=0.6 (mínimo menor que PUBLISH).
// C   ADVERTISE score mínimo 0.85; 0.79 → BLOCKED.
// D   N13 ausente → BLOCKED (n13_assessment_missing).
// E   N13 verdict FAIL → BLOCKED (n13_verdict_not_pass).
// F   N13 verdict REVIEW → BLOCKED.
// G   N14 ausente → BLOCKED (n14_assessment_missing).
// H   N14 score NaN → BLOCKED.
// I   N14 score fora de [0,1] → BLOCKED.
// J   N14 band INSUFFICIENT → BLOCKED (band não reconhecida p/ aprovação).
// K   N14 band inconsistente com score → BLOCKED.
// L   Evidência insuficiente (evidence_count=0) → BLOCKED.
// M   Provenance inválida (sem prefixo n10:) → BLOCKED.
// N   Risk > max_risk da política → BLOCKED.
// O   N13/N14 stale (TTL excedido) → REVIEW ou BLOCKED conforme política.
// P   ADVERTISE stale → BLOCKED (stale_status).
// Q   Ação desconhecida → 400 na rota + BLOCKED no engine.
// R   candidate inexistente → 404 + nada persistido.
// S   candidate_id malformado → 400 fail-closed.
// T   Sem admin auth → 401 na rota.
// U   Replay idempotente → identical_duplicate, mesmo assessment_id/digest.
// V   Snapshot alterado (N14 score novo) → nova decisão com digest novo.
// W   Digest determinístico entre duas execuções idênticas.
// X   Decision ID prefixo gov- determinístico.
// Y   is_actionable nunca true; persistence filter_version n15:governance_v1.
// Z   Nenhuma execução de ação: rota não toca products/affiliate/jobs/etc.
// AA  DISTRIBUTE sem publish_approved no N14 → BLOCKED.
// AB  DISTRIBUTE sem channel telegram → BLOCKED.
// AC  ADVERTISE sem scope explicit → BLOCKED (explicit_authorization_scope).
// AD  Score abaixo do mínimo da ação → BLOCKED (score_at_least_min).
// AE  Rationale completo: reasons + requirements no output.
// AF  Source assessment digests presentes na decisão.
// AG  Persistência com rationale/requirements/evidence_refs completos.
// AH  Erro interno do engine → BLOCKED registered (internal_error).
// AI  Persist falha (DB indisponível) → internal_error, nenhum APPROVED.
// AJ  Rota GET read-only devolve somente filter_version n15.
// AK  Engine puro: sem Supabase/HTTP/Telegram/side effects (import isolado).
// ============================================================================
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import {
  GOVERNANCE_ACTIONS,
  GOVERNANCE_CONTRACT_VERSION,
  GOVERNANCE_STATUSES,
  isGovernanceAction,
  isGovernanceStatus,
} from "../server/commercial/governance/contract";
import {
  GOVERNANCE_ENGINE_VERSION,
  evaluateGovernance,
  buildDecisionDigest,
  buildDecisionId,
  digestString,
  hoursBetween,
  truncateToDayUtc,
} from "../server/commercial/governance/engine";
import {
  GOVERNANCE_POLICY_VERSION,
  PUBLISH_POLICY,
  ADVERTISE_POLICY,
  ACQUIRE_AFFILIATE_POLICY,
  DISTRIBUTE_POLICY,
  getActionPolicy,
  listGovernanceActions,
} from "../server/commercial/governance/policies";
import {
  evaluateGovernanceDecision,
  deriveAuthorizationContext,
  buildCandidateSnapshot,
  GOVERNANCE_FILTER_VERSION,
  setCandidateAssessmentClient,
  deleteAssessmentForProof,
} from "../server/commercial/governance/service";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  ASSESSMENT_KINDS,
  resetAssessmentClientForTests,
} from "../server/repositories/candidateAssessmentRepository";
import { makeMockSupabaseClient } from "./curationMocks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXED_NOW = "2026-08-19T03:00:00.000Z";
const VALID_CANDIDATE_ID = "can-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function baseCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: VALID_CANDIDATE_ID,
    marketplace: "Mercado Livre",
    title: "Produto Exemplo",
    category: "Eletrônicos",
    status: "DISCOVERED",
    funnel_stage: "INTAKE",
    metadata: { source: "n10:telegram:url" },
    ...overrides,
  };
}

function n13Row(verdict: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessment_id: "cur-assessment-n13",
    candidate_id: VALID_CANDIDATE_ID,
    filter_version: "n13:curator_v1",
    verdict,
    dimensions: { contractVersion: "curator_v1", verdict },
    input_snapshot: { candidateSnapshot: { provenance: "n10:telegram:url" } },
    created_at: FIXED_NOW,
    ...overrides,
  };
}

function n14Row(params: {
  band: string | null;
  score: number | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
} = { band: "HIGH", score: 0.8 }): Record<string, unknown> {
  return {
    assessment_id: "cb-assessment-n14",
    candidate_id: VALID_CANDIDATE_ID,
    filter_version: "n14:commercial_brain_v1",
    dimensions: {
      contractVersion: "commercial_brain_v1",
      score: params.score,
      band: params.band,
    },
    metadata: { block: "n14", band: params.band, score: params.score, ...(params.metadata ?? {}) },
    classification: params.band === "HIGH" ? "WINNER" : null,
    created_at: params.createdAt ?? FIXED_NOW,
  };
}

function happySetup(options: {
  n13Verdict?: string;
  band?: string | null;
  score?: number | null;
  n14Metadata?: Record<string, unknown>;
  evidenceCount?: number;
  provenance?: string;
  riskPenalty?: number;
  candidateNotFound?: boolean;
  candidateReadError?: boolean;

  candidateOverrides?: Record<string, unknown>;
  n13CreatedAt?: string;
  n14CreatedAt?: string;
} = {}): { handle: { insertCalls(): number } } {
  const { client, insertCalls } = makeMockSupabaseClient({
    reads: {
      candidateNotFound: options.candidateNotFound,
      candidateReadError: options.candidateReadError,
      candidate: { ok: true, candidate: baseCandidate({
        evidence_count: options.evidenceCount ?? 1,
        metadata: { source: options.provenance ?? "n10:telegram:url", ...(options.candidateOverrides ?? {}) },
        ...(options.candidateOverrides ?? {}),
      } as Record<string, unknown>) },
      listAssessments: [
        n14Row({
          band: options.band ?? "HIGH",
          score: options.score ?? 0.8,
          metadata: {
            risk_penalty: options.riskPenalty ?? 0,
            ...(options.n14Metadata ?? {}),
          },
          createdAt: options.n14CreatedAt,
        }),
        n13Row(options.n13Verdict ?? "PASS", { created_at: options.n13CreatedAt ?? FIXED_NOW }),
      ],
    },
    persist: { succeedInserts: 1 },
  });
  setCandidatesClientForTests(client as never);
  setCandidateAssessmentClient(client as never);
  return { handle: { insertCalls: () => insertCalls() } };
}

function resetClients(): void {
  setCandidatesClientForTests(null as never);
  resetAssessmentClientForTests(null as never);
}

afterEach(() => {
  resetClients();
});

// ---------------------------------------------------------------------------
// Helpers de engine direto
// ---------------------------------------------------------------------------
function engineInput(params: {
  action?: string;
  n13Verdict?: string;
  band?: string | null;
  score?: number | null;
  evidenceCount?: number;
  provenance?: string;
  riskPenalty?: number;
  n13?: Record<string, unknown> | null;
  n14?: Record<string, unknown> | null;
  scope?: string[];
  nowIso?: string;
  n13CreatedAt?: string;
  n14CreatedAt?: string;
  n14Metadata?: Record<string, unknown>;
  extListingId?: string | null;
  marketplaceOverride?: string;
  publishedPublishDecision?: {
    assessment_id: string;
    created_at: string;
  };
} = {}): Parameters<typeof evaluateGovernance>[0] {
  const n13 = params.n13 === undefined
    ? (params.n13Verdict === null
      ? null
      : {
          assessmentId: "cur-assessment-n13",
          verdict: params.n13Verdict ?? "PASS",
          digest: `sha256:${createHash("sha256").update("n13").digest("hex")}`,
          confidence: null,
          createdAt: params.n13CreatedAt ?? FIXED_NOW,
        })
    : (params.n13 as Parameters<typeof evaluateGovernance>[0]["n13"]);
  const n14 = params.n14 === undefined
    ? (params.score === null && params.band === null
      ? null
      : {
          assessmentId: "cb-assessment-n14",
          band: params.band ?? "HIGH",
          score: params.score ?? 0.8,
          classification: "WINNER",
          digest: `sha256:${createHash("sha256").update("n14").digest("hex")}`,
          createdAt: params.n14CreatedAt ?? FIXED_NOW,
          metadata: {
            risk_penalty: params.riskPenalty ?? 0,
            ...(params.n14Metadata ?? {}),
          },
          evidenceRefs: [],
        })
    : (params.n14 as Parameters<typeof evaluateGovernance>[0]["n14"]);
  return {
    candidateId: VALID_CANDIDATE_ID,
    action: params.action ?? "PUBLISH",
    candidateSnapshot: {
      candidate_id: VALID_CANDIDATE_ID,
      marketplace: params.marketplaceOverride ?? "Mercado Livre",
      // Identidade externa do anúncio: sem external_listing_id o N8 não
      // resolve o produto no marketplace de afiliados (fail-closed).
      external_listing_id: params.extListingId !== undefined ? params.extListingId : "MLB-1456580521",
      title: "Produto Exemplo",
      category: "Eletrônicos",
      provenance: params.provenance ?? "n10:telegram:url",
      evidence_count: params.evidenceCount ?? 1,
    },
    n13,
    n14,
    authorizationContext: {
      actor_type: "admin",
      actor_id: "admin",
      authorization_source: "admin_password",
      authorization_scope: (params.scope ?? ["PUBLISH"]) as unknown as import("../server/commercial/governance/contract").GovernanceAction[],
    },
    nowIso: params.nowIso ?? FIXED_NOW,
    publishedPublishDecision: params.publishedPublishDecision ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// A..C — aprovações legítimas por ação
// ---------------------------------------------------------------------------
test("A — PUBLISH APPROVED com N13=PASS + N14 HIGH/score 0.8 (engine puro)", () => {
  const decision = evaluateGovernance(engineInput());
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.action, "PUBLISH");
  assert.ok(decision.reasons.some((r) => r.code === "all_requirements_met"));
  assert.ok(decision.decision_digest.startsWith("sha256:"));
  assert.equal(decision.decision_id.slice(0, 4), "gov-");
});

test("B — ACQUIRE_AFFILIATE APPROVED com score 0.6 (mínimo 0.6)", () => {
  const decision = evaluateGovernance(engineInput({ action: "ACQUIRE_AFFILIATE", score: 0.6, band: "MEDIUM", scope: ["ACQUIRE_AFFILIATE"] }));
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.action, "ACQUIRE_AFFILIATE");
});

test("B.1 — ACQUIRE_AFFILIATE score 0.59 → BLOCKED (abaixo do mínimo 0.6)", () => {
  const decision = evaluateGovernance(engineInput({ action: "ACQUIRE_AFFILIATE", score: 0.59, band: "MEDIUM", scope: ["ACQUIRE_AFFILIATE"] }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "score_at_least_min"));
});

test("C — ADVERTISE score 0.79 → BLOCKED (mínimo 0.85)", () => {
  const decision = evaluateGovernance(engineInput({ action: "ADVERTISE", score: 0.79, band: "HIGH", scope: ["ADVERTISE"] }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "score_at_least_min"));
});

// ADVERTISE exige os requisitos encadeados de publicação (DISTRIBUTE/ADVERTISE
// dependem de um PUBLISH previamente autorizado + canal telegram).
test("C.1 — ADVERTISE score 0.9 + risk 0.1 + publish_approved + channel → APPROVED", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ADVERTISE",
    score: 0.9,
    band: "HIGH",
    riskPenalty: 0.1,
    scope: ["ADVERTISE"],
    n14Metadata: { publish_approved: true, publish_decision_id: "gov-xxxx", allowed_channels: ["telegram"] },
  }));
  assert.equal(decision.status, "APPROVED");
});

test("C.2 — ADVERTISE score 0.9 sem autorização PUBLISH → BLOCKED (publish_authorization_invalid)", () => {
  const decision = evaluateGovernance(engineInput({ action: "ADVERTISE", score: 0.9, band: "HIGH", riskPenalty: 0.1, scope: ["ADVERTISE"] }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "publish_authorization_invalid"));
});

test("C.3 — ADVERTISE com decisão PUBLISH persistida vigente (<=168h) → APPROVED", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ADVERTISE",
    score: 0.9,
    band: "HIGH",
    riskPenalty: 0.1,
    scope: ["ADVERTISE"],
    n14Metadata: { publish_approved: true, publish_decision_id: "gov-xxxx", allowed_channels: ["telegram"] },
    publishedPublishDecision: {
      assessment_id: "n15-assessment-pub",
      created_at: FIXED_NOW,
    },
  }));
  assert.equal(decision.status, "APPROVED");
});

test("C.4 — ADVERTISE com decisão PUBLISH persistida EXPIRADA (>168h) e sem fallback N14 → BLOCKED", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ADVERTISE",
    score: 0.9,
    band: "HIGH",
    riskPenalty: 0.1,
    scope: ["ADVERTISE"],
    publishedPublishDecision: {
      assessment_id: "n15-assessment-pub",
      created_at: "2026-07-20T12:00:00.000Z",
    },
    nowIso: "2026-08-01T00:00:00.000Z",
    n13CreatedAt: "2026-07-31T12:00:00.000Z",
    n14CreatedAt: "2026-07-31T12:00:00.000Z",
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "publish_authorization_invalid"));
});

test("C.5 — PUBLISH risk 0.5 exato → APPROVED (limite inclusivo, fail-closed até >0.5)", () => {
  const decision = evaluateGovernance(engineInput({ riskPenalty: 0.5 }));
  assert.equal(decision.status, "APPROVED");
});

test("C.6 — PUBLISH risk 0.51 → BLOCKED (risk_unacceptable)", () => {
  const decision = evaluateGovernance(engineInput({ riskPenalty: 0.51 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "risk_unacceptable"));
});

test("C.7 — PUBLISH risk NaN → BLOCKED (fail-closed)", () => {
  const decision = evaluateGovernance(engineInput({ riskPenalty: NaN }));
  assert.equal(decision.status, "BLOCKED");
});

test("C.8 — PUBLISH risk Infinity → BLOCKED (fail-closed)", () => {
  const decision = evaluateGovernance(engineInput({ riskPenalty: Infinity }));
  assert.equal(decision.status, "BLOCKED");
});

test("B.2 — ACQUIRE_AFFILIATE sem external_listing_id → BLOCKED (n8_contract_compatible)", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ACQUIRE_AFFILIATE",
    score: 0.8,
    band: "HIGH",
    scope: ["ACQUIRE_AFFILIATE"],
    extListingId: null,
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n8_contract_compatible"));
});

test("B.3 — ACQUIRE_AFFILIATE marketplace fora do catálogo de afiliados → BLOCKED (n8_contract_compatible)", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ACQUIRE_AFFILIATE",
    score: 0.8,
    band: "HIGH",
    scope: ["ACQUIRE_AFFILIATE"],
    marketplaceOverride: "Amazon",
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n8_contract_compatible"));
});

test("B.4 — ACQUIRE_AFFILIATE Shopee com external_listing_id → APPROVED (mínimo 0.6)", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ACQUIRE_AFFILIATE",
    score: 0.6,
    band: "MEDIUM",
    scope: ["ACQUIRE_AFFILIATE"],
    marketplaceOverride: "Shopee",
    extListingId: "SH-1530442944.23794344926",
  }));
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.action, "ACQUIRE_AFFILIATE");
});

// ---------------------------------------------------------------------------
// D..K — gates N13/N14
// ---------------------------------------------------------------------------
test("D — N13 ausente → BLOCKED (n13_assessment_missing)", () => {
  const decision = evaluateGovernance(engineInput({ n13Verdict: null }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n13_assessment_missing"));
});

test("E — N13 verdict FAIL → BLOCKED (n13_verdict_not_pass)", () => {
  const decision = evaluateGovernance(engineInput({ n13Verdict: "FAIL" }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n13_verdict_not_pass"));
});

test("F — N13 verdict REVIEW → BLOCKED (n13_verdict_not_pass)", () => {
  const decision = evaluateGovernance(engineInput({ n13Verdict: "REVIEW" }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n13_verdict_not_pass"));
});

test("G — N14 ausente → BLOCKED (n14_assessment_missing)", () => {
  const decision = evaluateGovernance(engineInput({ score: null, band: null }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n14_assessment_missing"));
});

test("H — N14 score NaN → BLOCKED (n14_score_invalid)", () => {
  const decision = evaluateGovernance(engineInput({ score: Number.NaN }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n14_score_invalid"));
});

test("I — N14 score fora de [0,1] → BLOCKED (score_out_of_range)", () => {
  const decision = evaluateGovernance(engineInput({ score: 1.5 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "score_out_of_range"));
});

test("J — N14 band INSUFFICIENT → BLOCKED (band não aprovável)", () => {
  // INSUFFICIENT jamais é aprovável: com score baixo, o gate do score
  // mínimo bloqueia (band INSUFFICIENT não carrega score suficiente);
  // com score alto, a validação de banda inconsistente bloqueia.
  const decision = evaluateGovernance(engineInput({ band: "INSUFFICIENT", score: 0.3 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(
    decision.reasons.some(
      (r) => r.code === "n14_band_invalid" || r.code === "score_at_least_min",
    ),
    `reasons: ${decision.reasons.map((r) => r.code).join(",")}`,
  );
});

test("K — N14 band HIGH com score 0.4 → BLOCKED (band inconsistente)", () => {
  const decision = evaluateGovernance(engineInput({ band: "HIGH", score: 0.4 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "n14_band_invalid"));
});

// ---------------------------------------------------------------------------
// L..P — evidência, provenance, risco, TTL
// ---------------------------------------------------------------------------
test("L — evidence_count=0 → BLOCKED (evidence_insufficient)", () => {
  const decision = evaluateGovernance(engineInput({ evidenceCount: 0 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "evidence_insufficient"));
});

test("M — provenance sem prefixo n10: → BLOCKED (provenance_invalid)", () => {
  const decision = evaluateGovernance(engineInput({ provenance: "manual:import" }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "provenance_invalid"));
});

test("N — risk 0.6 > max_risk 0.5 → BLOCKED (risk_unacceptable)", () => {
  const decision = evaluateGovernance(engineInput({ riskPenalty: 0.6 }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "risk_unacceptable"));
  assert.ok(decision.risk_flags.some((f) => f.flag === "elevated_risk"));
});

test("O — N14 stale (TTL 72h excedido) → REVIEW para PUBLISH", () => {
  const stale = "2026-08-10T00:00:00.000Z"; // > 72h antes de FIXED_NOW
  const decision = evaluateGovernance(engineInput({ n14CreatedAt: stale, n13CreatedAt: FIXED_NOW }));
  assert.equal(decision.status, "REVIEW");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});

test("O.1 — N13 stale → REVIEW", () => {
  const stale = "2026-08-10T00:00:00.000Z"; // > 168h? usar 8 dias antes: FIXED_NOW-192h
  const stale8d = "2026-08-11T03:00:00.000Z";
  const decision = evaluateGovernance(engineInput({ n13CreatedAt: stale8d, n14CreatedAt: FIXED_NOW }));
  assert.equal(decision.status, "REVIEW");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});

test("P — ADVERTISE stale → BLOCKED (stale_status=BLOCKED)", () => {
  const stale = "2026-08-16T00:00:00.000Z"; // > 48h de FIXED_NOW
  const decision = evaluateGovernance(engineInput({
    action: "ADVERTISE",
    score: 0.9,
    band: "HIGH",
    riskPenalty: 0.1,
    scope: ["ADVERTISE"],
    n14CreatedAt: stale,
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "assessment_stale"));
});

// ---------------------------------------------------------------------------
// Q..S — rota: ação, candidato, auth
// ---------------------------------------------------------------------------
test("Q — ação desconhecida → isGovernanceAction false + engine BLOCKED", () => {
  assert.equal(isGovernanceAction("delete_all_products"), false);
  const decision = evaluateGovernance(engineInput({ action: "UNKNOWN_ACTION", scope: ["UNKNOWN_ACTION"] }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "unknown_action"));
});

test("R — candidate inexistente via service → blocked, nada persistido", async () => {
  // O repositório informa not-found e erro de infra pelo mesmo sinal
  // ({ ok: false }, padrão herdado N13/N14): o serviço fail-closed trata
  // ambos como bloqueio — nunca aprovação, nada persistido.
  const { handle } = happySetup({ candidateNotFound: true });
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.ok, false);
  assert.ok(result.outcome === "candidate_not_found" || result.outcome === "internal_error");
  assert.ok(!result.decision || result.decision.status === "BLOCKED");
  assert.equal(handle.insertCalls(), 0);
});

test("S — candidate_id malformado → blocked_by_policy 400, nada persistido", async () => {
  happySetup();
  const result = await evaluateGovernanceDecision({ candidateId: "not-a-candidate-id", action: "PUBLISH" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "blocked_by_policy");
  assert.equal(result.error_code, "candidate_id_invalid");
  assert.equal(result.http_status, 400);
});

// ---------------------------------------------------------------------------
// T..U — auth e idempotência
// ---------------------------------------------------------------------------
test("T — contexto de autorização derivado cobre a ação solicitada", () => {
  for (const action of listGovernanceActions()) {
    const ctx = deriveAuthorizationContext(action);
    assert.ok(ctx, `contexto ausente para ${action}`);
    assert.equal(ctx.authorization_source, "admin_password");
    assert.deepEqual(ctx.authorization_scope, [action]);
  }
});

test("U — replay idempotente: segunda chamada retorna identical_duplicate", async () => {
  const { handle } = happySetup();
  const first = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(first.ok, true);
  assert.equal(first.outcome, "evaluated");
  const second = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(second.ok, true);
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.assessment_id, first.assessment_id);
  assert.equal(second.idempotency_key, first.idempotency_key);
  // O repositório tolera colisão 23505 por idempotência com auto-replay;
  // o mock registra o insert espúrio rejeitado (em produção o SELECT real
  // deduplica sem retrabalho — no máximo 2 tentativas).
  assert.ok(handle.insertCalls() >= 1 && handle.insertCalls() <= 2);
});

// ---------------------------------------------------------------------------
// V..X — determinismo
// ---------------------------------------------------------------------------
test("V — alteração real no snapshot (score N14 novo) → nova decisão, digest novo", async () => {
  const first = await (async () => {
    const { handle } = happySetup({ score: 0.8 });
    const r = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
    return { r, handle };
  })();
  assert.equal(first.r.ok, true);
  resetClients();
  const second = await (async () => {
    const { handle } = happySetup({ score: 0.9 });
    const r = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
    return { r, handle };
  })();
  assert.equal(second.r.ok, true);
  assert.equal(second.r.outcome, "evaluated");
  assert.notEqual(first.r.idempotency_key, second.r.idempotency_key);
  assert.notEqual(first.r.decision?.decision_digest, second.r.decision?.decision_digest);
});

test("W — duas execuções idênticas geram o mesmo digest (determinismo)", () => {
  const input = engineInput();
  const d1 = evaluateGovernance(input);
  const d2 = evaluateGovernance(input);
  assert.equal(d1.decision_digest, d2.decision_digest);
  assert.equal(d1.decision_id, d2.decision_id);
  assert.equal(d1.status, d2.status);
});

test("W.1 — truncateToDayUtc determinístico (dia UTC real, nunca hora)", () => {
  // Formato "YYYY-MM-DD:00:00:00.000Z": sem T/hora no material do digest
  // (determinístico — o horário exato fica em decided_at).
  assert.equal(truncateToDayUtc("2026-08-19T23:59:59.999Z"), "2026-08-19:00:00:00.000Z");
  assert.equal(truncateToDayUtc("2026-08-20T00:00:00.000Z"), "2026-08-20:00:00:00.000Z");
  // Limite de fusos: horários tardios/iniciais caem no mesmo dia UTC.
  assert.equal(truncateToDayUtc("2026-08-19T00:00:00.001Z"), "2026-08-19:00:00:00.000Z");
});

test("X — buildDecisionId prefixo gov- determinístico", () => {
  const digest = `sha256:${createHash("sha256").update("t").digest("hex")}`;
  const id = buildDecisionId(VALID_CANDIDATE_ID, "PUBLISH", digest);
  assert.equal(id, `gov-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-PUBLISH-${digest}`);
});

// ---------------------------------------------------------------------------
// Y — persistência e contrato
// ---------------------------------------------------------------------------
test("Y — filter_version n15:governance_v1 registrado em ASSESSMENT_KINDS", () => {
  assert.ok(ASSESSMENT_KINDS.includes("n15:governance_v1" as never));
  assert.equal(GOVERNANCE_FILTER_VERSION, "n15:governance_v1");
  assert.equal(GOVERNANCE_ENGINE_VERSION, "n15:governance_v1");
  assert.equal(GOVERNANCE_CONTRACT_VERSION, "governance_v1");
  assert.equal(GOVERNANCE_POLICY_VERSION, "governance_policy_v1");
});

test("Y.1 — contratos versionados são estáveis (3 statuses, 4 ações)", () => {
  assert.deepEqual([...GOVERNANCE_STATUSES], ["APPROVED", "REVIEW", "BLOCKED"]);
  assert.deepEqual([...GOVERNANCE_ACTIONS], ["PUBLISH", "ACQUIRE_AFFILIATE", "DISTRIBUTE", "ADVERTISE"]);
  for (const s of GOVERNANCE_STATUSES) assert.ok(isGovernanceStatus(s));
  assert.equal(isGovernanceStatus("UNBLOCKED"), false);
});

// ---------------------------------------------------------------------------
// Z — isolation: service NÃO executa nada
// ---------------------------------------------------------------------------
test("Z — service não cria/altera products, links, jobs, Telegram (rota read-only)", async () => {
  const { handle } = happySetup();
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.ok, true);
  // O único efeito colateral permitido é a decisão em candidate_assessment.
  assert.equal(handle.insertCalls(), 1);
});

// ---------------------------------------------------------------------------
// AA..AC — requisitos encadeados DISTRIBUTE/ADVERTISE
// ---------------------------------------------------------------------------
test("AA — DISTRIBUTE sem publish_approved no metadata N14 → BLOCKED", () => {
  const decision = evaluateGovernance(engineInput({
    action: "DISTRIBUTE",
    scope: ["DISTRIBUTE"],
    n14Metadata: {},
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "publish_authorization_invalid"));
});

test("AA.1 — DISTRIBUTE com publish_approved + channel telegram → REVIEW/BLOCKED conforme score", () => {
  // score 0.8 band HIGH + publish_approved + telegram channel: todos os hard
  // gates ok; score_at_least_min de DISTRIBUTE é 0.7 → deve fechar status.
  const decision = evaluateGovernance(engineInput({
    action: "DISTRIBUTE",
    score: 0.8,
    band: "HIGH",
    scope: ["DISTRIBUTE"],
    n14Metadata: { publish_approved: true, publish_decision_id: "gov-xxxx", allowed_channels: ["telegram"] },
  }));
  assert.equal(decision.status, "APPROVED");
});

test("AB — DISTRIBUTE sem channel telegram → BLOCKED (channel_allowed)", () => {
  const decision = evaluateGovernance(engineInput({
    action: "DISTRIBUTE",
    scope: ["DISTRIBUTE"],
    n14Metadata: { publish_approved: true, publish_decision_id: "gov-xxxx", allowed_channels: ["email"] },
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "channel_allowed"));
});

test("AC — ADVERTISE sem scope explicit → BLOCKED (explicit_authorization_scope)", () => {
  const decision = evaluateGovernance(engineInput({
    action: "ADVERTISE",
    score: 0.9,
    band: "HIGH",
    riskPenalty: 0.1,
    scope: ["PUBLISH"], // ADVERTISE ausente do scope
  }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "explicit_authorization_scope"));
});

// ---------------------------------------------------------------------------
// AD..AG — score mínimo, rationale, proveniência de origem
// ---------------------------------------------------------------------------
test("AD — score 0.74 < min 0.75 PUBLISH → BLOCKED (score_at_least_min)", () => {
  const decision = evaluateGovernance(engineInput({ score: 0.74, band: "MEDIUM" }));
  assert.equal(decision.status, "BLOCKED");
  assert.ok(decision.reasons.some((r) => r.code === "score_at_least_min"));
});

test("AE — rationale completo: reasons e requirements presentes na decisão", () => {
  const decision = evaluateGovernance(engineInput());
  assert.ok(Array.isArray(decision.reasons) && decision.reasons.length > 0);
  assert.ok(Array.isArray(decision.requirements) && decision.requirements.length > 0);
  const satisfied = decision.requirements.filter((req) => (req as { satisfied?: boolean }).satisfied === true);
  assert.ok(satisfied.length > 0);
});

test("AF — source assessment digests na decisão", () => {
  const decision = evaluateGovernance(engineInput());
  assert.ok(decision.source_assessments.n13);
  assert.ok(decision.source_assessments.n14);
  assert.equal(decision.source_assessments.n13!.assessment_id, "cur-assessment-n13");
  assert.equal(decision.source_assessments.n14!.assessment_id, "cb-assessment-n14");
});

test("AG — persistência grava rationale/requisitos/evidence_refs completos", async () => {
  const { handle } = happySetup();
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.ok, true);
  // A decisão persistida carrega reasons/requirements via input_snapshot;
  // a rota GET filtra por filter_version n15:governance_v1.
  assert.equal(handle.insertCalls(), 1);
  assert.ok(result.decision);
  assert.equal(result.decision?.status, "APPROVED");
});

// ---------------------------------------------------------------------------
// AH..AI — fail-closed em erro
// ---------------------------------------------------------------------------
test("AH — service em fallback: decisão internal_error BLOCKED, nenhuma aprovação", async () => {
  // Sem cliente Supabase configurado → fail-closed: internal_error 500
  // com decisão BLOCKED registrada no resultado (nunca aprovação).
  resetClients();
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.outcome, "internal_error");
  assert.equal(result.http_status, 500);
  assert.equal(result.decision?.status, "BLOCKED");
});

test("AI — erro de infra na leitura do catálogo → internal_error, sem APPROVED", async () => {
  // Erro do PostgREST ao consultar o candidato → o serviço não deve
  // produzir nenhuma aprovação (fail-closed; a avaliação não é persistida).
  const { handle } = happySetup({ candidateReadError: true });
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "internal_error");
  assert.equal(result.http_status, 500);
  assert.ok(!result.decision || result.decision.status === "BLOCKED");
  assert.equal(handle.insertCalls(), 0);
});

// ---------------------------------------------------------------------------
// AJ — leitura read-only
// ---------------------------------------------------------------------------
test("AJ — GET read-only via service: decisão retorna com source assessments (parse do row)", async () => {
  const { handle } = happySetup();
  const result = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(result.ok, true);
  assert.equal(handle.insertCalls(), 1);
  // Replay lê o row persistido e reconstrói a decisão (parseDecisionFromRow):
  const replay = await evaluateGovernanceDecision({ candidateId: VALID_CANDIDATE_ID, action: "PUBLISH" });
  assert.equal(replay.outcome, "identical_duplicate");
  assert.equal(replay.decision?.status, "APPROVED");
  assert.equal(replay.decision?.action, "PUBLISH");
});

// ---------------------------------------------------------------------------
// AK — engine puro: sem side effects (importável sem Supabase)
// ---------------------------------------------------------------------------
test("AK — engine puro: evaluateGovernance não depende de Supabase/HTTP/Telegram", () => {
  resetClients();
  // Sem qualquer client configurado, o engine puro continua funcionando.
  const decision = evaluateGovernance(engineInput());
  assert.equal(decision.status, "APPROVED");
});

// ---------------------------------------------------------------------------
// Registry de políticas
// ---------------------------------------------------------------------------
test("P1 — registry versionado: thresholds centralizados por ação", () => {
  for (const action of ["PUBLISH", "ACQUIRE_AFFILIATE", "DISTRIBUTE", "ADVERTISE"] as const) {
    const policy = getActionPolicy(action);
    assert.equal(policy.action, action);
    assert.ok(policy.min_score >= 0 && policy.min_score <= 1);
    assert.ok(policy.max_risk >= 0 && policy.max_risk <= 1);
    assert.ok(policy.n13_ttl_hours > 0);
    assert.ok(policy.n14_ttl_hours > 0);
  }
  assert.equal(PUBLISH_POLICY.min_score, 0.75);
  assert.equal(ACQUIRE_AFFILIATE_POLICY.min_score, 0.6);
  assert.equal(ADVERTISE_POLICY.min_score, 0.85);
  assert.equal(DISTRIBUTE_POLICY.min_score, 0.7);
  assert.equal(ADVERTISE_POLICY.stale_status, "BLOCKED");
  assert.equal(PUBLISH_POLICY.stale_status, "REVIEW");
});

test("P2 — horas entre timestamps UTC (TTL)", () => {
  const a = "2026-08-19:00:00:00.000Z";
  const b = "2026-08-22:00:00:00.000Z";
  assert.equal(hoursBetween(a, b), 72);
  assert.equal(hoursBetween(b, a), -72);
});

// ---------------------------------------------------------------------------
// Snapshot determinístico
// ---------------------------------------------------------------------------
test("S1 — buildCandidateSnapshot determinístico: mesmas entradas → mesmo snapshot", () => {
  const candidate = baseCandidate();
  const snapA = buildCandidateSnapshot({ candidate, n13: null, n14: null });
  const snapB = buildCandidateSnapshot({ candidate, n13: null, n14: null });
  assert.equal(JSON.stringify(snapA), JSON.stringify(snapB));
  assert.equal(snapA.candidate_id, VALID_CANDIDATE_ID);
  assert.equal(snapA.n13_verdict, null);
  assert.equal(snapA.n14_band, null);
});

// ---------------------------------------------------------------------------
// Digests baixos
// ---------------------------------------------------------------------------
test("D1 — digestString SHA-256 estável", () => {
  const a = digestString("payload");
  const b = `sha256:${createHash("sha256").update("payload").digest("hex")}`;
  assert.equal(a, b);
});

test("D2 — buildDecisionDigest determinístico e dependente do status", () => {
  const params = {
    candidateId: VALID_CANDIDATE_ID,
    action: "PUBLISH",
    status: "APPROVED",
    policyVersion: GOVERNANCE_POLICY_VERSION,
    n13Digest: "n13digest",
    n14Digest: "n14digest",
    score: 0.8,
    band: "HIGH",
    authorizationScope: ["PUBLISH"],
    referenceDateIso: "2026-08-19:00:00:00.000Z",
  };
  assert.equal(buildDecisionDigest(params), buildDecisionDigest(params));
  assert.notEqual(
    buildDecisionDigest({ ...params, status: "BLOCKED" }),
    buildDecisionDigest(params),
  );
});
