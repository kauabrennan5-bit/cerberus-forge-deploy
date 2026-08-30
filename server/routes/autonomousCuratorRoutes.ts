import type { Express, Request, Response } from "express";
import { authorizeWeeklyAutomationRequest } from "../services/newsletterWeeklyAutomationAuth";
import { runAutonomousCuratorDaily } from "../services/autonomousCurator";
import { getAutonomousCuratorConfig } from "../repositories/autonomousCuratorRepository";

async function authorize(req: Request, res: Response): Promise<boolean> {
  const auth = await authorizeWeeklyAutomationRequest({ headers: req.headers as Record<string, string | string[] | undefined> });
  if (auth.authorized) return true;
  res.status(401).json({ ok: false, code: "AUTOMATION_UNAUTHORIZED" });
  return false;
}

export function registerAutonomousCuratorRoutes(app: Express): void {
  app.post("/api/internal/autonomous-curator/daily", async (req, res) => {
    if (!(await authorize(req, res))) return;
    const dryRun = req.body?.dryRun === true;
    const notify = req.body?.notify !== false;
    try {
      const result = await runAutonomousCuratorDaily({ dryRun, notify });
      return res.status(200).json({ ok: true, result });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:.-]{1,160}$/.test(error.message)
        ? error.message
        : "AUTONOMOUS_CURATOR_FAILED";
      console.error(`[AUTONOMOUS-CURATOR] daily_failed code=${code}`);
      return res.status(500).json({ ok: false, code });
    }
  });

  app.get("/api/internal/autonomous-curator/status", async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const config = await getAutonomousCuratorConfig();
      return res.status(200).json({
        ok: true,
        enabled: config.enabled,
        autoPublishEnabled: config.autoPublishEnabled,
        autoPublishThreshold: config.autoPublishThreshold,
        reviewThreshold: config.reviewThreshold,
        maxDailyPerCategory: config.maxDailyPerCategory,
      });
    } catch {
      return res.status(503).json({ ok: false, code: "AUTONOMOUS_CURATOR_STATUS_UNAVAILABLE" });
    }
  });
}
