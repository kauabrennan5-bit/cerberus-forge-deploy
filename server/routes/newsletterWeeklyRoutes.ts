import type express from "express";
import * as productsRepository from "../repositories/productsRepository";
import { runWeeklyDraftCycle, runWeeklyStaleDraftCheck } from "../services/newsletterWeeklyCampaign";
import {
  ensureWeeklyBrevoTestRecipient,
  WeeklyBrevoTestRecipientSetupError,
} from "../services/newsletterWeeklyBrevoTestRecipient";
import {
  syncWeeklyBrevoProductionAudience,
  WeeklyBrevoAudienceSyncError,
} from "../services/newsletterWeeklyBrevoAudienceSync";
import { reconcileWeeklyBrevoCampaignStatuses } from "../services/newsletterWeeklyBrevoStatusReconcile";
import {
  enableWeeklyProductionAfterVerifiedSync,
  isWeeklyProductionEnabled,
  readWeeklyProductionRuntimeConfig,
} from "../services/newsletterWeeklyProductionConfig";
import { authorizeWeeklyAutomationRequest } from "../services/newsletterWeeklyAutomationAuth";
import { registerAutonomousCuratorRoutes } from "./autonomousCuratorRoutes";
import { registerOperatorAutomationRoutes } from "./operatorAutomationRoutes";
import { runWeeklyProductionPreflight, renderWeeklyPreflightTelegram } from "../services/newsletterWeeklyPreflight";
import { sendTelegramMessage } from "../services/telegramBot";
import { createSupabaseNewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { verifyWeeklyPreviewSignature } from "../services/newsletterWeeklyPreview";
import { runWeeklyEditorialBackfill } from "../services/newsletterWeeklyEditorialBackfill";

export function registerNewsletterWeeklyRoutes(app: express.Express): void {
  // O mesmo registrador central já é conectado pelo server.ts; o Autonomous
  // Curator reutiliza a autenticação OIDC dos jobs internos sem acoplar sua
  // lógica à newsletter.
  registerAutonomousCuratorRoutes(app);
  registerOperatorAutomationRoutes(app);

  const requireAutomation = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = await authorizeWeeklyAutomationRequest({ headers: req.headers as Record<string, string | string[] | undefined> });
    if (!auth.authorized) return res.status(401).json({ success: false, code: "AUTOMATION_UNAUTHORIZED" });
    next();
  };

  app.get("/api/newsletter/weekly-preview/:campaignId", async (req, res) => {
    try {
      const campaign = await createSupabaseNewsletterCampaignStore().getCampaign(String(req.params.campaignId || ""));
      if (!campaign || !campaign.editionKey?.startsWith("weekly:") || !verifyWeeklyPreviewSignature(campaign, req.query.expires, req.query.signature)) {
        return res.status(404).send("Prévia indisponível ou expirada.");
      }
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      return res.status(200).type("html").send(campaign.bodyHtml);
    } catch {
      return res.status(404).send("Prévia indisponível ou expirada.");
    }
  });

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
      const designTestMode = req.body?.designTestMode === true;
      const testMode = req.body?.testMode === true || designTestMode;
      if (!testMode && !(await isWeeklyProductionEnabled())) {
        return res.status(200).json({ success: true, status: "skipped", reason: "disabled" });
      }
      const runtimeEnv = testMode
        ? process.env
        : { ...process.env, NEWSLETTER_WEEKLY_ENABLED: "true" };
      const result = await runWeeklyDraftCycle({ testMode, designTestMode, env: runtimeEnv });
      return res.status(result.status === "created" ? 201 : 200).json({ success: true, status: result.status, mode: designTestMode ? "design-test" : testMode ? "test" : "production", reason: result.status === "skipped" ? result.reason : undefined, campaignId: result.status === "created" ? result.campaign.id : undefined });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] draft_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(500).json({ success: false, code: "WEEKLY_DRAFT_FAILED" });
    }
  });

  app.post("/api/internal/newsletter/weekly-preflight", requireAutomation, async (_req, res) => {
    try {
      const result = await runWeeklyProductionPreflight();
      const chatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
      if (!chatId) return res.status(503).json({ success: false, code: "TELEGRAM_ADMIN_CHAT_MISSING", result });
      const delivery = await sendTelegramMessage(chatId, renderWeeklyPreflightTelegram(result));
      if (!delivery.ok) return res.status(503).json({ success: false, code: "WEEKLY_PREFLIGHT_TELEGRAM_FAILED", result });
      return res.status(result.ready ? 200 : 409).json({ success: true, result });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] preflight_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(503).json({ success: false, code: "WEEKLY_PREFLIGHT_FAILED" });
    }
  });

  app.post("/api/internal/newsletter/weekly-editorial-backfill", requireAutomation, async (req, res) => {
    try {
      const execute = req.body?.execute === true;
      const result = await runWeeklyEditorialBackfill({ execute, limit: Number(req.body?.limit || 50) });
      return res.status(200).json({ success: true, result });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] editorial_backfill_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(503).json({ success: false, code: "WEEKLY_EDITORIAL_BACKFILL_FAILED" });
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

  app.get("/api/internal/newsletter/weekly-production/status", requireAutomation, async (_req, res) => {
    try {
      const config = await readWeeklyProductionRuntimeConfig();
      return res.status(200).json({
        success: true,
        production: {
          enabled: config?.weeklyEnabled === true,
          listConfigured: Boolean(config?.brevoListId),
          syncStatus: config?.lastSyncStatus || "never",
          syncVerified: Boolean(config?.contactSyncVerifiedAt),
          eligibleSubscribers: config?.eligibleSubscribersCount || 0,
          brevoMembers: config?.brevoMembersCount || 0,
          lastSyncAt: config?.lastSyncAt || null,
        },
      });
    } catch {
      return res.status(503).json({ success: false, code: "WEEKLY_PRODUCTION_STATUS_UNAVAILABLE" });
    }
  });

  app.post("/api/internal/newsletter/weekly-production/sync", requireAutomation, async (_req, res) => {
    try {
      const result = await syncWeeklyBrevoProductionAudience();
      console.info(
        `[NEWSLETTER-WEEKLY] production_audience_ready provider=BREVO eligible=${result.eligibleSubscribers}` +
        ` members=${result.brevoMembers} created=${result.contactsCreated} associated=${result.contactsAssociated}` +
        ` removed=${result.contactsRemoved} suppressed=${result.locallySuppressedFromBrevo}` +
        ` unsubscribed=${result.locallyUnsubscribedFromBrevo}`,
      );
      return res.status(200).json({
        success: true,
        result: {
          state: result.state,
          listConfigured: true,
          eligibleSubscribers: result.eligibleSubscribers,
          brevoMembers: result.brevoMembers,
          contactsCreated: result.contactsCreated,
          contactsAssociated: result.contactsAssociated,
          contactsRemoved: result.contactsRemoved,
          locallyUnsubscribedFromBrevo: result.locallyUnsubscribedFromBrevo,
          locallySuppressedFromBrevo: result.locallySuppressedFromBrevo,
        },
      });
    } catch (error) {
      const code = error instanceof WeeklyBrevoAudienceSyncError ? error.code : "WEEKLY_AUDIENCE_SYNC_FAILED";
      console.error(`[NEWSLETTER-WEEKLY] production_audience_failed code=${code}`);
      return res.status(409).json({ success: false, code });
    }
  });

  app.post("/api/internal/newsletter/weekly-production/reconcile", requireAutomation, async (_req, res) => {
    try {
      const result = await reconcileWeeklyBrevoCampaignStatuses();
      console.info(
        `[NEWSLETTER-WEEKLY] provider_status_reconciled checked=${result.checked}` +
        ` finalized=${result.finalized} pending=${result.pending} blocked=${result.blocked} errors=${result.errors}`,
      );
      if (result.errors > 0) return res.status(503).json({ success: false, code: "WEEKLY_PROVIDER_STATUS_RECONCILE_FAILED", result });
      return res.status(200).json({ success: true, result });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:-]{1,100}$/.test(error.message)
        ? error.message
        : "WEEKLY_PROVIDER_STATUS_RECONCILE_FAILED";
      console.error(`[NEWSLETTER-WEEKLY] provider_status_reconcile_failed code=${code}`);
      return res.status(503).json({ success: false, code });
    }
  });

  app.post("/api/internal/newsletter/weekly-production/bootstrap", requireAutomation, async (_req, res) => {
    try {
      const result = await syncWeeklyBrevoProductionAudience();
      if (result.eligibleSubscribers <= 0 || result.eligibleSubscribers !== result.brevoMembers) {
        return res.status(409).json({ success: false, code: "WEEKLY_PRODUCTION_AUDIENCE_NOT_READY" });
      }
      const config = await enableWeeklyProductionAfterVerifiedSync();
      console.info(
        `[NEWSLETTER-WEEKLY] production_enabled list_configured=${Boolean(config.brevoListId)}` +
        ` eligible=${config.eligibleSubscribersCount} members=${config.brevoMembersCount}`,
      );
      return res.status(200).json({
        success: true,
        production: {
          enabled: config.weeklyEnabled,
          listConfigured: Boolean(config.brevoListId),
          syncStatus: config.lastSyncStatus,
          eligibleSubscribers: config.eligibleSubscribersCount,
          brevoMembers: config.brevoMembersCount,
        },
      });
    } catch (error) {
      const code = error instanceof WeeklyBrevoAudienceSyncError
        ? error.code
        : error instanceof Error && /^[A-Z0-9_:-]{1,100}$/.test(error.message)
          ? error.message
          : "WEEKLY_PRODUCTION_BOOTSTRAP_FAILED";
      console.error(`[NEWSLETTER-WEEKLY] production_bootstrap_failed code=${code}`);
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
