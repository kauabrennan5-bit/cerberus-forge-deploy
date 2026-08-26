import {
  createSupabaseNewsletterCampaignStore,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";
import {
  createConfiguredNewsletterProvider,
  getNewsletterProviderConfigStatus,
  type NewsletterCampaignProvider,
} from "./newsletterProvider";
import {
  createDryRunCampaignProvider,
  getNewsletterCampaignWorkerConfig,
  processNewsletterCampaignOnce,
} from "./newsletterCampaignWorker";

export type CampaignSchedulerHandle = {
  enabled: boolean;
  stop: () => void;
  tick: () => Promise<void>;
};

export function startNewsletterCampaignWorker(env: NodeJS.ProcessEnv = process.env): CampaignSchedulerHandle {
  const enabled = env.NEWSLETTER_CAMPAIGN_WORKER_ENABLED === "true";
  if (!enabled) return { enabled: false, stop: () => undefined, tick: async () => undefined };

  const config = getNewsletterCampaignWorkerConfig(env);
  let store: NewsletterCampaignStore;
  let provider: NewsletterCampaignProvider;
  try {
    store = createSupabaseNewsletterCampaignStore();
    if (config.dryRun) {
      provider = createDryRunCampaignProvider();
    } else {
      const status = getNewsletterProviderConfigStatus(env);
      if (!status.configured) throw new Error("CAMPAIGN_PROVIDER_NOT_CONFIGURED");
      provider = createConfiguredNewsletterProvider(env);
    }
  } catch (error) {
    console.error(`[NEWSLETTER-CAMPAIGN] worker.blocked reason=${sanitizeReason(error)}`);
    return { enabled: false, stop: () => undefined, tick: async () => undefined };
  }

  const intervalMs = parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_POLL_INTERVAL_MS, 30_000, 1_000, 86_400_000);
  let inFlight = false;
  let stopped = false;
  const reportedTerminalStates = new Set<string>();

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const campaigns = await store.listSendingCampaigns(Math.max(1, config.batchSize));
      for (const campaign of campaigns) {
        const result = await processNewsletterCampaignOnce(store, campaign.id, {
          provider,
          dryRun: config.dryRun,
          batchSize: config.batchSize,
          delayMs: config.delayMs,
          leaseMs: config.leaseMs,
          maxAttempts: config.maxAttempts,
          publicBaseUrl: config.publicBaseUrl,
        });
        console.info(`[NEWSLETTER-CAMPAIGN] campaign.tick campaign_id=${campaign.id} outcome=${result.outcome} processed=${result.processed} provider_called=${result.providerCalled}`);
        await maybeSendCampaignReport(result.campaign, env, reportedTerminalStates);
      }
    } catch (error) {
      console.error(`[NEWSLETTER-CAMPAIGN] worker.tick_failed reason=${sanitizeReason(error)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  console.info(`[NEWSLETTER-CAMPAIGN] worker.on pollIntervalMs=${intervalMs} dryRun=${config.dryRun}`);

  return {
    enabled: true,
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function maybeSendCampaignReport(
  campaign: Awaited<ReturnType<NewsletterCampaignStore["getCampaign"]>>,
  env: NodeJS.ProcessEnv,
  reportedTerminalStates: Set<string>,
): Promise<void> {
  if (!campaign || !["sent", "failed"].includes(campaign.status)) return;
  const reportKey = `${campaign.id}:${campaign.status}:${campaign.counts.success}:${campaign.counts.failed}:${campaign.counts.skipped}`;
  if (reportedTerminalStates.has(reportKey)) return;
  reportedTerminalStates.add(reportKey);
  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (!chatId) return;
  try {
    const { sendTelegramMessage } = await import("./telegramBot");
    const { campaignCompletionKeyboard, renderCampaignCompletionReport } = await import("./newsletterCampaignTelegram");
    await sendTelegramMessage(chatId, renderCampaignCompletionReport(campaign), { inline_keyboard: campaignCompletionKeyboard(campaign) });
  } catch (error) {
    console.error(`[NEWSLETTER-CAMPAIGN] report_failed campaign_id=${campaign.id} reason=${sanitizeReason(error)}`);
  }
}

function sanitizeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) || "unknown";
}
