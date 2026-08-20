/**
 * Bloco N15 — Service de avaliação de governança.
 *
 * Fluxo:
 *   1. validar candidate_id
 *   2. validar action
 *   3. carregar candidate (getCandidate)
 *   4. carregar N13 (listCandidateAssessments + filtro filter_version)
 *   5. carregar N14 (listCandidateAssessments + filtro filter_version)
 *   6. validar/estabelecer autorização (admin auth injetada; contexto
 *      derivado pelo servidor — nunca confiado no request)
 *   7. carregar policy do registry
 *   8. construir snapshot determinístico
 *   9. calcular digest (referência truncada a dia UTC; horário exato
 *      fica em decided_at)
 *   10. verificar replay (idempotency_key via lookup por candidate+digest)
 *   11. executar engine puro
 *   12. persistir decisão (candidate_assessment, filter_version
 *       n15:governance_v1)
 *   13. retornar resultado
 *
 * Fail-closed: erro interno → decisão BLOCKED registrada (internal_error),
 * nunca APPROVED. Candidato inexistente → 404 sem persistir.
 * N15 NÃO modifica products, candidates, candidate_evidence,
 * affiliate_links, jobs, job_queue, publication, Telegram, scheduler,
 * agents ou campaigns.
 */

import {
  AuthorizationContext,
  GOVERNANCE_ACTIONS,
  GovernanceAction,
  GovernanceDecision,
  isGovernanceAction,
} from "./contract";
import {
  GOVERNANCE_ENGINE_VERSION,
  buildDecisionId,
  buildDecisionDigest,
  evaluateGovernance,
  truncateToDayUtc,
} from "./engine";
import {
  getActionPolicy,
  GOVERNANCE_POLICY_VERSION,
} from "./policies";
import {
  buildAssessmentDigest,
  deleteAssessmentForProof,
  getAssessment,
  getCandidateAssessmentClient,
  listCandidateAssessments,
  persistAssessment,
  setCandidateAssessmentClient,
} from "../../repositories/candidateAssessmentRepository";

export const GOVERNANCE_FILTER_VERSION = "n15:governance_v1";

export interface GovernanceEvaluateInput {
  candidateId: string;
  action: string;
}

export interface GovernanceEvaluateResult {
  ok: boolean;
  outcome:
    | "evaluated"
    | "identical_duplicate"
    | "candidate_not_found"
    | "blocked_by_policy"
    | "internal_error";
  error_code?: string;
  decision?: GovernanceDecision;
  assessment_id?: string;
  idempotency_key?: string;
  http_status: number;
}

/** Deriva o contexto de autorização.
 *  O cliente NÃO pode injetar campos de decisão (approved, score etc.).
 *  authorization_scope é estabelecido pelo servidor a partir da ação
 *  solicitada — a rota garante admin auth (requireAdminAuth). */
export function deriveAuthorizationContext(
  action: string,
): AuthorizationContext | null {
  if (!action || typeof action !== "string" || !isGovernanceAction(action)) {
    return null;
  }
  return {
    actor_type: "admin",
    actor_id: "admin",
    authorization_source: "admin_password",
    authorization_scope: [action],
  };
}

/** Monta snapshot do candidato a partir dos dados persistidos +
 *  avaliações de origem. Determinístico: chaves ordenadas. */
export function buildCandidateSnapshot(params: {
  candidate: Record<string, unknown> | null;
  n13: {
    assessment_id: string;
    verdict: string;
    digest: string;
    created_at: string;
    evidence_refs: string[];
  } | null;
  n14: {
    assessment_id: string;
    band: string | null;
    score: number | null;
    digest: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
    evidence_refs: string[];
    classification?: string | null;
  } | null;
}): Record<string, unknown> {
  const candidate = params.candidate ?? {};
  const candidateMetadata =
    candidate.metadata && typeof candidate.metadata === "object"
      ? (candidate.metadata as Record<string, unknown>)
      : {};
  // Contagem de observações KNOWN herdada do N13 (curadoria) — o N14
  // reutiliza o mesmo critério; evita depender de candidate.evidence_count,
  // que não pertence ao record canônico do candidato.
  const candidateObservationCount = (
    cand: Record<string, unknown>,
  ): number => {
    const observedKeys = [
      "title",
      "price",
      "images",
      "seller",
      "rating",
      "review_count",
      "availability",
      "category",
    ] as const;
    let count = 0;
    for (const key of observedKeys) {
      const value = cand[key];
      if (value !== null && value !== undefined && value !== "") count += 1;
    }
    return count;
  };
  const n13 = params.n13;
  const n14 = params.n14;
  // Evidências de origem: preferir as refs gravadas pelas avaliações N14/
  // N13 (fonte canônica herdada do N13), caindo para as observações do
  // próprio candidato quando as avaliações não trazem refs.
  const evidenceCount =
    n14 && Array.isArray(n14.evidence_refs) && n14.evidence_refs.length > 0
      ? n14.evidence_refs.length
      : n13 && Array.isArray(n13.evidence_refs) && n13.evidence_refs.length > 0
        ? n13.evidence_refs.length
        : candidateObservationCount(candidate);

  // Identidade externa do anúncio (fonte única do contrato N8 —
  // sem external_listing_id não há como resolver o produto no
  // marketplace de afiliados; fail-closed).
  const externalListingId =
    typeof candidate.external_listing_id === "string"
      ? candidate.external_listing_id.trim()
      : typeof (candidateMetadata.external_listing_id) === "string"
        ? String(candidateMetadata.external_listing_id).trim()
        : "";

  return {
    candidate_id: candidate.candidate_id ?? "",
    marketplace: candidate.marketplace ?? null,
    external_listing_id: externalListingId === "" ? null : externalListingId,
    title: candidate.title ?? null,
    category: candidate.category ?? null,
    // Proveniência operacional canônica. metadata.source identifica a
    // origem de um campo e só é fallback para candidatos legados sem
    // metadata.provenance; nunca deve substituir a proveniência do funil.
    provenance:
      (candidateMetadata.provenance as string | undefined) ??
      (candidateMetadata.source as string | undefined) ??
      (candidate.provenance as string | undefined) ??
      null,
    evidence_count: evidenceCount,
    n13_assessment_id: n13?.assessment_id ?? null,
    n13_verdict: n13?.verdict ?? null,
    n13_digest: n13?.digest ?? null,
    n14_assessment_id: n14?.assessment_id ?? null,
    n14_band: n14?.band ?? null,
    n14_score: n14?.score ?? null,
    n14_digest: n14?.digest ?? null,
    n14_risk_penalty:
      (n14?.metadata as Record<string, unknown> | undefined)?.risk_penalty ?? null,
  };
}

/** Lê o assessment N13 mais recente do candidato (filtrado em memória). */
async function loadN13Assessment(
  candidateId: string,
): Promise<{
  assessment_id: string;
  verdict: string;
  digest: string;
  created_at: string;
  evidence_refs: string[];
} | null> {
  const listResult = await listCandidateAssessments({
    candidateId,
    limit: 50,
  });
  if (!listResult.ok) return null;
  const assessments = (listResult.assessments ?? [])
    .filter(
      (assessment) =>
        typeof assessment === "object" &&
        assessment !== null &&
        assessment.filter_version === "n13:curator_v1",
    )
    .sort(
      (a, b) =>
        new Date(b.created_at as string).getTime() -
        new Date(a.created_at as string).getTime(),
    );
  if (assessments.length === 0) return null;
  const latest = assessments[0] as Record<string, unknown>;
  const dimensions =
    latest.dimensions && typeof latest.dimensions === "object"
      ? (latest.dimensions as Record<string, unknown>)
      : {};
  return {
    assessment_id: String(latest.assessment_id ?? ""),
    // O N13 persiste o verdict em dimensions.verdict (sem coluna
    // verdict top-level) — espelha o padrão validado pelo service N13
    // (server/commercial/curation/service.ts).
    verdict: String(dimensions.verdict ?? latest.verdict ?? ""),
    digest: String(latest.digest ?? ""),
    created_at: String(latest.created_at ?? new Date().toISOString()),
    evidence_refs: Array.isArray(latest.evidence_refs)
      ? (latest.evidence_refs as string[])
      : [],
  };
}

/** Lê o assessment N14 mais recente do candidato (filtrado em memória). */
async function loadN14Assessment(
  candidateId: string,
): Promise<{
  assessment_id: string;
  band: string | null;
  score: number | null;
  classification: string | null;
  digest: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
  evidence_refs: string[];
} | null> {
  const listResult = await listCandidateAssessments({
    candidateId,
    limit: 50,
  });
  if (!listResult.ok) return null;
  const assessments = (listResult.assessments ?? [])
    .filter(
      (assessment) =>
        typeof assessment === "object" &&
        assessment !== null &&
        assessment.filter_version === "n14:commercial_brain_v1",
    )
    .sort(
      (a, b) =>
        new Date(b.created_at as string).getTime() -
        new Date(a.created_at as string).getTime(),
    );
  if (assessments.length === 0) return null;
  const latest = assessments[0] as Record<string, unknown>;
  const dimensions =
    latest.dimensions && typeof latest.dimensions === "object"
      ? (latest.dimensions as Record<string, unknown>)
      : {};
  const metadata =
    latest.metadata && typeof latest.metadata === "object"
      ? (latest.metadata as Record<string, unknown>)
      : null;
  return {
    assessment_id: String(latest.assessment_id ?? ""),
    band:
      typeof dimensions.band === "string"
        ? dimensions.band
        : typeof dimensions.priority_level === "string"
          ? dimensions.priority_level
          : null,
    score:
      typeof dimensions.score === "number"
        ? dimensions.score
        : typeof dimensions.priority_score === "number"
          ? dimensions.priority_score
          : null,
    classification:
      typeof latest.classification === "string"
        ? (latest.classification as string | null)
        : null,
    digest: String(latest.digest ?? ""),
    created_at: String(latest.created_at ?? new Date().toISOString()),
    metadata,
    evidence_refs: Array.isArray(latest.evidence_refs)
      ? (latest.evidence_refs as string[])
      : [],
  };
}

/**
 * Lê a decisão N15 PERSISTIDA mais recente do candidato com
 * action=PUBLISH e status=APPROVED ainda vigente (TTL da cadeia
 * PUBLISH→ADVERTISE/DISTRIBUTE = 168h). Ausência/expiração → null
 * (fail-closed no engine).
 */
async function loadN15PublishAuthorization(
  candidateId: string,
  nowIso: string,
): Promise<{
  assessment_id: string;
  created_at: string;
} | null> {
  const listResult = await listCandidateAssessments({
    candidateId,
    limit: 100,
  });
  if (!listResult.ok) return null;
  const publishRows = (listResult.assessments ?? [])
    .filter((row) => {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r !== "object") return false;
      if (r.filter_version !== GOVERNANCE_FILTER_VERSION) return false;
      const dims =
        r.dimensions && typeof r.dimensions === "object"
          ? (r.dimensions as Record<string, unknown>)
          : {};
      return dims.action === "PUBLISH" && dims.status === "APPROVED";
    })
    .sort(
      (a, b) =>
        new Date(b.created_at as string).getTime() -
        new Date(a.created_at as string).getTime(),
    );
  if (publishRows.length === 0) return null;
  const latest = publishRows[0] as Record<string, unknown>;
  // For a do TTL: a decisão persistida só autoriza a cadeia enquanto
  // estiver dentro de 168h da avaliação de origem (mesma janela do
  // assessment_not_stale para PUBLISH).
  const createdIso = String(latest.created_at ?? "");
  if (!createdIso) return null;
  const ageHours =
    (new Date(nowIso).getTime() - new Date(createdIso).getTime()) / 3_600_000;
  if (ageHours > 168) return null;
  return {
    assessment_id: String(latest.assessment_id ?? ""),
    created_at: createdIso,
  };
}

/** Lookup de decisão N15 já persistida com a mesma idempotency_key. */
async function findIdenticalN15Decision(
  candidateId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | null> {
  const listResult = await listCandidateAssessments({
    candidateId,
    limit: 100,
  });
  if (!listResult.ok) return null;
  const match = (listResult.assessments ?? []).find(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      row.filter_version === GOVERNANCE_FILTER_VERSION &&
      row.idempotency_key === idempotencyKey,
  );
  if (!match) {
    return null;
  }
  return match as Record<string, unknown>;
}

export async function evaluateGovernanceDecision(
  input: GovernanceEvaluateInput,
  options: { nowIso?: string } = {},
): Promise<GovernanceEvaluateResult> {
  try {
    // 1. validar candidate_id
    const candidateIdPattern = /^can-[a-fA-F0-9]{24,32}$/;
    if (
      typeof input.candidateId !== "string" ||
      !candidateIdPattern.test(input.candidateId)
    ) {
      return {
        ok: false,
        outcome: "blocked_by_policy",
        error_code: "candidate_id_invalid",
        http_status: 400,
      };
    }

    // 2. validar action
    if (
      typeof input.action !== "string" ||
      !(GOVERNANCE_ACTIONS as ReadonlyArray<string>).includes(input.action)
    ) {
      return {
        ok: false,
        outcome: "blocked_by_policy",
        error_code: "unknown_action",
        http_status: 400,
      };
    }

    // 3. carregar candidate
    const candidatesRepository = await import(
      "../../repositories/candidatesRepository"
    );
    // Fail-closed: verificar a infraestrutura ANTES de consultar o
    // candidato. Sem cliente Supabase configurado, getCandidate retorna
    // { ok: false } idêntico ao caso "registro ausente" — sem esta
    // verificação um candidato real seria tratado como inexistente
    // (false negative em um gate obrigatório). Erro de infra → 500.
    const repo = candidatesRepository as { requireClient?: () => unknown; getCandidatesClient?: () => unknown };
    const client = (typeof repo.requireClient === "function" ? repo.requireClient() : (typeof repo.getCandidatesClient === "function" ? repo.getCandidatesClient() : null));
    if (!client) {
      // Fail-closed: infra ausente nunca pode virar aprovação — decisão
      // BLOCKED registrada no resultado (mesmo padrão do catch global).
      const nowIso = options.nowIso ?? new Date().toISOString();
      const authorizationContext = deriveAuthorizationContext(input.action);
      return {
        ok: false,
        outcome: "internal_error",
        error_code: "missing_supabase",
        http_status: 500,
        decision: buildInternalErrorDecision(
          input,
          nowIso,
          authorizationContext ?? {
            actor_type: "admin" as const,
            actor_id: "admin",
            authorization_source: "admin_password" as const,
            authorization_scope: [],
          },
        ),
      };
    }
    const candidateResult = await candidatesRepository.getCandidate(
      input.candidateId,
    );
    if (!candidateResult.candidate) {
      // Fail-closed: erro de infra na leitura do catálogo nunca pode
      // virar "não encontrado" (false negative em gate obrigatório).
      if (!candidateResult.ok) {
        const nowIso = options.nowIso ?? new Date().toISOString();
        const authorizationContext = deriveAuthorizationContext(input.action);
        return {
          ok: false,
          outcome: "internal_error",
          error_code: ((candidateResult as { error?: string }).error) ?? "catalog_read_failed",
          http_status: 500,
          decision: buildInternalErrorDecision(
            input,
            nowIso,
            authorizationContext ?? {
              actor_type: "admin" as const,
              actor_id: "admin",
              authorization_source: "admin_password" as const,
              authorization_scope: [],
            },
          ),
        };
      }
      return {
        ok: false,
        outcome: "candidate_not_found",
        error_code: "candidate_not_found",
        http_status: 404,
      };
    }
    const candidate = candidateResult.candidate;

    // 4/5. carregar N13 e N14
    const n13 = await loadN13Assessment(input.candidateId);
    const n14 = await loadN14Assessment(input.candidateId);

    // 6. validar autorização (contexto derivado pelo servidor)
    const authorizationContext = deriveAuthorizationContext(input.action);
    if (!authorizationContext) {
      return {
        ok: false,
        outcome: "blocked_by_policy",
        error_code: "operator_authorization_missing",
        http_status: 403,
      };
    }

    // 7. carregar policy
    const actionPolicy = getActionPolicy(
      isGovernanceAction(input.action) ? input.action : ("" as GovernanceAction),
    );

    // 8. construir snapshot
    const candidateData =
      (candidate as unknown as Record<string, unknown>) ?? {};
    const snapshot = buildCandidateSnapshot({
      candidate: candidateData,
      n13: n13
        ? {
            assessment_id: n13.assessment_id,
            verdict: n13.verdict,
            digest: n13.digest,
            created_at: n13.created_at,
            evidence_refs: n13.evidence_refs,
          }
        : null,
        n14:
          n14
            ? {
                assessment_id: n14.assessment_id,
                band: n14.band,
                score: n14.score,
                digest: n14.digest,
                created_at: n14.created_at,
                metadata: n14.metadata,
                evidence_refs: n14.evidence_refs,
              }
            : null,
    });

    // 9. digest (determinístico; decided_at fora do material)
    const nowIso = options.nowIso ?? new Date().toISOString();
    const referenceDateIso = truncateToDayUtc(nowIso);
    const idempotencyKey = buildAssessmentDigest({
      candidateId: input.candidateId,
      filterVersion: GOVERNANCE_FILTER_VERSION,
      snapshot: {
        ...snapshot,
        action: actionPolicy.action,
        policy_version: GOVERNANCE_POLICY_VERSION,
        authorization_scope: authorizationContext.authorization_scope.slice().sort(),
        reference_date: referenceDateIso,
      },
    });

    // 10. verificar replay (lookup local do próprio candidato, evitando
    //     consulta global à tabela; o persist também dedup pela chave).
    const existingRow = await findIdenticalN15Decision(
      input.candidateId,
      idempotencyKey,
    );
    if (existingRow) {
      const decisionFromRow = parseDecisionFromRow(existingRow);
      return {
        ok: true,
        outcome: "identical_duplicate",
        decision: decisionFromRow ?? undefined,
        assessment_id: String(existingRow.assessment_id ?? ""),
        idempotency_key: idempotencyKey,
        http_status: 200,
      };
    }

    // 11. carregar autorização PUBLISH persistida (cadeia
    //     PUBLISH→ADVERTISE/DISTRIBUTE; TTL 168h) e executar o engine.
    const publishedPublishDecision = await loadN15PublishAuthorization(
      input.candidateId,
      nowIso,
    );
    let decision: GovernanceDecision;
    try {
      decision = evaluateGovernance({
        candidateId: input.candidateId,
        action: actionPolicy.action,
        candidateSnapshot: snapshot,
        n13: n13
          ? {
              assessmentId: n13.assessment_id,
              verdict: n13.verdict,
              digest: n13.digest,
              confidence: null,
              createdAt: n13.created_at,
            }
          : null,
        n14: n14
          ? {
              assessmentId: n14.assessment_id,
              band: n14.band,
              score: n14.score,
              classification: n14.classification,
              digest: n14.digest,
              createdAt: n14.created_at,
              metadata: n14.metadata ?? undefined,
              evidenceRefs: n14.evidence_refs,
            }
          : null,
        authorizationContext,
        nowIso,
        publishedPublishDecision,
      });
    } catch (_engineError) {
      // Fail-closed: erro interno do engine → BLOCKED no resultado.
      // SEM persistência: decisão de erro de infraestrutura não pode
      // ser confundida com uma avaliação real (D-1).
      return {
        ok: false,
        outcome: "internal_error",
        error_code: "engine_internal_error",
        http_status: 500,
        decision: buildInternalErrorDecision(input, nowIso, authorizationContext),
      };
    }

    // 12. persistir (filter_version n15:governance_v1)
    const assessmentId = buildDecisionId(
      input.candidateId,
      actionPolicy.action,
      decision.decision_digest,
    );

    const persistResult = await persistAssessment({
      assessmentId,
      candidateId: input.candidateId,
      filterVersion: GOVERNANCE_FILTER_VERSION,
      dimensions: {
        status: decision.status,
        action: decision.action,
        confidence: decision.status === "APPROVED" ? 1 : 0,
        confidence_level: decision.status === "APPROVED" ? "high" : "low",
        decision_digest: decision.decision_digest,
        policy_version: decision.policy_version,
        expires_at: decision.expires_at,
      },
      classification: mapStatusToClassification(decision.status),
      classificationBasis: buildClassificationBasis(decision),
      recommendation: "NONE",
      recommendationBasis: GOVERNANCE_ENGINE_VERSION,
      priority: {
        status: decision.status,
        action: decision.action,
        policy_version: decision.policy_version,
      },
      priorityLevel:
        decision.status === "APPROVED"
          ? "HIGH"
          : decision.status === "REVIEW"
            ? "MEDIUM"
            : "LOW",
      priorityScore:
        decision.status === "APPROVED"
          ? 0.95
          : decision.status === "REVIEW"
            ? 0.5
            : 0.1,
      unknowns: decision.reasons.map((reason) => reason.code),
      evidenceRefs: decision.evidence_refs,
      inputSnapshot: {
        governance: {
          decision_id: decision.decision_id,
          action: decision.action,
          status: decision.status,
          policy_version: decision.policy_version,
          decision_digest: decision.decision_digest,
          expires_at: decision.expires_at,
          reasons: decision.reasons,
          requirements: decision.requirements,
          risk_flags: decision.risk_flags,
          authorization_context: decision.authorization_context,
          source_assessments: decision.source_assessments,
        },
        candidate_snapshot: snapshot,
        reference_date: referenceDateIso,
      },
      idempotencyKey,
      metadata: {
        governance_engine: GOVERNANCE_ENGINE_VERSION,
        policy_version: GOVERNANCE_POLICY_VERSION,
        n13_assessment_id:
          decision.source_assessments.n13?.assessment_id ?? null,
        n14_assessment_id:
          decision.source_assessments.n14?.assessment_id ?? null,
        proof_run_id: null,
      },
    });

    // Duplicate real de idempotência detectado pelo repositório
    // (resolveReplay após colisão 23505): a decisão idêntica já
    // existe — retornar identical_duplicate com a decisão persistida.
    if (persistResult.ok && persistResult.outcome === "identical_duplicate") {
      const decisionFromRow = parseDecisionFromRow(
        persistResult.assessment as Record<string, unknown> | null,
      );
      return {
        ok: true,
        outcome: "identical_duplicate",
        decision: decisionFromRow ?? undefined,
        assessment_id: String(
          (persistResult.assessment as Record<string, unknown> | null)
            ?.assessment_id ?? "",
        ),
        idempotency_key: idempotencyKey,
        http_status: 200,
      };
    }
    if (!persistResult.ok) {
      return {
        ok: false,
        outcome: "internal_error",
        error_code: persistResult.error ?? "persist_failed",
        http_status: 500,
      };
    }
    return {
      ok: true,
      outcome:
        decision.status === "APPROVED" ? "evaluated" : "blocked_by_policy",
      decision,
      assessment_id:
        (persistResult.assessment?.assessment_id as string | undefined) ??
        assessmentId,
      idempotency_key: idempotencyKey,
      http_status: 200,
    };
  } catch (_error) {
    // Fail-closed global: erro inesperado → BLOCKED governado.
    const nowIso = options.nowIso ?? new Date().toISOString();
    const authorizationContext = deriveAuthorizationContext(
      typeof input.action === "string" ? input.action : "",
    ) ?? {
      actor_type: "admin" as const,
      actor_id: "admin",
      authorization_source: "admin_password" as const,
      authorization_scope: [],
    };
    const decision = buildInternalErrorDecision(
      input,
      nowIso,
      authorizationContext,
    );
    return {
      ok: false,
      outcome: "internal_error",
      error_code: "internal_error",
      decision,
      http_status: 500,
    };
  }
}

function mapStatusToClassification(
  status: string,
): "WINNER" | "HIDDEN_GEM" | "NOT_RECOMMENDED" {
  if (status === "APPROVED") return "WINNER";
  if (status === "REVIEW") return "HIDDEN_GEM";
  return "NOT_RECOMMENDED";
}

function buildClassificationBasis(decision: GovernanceDecision): string {
  const reasons = decision.reasons.map((reason) => reason.code).join(",");
  return `governance_v1; status=${decision.status}; action=${decision.action}; reasons=${reasons}`;
}

function parseDecisionFromRow(
  row: Record<string, unknown>,
): GovernanceDecision | null {
  const inputSnapshot =
    row.input_snapshot && typeof row.input_snapshot === "object"
      ? (row.input_snapshot as Record<string, unknown>)
      : null;
  const governance =
    inputSnapshot &&
    inputSnapshot.governance &&
    typeof inputSnapshot.governance === "object" &&
    inputSnapshot.governance !== null
      ? (inputSnapshot.governance as Record<string, unknown>)
      : null;
  if (!governance) return null;
  const authorizationContext =
    governance.authorization_context &&
    typeof governance.authorization_context === "object" &&
    governance.authorization_context !== null
      ? (governance.authorization_context as AuthorizationContext)
      : null;
  const sourceAssessments =
    governance.source_assessments &&
    typeof governance.source_assessments === "object" &&
    governance.source_assessments !== null
      ? (governance.source_assessments as GovernanceDecision["source_assessments"])
      : { n13: null, n14: null };
  const reasons = Array.isArray(governance.reasons)
    ? (governance.reasons as GovernanceDecision["reasons"])
    : [];
  const requirements = Array.isArray(governance.requirements)
    ? (governance.requirements as GovernanceDecision["requirements"])
    : [];
  const evidenceRefs = Array.isArray(governance.evidence_refs)
    ? (governance.evidence_refs as string[])
    : [];
  const riskFlags = Array.isArray(governance.risk_flags)
    ? (governance.risk_flags as GovernanceDecision["risk_flags"])
    : [];
  const action = governance.action;
  return {
    decision_id: String(governance.decision_id ?? row.assessment_id ?? ""),
    candidate_id: String(row.candidate_id ?? ""),
    action:
      action &&
      (GOVERNANCE_ACTIONS as ReadonlyArray<string>).includes(String(action))
        ? (action as GovernanceDecision["action"])
        : ("UNKNOWN" as GovernanceDecision["action"]),
    status:
      governance.status === "APPROVED" ||
      governance.status === "REVIEW" ||
      governance.status === "BLOCKED"
        ? (governance.status as GovernanceDecision["status"])
        : ("BLOCKED" as GovernanceDecision["status"]),
    policy_version: String(governance.policy_version ?? ""),
    decision_digest: String(governance.decision_digest ?? ""),
    decided_at: String(row.created_at ?? new Date().toISOString()),
    expires_at:
      typeof governance.expires_at === "string" ? governance.expires_at : null,
    reasons,
    requirements,
    evidence_refs: evidenceRefs,
    risk_flags: riskFlags,
    authorization_context: authorizationContext,
    source_assessments: sourceAssessments,
  };
}

function buildInternalErrorDecision(
  input: GovernanceEvaluateInput,
  nowIso: string,
  authorizationContext: AuthorizationContext,
): GovernanceDecision {
  const decisionDigest = buildDecisionDigest({
    candidateId: input.candidateId ?? "",
    action: input.action ?? "",
    status: "BLOCKED",
    policyVersion: GOVERNANCE_POLICY_VERSION,
    n13Digest: "",
    n14Digest: "",
    score: null,
    band: "",
    authorizationScope: authorizationContext.authorization_scope.slice().sort(),
    referenceDateIso: truncateToDayUtc(nowIso),
  });
  const decisionId = buildDecisionId(
    input.candidateId ?? "",
    input.action ?? "",
    decisionDigest,
  );
  return {
    decision_id: decisionId,
    candidate_id: input.candidateId ?? "",
    action: (GOVERNANCE_ACTIONS as ReadonlyArray<string>).includes(
      input.action ?? "",
    )
      ? (input.action as GovernanceDecision["action"])
      : ("UNKNOWN" as GovernanceDecision["action"]),
    status: "BLOCKED",
    policy_version: GOVERNANCE_POLICY_VERSION,
    decision_digest: decisionDigest,
    decided_at: nowIso,
    expires_at: null,
    reasons: [
      {
        code: "internal_error",
        message:
          "Internal error during governance evaluation. Fail-closed: never APPROVED.",
      },
    ],
    requirements: [],
    evidence_refs: [],
    risk_flags: [{ flag: "internal_error", severity: "high" }],
    authorization_context: authorizationContext,
    source_assessments: { n13: null, n14: null },
  };
}

// Acesso ao client para testes (espelhando o padrão N13/N14)
export { setCandidateAssessmentClient, deleteAssessmentForProof, getCandidateAssessmentClient };
