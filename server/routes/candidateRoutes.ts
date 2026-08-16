/**
 * Cerberus Finds Archive — Bloco N1 — Rotas administrativas de
 * candidatos (Contratos de Descoberta).
 *
 * Fronteiras: CANDIDATE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO
 *             MEMORY != AUTHORITY · RECOMMENDATION != ACTION
 *
 * Regras:
 *   - Todas as rotas são read-only ou formais (registro/veredito):
 *     NENHUMA executa scraping, cria produto canônico ou altera catálogo,
 *     Telegram, lifecycle, job queue ou Operator.
 *   - Admin auth obrigatória (requireAdminAuth).
 *   - promoteToProduct apenas REGISTRA o vínculo — criar o produto
 *     canônico é outra entidade e outro fluxo (N3/N5), jamais aqui.
 *   - deleteCandidateForProof NUNCA exposto via rota.
 *   - Sem endpoint público. Sem endpoint de execução.
 */
import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCandidate,
  getCandidatesClient,
  listCandidates,
  promoteToProduct,
  recordVerdict,
  registerCandidate,
  setCandidatesClient,
  startReview,
  type CandidateIntakeInput,
} from "../repositories/candidatesRepository";

export interface CandidateRouteDeps {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
}

export function registerCandidateRoutes(deps: CandidateRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  // POST /api/commercial/candidates — registrar candidato (formal)
  app.post("/api/commercial/candidates", requireAdminAuth, async (req, res) => {
    if (!getCandidatesClient()) {
      res.status(503).json({
        ok: false,
        error: "candidates_registry_unavailable",
        message: "Registry de candidatos indisponível (fail-closed).",
      });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: CandidateIntakeInput = {
      marketplace: body.marketplace ? String(body.marketplace) : "",
      source_url: body.source_url ? String(body.source_url) : "",
      external_listing_id: body.external_listing_id
        ? String(body.external_listing_id)
        : "",
      merchant: body.merchant !== undefined ? String(body.merchant) : undefined,
      title: body.title !== undefined ? String(body.title) : undefined,
      description: body.description !== undefined
        ? String(body.description)
        : undefined,
      category: body.category !== undefined ? String(body.category) : undefined,
      observed_price:
        body.observed_price !== undefined && body.observed_price !== null
          ? Number(body.observed_price)
          : null,
      observed_rating:
        body.observed_rating !== undefined && body.observed_rating !== null
          ? Number(body.observed_rating)
          : null,
      observed_rating_count:
        body.observed_rating_count !== undefined &&
        body.observed_rating_count !== null
          ? Number(body.observed_rating_count)
          : null,
      observed_availability: body.observed_availability !== undefined
        ? String(body.observed_availability)
        : undefined,
      observed_at: body.observed_at !== undefined
        ? String(body.observed_at)
        : undefined,
      evidence_hash: body.evidence_hash !== undefined
        ? String(body.evidence_hash)
        : undefined,
      collection_method: body.collection_method !== undefined
        ? String(body.collection_method)
        : undefined,
      raw_snapshot_url:
        body.raw_snapshot_url !== undefined && body.raw_snapshot_url !== null
          ? String(body.raw_snapshot_url)
          : null,
      idempotency_key: body.idempotency_key !== undefined
        ? String(body.idempotency_key)
        : undefined,
      metadata:
        body.metadata !== undefined &&
        typeof body.metadata === "object" &&
        body.metadata !== null
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    };

    const result = await registerCandidate(input);
    if (!result.ok) {
      const status =
        result.outcome === "conflict_rejected" ||
        result.outcome === "identical_duplicate"
          ? 409
          : 400;
      res.status(status).json({
        ok: false,
        error: result.reason ?? "generic_error",
        outcome: result.outcome,
        existing_id: result.existing_id,
        candidate: result.candidate,
      });
      return;
    }
    res.status(201).json({
      ok: true,
      outcome: result.outcome,
      candidate_id: result.candidate_id,
      candidate: result.candidate,
    });
  });

  // GET /api/commercial/candidates — listar (filtro por status/stage/marketplace)
  app.get("/api/commercial/candidates", requireAdminAuth, async (req, res) => {
    const params = {
      status:
        typeof req.query.status === "string" ? req.query.status : undefined,
      funnel_stage:
        typeof req.query.funnel_stage === "string"
          ? req.query.funnel_stage
          : undefined,
      marketplace:
        typeof req.query.marketplace === "string"
          ? req.query.marketplace
          : undefined,
      limit:
        typeof req.query.limit === "string"
          ? Number(req.query.limit)
          : undefined,
      offset:
        typeof req.query.offset === "string"
          ? Number(req.query.offset)
          : undefined,
    };
    const result = await listCandidates(params);
    res.json({ ok: true, ...result });
  });

  // GET /api/commercial/candidates/:id
  app.get("/api/commercial/candidates/:id", requireAdminAuth, async (req, res) => {
    const result = await getCandidate(req.params.id);
    if (!result.ok) {
      res.status(404).json({ ok: false, error: "candidate_not_found" });
      return;
    }
    res.json({ ok: true, candidate: result.candidate });
  });

  // POST /api/commercial/candidates/:id/review — iniciar revisão
  app.post(
    "/api/commercial/candidates/:id/review",
    requireAdminAuth,
    async (req, res) => {
      const result = await startReview(req.params.id);
      if (!result.ok) {
        const status =
          result.reason === "candidate_not_found" ? 404 : 409;
        res.status(status).json({
          ok: false,
          error: result.reason ?? "generic_error",
        });
        return;
      }
      res.json({ ok: true, candidate: result.candidate });
    },
  );

  // POST /api/commercial/candidates/:id/verdict — veredito de curadoria
  app.post(
    "/api/commercial/candidates/:id/verdict",
    requireAdminAuth,
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await recordVerdict({
        candidate_id: req.params.id,
        status: body.status ? String(body.status) : "",
        rejection_reason:
          body.rejection_reason !== undefined
            ? String(body.rejection_reason)
            : undefined,
        review_notes:
          body.review_notes !== undefined
            ? String(body.review_notes)
            : undefined,
        reviewed_by:
          body.reviewed_by !== undefined
            ? String(body.reviewed_by)
            : undefined,
      });
      if (!result.ok) {
        const status = result.reason === "candidate_not_found" ? 404 : 409;
        res.status(status).json({
          ok: false,
          error: result.reason ?? "generic_error",
        });
        return;
      }
      res.json({ ok: true, outcome: result.outcome, candidate: result.candidate });
    },
  );

  // POST /api/commercial/candidates/:id/promote — registrar vínculo
  // (registro, nunca migração de identidade)
  app.post(
    "/api/commercial/candidates/:id/promote",
    requireAdminAuth,
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await promoteToProduct({
        candidate_id: req.params.id,
        promoted_product_id: body.promoted_product_id
          ? String(body.promoted_product_id)
          : "",
      });
      if (!result.ok) {
        const status =
          result.reason === "candidate_not_found" ? 404 : 409;
        res.status(status).json({
          ok: false,
          error: result.reason ?? "generic_error",
        });
        return;
      }
      res.json({ ok: true, candidate: result.candidate });
    },
  );
}

export { getCandidatesClient, setCandidatesClient };
