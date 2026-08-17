// ============================================================================
// Bloco N9 — Rotas administrativas do ciclo comercial (admin-only).
//
// Todas as rotas exigem autenticação administrativa (requireAdminAuth).
// Regras:
//   - start   → cria ciclo governado (fail-closed se faltar credencial de
//               autenticação; sem credencial → 401 do middleware, nunca 200);
//   - run-*   → executa exatamente UMA etapa do ciclo (sem encadeamento
//               automático); cada etapa tem sua própria etapa;
//   - run-all → executa as etapas na ordem S1→S8, registrando cada passo;
//   - state   → render-only: estado consolidado do ciclo (somente leituras);
//   - list    → render-only: lista de ciclos (somente leituras);
//   - cleanup → prova controlada: remove ciclo + steps + decisions + links
//               artificiais (exclusivo de provas; exige ciclo em estado de
//               prova — não remove produto canônico nem assessment real).
//
// Nada aqui cria produtos; a única rota que pode tocar products é a
// run-publication, que delega ao executor N5 — que por sua vez exige
// DECISION_ALLOWED, Policy Engine, ApprovalStore e idempotencyKey.
// ============================================================================
import { Request, Response, Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  startCycle,
  runDiscovery,
  runResearch,
  runAssessment,
  runAcquisition,
  runResolution,
  runDecision,
  runPublication,
  runAllStages,
  getCycleState,
  deleteCycleForProof,
} from "../commercial/cycle/commercialCycleService";
import {
  listCycles,
  setCycleClient,
} from "../commercial/cycle/cycleRepository";
import { isCycleMarketplace } from "../commercial/cycle/decisionGate";

export function registerCycleRoutes(router: Router, requireAdminAuth: (req: Request, res: Response, next: () => void) => void, client: SupabaseClient | null): void {
  // Injeta o cliente do server (mesmo padrão dos demais blocos — o
  // repository do N9 aceita o client via setCycleClient).
  setCycleClient(client);

  // POST /api/admin/cycle/start
  router.post("/api/admin/cycle/start", requireAdminAuth, async (req, res) => {
    try {
      const body = req.body ?? {};
      const marketplaceRaw = body.marketplace;
      const sourceUrl = typeof body.source_url === "string" ? body.source_url : undefined;
      const sourceType = body.source_type === "QUERY" ? "QUERY" : "URL";
      const query = typeof body.query === "string" ? body.query : undefined;
      const providerId = typeof body.provider_id === "string" ? body.provider_id : undefined;
      if (!sourceUrl) {
        res.status(400).json({ ok: false, reason: "source_url obrigatório" });
        return;
      }
      if (!isCycleMarketplace(marketplaceRaw)) {
        res.status(400).json({ ok: false, reason: "marketplace inválido (mercadolivre|shopee)" });
        return;
      }
      const result = await startCycle({
        marketplace: marketplaceRaw,
        sourceUrl,
        sourceType: sourceType as "URL" | "QUERY",
        query: query ?? null,
        providerId: providerId ?? null,
        createdBy: body.created_by ?? "operator-admin",
      });
      if (!result.ok) {
        // Motivos de VALIDAÇÃO de input → 400 (caller corrigível);
        // demais falhas → 500 (infraestrutura).
        const isInputValidation =
          result.reason === "invalid_marketplace" ||
          result.reason === "invalid_source_url" ||
          result.reason === "invalid_source_url_protocol" ||
          result.reason === "invalid_source_url_parse";
        res.status(isInputValidation ? 400 : 500).json({ ok: false, reason: result.reason ?? "cycle_start_failed" });
        return;
      }
      res.status(200).json({ ok: true, cycleId: result.cycleId, outcome: result.outcome });
    } catch (err) {
      res.status(500).json({ ok: false, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  });

  // POST /api/admin/cycle/:cycleId/run/:stage
  const runStage = async (cycleId: string, stage: string, runner: (id: string) => Promise<{ ok: boolean; [k: string]: unknown }>, res: Response) => {
    if (!/^ncc-[A-Za-z0-9_-]+$/.test(cycleId)) {
      res.status(400).json({ ok: false, reason: "cycle_id inválido" });
      return;
    }
    try {
      const result = await runner(cycleId);
      res.status(200).json({ ok: true, stage, result });
    } catch (err) {
      res.status(500).json({ ok: false, stage, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  };

  router.post("/api/admin/cycle/:cycleId/run/discovery", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "DISCOVERY", runDiscovery, res));
  router.post("/api/admin/cycle/:cycleId/run/research", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "RESEARCH", runResearch, res));
  router.post("/api/admin/cycle/:cycleId/run/assessment", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "ASSESSMENT", runAssessment, res));
  router.post("/api/admin/cycle/:cycleId/run/acquisition", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "ACQUISITION", runAcquisition, res));
  router.post("/api/admin/cycle/:cycleId/run/resolution", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "RESOLUTION", runResolution, res));
  router.post("/api/admin/cycle/:cycleId/run/decision", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "DECISION", runDecision, res));
  router.post("/api/admin/cycle/:cycleId/run/publication", requireAdminAuth, (req, res) => runStage(req.params.cycleId, "PUBLICATION", runPublication, res));

  // POST /api/admin/cycle/:cycleId/run-all — executa S1→S8 registrando cada passo.
  router.post("/api/admin/cycle/:cycleId/run-all", requireAdminAuth, async (req, res) => {
    if (!/^ncc-[A-Za-z0-9_-]+$/.test(req.params.cycleId)) {
      res.status(400).json({ ok: false, reason: "cycle_id inválido" });
      return;
    }
    try {
      const result = await runAllStages(req.params.cycleId);
      res.status(200).json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  });

  // GET /api/admin/cycle/:cycleId/state — render-only (somente leituras).
  router.get("/api/admin/cycle/:cycleId/state", requireAdminAuth, async (req, res) => {
    if (!/^ncc-[A-Za-z0-9_-]+$/.test(req.params.cycleId)) {
      res.status(400).json({ ok: false, reason: "cycle_id inválido" });
      return;
    }
    try {
      const result = await getCycleState(req.params.cycleId);
      if (!result.ok) {
        res.status(404).json({ ok: false, reason: result.reason ?? "cycle_not_found" });
        return;
      }
      res.status(200).json({ ok: true, state: result.state });
    } catch (err) {
      res.status(500).json({ ok: false, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  });

  // GET /api/admin/cycle/list — render-only (somente leituras).
  router.get("/api/admin/cycle/list", requireAdminAuth, async (_req, res) => {
    try {
      const result = await listCycles({ limit: 100 });
      res.status(200).json({ ok: true, cycles: result.cycles ?? [] });
    } catch (err) {
      res.status(500).json({ ok: false, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  });

  // POST /api/admin/cycle/:cycleId/cleanup — prova controlada exclusiva.
  router.post("/api/admin/cycle/:cycleId/cleanup", requireAdminAuth, async (req, res) => {
    if (!/^ncc-[A-Za-z0-9_-]+$/.test(req.params.cycleId)) {
      res.status(400).json({ ok: false, reason: "cycle_id inválido" });
      return;
    }
    if (req.body.proof !== "commercial_proof") {
      res.status(400).json({ ok: false, reason: "cleanup exige confirmação proof=commercial_proof" });
      return;
    }
    try {
      const result = await deleteCycleForProof(req.params.cycleId);
      if (!result.ok) {
        res.status(500).json({ ok: false, reason: result.reason ?? "cleanup_failed" });
        return;
      }
      res.status(200).json({ ok: true, cleaned: true });
    } catch (err) {
      res.status(500).json({ ok: false, reason: `erro de infraestrutura: ${String((err as Error)?.message ?? err)}` });
    }
  });
}
