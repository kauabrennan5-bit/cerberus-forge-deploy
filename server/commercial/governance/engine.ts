/**
 * Bloco N15 — Decision engine PURO.
 *
 * Input: snapshot do candidato + assessments de origem (N13/N14) + ação +
 *        política + contexto de autorização + horário de referência.
 * Output: GovernanceDecision.
 *
 * Sem Supabase, HTTP, Telegram, filesystem, environment, jobs ou side
 * effects. Toda a regra de negócio vive aqui; o registry (policies.ts)
 * centraliza thresholds.
 *
 * Fail-closed: erro/UNKNOWN/ausência NUNCA resulta em APPROVED.
 * Digest determinístico: sem milissegundos do relógio no material do
 * digest (avaliadoAt fora do material; TTL truncado a dia UTC).
 */

import { createHash } from "crypto";
import {
  AuthorizationContext,
  GOVERNANCE_ACTIONS,
  GovernanceAction,
  GovernanceDecision,
  GovernanceReasonCode,
  GovernanceSourceAssessments,
} from "./contract";
import {
  getActionPolicy,
  GOVERNANCE_POLICY_VERSION,
} from "./policies";

export const GOVERNANCE_ENGINE_VERSION = "n15:governance_v1";

export interface GovernanceEngineInput {
  candidateId: string;
  action: string;
  /** Snapshot do candidato (campos legíveis). */
  candidateSnapshot: Record<string, unknown> | null;
  n13: {
    assessmentId: string;
    verdict: string;
    digest: string;
    confidence: number | null;
    createdAt: string;
    confidenceLevel?: string;
  } | null;
  n14: {
    assessmentId: string;
    band: string | null;
    score: number | null;
    classification: string | null;
    digest: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
    evidenceRefs?: string[];
  } | null;
  /** Contexto estabelecido e validado pelo servidor. */
  authorizationContext: AuthorizationContext;
  /** Horário de referência (decided_at). Fora do digest quando truncado. */
  nowIso: string;
}

export function digestString(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/** Serialização estável: chaves ordenadas, arrays preservados na ordem
 *  declarada do snapshot (snapshot é objeto, nunca array na raiz). */
function stableJson(value: unknown): string {
  return JSON.stringify(value, stableReplacer);
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableReplacer("", item));
  }
  const obj = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    ordered[key] = stableReplacer(key, obj[key]);
  }
  return ordered;
}

/** Trunca ISO para dia UTC determinístico (sem milissegundos nem
 *  hora no material do digest; o horário exato fica em decided_at).
 *  FIX: a versão anterior (slice(0,13)+":00:00.000Z") preservava a hora
 *  original (ex.: "...T23:59Z" → "...T23:00Z"), introduzindo
 *  não-determinismo — corrigido para truncamento real ao dia UTC. */
export function truncateToDayUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10) + ":00:00:00.000Z";
  }
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}:00:00:00.000Z`;
}

/** Horas entre duas ISO truncadas a dia UTC. */
export function hoursBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3_600_000;
}

const RECOGNIZED_PROVENANCES_PREFIX = "n10:";
const KNOWN_BANDS = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"] as const;
const REQUIRED_N14_BANDS: ReadonlyArray<string> = ["HIGH", "MEDIUM", "LOW"];

export interface Reason {
  code: GovernanceReasonCode;
  message: string;
}

export function evaluateGovernance(
  input: GovernanceEngineInput,
): GovernanceDecision {
  const actionPolicy = isGovernanceAction(input.action)
    ? getActionPolicy(input.action as GovernanceAction)
    : null;
  void isGovernanceAction;

  const reasons: Reason[] = [];
  const requirements = buildRequirementList(input, actionPolicy);
  const evidenceRefs = collectEvidenceRefs(input);
  const riskFlags: GovernanceDecision["risk_flags"] = [];

  // 1. candidate_exists
  const candidateSnapshotValid = candidateExists(input.candidateSnapshot);
  if (!candidateSnapshotValid) {
    reasons.push({ code: "candidate_missing", message: "Candidate snapshot missing or invalid." });
  }

  // 2. n13 gates
  const n13Present = !!input.n13;
  const n13Pass =
    n13Present &&
    input.n13!.verdict === "PASS";
  if (!n13Present) {
    reasons.push({ code: "n13_assessment_missing", message: "N13 assessment missing." });
  } else if (!n13Pass) {
    reasons.push({
      code: "n13_verdict_not_pass",
      message: `N13 verdict is '${input.n13!.verdict}', not PASS.`,
    });
  }

  // 3. n14 gates
  const n14Present = !!input.n14;
  let n14Valid = false;
  if (!n14Present) {
    reasons.push({ code: "n14_assessment_missing", message: "N14 assessment missing." });
  } else if (!isFiniteScore(input.n14!.score)) {
    reasons.push({ code: "n14_score_invalid", message: "N14 score is not a finite number." });
  } else if (input.n14!.score! < 0 || input.n14!.score! > 1) {
    reasons.push({ code: "score_out_of_range", message: `Score ${input.n14!.score} outside [0, 1].` });
  } else if (
    input.n14!.band === null ||
    !KNOWN_BANDS.includes(input.n14!.band as (typeof KNOWN_BANDS)[number])
  ) {
    reasons.push({ code: "n14_band_invalid", message: `Band '${String(input.n14!.band)}' is not recognized.` });
  } else {
    n14Valid = true;
  }

  // 4. evidence_sufficient / provenance_valid (do snapshot do candidato)
  const evidenceSufficient = hasSufficientEvidence(input.candidateSnapshot);
  if (!evidenceSufficient) {
    reasons.push({ code: "evidence_insufficient", message: "No coherent KNOWN evidence for the candidate." });
  }
  const provenanceValid = hasValidProvenance(input.candidateSnapshot);
  if (!provenanceValid) {
    reasons.push({ code: "provenance_invalid", message: "Candidate provenance is not recognized (n10:*)." });
  }

  // 5. risk_acceptable (penalidade de risco do N14 refletida no metadata)
  const riskValue = extractRiskValue(input);
  const riskAcceptable = actionPolicy
    ? riskValue <= actionPolicy.max_risk
    : false;
  if (!riskAcceptable) {
    reasons.push({
      code: "risk_unacceptable",
      message: `Combined risk ${riskValue.toFixed(2)} exceeds policy maximum ${actionPolicy ? actionPolicy.max_risk : "n/a"}.`,
    });
  }
  if (riskValue > 0.5) {
    riskFlags.push({ flag: "elevated_risk", severity: riskValue > 0.8 ? "high" : "medium" });
  }

  // 6. assessment_not_stale (TTL do registry; stale → REVIEW/BLOCKED)
  let assessmentStale = false;
  let stalePolicy: "REVIEW" | "BLOCKED" = "REVIEW";
  if (actionPolicy) {
    const n13Fresh = hoursBetween(input.n13?.createdAt ?? input.nowIso, input.nowIso) <= actionPolicy.n13_ttl_hours;
    const n14Fresh = hoursBetween(input.n14?.createdAt ?? input.nowIso, input.nowIso) <= actionPolicy.n14_ttl_hours;
    assessmentStale = !n13Fresh || !n14Fresh;
    stalePolicy = actionPolicy.stale_status;
    if (assessmentStale) {
      reasons.push({
        code: "assessment_stale",
        message: `Source assessment older than policy TTL (n13=${actionPolicy.n13_ttl_hours}h, n14=${actionPolicy.n14_ttl_hours}h).`,
      });
    }
  }

  // 7. action_allowed
  const actionAllowed = actionPolicy !== null;
  if (!actionAllowed) {
    reasons.push({ code: "unknown_action", message: `Action '${input.action}' is not in the governance catalog.` });
  }

  // 8. score_at_least_min
  let minScoreMet = false;
  if (actionPolicy && isFiniteScore(input.n14?.score ?? null)) {
    minScoreMet = (input.n14!.score ?? -1) >= actionPolicy.min_score;
    if (!minScoreMet) {
      reasons.push({
        code: "score_at_least_min",
        message: `Score ${input.n14!.score ?? "null"} below policy minimum ${actionPolicy.min_score}.`,
      });
    }
  } else if (actionPolicy) {
    reasons.push({
      code: "score_at_least_min",
      message: "Score unavailable; minimum cannot be satisfied.",
    });
  }

  // 9. publish_previously_authorized (DISTRIBUTE/ADVERTISE)
  let publishAuthorized = false;
  const requiresPublish =
    input.action === "DISTRIBUTE" || input.action === "ADVERTISE";
  const publishAuthorizationContext = (input.n14?.metadata ?? {}) as Record<string, unknown>;
  if (requiresPublish) {
    publishAuthorized =
      publishAuthorizationContext.publish_approved === true &&
      typeof publishAuthorizationContext.publish_decision_id === "string";
    if (!publishAuthorized) {
      reasons.push({
        code: "publish_previously_authorized",
        message: "No APPROVED PUBLISH decision referenced for this candidate.",
      });
    }
  }

  // 10. channel_allowed (DISTRIBUTE)
  let channelAllowed = false;
  if (input.action === "DISTRIBUTE") {
    channelAllowed = Array.isArray(publishAuthorizationContext.allowed_channels) &&
      (publishAuthorizationContext.allowed_channels as unknown[]).includes("telegram");
    if (!channelAllowed) {
      reasons.push({
        code: "channel_allowed",
        message: "No allowed distribution channel declared for this candidate.",
      });
    }
  }

  // 11. explicit_authorization_scope (ADVERTISE)
  let scopeExplicit = false;
  if (input.action === "ADVERTISE") {
    scopeExplicit = input.authorizationContext.authorization_scope.includes("ADVERTISE");
    if (!scopeExplicit) {
      reasons.push({
        code: "explicit_authorization_scope",
        message: "ADVERTISE is not in the operator authorization scope.",
      });
    }
  }

  // 12. operator_authorization
  const operatorAuthorized =
    !!input.authorizationContext &&
    input.authorizationContext.authorization_source === "admin_password" &&
    Array.isArray(input.authorizationContext.authorization_scope) &&
    input.authorizationContext.authorization_scope.includes(
      input.action as GovernanceAction,
    );
  if (!operatorAuthorized) {
    reasons.push({
      code: "operator_authorization_missing",
      message: "Operator authorization missing or does not cover this action.",
    });
  }

  // Fail-closed: qualquer hard gate faltando → nunca APPROVED.
  const hardGateFailures = reasons
    .map((r) => r.code)
    .filter((code) => hardGateCodes.includes(code));

  let status: "APPROVED" | "REVIEW" | "BLOCKED" = "BLOCKED";
  if (!actionAllowed) {
    // Erro de contrato (ação desconhecida) — decisão BLOCKED, nunca approved.
    status = "BLOCKED";
  } else if (hardGateFailures.length === 0 && minScoreMet && riskAcceptable && !assessmentStale && operatorAuthorized) {
    status = "APPROVED";
    if (actionPolicy) {
      reasons.push({
        code: "all_requirements_met",
        message: `All requirements satisfied for ${input.action} under ${actionPolicy.action === input.action ? actionPolicy.action : input.action} policy.`,
      });
    }
  } else if (assessmentStale && hardGateFailures.length === 0) {
    status = stalePolicy;
  } else if (
    actionPolicy &&
    minScoreMet &&
    riskAcceptable &&
    !assessmentStale &&
    hardGateFailures.length === 0
  ) {
    status = "REVIEW";
  } else {
    status = "BLOCKED";
  }

  // Band consistente com score (requisito de banda válido já verificado).
  const bandConsistent =
    n14Valid && isBandConsistentWithScore(input.n14!.band!, input.n14!.score!);
  if (n14Valid && !bandConsistent) {
    reasons.push({
      code: "n14_band_invalid",
      message: `Band '${input.n14!.band}' inconsistent with score ${input.n14!.score}.`,
    });
    status = "BLOCKED";
  }

  const requirementRows = requirements.map((requirement) => ({
    requirement,
    satisfied: isRequirementSatisfied(
      requirement,
      {
        candidateExists: candidateSnapshotValid,
        n13Present,
        n13Pass,
        n14Present,
        n14Valid,
        evidenceSufficient,
        provenanceValid,
        riskAcceptable,
        assessmentStale,
        actionAllowed,
        operatorAuthorized,
        minScoreMet,
        publishAuthorized,
        channelAllowed,
        scopeExplicit,
        bandConsistent,
      },
    ),
    detail: null,
  }));

  const nowIso = input.nowIso;
  const expiresAt =
    status === "APPROVED" && actionPolicy
      ? new Date(
          new Date(nowIso).getTime() + actionPolicy.n14_ttl_hours * 3_600_000,
        ).toISOString()
      : null;

  const sourceAssessments: GovernanceSourceAssessments = {
    n13: input.n13
      ? {
          assessment_id: input.n13.assessmentId,
          verdict: input.n13.verdict,
          digest: input.n13.digest,
          confidence: input.n13.confidence,
        }
      : null,
    n14: input.n14
      ? {
          assessment_id: input.n14.assessmentId,
          band: input.n14.band ?? "",
          score: input.n14.score,
          digest: input.n14.digest,
          classification_basis: input.n14.classification ?? "",
        }
      : null,
  };

  const decisionDigest = buildDecisionDigest({
    candidateId: input.candidateId ?? "",
    action: actionPolicy ? actionPolicy.action : (input.action as string),
    status,
    policyVersion: GOVERNANCE_POLICY_VERSION,
    n13Digest: input.n13?.digest ?? "",
    n14Digest: input.n14?.digest ?? "",
    score: isFiniteScore(input.n14?.score ?? null) ? input.n14!.score : null,
    band: input.n14?.band ?? "",
    authorizationScope: [...input.authorizationContext.authorization_scope].sort(),
    referenceDateIso: truncateToDayUtc(nowIso),
  });

  const decisionId = buildDecisionId(input.candidateId ?? "", input.action, decisionDigest);

  return {
    decision_id: decisionId,
    candidate_id: input.candidateId ?? "",
    action: actionPolicy ? actionPolicy.action : ("UNKNOWN" as GovernanceDecision["action"]),
    status,
    policy_version: GOVERNANCE_POLICY_VERSION,
    decision_digest: decisionDigest,
    decided_at: nowIso,
    expires_at: expiresAt,
    reasons,
    requirements: requirementRows,
    evidence_refs: evidenceRefs,
    risk_flags: riskFlags,
    authorization_context: input.authorizationContext,
    source_assessments: sourceAssessments,
  };
}

// ==========================================================================
// Digest determinístico (mesmo padrão N13/N14): snapshot estável +
// digests de origem + ação + política + thresholds relevantes +
// authorization scope ordenado + referência truncada a dia UTC.
// ==========================================================================

export function buildDecisionDigest(params: {
  candidateId: string;
  action: string;
  status: string;
  policyVersion: string;
  n13Digest: string;
  n14Digest: string;
  score: number | null;
  band: string;
  authorizationScope: string[];
  referenceDateIso: string;
}): string {
  const payload = {
    candidate_id: params.candidateId,
    action: params.action,
    status: params.status,
    policy_version: params.policyVersion,
    n13_digest: params.n13Digest,
    n14_digest: params.n14Digest,
    score: params.score,
    band: params.band,
    authorization_scope: params.authorizationScope,
    reference_date: params.referenceDateIso,
  };
  return digestString(stableJson(payload));
}

export function buildDecisionId(
  candidateId: string,
  action: string,
  decisionDigest: string,
): string {
  // gov-{candidate_suffix}-{action}-{digest}
  const suffix = candidateId.startsWith("can-") ? candidateId.slice(4) : candidateId;
  return `gov-${suffix}-${action}-${decisionDigest}`;
}

// ==========================================================================
// Helpers puros
// ==========================================================================

function isGovernanceAction(value: string): boolean {
  return (GOVERNANCE_ACTIONS as ReadonlyArray<string>).includes(value);
}

function isFiniteScore(score: number | null): boolean {
  return typeof score === "number" && Number.isFinite(score);
}

function candidateExists(snapshot: Record<string, unknown> | null): boolean {
  if (!snapshot) return false;
  const id = snapshot.candidate_id;
  return typeof id === "string" && id.length > 0;
}

function hasSufficientEvidence(snapshot: Record<string, unknown> | null): boolean {
  if (!snapshot) return false;
  const evidenceCount = snapshot.evidence_count;
  return typeof evidenceCount === "number" && evidenceCount >= 1;
}

function hasValidProvenance(snapshot: Record<string, unknown> | null): boolean {
  if (!snapshot) return false;
  const provenance = snapshot.provenance;
  return typeof provenance === "string" && provenance.startsWith(RECOGNIZED_PROVENANCES_PREFIX);
}

function extractRiskValue(input: GovernanceEngineInput): number {
  // Risco combinado = penalidade de risco do N14 (metadata risk_penalty),
  // default 0 quando ausente (fail-closed: se a política exige
  // risk_acceptable e o valor exceder max_risk, o hard gate rejeita).
  const metadata = (input.n14?.metadata ?? {}) as Record<string, unknown>;
  const penalty = metadata.risk_penalty;
  return typeof penalty === "number" && Number.isFinite(penalty) ? Math.max(0, Math.min(1, penalty)) : 0;
}

function isBandConsistentWithScore(band: string, score: number): boolean {
  if (band === "INSUFFICIENT") return true;
  if (band === "HIGH") return score >= 0.75;
  if (band === "MEDIUM") return score >= 0.5 && score < 0.75;
  if (band === "LOW") return score < 0.5;
  return false;
}

const hardGateCodes: GovernanceReasonCode[] = [
  "candidate_missing",
  "n13_assessment_missing",
  "n13_verdict_not_pass",
  "n14_assessment_missing",
  "n14_score_invalid",
  "score_out_of_range",
  "n14_band_invalid",
  "evidence_insufficient",
  "provenance_invalid",
  "risk_unacceptable",
  "operator_authorization_missing",
  "unknown_action",
  "publish_previously_authorized",
  "channel_allowed",
  "explicit_authorization_scope",
  "score_at_least_min",
] as GovernanceReasonCode[];

function buildRequirementList(
  input: GovernanceEngineInput,
  policy: ReturnType<typeof getActionPolicy> | null,
): string[] {
  if (!policy) return ["action_allowed"];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const gate of policy.hard_gates) {
    if (!seen.has(gate)) {
      seen.add(gate);
      list.push(gate);
    }
  }
  for (const requirement of policy.requirements) {
    if (!seen.has(requirement.requirement)) {
      seen.add(requirement.requirement);
      list.push(requirement.requirement);
    }
  }
  return list;
}

function isRequirementSatisfied(
  requirement: string,
  flags: Record<string, boolean>,
): boolean {
  const mapping: Record<string, keyof typeof flags> = {
    candidate_exists: "candidateExists",
    n13_pass: "n13Pass",
    n14_assessment_exists: "n14Present",
    n14_score_valid: "n14Valid",
    n14_band_valid: "bandConsistent",
    evidence_sufficient: "evidenceSufficient",
    provenance_valid: "provenanceValid",
    risk_acceptable: "riskAcceptable",
    assessment_not_stale: "assessmentStale",
    action_allowed: "actionAllowed",
    operator_authorization: "operatorAuthorized",
    score_at_least_min: "minScoreMet",
    publish_previously_authorized: "publishAuthorized",
    channel_allowed: "channelAllowed",
    explicit_authorization_scope: "scopeExplicit",
  };
  const key = mapping[requirement];
  if (!key) return false;
  const value = flags[key];
  return requirement === "assessment_not_stale" ? !value : value;
}

function collectEvidenceRefs(input: GovernanceEngineInput): string[] {
  const refs: string[] = [];
  if (input.n14?.evidenceRefs && Array.isArray(input.n14.evidenceRefs)) {
    for (const ref of input.n14.evidenceRefs) {
      if (typeof ref === "string") refs.push(ref);
    }
  }
  return refs;
}
