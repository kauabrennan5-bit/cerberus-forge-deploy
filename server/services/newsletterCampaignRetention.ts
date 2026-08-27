import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfiguredCampaignSupabase } from "../repositories/newsletterCampaignRepository";

const DEFAULT_ARCHIVE_AFTER_DAYS = 7;
const DEFAULT_DELETE_AFTER_DAYS = 30;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 86_400_000;
const MIN_INTERVAL_MS = 3_600_000;
const MAX_INTERVAL_MS = 604_800_000;
const MAX_BATCH_SIZE = 50;

export type NewsletterCampaignRetentionConfig = {
  enabled: boolean;
  archiveAfterDays: number;
  deleteAfterDays: number;
  batchSize: number;
  intervalMs: number;
};

export type NewsletterCampaignRetentionResult = {
  archivedCount: number;
  deletedCount: number;
  skippedRecipientCount: number;
};

export type NewsletterCampaignRetentionSchedulerHandle = {
  enabled: boolean;
  stop: () => void;
  tick: () => Promise<void>;
};

export function getNewsletterCampaignRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): NewsletterCampaignRetentionConfig {
  return {
    // A política fica ativa por padrão após a migration; pode ser desligada
    // explicitamente sem alterar o worker/provider de campanhas.
    enabled: env.NEWSLETTER_CAMPAIGN_RETENTION_ENABLED !== "false",
    archiveAfterDays: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_RETENTION_ARCHIVE_AFTER_DAYS, DEFAULT_ARCHIVE_AFTER_DAYS, 1, 365),
    // Nunca permitir exclusão física antes dos 30 dias aprovados.
    deleteAfterDays: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_RETENTION_DELETE_AFTER_DAYS, DEFAULT_DELETE_AFTER_DAYS, 30, 3650),
    batchSize: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_RETENTION_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    intervalMs: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_RETENTION_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
  };
}

export async function runNewsletterCampaignRetentionOnce(
  client: SupabaseClient,
  config: NewsletterCampaignRetentionConfig = getNewsletterCampaignRetentionConfig(),
): Promise<NewsletterCampaignRetentionResult> {
  const { data, error } = await client.rpc("cleanup_expired_newsletter_test_campaigns", {
    p_archive_after_days: config.archiveAfterDays,
    p_delete_after_days: config.deleteAfterDays,
    p_batch_size: config.batchSize,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    archivedCount: numberValue(row?.archived_count),
    deletedCount: numberValue(row?.deleted_count),
    skippedRecipientCount: numberValue(row?.skipped_recipient_count),
  };
}

export function startNewsletterCampaignRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): NewsletterCampaignRetentionSchedulerHandle {
  const config = getNewsletterCampaignRetentionConfig(env);
  if (!config.enabled) {
    console.info("[NEWSLETTER-RETENTION] scheduler.off NEWSLETTER_CAMPAIGN_RETENTION_ENABLED=false");
    return { enabled: false, stop: () => undefined, tick: async () => undefined };
  }

  const client = getConfiguredCampaignSupabase();
  if (!client) {
    console.warn("[NEWSLETTER-RETENTION] scheduler.blocked Supabase não configurado; nenhuma campanha foi alterada.");
    return { enabled: false, stop: () => undefined, tick: async () => undefined };
  }

  let stopped = false;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await runNewsletterCampaignRetentionOnce(client, config);
      console.info(
        `[NEWSLETTER-RETENTION] tick archived=${result.archivedCount} deleted=${result.deletedCount} skipped_recipient=${result.skippedRecipientCount}`,
      );
    } catch (error) {
      console.error(`[NEWSLETTER-RETENTION] tick_failed reason=${sanitizeError(error)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, config.intervalMs);
  void tick();
  console.info(
    `[NEWSLETTER-RETENTION] scheduler.on intervalMs=${config.intervalMs} archiveAfterDays=${config.archiveAfterDays} deleteAfterDays=${config.deleteAfterDays} batchSize=${config.batchSize}`,
  );

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

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) || "unknown";
}
