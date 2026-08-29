import { timingSafeEqual } from "node:crypto";
import type express from "express";
import * as productsRepository from "../repositories/productsRepository";
import { runWeeklyDraftCycle, runWeeklyStaleDraftCheck } from "../services/newsletterWeeklyCampaign";
import {
  ensureWeeklyBrevoTestRecipient,
  WeeklyBrevoTestRecipientSetupError,
} from "../services/newsletterWeeklyBrevoTestRecipient";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function registerNewsletterWeeklyRoutes(app: express.Express): void {
  const requireAutomation = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const expected = (process.env.CERBERUS_AUTOMATION_TOKEN || "").trim();
    const provided = String(req.headers["x-cerberus-automation-token"] || "").trim();
    if (!expected || !tokenMatches(provided, expected)) return res.status(401).json({ success: false, code: "AUTOMATION_UNAUTHORIZED" });
    next();
  };

  app.get("/go/:ref", async (req, res) => {
    const ref = String(req.params.ref || "").trim();
    if (!ref) return res.status(404).send("Produto não encontrado.");
    try {
      const products = await productsRepository.getProducts();
      const product = products.find(item => item.ref === ref);
      if (!product || product.ativo !== true || product.status !== "published") return res.status(404).send("Produto indisponível.");
      try {
        await productsRepository.recordProductClick({
          productId: product.id,
          productSlug: product.slug,
          productName: product.displayTitle || product.produto,
          productPrice: Number(product.ofertaPromocional?.source === "admin_confirmed" ? product.ofertaPromocional.price : product.preco),
          utm_source: String(req.query.utm_source || "email").slice(0, 120),
          utm_medium: String(req.query.utm_medium || "newsletter").slice(0, 120),
          utm_campaign: String(req.query.campaign_id || "").slice(0, 160),
          utm_content: String(req.query.position || product.id).slice(0, 120),
          referrer: String(req.headers.referer || "").slice(0, 500),
          landingPage: `/go/${encodeURIComponent(ref)}`,
          userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
          ipAddress: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
        });
      } catch (error) {
        console.error(`[NEWSLETTER-WEEKLY] click_tracking_failed ref=${ref} reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 100) : "unknown"}`);
      }
      return res.redirect(302, product.link);
    } catch {
      return res.status(503).send("Destino temporariamente indisponível.");
    }
  });

  app.post("/api/internal/newsletter/weekly-draft", requireAutomation, async (req, res) => {
    try {
      const result = await runWeeklyDraftCycle({ testMode: req.body?.testMode === true });
      return res.status(result.status === "created" ? 201 : 200).json({ success: true, status: result.status, reason: result.status === "skipped" ? result.reason : undefined, campaignId: result.status === "created" ? result.campaign.id : undefined });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] draft_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(500).json({ success: false, code: "WEEKLY_DRAFT_FAILED" });
    }
  });

  app.post("/api/internal/newsletter/weekly-test-recipient/ensure", requireAutomation, async (_req, res) => {
    try {
      const result = await ensureWeeklyBrevoTestRecipient();
      console.info(
        `[NEWSLETTER-WEEKLY] test_recipient_ready provider=BREVO state=${result.state}` +
        ` contact_created=${result.contactCreated} list_created=${result.listCreated} associated=${result.associated}`,
      );
      return res.status(200).json({ success: true, result });
    } catch (error) {
      const code = error instanceof WeeklyBrevoTestRecipientSetupError
        ? error.code
        : "WEEKLY_TEST_RECIPIENT_SETUP_FAILED";
      console.error(`[NEWSLETTER-WEEKLY] test_recipient_setup_failed code=${code}`);
      return res.status(409).json({ success: false, code });
    }
  });

  app.post("/api/internal/newsletter/weekly-stale", requireAutomation, async (_req, res) => {
    try {
      const notified = await runWeeklyStaleDraftCheck();
      return res.json({ success: true, notified });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] stale_check_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(500).json({ success: false, code: "WEEKLY_STALE_CHECK_FAILED" });
    }
  });
}
