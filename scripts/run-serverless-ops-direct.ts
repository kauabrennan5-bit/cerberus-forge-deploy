import "dotenv/config";
import { runWeeklyDraftCycle, runWeeklyStaleDraftCheck } from "../server/services/newsletterWeeklyCampaign";
import { runWeeklyProductionPreflight, renderWeeklyPreflightTelegram } from "../server/services/newsletterWeeklyPreflight";
import { syncWeeklyBrevoProductionAudience } from "../server/services/newsletterWeeklyBrevoAudienceSync";
import { reconcileWeeklyBrevoCampaignStatuses } from "../server/services/newsletterWeeklyBrevoStatusReconcile";
import { readWeeklyProductionRuntimeConfig, isWeeklyProductionEnabled } from "../server/services/newsletterWeeklyProductionConfig";
import { createConfiguredNewsletterProvider, getNewsletterProviderConfigStatus } from "../server/services/newsletterProvider";
import { createNewsletterOutboxWorker } from "../server/services/newsletterOutboxWorker";
import { runSystemHealthCheck } from "../server/services/cerberusOperator";
import { readAutonomousCuratorInvariant } from "../server/services/autonomousCuratorContinuousV2";
import { sendTelegramMessage } from "../server/services/telegramBot";

type Operation =
  | "serverless-health"
  | "weekly-preflight"
  | "weekly-draft"
  | "weekly-stale"
  | "audience-status"
  | "audience-sync"
  | "audience-reconcile"
  | "newsletter-outbox-once"
  | "operator-health"
  | "curator-invariant";

const FUNCTIONS_BASE = (process.env.SUPABASE_FUNCTIONS_BASE || "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1").replace(/\/+$/, "");
const STOREFRONT_URL = (process.env.STOREFRONT_URL || "https://cerberus-finds.pages.dev").replace(/\/+$/, "");

function operationFromArg(): Operation {
  const value = String(process.argv[2] || process.env.CERBERUS_OPS_OPERATION || "serverless-health").trim() as Operation;
  const allowed = new Set<Operation>([
    "serverless-health", "weekly-preflight", "weekly-draft", "weekly-stale",
    "audience-status", "audience-sync", "audience-reconcile", "newsletter-outbox-once",
    "operator-health", "curator-invariant",
  ]);
  if (!allowed.has(value)) throw new Error(`SERVERLESS_OPS_OPERATION_INVALID:${value}`);
  return value;
}

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`SERVERLESS_OPS_SECRET_MISSING:${label}`);
}

function requireSupabaseAdmin(): void {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);
}

function requireBrevo(): void {
  requireAny("BREVO_API_KEY", ["BREVO_API_KEY"]);
}

async function jsonGet(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "Cache-Control": "no-store" } });
  if (!response.ok) throw new Error(`SERVERLESS_HEALTH_HTTP_${response.status}:${url}`);
  return response.json();
}

async function serverlessHealth() {
  const [root, catalog, deployMeta, runtime, publicApi, telegram] = await Promise.all([
    fetch(`${STOREFRONT_URL}/`, { signal: AbortSignal.timeout(20_000) }),
    jsonGet(`${STOREFRONT_URL}/data/products.json?t=${Date.now()}`),
    jsonGet(`${STOREFRONT_URL}/deploy-meta.json?t=${Date.now()}`),
    jsonGet(`${FUNCTIONS_BASE}/cerberus-runtime-api/health`),
    jsonGet(`${FUNCTIONS_BASE}/cerberus-public-api/health`),
    jsonGet(`${FUNCTIONS_BASE}/cerberus-telegram-gateway/health`),
  ]);
  if (!root.ok) throw new Error(`STOREFRONT_HTTP_${root.status}`);
  if (!Array.isArray(catalog) || catalog.length !== 30) throw new Error(`STOREFRONT_CATALOG_COUNT:${Array.isArray(catalog) ? catalog.length : "invalid"}`);
  if (deployMeta?.platform !== "cloudflare-pages") throw new Error("STOREFRONT_PLATFORM_INVALID");
  if (runtime?.status !== "ok" || runtime?.runtime !== "supabase-edge") throw new Error("RUNTIME_EDGE_UNHEALTHY");
  if (publicApi?.status !== "ok" || publicApi?.runtime !== "supabase-edge") throw new Error("PUBLIC_EDGE_UNHEALTHY");
  if (telegram?.status !== "ok" || telegram?.runtime !== "supabase-edge" || telegram?.renderDependency !== false) throw new Error("TELEGRAM_EDGE_UNHEALTHY");
  return {
    ok: true,
    runtime: "github-actions-direct",
    renderDependency: false,
    storefront: STOREFRONT_URL,
    products: catalog.length,
    deployedSha: String(deployMeta?.sha || ""),
    edges: [runtime?.service, publicApi?.service, telegram?.service],
  };
}

async function weeklyPreflight() {
  requireSupabaseAdmin();
  const result = await runWeeklyProductionPreflight();
  const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (chatId && present("TELEGRAM_BOT_TOKEN")) {
    const delivery = await sendTelegramMessage(chatId, renderWeeklyPreflightTelegram(result));
    if (!delivery.ok) throw new Error("WEEKLY_PREFLIGHT_TELEGRAM_FAILED");
  }
  return { ready: result.ready, result };
}

async function weeklyDraft() {
  requireSupabaseAdmin();
  requireAny("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
  requireAny("TELEGRAM_ADMIN_CHAT_ID", ["TELEGRAM_ADMIN_CHAT_ID"]);
  const enabled = await isWeeklyProductionEnabled();
  if (!enabled) return { status: "skipped", reason: "disabled" };
  return runWeeklyDraftCycle({ env: { ...process.env, NEWSLETTER_WEEKLY_ENABLED: "true" } });
}

async function audienceStatus() {
  requireSupabaseAdmin();
  const config = await readWeeklyProductionRuntimeConfig();
  return {
    enabled: config?.weeklyEnabled === true,
    listConfigured: Boolean(config?.brevoListId),
    syncStatus: config?.lastSyncStatus || "never",
    syncVerified: Boolean(config?.contactSyncVerifiedAt),
    eligibleSubscribers: config?.eligibleSubscribersCount || 0,
    brevoMembers: config?.brevoMembersCount || 0,
    lastSyncAt: config?.lastSyncAt || null,
  };
}

async function audienceSync() {
  requireSupabaseAdmin();
  requireBrevo();
  const result = await syncWeeklyBrevoProductionAudience();
  if (result.eligibleSubscribers < 0 || result.brevoMembers < 0) throw new Error("WEEKLY_AUDIENCE_SYNC_INVALID_COUNT");
  return result;
}

async function audienceReconcile() {
  requireSupabaseAdmin();
  requireBrevo();
  const result = await reconcileWeeklyBrevoCampaignStatuses();
  if (result.errors > 0) throw new Error(`WEEKLY_PROVIDER_STATUS_RECONCILE_ERRORS:${result.errors}`);
  return result;
}

async function newsletterOutboxOnce() {
  requireSupabaseAdmin();
  requireBrevo();
  const config = getNewsletterProviderConfigStatus();
  if (!config.configured) throw new Error("NEWSLETTER_PROVIDER_NOT_CONFIGURED");
  const provider = createConfiguredNewsletterProvider();
  const worker = createNewsletterOutboxWorker(provider, {
    logger: (event, fields) => console.info(`[SERVERLESS-OUTBOX] ${event} ${JSON.stringify(fields)}`),
  });
  return worker.processOnce();
}

async function operatorHealth() {
  requireSupabaseAdmin();
  const report = await runSystemHealthCheck();
  return { report, runtime: "github-actions-direct", renderDependency: false };
}

async function curatorInvariant() {
  requireSupabaseAdmin();
  const result = await readAutonomousCuratorInvariant();
  return { result, runtime: "github-actions-direct", renderDependency: false };
}

async function main(): Promise<void> {
  const operation = operationFromArg();
  let result: unknown;
  switch (operation) {
    case "serverless-health": result = await serverlessHealth(); break;
    case "weekly-preflight": result = await weeklyPreflight(); break;
    case "weekly-draft": result = await weeklyDraft(); break;
    case "weekly-stale": requireSupabaseAdmin(); result = { notified: await runWeeklyStaleDraftCheck() }; break;
    case "audience-status": result = await audienceStatus(); break;
    case "audience-sync": result = await audienceSync(); break;
    case "audience-reconcile": result = await audienceReconcile(); break;
    case "newsletter-outbox-once": result = await newsletterOutboxOnce(); break;
    case "operator-health": result = await operatorHealth(); break;
    case "curator-invariant": result = await curatorInvariant(); break;
  }
  console.log(JSON.stringify({ ok: true, operation, result }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "SERVERLESS_OPS_DIRECT_FAILED";
  console.error(message);
  process.exitCode = 1;
});
