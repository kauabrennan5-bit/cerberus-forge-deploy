/**
 * Cerberus Finds Archive — Bloco 17 — Rotas administrativas do
 * Experiment Registry.
 *
 * Fronteiras: EXPERIMENT != EXECUTION · DECISION != ACTION
 *             MEMORY != AUTHORITY · RECOMMENDATION != ACTION
 *
 * Regras:
 *   - Todas as rotas são read-only ou formais (criar/gravar decisão):
 *     NENHUMA executa variante, produto, Telegram, agente ou executor.
 *   - Admin auth obrigatória (requireAdminAuth).
 *   - POST /api/commercial/experiments + /decide + /observe: endpoints
 *     FORMAIS — criam/gravam registro, não executam nada material.
 *   - Sem endpoint público. Sem endpoint de execução.
 */

import type { Express, NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getExperiment,
  getExperimentClient,
  insertExperiment,
  listDecisions,
  listExperiments,
  recordExperimentDecision,
  setExperimentClient,
  updateExperimentObservation,
  validateExperimentDesign,
  type ExperimentDesignInput,
  type ExperimentRecord,
} from "../repositories/experimentRepository";
import { deriveMinSampleSize } from "../commercialBrain/statisticalRigor";

export interface ExperimentRouteDeps {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
}

export function registerExperimentRoutes(deps: ExperimentRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  // POST /api/commercial/experiments — criar experimento formal
  app.post("/api/commercial/experiments", requireAdminAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!getExperimentClient()) {
      res.status(503).json({
        ok: false,
        error: "experiment_registry_unavailable",
        message: "Registry do Experiment Registry indisponível (fail-closed).",
      });
      return;
    }

    const design: ExperimentDesignInput = {
      hypothesis: body.hypothesis ? String(body.hypothesis) : "",
      rationale: body.rationale !== undefined ? String(body.rationale) : undefined,
      variant_a_label: body.variant_a_label ? String(body.variant_a_label) : "",
      variant_b_label: body.variant_b_label ? String(body.variant_b_label) : "",
      target_population: body.target_population ? String(body.target_population) : "",
      target_product_ids: Array.isArray(body.target_product_ids)
        ? body.target_product_ids.map(String)
        : [],
      success_metric: body.success_metric ? String(body.success_metric) : "",
      metric_definition: body.metric_definition ? String(body.metric_definition) : "",
      design_alpha: body.design_alpha !== undefined ? Number(body.design_alpha) : undefined,
      design_power: body.design_power !== undefined ? Number(body.design_power) : undefined,
      design_mde_relative: body.design_mde_relative !== undefined ? Number(body.design_mde_relative) : undefined,
      design_baseline_proportion: body.design_baseline_proportion !== undefined ? Number(body.design_baseline_proportion) : undefined,
      fdr: body.fdr !== undefined ? Number(body.fdr) : undefined,
      min_sample_size: Number(body.min_sample_size ?? deriveMinSampleSize().nPerVariant),
      planned_duration_days: body.planned_duration_days !== undefined ? Number(body.planned_duration_days) : undefined,
      planned_end_date: body.planned_end_date !== undefined ? (body.planned_end_date ? String(body.planned_end_date) : null) : undefined,
      created_by: "operator-admin",
    };

    const validation = validateExperimentDesign(design);
    if (!validation.valid) {
      const err = validation as { error_code: string; explanation: string };
      res.status(400).json({ ok: false, error: err.error_code, message: err.explanation });
      return;
    }

    const outcome = await insertExperiment(design);
    if (outcome.missing_supabase) {
      res.status(503).json({ ok: false, error: "supabase_unavailable", message: outcome.error_message });
      return;
    }
    if (outcome.conflict_rejected) {
      res.status(409).json({ ok: false, error: "experiment_conflict_rejected", message: outcome.error_message });
      return;
    }
    if (outcome.identical_duplicate) {
      res.status(200).json({
        ok: true,
        duplicated: true,
        message: "Experimento idêntico já registrado (idempotência).",
        record: outcome.record,
      });
      return;
    }
    if (outcome.database_error) {
      res.status(500).json({ ok: false, error: "database_error", message: outcome.error_message });
      return;
    }
    res.status(201).json({ ok: true, record: outcome.record });
  });

  // GET /api/commercial/experiments
  app.get("/api/commercial/experiments", requireAdminAuth, async (_req, res) => {
    const list = await listExperiments({ limit: 50 });
    if (list.missing_supabase) {
      res.status(503).json({ ok: false, error: "supabase_unavailable" });
      return;
    }
    if (!list.success) {
      res.status(500).json({ ok: false, error: "database_error" });
      return;
    }
    res.json({ ok: true, experiments: list.experiments, total: list.total });
  });

  // GET /api/commercial/experiments/:id
  app.get("/api/commercial/experiments/:id", requireAdminAuth, async (req, res) => {
    const lookup = await getExperiment(req.params.id);
    if (!lookup.success || lookup.total === 0) {
      res.status(404).json({ ok: false, error: "experiment_not_found" });
      return;
    }
    res.json({ ok: true, record: lookup.experiments[0] });
  });

  // GET /api/commercial/experiments/:id/status
  app.get("/api/commercial/experiments/:id/status", requireAdminAuth, async (req, res) => {
    const lookup = await getExperiment(req.params.id);
    if (!lookup.success || lookup.total === 0) {
      res.status(404).json({ ok: false, error: "experiment_not_found" });
      return;
    }
    const record = lookup.experiments[0];
    const gate = evaluateStatusGate(record);
    res.json({ ok: true, status: record.status, gate, summary: summarizeForStatus(record) });
  });

  // GET /api/commercial/decisions
  app.get("/api/commercial/decisions", requireAdminAuth, async (_req, res) => {
    const list = await listDecisions();
    if (list.missing_supabase) {
      res.status(503).json({ ok: false, error: "supabase_unavailable" });
      return;
    }
    if (!list.success) {
      res.status(500).json({ ok: false, error: "database_error" });
      return;
    }
    res.json({ ok: true, decisions: list.experiments, total: list.total });
  });

  // POST /api/commercial/experiments/:id/decide — decisão formal (gate obrigatório)
  app.post("/api/commercial/experiments/:id/decide", requireAdminAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision ? String(body.decision) : "";
    const decision_basis = body.decision_basis ? String(body.decision_basis) : "";

    if (!decision) {
      res.status(400).json({ ok: false, error: "decision_required", message: "decision é obrigatório (SCALE|MAINTAIN|KILL|INCONCLUSIVE)." });
      return;
    }
    if (!decision_basis) {
      res.status(400).json({ ok: false, error: "decision_basis_required", message: "decision_basis (proveniência) é obrigatório — opinião textual não é decisão." });
      return;
    }

    const outcome = await recordExperimentDecision({
      experiment_id: req.params.id,
      decision,
      decision_basis,
      decided_by: "operator-admin",
    });
    if (outcome.missing_supabase) {
      res.status(503).json({ ok: false, error: "supabase_unavailable" });
      return;
    }
    if (outcome.database_error) {
      res.status(500).json({ ok: false, error: "database_error", message: outcome.error_message });
      return;
    }
    if (outcome.rejected) {
      res.status(409).json({
        ok: false,
        error: outcome.rejection_reason ?? "decision_rejected",
        explanation: outcome.rejection_explanation,
        sample_current: outcome.sample_current,
        sample_minimum: outcome.sample_minimum,
        days_remaining: outcome.days_remaining,
      });
      return;
    }
    res.status(201).json({ ok: true, record: outcome.record });
  });

  // POST /api/commercial/experiments/:id/observe — observação formal (amostra/cliques)
  app.post("/api/commercial/experiments/:id/observe", requireAdminAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of [
      "sample_size_a",
      "sample_size_b",
      "clicks_a",
      "clicks_b",
      "sample_size",
      "status",
      "start_date",
      "planned_end_date",
    ] as const) {
      if (body[field] !== undefined) {
        patch[field] = body[field] === "" ? null : body[field];
      }
    }
    const outcome = await updateExperimentObservation(
      req.params.id,
      patch as Parameters<typeof updateExperimentObservation>[1],
    );
    if (outcome.missing_supabase) {
      res.status(503).json({ ok: false, error: "supabase_unavailable" });
      return;
    }
    if (!outcome.updated) {
      res.status(400).json({ ok: false, error: "observation_update_failed", message: outcome.error_message });
      return;
    }
    res.status(200).json({ ok: true, record: outcome.record });
  });
}

/**
 * Status gate resumido (para /status): o que falta para permitir decisão.
 */
export function evaluateStatusGate(record: {
  sample_size: number;
  min_sample_size: number;
  planned_end_date: string | null;
  planned_duration_days: number;
  start_date: string | null;
  decision: string | null;
}): {
  decision_allowed: boolean;
  sample_met: boolean;
  period_ended: boolean;
  shortfall: number;
} {
  const sample_met = record.sample_size >= record.min_sample_size;
  const period_ended =
    record.planned_end_date !== null &&
    new Date(record.planned_end_date).getTime() <= Date.now();
  const fallback =
    !record.planned_end_date &&
    record.start_date !== null &&
    (Date.now() - new Date(record.start_date).getTime()) / 86400000 >= record.planned_duration_days;
  return {
    decision_allowed: sample_met || period_ended || fallback || record.decision !== null,
    sample_met,
    period_ended,
    shortfall: Math.max(0, record.min_sample_size - record.sample_size),
  };
}

function summarizeForStatus(record: ExperimentRecord): {
  experiment_id: string;
  hypothesis: string;
  variant_a_label: string;
  variant_b_label: string;
  sample_size: number;
  min_sample_size: number;
  start_date: string | null;
  planned_end_date: string | null;
  decision: string | null;
  statistical_rigor_version: string;
} {
  return {
    experiment_id: record.experiment_id,
    hypothesis: record.hypothesis,
    variant_a_label: record.variant_a_label,
    variant_b_label: record.variant_b_label,
    sample_size: record.sample_size,
    min_sample_size: record.min_sample_size,
    start_date: record.start_date,
    planned_end_date: record.planned_end_date,
    decision: record.decision,
    statistical_rigor_version: record.statistical_rigor_version,
  };
}

export { setExperimentClient };
