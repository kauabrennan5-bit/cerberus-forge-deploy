import { Router, type NextFunction, type Request, type Response } from "express";
import { searchShopeeProductsDDG } from "../services/shopeeSearchProvider";
import { discoverShopeeProducts } from "../services/shopeeDiscovery";

const router = Router();

/**
 * Diagnostic endpoints can trigger external network/search work and are never
 * intended to be a public production API. They are disabled by default and,
 * when explicitly enabled, require a separate diagnostic token.
 */
function requireDiagnosticAccess(req: Request, res: Response, next: NextFunction) {
  if (process.env.DIAGNOSTICS_ENABLED !== "true") {
    return res.status(404).json({ success: false, error: "Not found" });
  }

  const expected = String(process.env.DIAGNOSTICS_TOKEN || "").trim();
  if (!expected) {
    return res.status(503).json({ success: false, error: "Diagnostics are not configured" });
  }

  const provided = String(req.headers["x-diagnostics-token"] || "").trim();
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  next();
}

router.use(requireDiagnosticAccess);

router.get("/diag/search-test", async (req, res) => {
  const query = String(req.query.q || "organizador cozinha").slice(0, 160);
  const results = await searchShopeeProductsDDG(query, 5);
  res.json({
    source: "DuckDuckGo Lite",
    query,
    count: results.length,
    results
  });
});

router.get("/diag/discovery-test", async (req, res) => {
  const query = String(req.query.q || "organizador cozinha").slice(0, 160);
  const result = await discoverShopeeProducts(query, 3);
  res.json(result);
});

export default router;
