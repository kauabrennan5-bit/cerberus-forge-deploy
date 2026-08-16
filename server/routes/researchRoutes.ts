// ============================================================================
// Bloco N3 — Rotas administrativas de Research (Pipeline de Pesquisa +
// Evidência).
//
// Regras:
//   - POST /api/commercial/research/:candidateId  → inicia sessão de
//     pesquisa (coleta + evidências); admin auth obrigatória;
//   - GET  /api/commercial/research/:candidateId  → sessões + resumo;
//   - GET  /api/commercial/research/:candidateId/evidence → evidências
//     completas com proveniência;
//   - RESEARCH != PUBLICATION · RESEARCH != PROMOTION — nenhuma rota cria
//     produto canônico, altera candidates ou executa qualquer ação externa;
//   - deleteEvidenceForProof NUNCA exposto via rota;
//   - Sem endpoint público. A execução de pesquisa é exclusiva destas rotas
//     administrativas (o Telegram /research é render-only).
// ============================================================================

import type { Express, NextFunction, Request, Response } from "express";
import {
  listCandidateEvidence,
  listEvidence,
  listFieldEvidence,
  listResearchSessions,
} from "../repositories/candidateEvidenceRepository";
import { startResearch } from "../commercial/discovery/research";

export interface ResearchRouteDeps {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
}

export function registerResearchRoutes(deps: ResearchRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  // POST /api/commercial/research/:candidateId — iniciar sessão de pesquisa
  app.post(
    "/api/commercial/research/:candidateId",
    requireAdminAuth,
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const requestedFields = Array.isArray(body.requested_fields)
        ? (body.requested_fields as unknown[]).map(f => String(f))
        : undefined;

      const result = await startResearch({
        candidate_id: req.params.candidateId,
        initiated_by: "operator-admin",
        requested_fields: requestedFields,
      });

      if (!result.ok) {
        const status = result.error === "candidate_not_found" ? 404 : 400;
        res.status(status).json({
          ok: false,
          error: result.error ?? "research_failed",
          research_id: result.research_id,
        });
        return;
      }

      const status = result.fetch_failed ? 424 : 201;
      res.status(status).json({
        ok: true,
        research_id: result.research_id,
        candidate_id: result.candidate_id,
        fetch_failed: result.fetch_failed,
        fetch_reason: result.fetch_reason,
        session_evidence_id: result.session_evidence_id,
        fields: result.fields,
        contradictions: result.contradictions,
        unknowns: result.unknowns,
        note: "EVIDENCE != FACT CANÔNICO · RESEARCH != PUBLICATION · RESEARCH != PROMOTION",
      });
    },
  );

  // GET /api/commercial/research/:candidateId — sessões + resumo
  app.get(
    "/api/commercial/research/:candidateId",
    requireAdminAuth,
    async (req, res) => {
      const candidateId = req.params.candidateId;
      const sessionsResult = await listResearchSessions(candidateId);
      if (!sessionsResult.ok) {
        res.status(503).json({
          ok: false,
          error: "evidence_registry_unavailable",
          message: "Registry de evidências indisponível (fail-closed).",
        });
        return;
      }

      // Resumo: quantas contradições e UNKNOWNs por candidato
      const allEvidence = await listCandidateEvidence(candidateId);
      const contradictions = allEvidence.ok
        ? allEvidence.evidence.filter(e => e.field_state === "CONTRADICTED").length
        : 0;
      const unknowns = allEvidence.ok
        ? allEvidence.evidence.filter(e => e.field_state === "UNKNOWN" || e.field_state === "COLLECTION_FAILED").length
        : 0;

      res.json({
        ok: true,
        candidate_id: candidateId,
        sessions: sessionsResult.sessions,
        total_sessions: sessionsResult.sessions.length,
        contradictions,
        unknowns,
        total_evidence: allEvidence.ok ? allEvidence.evidence.length : 0,
      });
    },
  );

  // GET /api/commercial/research/:candidateId/evidence — evidências completas
  app.get(
    "/api/commercial/research/:candidateId/evidence",
    requireAdminAuth,
    async (req, res) => {
      const candidateId = req.params.candidateId;
      const researchId =
        typeof req.query.research_id === "string"
          ? req.query.research_id
          : undefined;
      const fieldName =
        typeof req.query.field_name === "string"
          ? req.query.field_name
          : undefined;
      const state =
        typeof req.query.field_state === "string"
          ? req.query.field_state
          : undefined;

      const result = await listEvidence({
        candidate_id: candidateId,
        research_id: researchId,
        field_name: fieldName,
        field_state: state,
        limit: 200,
      });

      if (!result.ok) {
        res.status(503).json({
          ok: false,
          error: "evidence_registry_unavailable",
          message: "Registry de evidências indisponível (fail-closed).",
        });
        return;
      }

      res.json({
        ok: true,
        candidate_id: candidateId,
        research_id: researchId,
        field_name: fieldName,
        field_state: state,
        evidence: result.evidence,
        total: result.total,
      });
    },
  );
}
