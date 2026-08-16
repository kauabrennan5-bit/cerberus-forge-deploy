// ============================================================================
// Bloco N2 — Rotas administrativas de descoberta controlada.
// POST /api/commercial/discover — autenticação administrativa obrigatória.
// Nunca executa publicação, promoção ou alteração do catálogo canônico.
// ============================================================================

import { Request, Response, Router } from "express";
import { MARKETPLACE_SOURCES, isMarketplaceSource } from "../commercial/discovery/types";
import { executeDiscover } from "../commercial/discovery/discover";

interface DiscoveryRouteDeps {
  app: { post(path: string, ...handlers: unknown[]): unknown; get?(path: string, ...handlers: unknown[]): unknown };
  requireAdminAuth: (req: Request, res: Response, next: (err?: unknown) => void) => void;
}

export function setupDiscoveryRoutes(deps: DiscoveryRouteDeps): Router {
  const router = Router();
  const { app, requireAdminAuth } = deps;

  app.post("/api/commercial/discover", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const marketplaceRaw = body.marketplace;
      if (!isMarketplaceSource(marketplaceRaw)) {
        res.status(400).json({
          ok: false,
          error: "invalid_marketplace",
          allowed: [...MARKETPLACE_SOURCES],
        });
        return;
      }
      const mode = body.mode;
      if (mode !== "url" && mode !== "search") {
        res.status(400).json({ ok: false, error: "invalid_mode", allowed: ["url", "search"] });
        return;
      }
      if (mode === "url" && (!body.url || typeof body.url !== "string" || body.url.trim().length === 0)) {
        res.status(400).json({ ok: false, error: "missing_url" });
        return;
      }
      if (mode === "search" && (!body.query || typeof body.query !== "string" || body.query.trim().length === 0)) {
        res.status(400).json({ ok: false, error: "missing_query" });
        return;
      }

      const result = await executeDiscover({
        marketplace: marketplaceRaw,
        mode,
        url: body.url,
        query: body.query,
        limit: body.limit,
      });

      if (!result.ok) {
        res.status(424).json({
          ok: false,
          marketplace: result.marketplace,
          mode: result.mode,
          found: 0,
          created: 0,
          duplicates: 0,
          conflicts: 0,
          items: [],
          error: result.error ?? "discovery_failed",
        });
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      console.error("[DISCOVER-ROUTE] erro inesperado:", (err as Error).message);
      res.status(500).json({ ok: false, error: "generic_error" });
    }
  });

  return router;
}
