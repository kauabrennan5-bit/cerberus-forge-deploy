import type { NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { normalizeNewsletterEmail, isValidNewsletterEmail } from "./newsletterConsent";
import { transitionCampaign, type EmailCampaign } from "./newsletterCampaignState";
import type { NewsletterProviderResult } from "./newsletterProvider";
import {
  createConfiguredWeeklyBrevoMarketingProvider,
  type WeeklyBrevoMarketingProvider,
} from "./newsletterWeeklyBrevoProvider";

const weeklyDeliveryLocks = new Map<string, Promise<void>>();

export type WeeklyMarketingDeliveryOptions = {
  store: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  provider?: WeeklyBrevoMarketingProvider;
};

export async function sendWeeklyMarketingTest(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: WeeklyMarketingDeliveryOptions,
): Promise<{ campaign: EmailCampaign; providerResult: NewsletterProviderResult }> {
  return withWeeklyDeliveryLock(campaign.id, async () => {
    const env = options.env || process.env;
    const current = await requireCampaign(options.store, campaign.id);
    if (!current.editionKey?.startsWith("weekly-test:")) {
      throw new Error("WEEKLY_MARKETING_TEST_CAMPAIGN_REQUIRED");
    }
    if (current.status === "test_sent" && current.testProviderMessageId?.trim()) {
      throw new Error("CAMPAIGN_TEST_ALREADY_SENT");
    }
    if (current.status !== "approved") throw new Error("CAMPAIGN_TEST_REQUIRES_APPROVAL");

    const testEmail = normalizeNewsletterEmail(env.NEWSLETTER_TEST_EMAIL);
    if (!testEmail || !isValidNewsletterEmail(testEmail)) {
      throw new Error("NEWSLETTER_TEST_EMAIL_MISSING");
    }

    const provider = options.provider || createConfiguredWeeklyBrevoMarketingProvider(env);
    let working = current;
    let brevoCampaignId = current.testProviderMessageId?.trim() || "";
    if (!brevoCampaignId) {
      const created = await provider.createCampaign({
        campaignId: current.id,
        name: buildBrevoCampaignName(current),
        subject: current.subject,
        htmlContent: current.bodyHtml,
      });
      brevoCampaignId = created.brevoCampaignId;
      working = await options.store.updateCampaign({
        ...current,
        testProviderMessageId: brevoCampaignId,
      });
    }

    const sent = await provider.sendTest(brevoCampaignId, [testEmail]);
    const tested = transitionCampaign(
      working,
      {
        type: "record_test_sent",
        actorTelegramId,
        providerReference: brevoCampaignId,
      },
      options.now || new Date(),
    );
    return {
      campaign: await options.store.updateCampaign(tested),
      providerResult: {
        status: sent.status,
        providerReference: brevoCampaignId,
      },
    };
  });
}

export async function sendWeeklyMarketingNow(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: WeeklyMarketingDeliveryOptions,
): Promise<EmailCampaign> {
  return withWeeklyDeliveryLock(campaign.id, async () => {
    const env = options.env || process.env;
    const now = options.now || new Date();
    const current = await requireCampaign(options.store, campaign.id);
    if (!current.editionKey?.startsWith("weekly:")) {
      throw new Error("WEEKLY_MARKETING_PRODUCTION_CAMPAIGN_REQUIRED");
    }
    if (current.status !== "approved") throw new Error("WEEKLY_MARKETING_PRODUCTION_APPROVAL_REQUIRED");
    if (!current.generalSendConfirmedAt || !current.generalSendConfirmedByTelegramId) {
      throw new Error("GENERAL_SEND_CONFIRMATION_REQUIRED");
    }
    assertWeeklyApprovalFresh(current, env, now);
    if (env.NEWSLETTER_WEEKLY_ENABLED !== "true") {
      throw new Error("WEEKLY_MARKETING_PRODUCTION_DISABLED");
    }

    const listId = parsePositiveInteger(env.BREVO_NEWSLETTER_LIST_ID);
    if (!listId || env.BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED !== "true") {
      throw new Error("WEEKLY_MARKETING_PRODUCTION_RECIPIENT_STRATEGY_UNVERIFIED");
    }

    const provider = options.provider || createConfiguredWeeklyBrevoMarketingProvider(env);
    let working = current;
    let brevoCampaignId = current.testProviderMessageId?.trim() || "";
    if (!brevoCampaignId) {
      const created = await provider.createCampaign({
        campaignId: current.id,
        name: buildBrevoCampaignName(current),
        subject: current.subject,
        htmlContent: current.bodyHtml,
        listIds: [listId],
      });
      brevoCampaignId = created.brevoCampaignId;
      working = await options.store.updateCampaign({
        ...current,
        testProviderMessageId: brevoCampaignId,
      });
    }

    await provider.sendNow(brevoCampaignId);
    const sending = transitionCampaign(
      working,
      { type: "begin_sending", actorTelegramId },
      now,
    );
    return options.store.updateCampaign(sending);
  });
}

function assertWeeklyApprovalFresh(campaign: EmailCampaign, env: NodeJS.ProcessEnv, now: Date): void {
  const sourceTimestamp = campaign.approvedAt || campaign.createdAt;
  const sourceMs = Date.parse(sourceTimestamp || "");
  if (!Number.isFinite(sourceMs)) {
    throw new Error("WEEKLY_MARKETING_PRODUCTION_APPROVAL_TIMESTAMP_INVALID");
  }
  const configured = Number.parseInt(env.NEWSLETTER_WEEKLY_APPROVAL_TTL_HOURS || "24", 10);
  const ttlHours = Number.isSafeInteger(configured) ? Math.max(1, Math.min(168, configured)) : 24;
  if (now.getTime() - sourceMs >= ttlHours * 60 * 60 * 1000) {
    throw new Error("WEEKLY_MARKETING_PRODUCTION_STALE");
  }
}

function buildBrevoCampaignName(campaign: EmailCampaign): string {
  const edition = campaign.editionKey?.trim() || "weekly";
  return `Cerberus ${edition} ${campaign.id}`.slice(0, 255);
}

async function requireCampaign(store: NewsletterCampaignStore, campaignId: string): Promise<EmailCampaign> {
  const current = await store.getCampaign(campaignId);
  if (!current) throw new Error("CAMPAIGN_NOT_FOUND");
  return current;
}

async function withWeeklyDeliveryLock<T>(campaignId: string, operation: () => Promise<T>): Promise<T> {
  const previous = weeklyDeliveryLocks.get(campaignId) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  weeklyDeliveryLocks.set(campaignId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (weeklyDeliveryLocks.get(campaignId) === tail) weeklyDeliveryLocks.delete(campaignId);
  }
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
