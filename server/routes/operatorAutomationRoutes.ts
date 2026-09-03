import type express from "express";
import * as cerberusOperator from "../services/cerberusOperator";
import { authorizeWeeklyAutomationRequest } from "../services/newsletterWeeklyAutomationAuth";

let activeHealthCycle: Promise<unknown> | null = null;

export function registerOperatorAutomationRoutes(app: express.Express): void {
  app.post("/api/internal/operator/health-cycle", async (req, res) => {
    const auth = await authorizeWeeklyAutomationRequest({
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (!auth.authorized) {
      return res.status(401).json({ success: false, code: "AUTOMATION_UNAUTHORIZED" });
    }

    if (activeHealthCycle) {
      return res.status(202).json({ success: true, accepted: true, status: "already_running" });
    }

    activeHealthCycle = cerberusOperator.runSystemHealthCheck();
    try {
      const report = await activeHealthCycle;
      return res.status(200).json({
        success: true,
        accepted: true,
        status: "completed",
        report,
      });
    } catch (error) {
      const reason = error instanceof Error
        ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120)
        : "UNKNOWN";
      console.error(`[OPERATOR EXTERNAL] health_cycle_failed reason=${reason}`);
      return res.status(503).json({ success: false, code: "OPERATOR_HEALTH_CYCLE_FAILED" });
    } finally {
      activeHealthCycle = null;
    }
  });
}
