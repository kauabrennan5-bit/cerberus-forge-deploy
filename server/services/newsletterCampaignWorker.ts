import { createHash } from "node:crypto";
import type { EmailCampaign, CampaignCounts } from "./newsletterCampaignState";
import { UNSUBSCRIBE_URL_PLACEHOLDER } from "./newsletterCampaignTemplate";
import type {
  EmailCampaignRecipient,
  NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";
import type {
  NewsletterCampaignProvider,
  NewsletterCampaignProviderInput,
  NewsletterProviderError,
} from "./newsletterProvider";

export type CampaignWorkerOutcome =
  | "idle"
  | "succeeded"
  | "duplicate"
  | "skipped_unsubscribed"
  | "retryable"
  | "failed";

export type CampaignWorkerResult = {
  outcome: CampaignWorkerOutcome;
  providerCalled: boolean;
  campaign: EmailCampaign | null;
  recipient: EmailCampaignRecipient | null;
  processed: number;
};

export type NewsletterCampaignWorkerOptions = {
  provider?: NewsletterCampaignProvider;
  dryRun?: boolean;
  batchSize?: number;
  delayMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  publicBaseUrl?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type NewsletterCampaignWorkerConfig = {
  dryRun: boolean;
  batchSize: number;
  delayMs: number;
  leaseMs: number;
  maxAttempts: number;
  publicBaseUrl: string;
};

export function getNewsletterCampaignWorkerConfig(env: NodeJS.ProcessEnv = process.env): NewsletterCampaignWorkerConfig {
  return {
    dryRun: env.DRY_RUN === "true",
    batchSize: parseBoundedInteger(env.BREVO_BATCH_SIZE, 1, 1, 1000),
    delayMs: parseBoundedInteger(env.BREVO_BATCH_DELAY_MS, 0, 0, 86_400_000),
    leaseMs: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_LEASE_MS, 60_000, 1_000, 600_000),
    maxAttempts: parseBoundedInteger(env.NEWSLETTER_CAMPAIGN_MAX_ATTEMPTS, 3, 1, 10),
    publicBaseUrl: (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim(),
  };
}

export async function processNewsletterCampaignOnce(
  store: NewsletterCampaignStore,
  campaignId: string,
  options: NewsletterCampaignWorkerOptions = {},
): Promise<CampaignWorkerResult> {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) return { outcome: "idle", providerCalled: false, campaign: null, recipient: null, processed: 0 };
  if (campaign.status !== "sending") {
    return { outcome: "idle", providerCalled: false, campaign, recipient: null, processed: 0 };
  }

  const config = getNewsletterCampaignWorkerConfig();
  const dryRun = options.dryRun ?? config.dryRun;
  const batchSize = options.batchSize ?? config.batchSize;
  const delayMs = options.delayMs ?? config.delayMs;
  const leaseMs = options.leaseMs ?? config.leaseMs;
  const maxAttempts = options.maxAttempts ?? config.maxAttempts;
  const publicBaseUrl = options.publicBaseUrl ?? config.publicBaseUrl;
  const now = options.now || (() => new Date());
  const sleep = options.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  if (!dryRun && !options.provider) {
    throw new Error("CAMPAIGN_PROVIDER_REQUIRED");
  }

  let lastOutcome: CampaignWorkerOutcome = "idle";
  let lastRecipient: EmailCampaignRecipient | null = null;
  let providerCalled = false;
  let processed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    const leaseToken = `campaign-lease-${crypto.randomUUID()}`;
    const claimed = await store.claimRecipient(campaignId, leaseToken, leaseMs);
    if (!claimed) break;
    processed += 1;
    lastRecipient = claimed.recipient;

    const subscriber = await store.readSubscriber(claimed.recipient.subscriberEmail);
    if (!subscriber || subscriber.status !== "subscribed" || subscriber.marketing_consent !== true) {
      lastRecipient = await store.markRecipientSkipped(
        claimed.recipient.id,
        claimed.leaseToken,
        "subscriber_not_marketing_eligible",
      );
      lastOutcome = "skipped_unsubscribed";
    } else if (dryRun) {
      lastRecipient = await store.markRecipientSent(
        claimed.recipient.id,
        claimed.leaseToken,
        `dry-run:${claimed.recipient.id}`,
      );
      lastOutcome = "succeeded";
    } else {
      if (!publicBaseUrl) {
        lastRecipient = await store.markRecipientFailed(claimed.recipient.id, claimed.leaseToken, "CAMPAIGN_PUBLIC_BASE_URL_MISSING", new Date(now().getTime() + retryDelayMs(claimed.recipient.attemptCount)).toISOString());
        lastOutcome = "failed";
        continue;
      }
      let unsubscribeUrl: string;
      try {
        const token = await store.prepareUnsubscribeToken(claimed.recipient.subscriberEmail);
        unsubscribeUrl = buildUnsubscribeUrl(publicBaseUrl, token);
      } catch {
        lastRecipient = await store.markRecipientFailed(claimed.recipient.id, claimed.leaseToken, "UNSUBSCRIBE_TOKEN_PREPARATION_FAILED", new Date(now().getTime() + retryDelayMs(claimed.recipient.attemptCount)).toISOString());
        lastOutcome = "failed";
        continue;
      }
      const htmlContent = campaign.bodyHtml.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
      const textContent = campaign.bodyText.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
      const input: NewsletterCampaignProviderInput = {
        campaignId: campaign.id,
        recipientId: claimed.recipient.id,
        subscriberEmail: claimed.recipient.subscriberEmail,
        subject: campaign.subject,
        htmlContent,
        textContent,
        idempotencyKey: campaignRecipientIdempotencyKey(campaign.id, claimed.recipient.id),
      };
      try {
        providerCalled = true;
        const result = await options.provider!.sendCampaign(input);
        lastRecipient = await store.markRecipientSent(
          claimed.recipient.id,
          claimed.leaseToken,
          result.providerReference,
        );
        lastOutcome = result.status === "duplicate" ? "duplicate" : "succeeded";
      } catch (error) {
        const failure = toCampaignFailure(error);
        const nextAttemptAt = new Date(now().getTime() + retryDelayMs(claimed.recipient.attemptCount)).toISOString();
        lastRecipient = await store.markRecipientFailed(
          claimed.recipient.id,
          claimed.leaseToken,
          failure.message,
          nextAttemptAt,
        );
        lastOutcome = failure.retryable && claimed.recipient.attemptCount < maxAttempts ? "retryable" : "failed";
      }
    }

    if (index + 1 < batchSize && delayMs > 0) await sleep(delayMs);
  }

  const counts = await store.summarizeRecipients(campaignId);
  const updatedCampaign = await updateCampaignCounts(store, campaign, counts, now);
  return {
    outcome: lastOutcome,
    providerCalled,
    campaign: updatedCampaign,
    recipient: lastRecipient,
    processed,
  };
}

export function buildUnsubscribeUrl(publicBaseUrl: string, token: string): string {
  const base = publicBaseUrl.trim();
  if (!token.trim()) throw new Error("UNSUBSCRIBE_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("UNSUBSCRIBE_URL_INVALID");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("UNSUBSCRIBE_URL_INVALID");
  parsed.pathname = "/api/newsletter/unsubscribe";
  parsed.search = "";
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

export function campaignRecipientIdempotencyKey(campaignId: string, recipientId: string): string {
  const digest = createHash("sha256").update(`${campaignId}:${recipientId}`, "utf8").digest("hex").slice(0, 32);
  return `campaign-recipient-v1:${digest}`;
}

export function createDryRunCampaignProvider(): NewsletterCampaignProvider {
  return {
    async sendCampaign(input) {
      return {
        status: "succeeded",
        providerReference: `dry-run:${input.recipientId}`,
      };
    },
  };
}

async function updateCampaignCounts(
  store: NewsletterCampaignStore,
  campaign: EmailCampaign,
  counts: CampaignCounts,
  now: () => Date,
): Promise<EmailCampaign> {
  const next = structuredClone(campaign);
  next.counts = counts;
  if (counts.success + counts.failed + counts.skipped === counts.total) {
    if (counts.failed === 0) {
      next.status = "sent";
      next.sentAt = now().toISOString();
    } else {
      next.status = "failed";
      next.sentAt = null;
    }
  }
  return store.updateCampaign(next);
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1000, 1_000 * (2 ** Math.max(0, attemptCount - 1)));
}

function toCampaignFailure(error: unknown): { retryable: boolean; message: string } {
  if (error && typeof error === "object" && error instanceof Error) {
    const providerError = error as NewsletterProviderError;
    return {
      retryable: providerError.kind === "timeout" || providerError.kind === "transient_5xx",
      message: sanitizeFailure(providerError.code || "CAMPAIGN_PROVIDER_ERROR"),
    };
  }
  return { retryable: false, message: "CAMPAIGN_PROVIDER_ERROR" };
}

function sanitizeFailure(value: string): string {
  return value.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) || "CAMPAIGN_PROVIDER_ERROR";
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
