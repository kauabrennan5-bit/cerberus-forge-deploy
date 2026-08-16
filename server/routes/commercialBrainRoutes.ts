/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Rotas HTTP de leitura analítica (FASE B+).
 *
 * Contratos aprovados (D-2 do Design Review):
 *   GET  /api/commercial/analyze         → POST equivalente é proibido:
 *                                            a análise é puramente analítica;
 *                                            qualquer persistência é memória,
 *                                            não execução. A persistência é
 *                                            controlada por query param.
 *   GET  /api/commercial/signals         → leitura de sinais persistidos
 *   GET  /api/commercial/recommendations → leitura de artefatos persistidos
 *
 * Todas usam requireAdminAuth (auth administrativa EXISTENTE,
 * ADMIN_PASSWORD + x-admin-password / Bearer / body / query).
 * Sem whitelist nova, sem novo papel, sem nova autoridade.
 *
 * Fronteiras:
 *   READ ONLY (em products) · ANALYSIS != EXECUTION
 *   SIGNAL != REVENUE · RECOMMENDATION != ACTION
 */
import type { Express, NextFunction, Request, Response } from "express";
import { ANALYSIS_WINDOWS, AnalysisWindow } from "../commercialBrain/types";
import { COMMERCIAL_BRAIN_VERSION } from "../commercialBrain/types";
import {
  getArtifactsByPeriod,
  getArtifactsByProduct,
  getArtifactsByType,
  getSignalsByPeriod,
  setCommercialBrainClientForTests,
} from "../repositories/commercialBrainRepository";
import { supabase } from "../repositories/productsRepository";
import {
  runCommercialAnalysis,
  scanBannedTerms,
  setCommercialBrainClientForTests as setServiceClientForTests,
} from "../services/commercialAnalysisService";

export { setCommercialBrainClientForTests, setServiceClientForTests };

/**
 * Registra as rotas do Cérebro Comercial V1 no app Express.
 * requireAdminAuth deve ser o middleware de autenticação existente.
 */
export function registerCommercialBrainRoutes(params: {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
}): void {
  const { app, requireAdminAuth } = params;

  /**
   * GET /api/commercial/analyze
   * Produz a análise V1 (sinais, oportunidades, riscos, recomendações).
   * persist=false → leitura analítica pura (nada gravado).
   * persist=true (default) → sinais e recomendações gravados como memória
   * analítica (commercial_signals / commercial_artifacts), nunca como ação.
   */
  app.get("/api/commercial/analyze", requireAdminAuth, async (req, res) => {
    try {
      const productId = String(req.query.product_id || "").trim();
      const productRef = String(req.query.product_ref || productId).trim();
      const rawWindow = String(req.query.window || "7d").trim();
      const persistParam = String(req.query.persist || "false").trim().toLowerCase();
      const persist = persistParam !== "false";

      if (!productId) {
        return res.status(400).json({
          success: false,
          code: "MISSING_PRODUCT_ID",
          error: "Parâmetro product_id obrigatório.",
        });
      }
      const window: AnalysisWindow =
        ANALYSIS_WINDOWS.includes(rawWindow as AnalysisWindow)
          ? (rawWindow as AnalysisWindow)
          : "7d";

      const evaluatedAt = new Date();
      const { analysis, persisted } = await runCommercialAnalysis({
        productId,
        productRef,
        window,
        evaluatedAt,
        persist,
        analysisId: undefined,
        correlationId: undefined,
      });

      const banned = scanBannedTerms(analysis);
      if (banned.length > 0) {
        // Vocabulário proibido (venda/receita/lucro) contaminou a análise.
        // A análise é descartada por segurança; nada é persistido.
        return res.status(500).json({
          success: false,
          code: "BANNED_VOCABULARY",
          error: `Análise descartada: vocabulário comercial não sustentado detectado (${banned.join(", ")}).`,
        });
      }

      return res.json({
        success: true,
        analysis,
        persisted,
        analysisVersion: COMMERCIAL_BRAIN_VERSION,
        producedAt: analysis.producedAt,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("persist_")) {
        return res.status(503).json({
          success: false,
          code: "MEMORY_UNAVAILABLE",
          error: error.message,
        });
      }
      return res.status(500).json({
        success: false,
        code: "ANALYSIS_ERROR",
        error: error instanceof Error ? error.message : "Falha ao executar a análise.",
      });
    }
  });

  /**
   * GET /api/commercial/signals
   * Leitura de sinais persistidos (memória analítica). Filtros opcionais:
   * product_id, signal_type, confidence, from, to, correlation_id, limit.
   */
  app.get("/api/commercial/signals", requireAdminAuth, async (req, res) => {
    try {
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      if (!from || !to) {
        return res.status(400).json({
          success: false,
          code: "MISSING_PERIOD",
          error: "Parâmetros from e to (ISO 8601) obrigatórios.",
        });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const outcome = await getSignalsByPeriod({ from, to, limit });
      if (outcome.outcome === "missing_supabase") {
        return res.status(503).json({ success: false, code: "MEMORY_UNAVAILABLE", error: outcome.error });
      }
      if (outcome.outcome === "database_error") {
        return res.status(503).json({ success: false, code: "READ_ERROR", error: outcome.error });
      }
      let records = (outcome.record as unknown as Record<string, unknown>[]) || [];

      const productFilter = String(req.query.product_id || "").trim();
      if (productFilter) records = records.filter((r) => String(r.product_id) === productFilter);
      const typeFilter = String(req.query.signal_type || "").trim();
      if (typeFilter) records = records.filter((r) => String(r.signal_type) === typeFilter);
      const confidenceFilter = String(req.query.confidence || "").trim();
      if (confidenceFilter) records = records.filter((r) => String(r.confidence) === confidenceFilter);
      const correlationFilter = String(req.query.correlation_id || "").trim();
      if (correlationFilter) records = records.filter((r) => String(r.correlation_id) === correlationFilter);

      return res.json({ success: true, signals: records, total: records.length });
    } catch (error) {
      return res.status(500).json({
        success: false,
        code: "READ_ERROR",
        error: error instanceof Error ? error.message : "Falha ao ler sinais.",
      });
    }
  });

  /**
   * GET /api/commercial/recommendations
   * Leitura de artefatos persistidos (oportunidades, riscos, recomendações).
   * Filtros opcionais: artifact_type, product_id, from, to, limit.
   */
  app.get("/api/commercial/recommendations", requireAdminAuth, async (req, res) => {
    try {
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      if (!from || !to) {
        return res.status(400).json({
          success: false,
          code: "MISSING_PERIOD",
          error: "Parâmetros from e to (ISO 8601) obrigatórios.",
        });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const artifactType = String(req.query.artifact_type || "").trim();

      let records: Record<string, unknown>[] = [];
      if (artifactType) {
        if (!["opportunity", "risk", "recommendation"].includes(artifactType)) {
          return res.status(400).json({
            success: false,
            code: "INVALID_ARTIFACT_TYPE",
            error: `artifact_type inválido: "${artifactType}".`,
          });
        }
        const outcome = await getArtifactsByType(artifactType as "opportunity" | "risk" | "recommendation", limit);
        if (outcome.outcome !== "inserted") {
          return res.status(503).json({ success: false, code: "READ_ERROR", error: outcome.error });
        }
        records = (outcome.record as unknown as Record<string, unknown>[]) || [];
      } else {
        const outcome = await getArtifactsByPeriod({ from, to, limit });
        if (outcome.outcome !== "inserted") {
          return res.status(503).json({ success: false, code: "READ_ERROR", error: outcome.error });
        }
        records = (outcome.record as unknown as Record<string, unknown>[]) || [];
      }

      const productFilter = String(req.query.product_id || "").trim();
      if (productFilter) records = records.filter((r) => String(r.product_id) === productFilter);

      return res.json({ success: true, recommendations: records, total: records.length });
    } catch (error) {
      return res.status(500).json({
        success: false,
        code: "READ_ERROR",
        error: error instanceof Error ? error.message : "Falha ao ler recomendações.",
      });
    }
  });
}
