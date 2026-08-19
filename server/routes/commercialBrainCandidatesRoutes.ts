// ============================================================================
// Bloco N14 — Commercial Brain de CANDIDATES — Rotas (Fase 1).
//
// GOVERNANÇA:
// - READ-ONLY: nada de products, affiliate_links, jobs, publicação,
//   Telegram, N8/N15/N16 é chamado a partir daqui.
// - Autenticação administrativa obrigatória (requireAdminAuth).
// - GATE N13 obrigatório: POST /evaluate só executa com assessment
//   N13 'n13:curator_v1' + verdict 'PASS'; caso contrário fail-closed
//   sem criar assessment N14.
// - Falha em qualquer etapa → nunca score aprovado (fail-closed).
// ============================================================================
import type { Express, NextFunction, Request, Response } from "express";
import {
  evaluateCommercialBrain,
  type CommercialBrainGateReason,
} from "../commercial/commercialBrain/service";
import { listCandidateAssessments } from "../repositories/candidateAssessmentRepository";

export function registerCommercialBrainCandidatesRoutes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void,
): void {
  /**
   * POST /api/commercial/commercial-brain/evaluate
   * Body: {
   *   "candidate_id": "can-<hex 24-32>",
   *   "signals": {                 ← opcionais; substituem/complementam
   *      "price": { value, status, source, observedAt, provenance, currency },
   *      "commission": { value, status, source, observedAt, provenance },
   *      "availability": { value, status, source, observedAt, provenance },
   *      "market": { value, status, source, observedAt, provenance },
   *      "seller": { value, reviewCount, status, source, observedAt, provenance },
   *      "competition": { value, status, source, observedAt, provenance }
   *   }
   * }
   * Sinais ausentes permanecem UNKNOWN (nunca 0). Gate N13 obrigatório.
   */
  app.post("/api/commercial/commercial-brain/evaluate", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.body?.candidate_id === "string" ? req.body.candidate_id.trim() : "";
      if (!/^can-[A-Za-z0-9]{24,32}$/.test(candidateId)) {
        res.status(400).json({
          ok: false,
          error: "invalid_candidate_id",
          note: "candidate_id deve estar no formato can-<hex 24-32>",
        });
        return;
      }
      const signalsInput = isPlainSignalsObject(req.body?.signals) ? req.body.signals : null;
      const result = await evaluateCommercialBrain(candidateId, signalsInput, null);
      if (!result.ok) {
        const httpStatus = result.gateReason === "candidate_not_found"
          ? 404
          : result.gateReason === "invalid_candidate_id"
            ? 400
            : 424;
        res.status(httpStatus).json({
          ok: false,
          outcome: result.outcome,
          gate_reason: result.gateReason ?? "commercial_brain_error",
          error: result.error ?? null,
          note: "Análise comercial não concluída (fail-closed): nenhum score foi aprovado. " +
            "Nenhuma ação comercial foi executada.",
        });
        return;
      }
      const payload: Record<string, unknown> = {
        ok: true,
        outcome: result.outcome,
        candidate_id: candidateId,
        score: result.decision?.score ?? null,
        band: result.decision?.band,
        confidence: result.decision?.confidence,
        coverage: result.decision?.coverage,
        conflict: result.decision?.conflict,
        conflict_dimensions: result.decision?.conflictDimensions,
        dimensions_used: result.decision?.dimensionsUsed,
        dimensions_unknown: result.decision?.dimensionsUnknown,
        risk_penalty: result.decision?.riskPenalty,
        risk_factors: result.decision?.riskFactors,
        rationale: result.decision?.rationale,
        digest: result.decision?.digest,
        idempotency_key: result.decision?.idempotencyKey,
        weights_version: result.decision?.weightsVersion,
        note: "Análise comercial read-only de candidato: nenhum produto, link, " +
          "publicação, job ou efeito comercial foi criado/alterado.",
      };
      res.status(200).json(payload);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        note: "Erro inesperado durante análise comercial (fail-closed): nenhum score foi aprovado.",
      });
    }
  });

  /**
   * GET /api/commercial/commercial-brain/:candidateId
   * Somente leitura: devolve as avaliações N14 já persistidas.
   * NÃO dispara nova avaliação.
   */
  app.get("/api/commercial/commercial-brain/:candidateId", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.params.candidateId === "string" ? req.params.candidateId.trim() : "";
      if (!/^can-[A-Za-z0-9]{24,32}$/.test(candidateId)) {
        res.status(400).json({ ok: false, error: "invalid_candidate_id" });
        return;
      }
      const result = await listCandidateAssessments({ candidateId, limit: 50 });
      if (!result.ok) {
        res.status(424).json({ ok: false, error: result.error ?? "list_error" });
        return;
      }
      const n14 = (result.assessments ?? []).filter(
        (a) => (a as Record<string, unknown>).filter_version === "n14:commercial_brain_v1",
      );
      res.json({
        ok: true,
        candidateId,
        assessments: n14,
        note: "Leitura read-only das avaliações comerciais N14 persistidas.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
}

function isPlainSignalsObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === null || (typeof v === "object" && v !== null && !Array.isArray(v)))
  );
}
