// ============================================================================
// Bloco N4 — Rotas administrativas de avaliação de candidatos.
//
// - POST   /api/commercial/assess/:candidateId          → executa o filtro v1
// - GET    /api/commercial/assess/:candidateId          → última avaliação
// - GET    /api/commercial/assess/:candidateId/history  → todas as avaliações
//
// Todas exigem x-admin-password (requireAdminAuth).
// GOVERNANÇA:
// - RECOMMENDATION != ACTION: nenhuma rota publica, promove ou executa ação.
// - CANDIDATE != FACT CANÔNICO: nenhuma referência a products.
// ============================================================================
import type { Express, Request, Response } from "express";
import {
  assessCandidate,
  type AssessResult,
} from "../commercial/filter/cerberusFilter";
import {
  listCandidateAssessments,
  getAssessment,
  persistAssessment,
  buildAssessmentDigest,
} from "../repositories/candidateAssessmentRepository";
import { FILTER_VERSION } from "../commercial/filter/cerberusFilterRules";

function adminError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

function validateCandidateId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 255;
}

export function registerAssessmentRoutes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  // Executa o filtro (persiste a avaliação — replay idempotente).
  app.post("/api/commercial/assess/:candidateId", requireAdminAuth, async (req, res) => {
    const candidateId = req.params.candidateId;
    if (!validateCandidateId(candidateId)) {
      return adminError(res, 400, "invalid_candidate_id");
    }
    const result = await assessCandidate(candidateId);
    if (!result.ok || !result.dimensions) {
      return adminError(res, 404, result.reason ?? "assessment_failed");
    }
    const idempotencyKey = buildAssessmentDigest({
      candidateId,
      filterVersion: FILTER_VERSION,
      snapshot: result.inputSnapshot ?? {},
    });
    const assessmentId = `asm-${candidateId}-${idempotencyKey.slice(-16)}`;
    const persisted = await persistAssessment({
      assessmentId,
      candidateId,
      filterVersion: FILTER_VERSION,
      dimensions: result.dimensions as unknown as Record<string, unknown>,
      classification: result.classification?.classification ?? null,
      classificationBasis: result.classification?.basis ?? "",
      recommendation: result.recommendation?.recommendation ?? null,
      recommendationBasis: result.recommendation?.basis ?? "",
      priority: result.priority as unknown as Record<string, unknown>,
      priorityLevel: result.priority?.priority_level ?? null,
      priorityScore: result.priority?.priority_score ?? null,
      unknowns: result.unknowns ?? [],
      contradictions: result.contradictions ?? [],
      collectionFailures: result.collectionFailures ?? [],
      evidenceRefs: result.evidenceRefs ?? [],
      inputSnapshot: result.inputSnapshot as Record<string, unknown>,
      idempotencyKey,
    });
    if (!persisted.ok) {
      return adminError(res, 500, persisted.error ?? "persistence_failed");
    }
    res.status(200).json({
      ok: true,
      outcome: persisted.outcome,
      assessment: persisted.assessment,
    });
  });

  // Última avaliação do candidato (render/admin).
  app.get("/api/commercial/assess/:candidateId", requireAdminAuth, async (req, res) => {
    const candidateId = req.params.candidateId;
    if (!validateCandidateId(candidateId)) {
      return adminError(res, 400, "invalid_candidate_id");
    }
    const list = await listCandidateAssessments({ candidateId, limit: 1 });
    if (!list.ok) {
      return adminError(res, 500, list.error ?? "list_failed");
    }
    res.status(200).json({ ok: true, assessments: list.assessments });
  });

  // Histórico completo (preservação de histórico — nunca apaga).
  app.get("/api/commercial/assess/:candidateId/history", requireAdminAuth, async (req, res) => {
    const candidateId = req.params.candidateId;
    if (!validateCandidateId(candidateId)) {
      return adminError(res, 400, "invalid_candidate_id");
    }
    const list = await listCandidateAssessments({ candidateId, limit: 100 });
    if (!list.ok) {
      return adminError(res, 500, list.error ?? "list_failed");
    }
    res.status(200).json({ ok: true, assessments: list.assessments });
  });

  // Avaliação específica por id (render).
  app.get("/api/commercial/assessment/:assessmentId", requireAdminAuth, async (req, res) => {
    const assessmentId = req.params.assessmentId;
    if (!validateCandidateId(assessmentId)) {
      return adminError(res, 400, "invalid_assessment_id");
    }
    const result = await getAssessment(assessmentId);
    if (!result.ok) {
      return adminError(res, 500, result.error ?? "lookup_failed");
    }
    if (!result.assessment) {
      return adminError(res, 404, "assessment_not_found");
    }
    res.status(200).json({ ok: true, assessment: result.assessment });
  });
}

// Reexportação útil para registros de rotas e para testes do serviço.
export { assessCandidate };
