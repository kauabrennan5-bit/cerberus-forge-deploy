// ============================================================================
// Bloco N12 — Entrypoint administrativo de pesquisa automatizada.
// POST /api/commercial/research-batch — autenticação administrativa obrigatória.
//
// Governança (inalterável):
//   - RESEARCH != PUBLICATION · RESEARCH != PROMOTION — nunca cria/altera
//     produtos, publica, promove, cria affiliate_links, campaigns,
//     job_queue, habilita scheduler ou agentes.
//   - CANDIDATE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO.
//   - O N12 é camada de COORDENAÇÃO: delega read-only ao N1 (existência de
//     candidates) e delega a sessão de pesquisa ao N3 (startResearch).
//   - FAIL-CLOSED: qualquer validação inválida é rejeitada antes de
//     qualquer execução externa.
//
// Decisão de arquitetura (registrar no relatório de consolidação):
// reutilizamos o mecanismo administrativo EXISTENTE do projeto
// (requireAdminAuth) em vez de criar uma nova rota permanente exposta.
// A superfície é a menor possível: um único POST que valida, executa
// o orquestrador N12 e devolve o AutomatedResearchBatchResult.
// Não há endpoint público/Telegram nesta fase — o N11 permanece a
// autoridade de coordenação do discovery; a integração Telegram do N12
// (se desejada) será avaliada em bloco separado.
// ============================================================================

import { Request, Response } from "express";
import {
  RESEARCH_DEFAULT_FIELDS,
  RESEARCH_LIMITS,
  type AutomatedResearchRequest,
} from "../commercial/facilitator/researchContracts";
import { AutomatedResearchOrchestrator } from "../commercial/facilitator/automatedResearch";
import { executeIntegratedResearch } from "../commercial/facilitator/integratedResearchExecutor";

interface ResearchBatchRouteDeps {
  app: { post(path: string, ...handlers: unknown[]): unknown };
  requireAdminAuth: (req: Request, res: Response, next: (err?: unknown) => void) => void;
}

/** Body do request administrativo (validação fail-closed nesta rota). */
interface ResearchBatchRequestBody {
  candidates?: ReadonlyArray<{
    candidate_id?: unknown;
    requested_fields?: unknown;
    proof_run_id?: unknown;
  }>;
  coordination?: {
    concurrency?: unknown;
    item_timeout_ms?: unknown;
    max_retries?: unknown;
  };
  proof_run_id?: unknown;
}

/**
 * validateResearchBatchBody — validação administrativa fail-closed
 * (camadas acima já validam; aqui re-forçamos o contrato com rejeição
 * limpa de tipos inválidos). NUNCA transformar input inválido em defaults
 * silenciosos que mascarem erro.
 */
function validateResearchBatchBody(
  body: ResearchBatchRequestBody,
): { ok: true; request: AutomatedResearchRequest } | { ok: false; error: string } {
  const candidatesRaw = body.candidates;
  if (!candidatesRaw || !Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
    return { ok: false, error: "candidates_ausente" };
  }
  if (candidatesRaw.length > RESEARCH_LIMITS.MAX_BATCH_CANDIDATES) {
    return { ok: false, error: "lote_excedido" };
  }

  const candidates = candidatesRaw.map((raw) => {
    if (!raw || typeof raw !== "object") {
      return { ok: false as const, error: "candidate_invalido" };
    }
    const r = raw as { candidate_id?: unknown; requested_fields?: unknown; proof_run_id?: unknown };
    const candidate_id = r.candidate_id;
    if (typeof candidate_id !== "string" || candidate_id.trim().length === 0) {
      return { ok: false as const, error: "candidate_id_invalido" };
    }
    let requested_fields: ReadonlyArray<string> | undefined;
    if (r.requested_fields !== undefined) {
      if (!Array.isArray(r.requested_fields)) {
        return { ok: false as const, error: "requested_fields_invalido" };
      }
      const filtered = r.requested_fields.filter(
        (f): f is string => typeof f === "string" && f.trim().length > 0,
      );
      const validFieldNames: ReadonlyArray<string> = RESEARCH_DEFAULT_FIELDS as ReadonlyArray<string>;
      if (filtered.length === 0 || filtered.some((f) => !validFieldNames.includes(f))) {
        return { ok: false as const, error: "campos_invalidos" };
      }
      requested_fields = filtered;
    }
    let proof_run_id: string | null | undefined;
    if (r.proof_run_id !== undefined) {
      if (r.proof_run_id === null) {
        proof_run_id = null;
      } else if (typeof r.proof_run_id !== "string") {
        return { ok: false as const, error: "proof_run_id_invalido" };
      } else {
        proof_run_id = r.proof_run_id;
      }
    }
    return { ok: true as const, candidate: { candidate_id, requested_fields, proof_run_id } };
  });

  for (const c of candidates) {
    if (!c.ok) {
      return { ok: false, error: c.error };
    }
  }

  let coordination: AutomatedResearchRequest["coordination"] | undefined;
  const coordRaw = body.coordination;
  if (coordRaw !== undefined && coordRaw !== null) {
    if (typeof coordRaw !== "object") {
      return { ok: false, error: "coordination_invalido" };
    }
    const cr = coordRaw as {
      concurrency?: unknown;
      item_timeout_ms?: unknown;
      max_retries?: unknown;
    };
    const concurrency =
      cr.concurrency === undefined ? undefined : Number(cr.concurrency);
    const item_timeout_ms =
      cr.item_timeout_ms === undefined ? undefined : Number(cr.item_timeout_ms);
    const max_retries =
      cr.max_retries === undefined ? undefined : Number(cr.max_retries);
    if (
      (cr.concurrency !== undefined && (!Number.isFinite(concurrency!) || concurrency! < 1)) ||
      (cr.item_timeout_ms !== undefined && (!Number.isFinite(item_timeout_ms!) || item_timeout_ms! <= 0)) ||
      (cr.max_retries !== undefined && (!Number.isFinite(max_retries!) || max_retries! < 0))
    ) {
      return { ok: false, error: "coordination_fora_dos_limites" };
    }
    coordination = {
      concurrency: Number.isFinite(concurrency as number) ? (concurrency as number) : undefined,
      item_timeout_ms: Number.isFinite(item_timeout_ms as number)
        ? (item_timeout_ms as number)
        : undefined,
      max_retries: Number.isFinite(max_retries as number) ? (max_retries as number) : undefined,
    };
  }

  let proof_run_id: string | null | undefined;
  if (body.proof_run_id !== undefined) {
    if (body.proof_run_id === null) {
      proof_run_id = null;
    } else if (typeof body.proof_run_id !== "string") {
      return { ok: false, error: "proof_run_id_invalido" };
    } else {
      proof_run_id = body.proof_run_id;
    }
  }

  return {
    ok: true,
    request: {
      candidates: candidates.map((c) => (c as { ok: true; candidate: object }).candidate),
      coordination,
      proof_run_id,
    } as AutomatedResearchRequest,
  };
}

export function registerResearchBatchRoutes(deps: ResearchBatchRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  app.post("/api/commercial/research-batch", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const validation = validateResearchBatchBody(req.body ?? {});
      if (!validation.ok) {
        res.status(400).json({ ok: false, error: (validation as { error: string }).error });
        return;
      }

      const orchestrator = new AutomatedResearchOrchestrator(executeIntegratedResearch);
      const result = await orchestrator.executeBatch(validation.request);

      res.status(200).json({
        ok: true,
        batch_id: result.batch_id,
        status: result.status,
        proof_run_id: result.proof_run_id,
        received: result.metrics?.received ?? result.items.length,
        processed: result.metrics?.processed ?? result.items.length,
        metrics: result.metrics,
        items: result.items,
      });
    } catch (err) {
      console.error("[RESEARCH-BATCH-ROUTE] erro inesperado:", (err as Error).message);
      res.status(500).json({ ok: false, error: "generic_error" });
    }
  });
}
