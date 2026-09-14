import "dotenv/config";
import {
  syncWeeklyBrevoProductionAudience,
  WeeklyBrevoAudienceSyncError,
} from "../server/services/newsletterWeeklyBrevoAudienceSync";
import { reconcileWeeklyBrevoCampaignStatuses } from "../server/services/newsletterWeeklyBrevoStatusReconcile";
import {
  enableWeeklyProductionAfterVerifiedSync,
  readWeeklyProductionRuntimeConfig,
} from "../server/services/newsletterWeeklyProductionConfig";

type Operation = "status" | "reconcile" | "sync" | "bootstrap";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`WEEKLY_AUDIENCE_DIRECT_SECRET_MISSING:${label}`);
}

function operation(): Operation {
  const raw = String(process.env.WEEKLY_AUDIENCE_OPERATION || "status").trim();
  if (["status", "reconcile", "sync", "bootstrap"].includes(raw)) return raw as Operation;
  throw new Error(`WEEKLY_AUDIENCE_DIRECT_OPERATION_UNSUPPORTED:${raw}`);
}

function safeDiagnostic(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/[^a-zA-Z0-9_ .,:;()\-\/]/g, "?").trim().slice(0, max);
}

function describeFailure(error: unknown): string {
  if (error instanceof WeeklyBrevoAudienceSyncError) {
    return `WEEKLY_AUDIENCE_DIRECT_FAILED:${safeDiagnostic(error.code, 100)}`;
  }
  if (error instanceof Error) {
    const message = safeDiagnostic(error.message);
    return message ? `WEEKLY_AUDIENCE_DIRECT_FAILED:${message}` : "WEEKLY_AUDIENCE_DIRECT_FAILED";
  }
  if (error && typeof error === "object") {
    const raw = error as Record<string, unknown>;
    const code = safeDiagnostic(raw.code, 100);
    const message = safeDiagnostic(raw.message);
    if (code || message) return ["WEEKLY_AUDIENCE_DIRECT_FAILED", code, message].filter(Boolean).join(":");
  }
  return "WEEKLY_AUDIENCE_DIRECT_FAILED";
}

function statusSnapshot(config: Awaited<ReturnType<typeof readWeeklyProductionRuntimeConfig>>) {
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

async function main(): Promise<void> {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);

  const op = operation();
  if (op !== "status") requireAny("BREVO_API_KEY", ["BREVO_API_KEY"]);

  let result: unknown;
  let providerAudienceMutations = 0;
  let localConsentReconciliations = 0;
  let productionEnableChanges = 0;
  let localCampaignFinalizations = 0;

  if (op === "status") {
    result = statusSnapshot(await readWeeklyProductionRuntimeConfig());
  } else if (op === "reconcile") {
    const reconcile = await reconcileWeeklyBrevoCampaignStatuses();
    if (reconcile.errors !== 0) throw new Error("WEEKLY_PROVIDER_STATUS_RECONCILE_FAILED");
    localCampaignFinalizations = reconcile.finalized;
    result = reconcile;
  } else if (op === "sync") {
    if (process.env.WEEKLY_ALLOW_PROVIDER_MUTATIONS !== "true") {
      throw new Error("WEEKLY_AUDIENCE_PROVIDER_MUTATIONS_NOT_AUTHORIZED");
    }
    const sync = await syncWeeklyBrevoProductionAudience();
    providerAudienceMutations = sync.contactsCreated + sync.contactsAssociated + sync.contactsRemoved + (sync.listCreated ? 1 : 0);
    localConsentReconciliations = sync.locallyUnsubscribedFromBrevo + sync.locallySuppressedFromBrevo;
    result = sync;
  } else {
    if (process.env.WEEKLY_ALLOW_PROVIDER_MUTATIONS !== "true") {
      throw new Error("WEEKLY_AUDIENCE_PROVIDER_MUTATIONS_NOT_AUTHORIZED");
    }
    if (process.env.WEEKLY_ALLOW_PRODUCTION_BOOTSTRAP !== "true") {
      throw new Error("WEEKLY_PRODUCTION_BOOTSTRAP_NOT_AUTHORIZED");
    }
    const sync = await syncWeeklyBrevoProductionAudience();
    providerAudienceMutations = sync.contactsCreated + sync.contactsAssociated + sync.contactsRemoved + (sync.listCreated ? 1 : 0);
    localConsentReconciliations = sync.locallyUnsubscribedFromBrevo + sync.locallySuppressedFromBrevo;
    if (sync.eligibleSubscribers <= 0 || sync.eligibleSubscribers !== sync.brevoMembers) {
      throw new Error("WEEKLY_PRODUCTION_AUDIENCE_NOT_READY");
    }
    const config = await enableWeeklyProductionAfterVerifiedSync();
    productionEnableChanges = config.weeklyEnabled ? 1 : 0;
    result = { sync, production: statusSnapshot(config) };
  }

  const proof = {
    runtime: "github-actions-direct",
    mode: "weekly-production-audience-direct",
    operation: op,
    renderDependency: false,
    newsletterSends: 0,
    sendNowCalls: 0,
    providerCampaignCreates: 0,
    providerAudienceMutations,
    localConsentReconciliations,
    productionEnableChanges,
    localCampaignFinalizations,
    result,
  };

  if (proof.newsletterSends !== 0 || proof.sendNowCalls !== 0 || proof.providerCampaignCreates !== 0) {
    throw new Error("WEEKLY_AUDIENCE_DIRECT_SAFETY_CONTRACT_VIOLATED");
  }
  if ((op === "status" || op === "reconcile") && (providerAudienceMutations !== 0 || localConsentReconciliations !== 0 || productionEnableChanges !== 0)) {
    throw new Error("WEEKLY_AUDIENCE_READ_ONLY_CONTRACT_VIOLATED");
  }

  console.log(JSON.stringify(proof));
}

main().catch((error) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
