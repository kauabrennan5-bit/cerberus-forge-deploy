// ============================================================================
// Bloco N13 — Rotas de curadoria Cerberus (Fase 1).
//
// GOVERNANÇA:
// - READ-ONLY em relação ao candidato e ao catálogo: POST /evaluate NÃO
//   altera candidato, NÃO cria produto, NÃO cria affiliate_link, NÃO
//   publica, NÃO agenda jobs.
// - A persistência é a tabela candidate_assessment já existente (N4):
//   avaliaçōes de curadoria com filter_version "n13:curator_v1".
// - Autenticação administrativa obrigatória (requireAdminAuth).
// - Falha em qualquer etapa → nunca PASS; erro reportado como outcome
//   com rationale (fail-closed).
// ============================================================================
import type { Express, NextFunction, Request, Response } from "express";
import {
  evaluateCandidateById,
  type CuratorServiceResult,
} from "../commercial/curation/service";
import { listCandidateAssessments } from "../repositories/candidateAssessmentRepository";

export function registerCurationRoutes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void,
): void {
  /**
   * POST /api/commercial/curation/evaluate
   * Body: { "candidate_id": "can-<sha256hex>" }
   * Avalia o candidato contra os critérios estruturais do contrato
   * curator_v1 e persiste a avaliação (idempotente). Read-only: nada
   * fora de candidate_assessment é tocado.
   */
  app.post("/api/commercial/curation/evaluate", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.body?.candidate_id === "string" ? req.body.candidate_id.trim() : "";
      if (!/^can-[A-Za-z0-9]{32}$/.test(candidateId)) {
        res.status(400).json({
          ok: false,
          error: "invalid_candidate_id",
          note: "candidate_id deve estar no formato can-<sha256 hex 32 chars>",
        });
        return;
      }
      const result: CuratorServiceResult = await evaluateCandidateById(candidateId);
      const httpStatus = result.ok ? 200 : result.outcome === "candidate_not_found" ? 404 : 424;
      const payload: Record<string, unknown> = { ok: result.ok, outcome: result.outcome };
      if (result.decision) payload.decision = result.decision;
      if (result.error) payload.error = result.error;
      payload.note =
        result.ok
          ? "Curadoria estrutural read-only: nenhum produto, link ou publicação foi criado/alterado."
          : "Avaliação não concluída (fail-closed): nenhuma aprovação foi concedida.";
      res.status(httpStatus).json(payload);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        note: "Erro inesperado durante avaliação — nenhum PASS foi concedido (fail-closed).",
      });
    }
  });

  /**
   * GET /api/commercial/curation/:candidateId
   * Somente leitura: devolve as avaliações de curadoria já persistidas
   * para o candidato. NÃO dispara nova avaliação.
   */
  app.get("/api/commercial/curation/:candidateId", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.params.candidateId === "string" ? req.params.candidateId.trim() : "";
      if (!/^can-[A-Za-z0-9]{32}$/.test(candidateId)) {
        res.status(400).json({ ok: false, error: "invalid_candidate_id" });
        return;
      }
      const result = await listCandidateAssessments({
        candidateId,
        limit: 50,
      });
      if (!result.ok) {
        res.status(424).json({ ok: false, error: result.error ?? "list_error" });
        return;
      }
      const n13 = (result.assessments ?? []).filter(
        (a) => (a as Record<string, unknown>).filter_version === "n13:curator_v1",
      );
      res.json({
        ok: true,
        candidateId,
        assessments: n13,
        note: "Leitura read-only das avaliações de curadoria N13 persistidas.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
}
