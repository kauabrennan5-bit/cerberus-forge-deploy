// ============================================================================
// Bloco N15 — Governança: camada de aprovação governada para ações
// comerciais (Fase 1).
//
// GOVERNANÇA (contrato N15):
// - N15 = GATEKEEPER, NUNCA executor: POST /decide NÃO publica, NÃO
//   adquire link, NÃO cria produto, NÃO agenda job, NÃO envia Telegram.
//   A decisão é apenas autorização declarativa (fail-closed): toda
//   ação real continua dependendo dos blocos executores downstream
//   (N5/N8/etc.), que por sua vez revalidam autorização.
// - Gates obrigatórios: N13 PASS (n13:curator_v1) + N14 score válido
//   (n14:commercial_brain_v1). Qualquer erro/ausência → fail-closed:
//   REJECTED/BLOCKED, nunca APPROVED.
// - Persistência reutiliza candidate_assessment (N4) com
//   filter_version "n15:governance_v1" — avaliação com
//   is_actionable=false sempre.
// - Autenticação administrativa obrigatória (requireAdminAuth).
// - Idempotente: mesmo snapshot → mesmo digest → identical_duplicate.
// - Nenhuma evidência/credencial sensível é persistida ou exposta.
// ============================================================================
import type { Express, NextFunction, Request, Response } from "express";
import {
  evaluateGovernanceDecision,
  type GovernanceEvaluateResult,
} from "../commercial/governance/service";
import {
  GOVERNANCE_ACTIONS,
  isGovernanceAction,
} from "../commercial/governance/contract";
import { listCandidateAssessments } from "../repositories/candidateAssessmentRepository";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Valida o envelope de sinais compatível com o N14 (mesmo formato).
function isPlainSignalsObject(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!isPlainObject(value)) return false;
  for (const val of Object.values(value)) {
    if (!isPlainObject(val)) return false;
  }
  return true;
}

export function registerGovernanceRoutes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void,
): void {
  /**
   * POST /api/commercial/governance/decide
   * Body: {
   *   "candidate_id": "can-<hex 24-32>",
   *   "action": "publish" | "acquire" | "distribute" | "advertise",
   *   "signals"?: { ... }   (opcional, mesmo formato do N14; reservado)
   * }
   * Decide governança sobre a AÇÃO declarada. Read-only: não executa
   * nada; apenas registra a decisão de aprovação/rejeição com
   * rationale completo. Fail-closed: qualquer falha → BLOCKED.
   */
  app.post("/api/commercial/governance/decide", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.body?.candidate_id === "string" ? req.body.candidate_id.trim() : "";
      if (!/^can-[a-fA-F0-9]{24,32}$/.test(candidateId)) {
        res.status(400).json({
          ok: false,
          error: "invalid_candidate_id",
          note: "candidate_id deve estar no formato can-<hex 24-32>",
        });
        return;
      }
      const rawAction = typeof req.body?.action === "string" ? req.body.action.trim() : "";
      const isValidAction = isGovernanceAction(rawAction);
      if (!isValidAction) {
        res.status(400).json({
          ok: false,
          error: "invalid_action",
          allowed_actions: [...GOVERNANCE_ACTIONS],
          note: "Ação não reconhecida. Falha fechada: nenhuma autorização foi concedida.",
        });
        return;
      }
      const result: GovernanceEvaluateResult = await evaluateGovernanceDecision(
        { candidateId, action: rawAction },
        // signals é reservado para evolução futura (score manual N14);
        // por enquanto nada do corpo é injetado na decisão.
      );
      // Status HTTP estabelecido pelo service (fail-closed):
      // 400 invalidCandidate/unknownAction · 404 ausente · 500 infra.
      const httpStatus = result.ok ? 200 : result.http_status || 500;
      const payload: Record<string, unknown> = {
        ok: result.ok,
        outcome: result.outcome,
        candidate_id: candidateId,
        action: rawAction,
      };
      if (result.decision) payload.decision = result.decision;
      if (result.error_code) payload.error_code = result.error_code;
      if (result.assessment_id) payload.assessment_id = result.assessment_id;
      if (result.idempotency_key) payload.idempotency_key = result.idempotency_key;
      payload.note =
        result.ok && result.decision
          ? `Governança ${result.decision.status} para '${rawAction}': decisão read-only — a execução real depende dos blocos executores, que revalidam autorização. Nenhuma ação foi executada.`
          : "Decisão governada fail-closed (BLOCKED/REJECTED): nenhuma autorização foi concedida. Nenhuma ação foi executada.";
      res.status(httpStatus).json(payload);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "internal_error",
        note: "Erro inesperado na decisão governada — fail-closed: nenhuma autorização foi concedida. Nenhuma ação foi executada.",
      });
    }
  });

  /**
   * GET /api/commercial/governance/:candidateId
   * Somente leitura: devolve as decisões de governança já persistidas
   * para o candidato. NÃO dispara nova decisão.
   */
  app.get("/api/commercial/governance/:candidateId", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const candidateId = typeof req.params.candidateId === "string" ? req.params.candidateId.trim() : "";
      if (!/^can-[a-fA-F0-9]{24,32}$/.test(candidateId)) {
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
      const n15 = (result.assessments ?? []).filter(
        (a) => (a as Record<string, unknown>).filter_version === "n15:governance_v1",
      );
      res.json({
        ok: true,
        candidateId,
        decisions: n15,
        note: "Leitura read-only das decisões de governança N15 persistidas. Nenhuma ação foi executada.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
}
