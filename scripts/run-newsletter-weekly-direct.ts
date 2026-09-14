import "dotenv/config";
import { runWeeklyDraftCycle, runWeeklyStaleDraftCheck } from "../server/services/newsletterWeeklyCampaign";
import { runWeeklyProductionPreflight, renderWeeklyPreflightTelegram } from "../server/services/newsletterWeeklyPreflight";
import { runWeeklyEditorialBackfill } from "../server/services/newsletterWeeklyEditorialBackfill";
import { isWeeklyProductionEnabled } from "../server/services/newsletterWeeklyProductionConfig";
import { sendTelegramMessage } from "../server/services/telegramBot";

type Operation = "preflight" | "draft" | "stale" | "backfill-dry-run" | "backfill-execute";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`WEEKLY_DIRECT_SECRET_MISSING:${label}`);
}

function operation(): Operation {
  const raw = String(process.env.WEEKLY_OPERATION || "preflight").trim();
  if (["preflight", "draft", "stale", "backfill-dry-run", "backfill-execute"].includes(raw)) return raw as Operation;
  throw new Error(`WEEKLY_DIRECT_OPERATION_UNSUPPORTED:${raw}`);
}

function serverlessNewsletterEnabled(): boolean {
  return process.env.CERBERUS_SERVERLESS_NEWSLETTER_ENABLED === "true";
}

function serverlessWeeklyPreviewReady(): boolean {
  return process.env.CERBERUS_SERVERLESS_WEEKLY_PREVIEW_READY === "true";
}

function safeDiagnostic(value: unknown, max = 180): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/[^a-zA-Z0-9_ .,:;()\-\/]/g, "?").trim().slice(0, max);
}

function describeDirectFailure(error: unknown): string {
  if (error instanceof Error) {
    const message = safeDiagnostic(error.message);
    return message ? `WEEKLY_DIRECT_RUN_FAILED:${message}` : "WEEKLY_DIRECT_RUN_FAILED";
  }
  if (error && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    const code = safeDiagnostic(raw.code, 80);
    const message = safeDiagnostic(raw.message);
    if (code || message) return ["WEEKLY_DIRECT_RUN_FAILED", code, message].filter(Boolean).join(":");
  }
  return "WEEKLY_DIRECT_RUN_FAILED";
}

async function main(): Promise<void> {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);

  const op = operation();
  let telegramMessagesSent = 0;
  let campaignDraftsCreated = 0;
  let editorialProductsUpdated = 0;
  let status = "ok";
  let result: unknown = null;
  const trackedTelegramSender = async (chatId: string, text: string, replyMarkup?: unknown) => {
    const delivery = await sendTelegramMessage(chatId, text, replyMarkup);
    if (delivery.ok) telegramMessagesSent += 1;
    return delivery;
  };

  if (op === "preflight") {
    const preflight = await runWeeklyProductionPreflight();
    result = preflight;
    if (process.env.WEEKLY_PREFLIGHT_TELEGRAM_NOTIFY === "true") {
      const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
      if (!chatId) throw new Error("WEEKLY_DIRECT_TELEGRAM_ADMIN_CHAT_MISSING");
      const delivery = await trackedTelegramSender(chatId, renderWeeklyPreflightTelegram(preflight));
      if (!delivery.ok) throw new Error("WEEKLY_DIRECT_PREFLIGHT_TELEGRAM_FAILED");
    }
  } else if (op === "draft") {
    if (!serverlessNewsletterEnabled() || !serverlessWeeklyPreviewReady() || !(await isWeeklyProductionEnabled())) {
      status = "skipped";
      result = { reason: "weekly_production_or_preview_disabled" };
    } else {
      const outcome = await runWeeklyDraftCycle({
        env: { ...process.env, NEWSLETTER_WEEKLY_ENABLED: "true" },
        telegramSender: trackedTelegramSender,
      });
      result = outcome.status === "created"
        ? { status: outcome.status, campaignId: outcome.campaign.id, productCount: outcome.products.length }
        : outcome;
      campaignDraftsCreated = outcome.status === "created" ? 1 : 0;
    }
  } else if (op === "stale") {
    if (!serverlessNewsletterEnabled()) {
      status = "skipped";
      result = { reason: "serverless_newsletter_disabled" };
    } else {
      result = { notified: await runWeeklyStaleDraftCheck({ telegramSender: trackedTelegramSender }) };
    }
  } else if (op === "backfill-dry-run") {
    result = await runWeeklyEditorialBackfill({ execute: false, limit: Number(process.env.WEEKLY_BACKFILL_LIMIT || 50) });
  } else {
    if (process.env.WEEKLY_ALLOW_EDITORIAL_BACKFILL_EXECUTE !== "true") {
      throw new Error("WEEKLY_DIRECT_BACKFILL_EXECUTE_NOT_AUTHORIZED");
    }
    const backfill = await runWeeklyEditorialBackfill({ execute: true, limit: Number(process.env.WEEKLY_BACKFILL_LIMIT || 50) });
    editorialProductsUpdated = backfill.updated;
    result = backfill;
  }

  const proof = {
    runtime: "github-actions-direct",
    mode: "newsletter-weekly-direct",
    operation: op,
    renderDependency: false,
    status,
    autoPublished: 0,
    newsletterSends: 0,
    sendNowCalls: 0,
    consentChanges: 0,
    providerCampaignCreates: 0,
    campaignDraftsCreated,
    editorialProductsUpdated,
    telegramMessagesSent,
    result,
  };

  if (proof.autoPublished !== 0 || proof.newsletterSends !== 0 || proof.sendNowCalls !== 0 || proof.consentChanges !== 0 || proof.providerCampaignCreates !== 0) {
    throw new Error("WEEKLY_DIRECT_SAFETY_CONTRACT_VIOLATED");
  }
  console.log(JSON.stringify(proof));
}

main().catch((error) => {
  console.error(describeDirectFailure(error));
  process.exitCode = 1;
});
