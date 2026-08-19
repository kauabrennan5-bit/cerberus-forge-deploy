// ============================================================================
// Bloco N13 — Serviço de curadoria Cerberus (orquestração read-only).
//
// GOVERNANÇA:
// - REUTILIZA a persistência existente de candidate_assessment (Bloco N4):
//   persistAssessment + buildAssessmentDigest — NENHUMA tabela nova.
// - A avaliação é READ-ONLY em relação ao candidato: getCandidate e
//   listEvidence somente; nada é alterado, criado ou publicado.
// - is_actionable=false sempre (RECOMMENDATION != ACTION).
// - Idempotência pelo mecanismo existente: idempotency_key único →
//   outcome "identical_duplicate" (mesma avaliação não cria registro
//   equivalente).
// - Fail-closed: erro em qualquer etapa → assessment persistido como
//   BLOCKED com rationale de erro interno. Nunca PASS por fallback.
// ============================================================================
import {
  getCandidate,
  type CandidateRecord,
} from "../../repositories/candidatesRepository";
import {
  listCandidateEvidence,
  type EvidenceRecord,
} from "../../repositories/candidateEvidenceRepository";
import {
  buildAssessmentDigest,
  persistAssessment,
  type AssessmentVersion,
  type Classification,
  type Recommendation,
  type PersistAssessmentResult,
} from "../../repositories/candidateAssessmentRepository";
import {
  CURATOR_PROVENANCE,
} from "./contract";
import { evaluateCandidate } from "./engine";
import type { CuratorDecision } from "./contract";

// ---------------------------------------------------------------------------
// Contrato do serviço
// ---------------------------------------------------------------------------

export type CuratorServiceOutcome =
  | "evaluated"
  | "identical_duplicate"
  | "candidate_not_found"
  | "evidence_unavailable"
  | "persist_error";

export interface CuratorServiceResult {
  ok: boolean;
  outcome: CuratorServiceOutcome;
  decision?: CuratorDecision;
  error?: string;
}

export interface FilterVersionMetadata {
  filterVersion: AssessmentVersion;
  classification: Classification | null;
  recommendation: Recommendation | null;
  classificationBasis: string;
  recommendationBasis: string;
}

/**
 * Mapeia o verdict N13 para a persistência N4 sem alterar a semântica
 * comercial do N4: a curadoria usa filter_version "n13:curator_v1",
 * classification/RECOMMENDATION NUNCA comercial (NONE/INSUFFICIENT).
 */
export function mapVerdictToAssessment(
  decision: CuratorDecision,
): FilterVersionMetadata {
  // Sem autoridade comercial: classificação/recomendação do N4 servem apenas
  // para preencher colunas existentes — a verdade da curadoria está no
  // verdict (dimensões/metadata) e é NUNCA consumida por fluxos comerciais.
  let classification: Classification | null = null;
  let recommendation: Recommendation | null = null;
  if (decision.verdict === "PASS") {
    classification = "INSUFFICIENT";
    recommendation = "INVESTIGATE_FURTHER";
  } else if (decision.verdict === "FAIL") {
    classification = "NOT_RECOMMENDED";
    recommendation = "REJECT";
  } else {
    classification = "INSUFFICIENT";
    recommendation = "PARK";
  }
  return {
    filterVersion: "n13:curator_v1",
    classification,
    recommendation,
    classificationBasis: `n13_curator_v1_verdict_${decision.verdict.toLowerCase()}:curadoria_estrutural_nao_comercial`,
    recommendationBasis: decision.rationale,
  };
}

// ---------------------------------------------------------------------------
// Entrada do candidato (projeção mínima e estável)
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectCandidateInput(candidate: CandidateRecord) {
  const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
  return {
    candidateId: candidate.candidate_id,
    marketplace: candidate.marketplace,
    sourceUrl: candidate.source_url,
    externalListingId: candidate.external_listing_id,
    status: candidate.status,
    funnelStage: candidate.funnel_stage,
    provenance: typeof metadata.provenance === "string" ? metadata.provenance : null,
  };
}

function projectEvidenceInput(evidences: ReadonlyArray<EvidenceRecord>) {
  return evidences.map((e) => ({
    evidenceId: e.evidence_id,
    fieldName: e.field_name,
    fieldState: e.field_state,
    // Contradição explícita: field_state=CONTRADICTED ou metadata.contradiction_with
    // presente (o repo N10/N12 grava a contradição assim; contradicted_by_evidence_ids
    // é apenas input de persist e não é coluna lida por listCandidateEvidence).
    isContradicted:
      e.field_state === "CONTRADICTED" ||
      isPlainRecord(e.metadata) && Array.isArray(e.metadata.contradiction_with) && (e.metadata.contradiction_with as unknown[]).length > 0,
    kind: e.kind,
  }));
}

/** Erro interno durante avaliação → BLOCKED explícito (fail-closed). */
function errorDecision(candidateId: string, reason: string, now: string): CuratorDecision {
  return evaluateCandidate(
    {
      candidateId,
      marketplace: null,
      sourceUrl: null,
      externalListingId: null,
      status: null,
      funnelStage: null,
      provenance: null,
      evidence: [],
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

/** Agora injetável para testes determinísticos. */
let nowProvider: () => string = () => new Date().toISOString();

export function setCuratorNowProvider(provider: () => string): void {
  nowProvider = provider;
}

export function resetCuratorNowProvider(): void {
  nowProvider = () => new Date().toISOString();
}

export async function evaluateCandidateById(
  candidateId: string,
): Promise<CuratorServiceResult> {
  try {
    const candidateResult = await getCandidate(candidateId);
    if (!candidateResult.ok || !candidateResult.candidate) {
      return { ok: false, outcome: "candidate_not_found", error: "candidate_not_found" };
    }
    const candidate = candidateResult.candidate;

    const evidenceResult = await listCandidateEvidence(candidateId);
    if (!evidenceResult.ok) {
      return { ok: false, outcome: "evidence_unavailable", error: evidenceResult.reason ?? "evidence_read_error" };
    }

    const input = projectCandidateInput(candidate);
    input.provenance = input.provenance ?? (typeof (candidate.metadata as Record<string, unknown>).source === "string"
      ? (candidate.metadata as Record<string, unknown>).source as string
      : null);

    const now = nowProvider();
    const decision = evaluateCandidate(
      { ...input, evidence: projectEvidenceInput(evidenceResult.evidence ?? []) },
      now,
    );

    const mapped = mapVerdictToAssessment(decision);
    const snapshot = {
      verdict: decision.verdict,
      confidence: decision.confidence,
      criteria: decision.criteria,
      candidateSnapshot: {
        marketplace: input.marketplace,
        sourceUrl: input.sourceUrl,
        externalListingId: input.externalListingId,
        status: input.status,
        funnelStage: input.funnelStage,
        provenance: input.provenance,
      },
      evidenceCount: evidenceResult.evidence?.length ?? 0,
    };

    const persistResult: PersistAssessmentResult = await persistAssessment({
      assessmentId: `cur-${candidateId.slice(4)}`,
      candidateId,
      filterVersion: mapped.filterVersion,
      dimensions: { contractVersion: decision.contractVersion, verdict: decision.verdict },
      classification: mapped.classification,
      classificationBasis: mapped.classificationBasis,
      recommendation: mapped.recommendation,
      recommendationBasis: mapped.recommendationBasis,
      priority: {},
      priorityLevel: null,
      priorityScore: null,
      unknowns: decision.criteria.filter((c) => c.result === "blocked").map((c) => `${c.criterion}: ${c.rationale}`),
      contradictions: decision.criteria.filter((c) => c.rationale.includes("contradit")).map((c) => c.rationale),
      collectionFailures: [],
      evidenceRefs: (evidenceResult.evidence ?? []).map((e) => e.evidence_id),
      inputSnapshot: snapshot,
      correlationId: null,
      idempotencyKey: buildAssessmentDigest({
        candidateId,
        filterVersion: mapped.filterVersion,
        snapshot,
      }),
        metadata: {
        block: "n13", version: "curator_v1",
        verdict: decision.verdict,
        rationale: decision.rationale,
        contractVersion: decision.contractVersion,
        provenance: CURATOR_PROVENANCE,
      },
    });

    if (!persistResult.ok) {
      // Falha de persistência não pode virar PASS: decisão existe mas
      // não está auditável → reportar erro sem sucesso.
      return { ok: false, outcome: "persist_error", error: persistResult.error ?? "persist_error" };
    }
    return {
      ok: true,
      outcome: persistResult.outcome === "identical_duplicate" ? "identical_duplicate" : "evaluated",
      decision,
    };
  } catch (error) {
    // Fail-closed: erro inesperado vira decisão BLOCKED com rationale
    // de erro interno, persistida para auditoria.
    const now = nowProvider();
    try {
      const decision = errorDecision(candidateId, (error as Error)?.message ?? "unknown", now);
      const mapped = mapVerdictToAssessment(decision);
      await persistAssessment({
        assessmentId: `cur-err-${candidateId.slice(4)}`,
        candidateId,
        filterVersion: mapped.filterVersion,
        dimensions: { contractVersion: decision.contractVersion, verdict: "BLOCKED", internalError: true },
        classification: mapped.classification,
        classificationBasis: mapped.classificationBasis,
        recommendation: mapped.recommendation,
        recommendationBasis: `erro_interno_durante_avaliacao:${(error as Error)?.message ?? "unknown"}`,
        priority: {},
        priorityLevel: null,
        priorityScore: null,
        unknowns: [`erro_interno:${(error as Error)?.message ?? "unknown"}`],
        contradictions: [],
        collectionFailures: [],
        evidenceRefs: [],
        inputSnapshot: { internalError: true },
        correlationId: null,
        idempotencyKey: buildAssessmentDigest({
          candidateId,
          filterVersion: mapped.filterVersion,
          snapshot: { internalError: true, candidateId },
        }),
        metadata: { block: "n13", version: "curator_v1", internalError: true },
      });
    } catch {
      // Nem a auditoria do erro é possível — retornar erro cru, nunca PASS.
    }
    return { ok: false, outcome: "evidence_unavailable", error: `internal_error:${(error as Error)?.message ?? "unknown"}` };
  }
}
