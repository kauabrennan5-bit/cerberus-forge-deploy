import type { NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { normalizeNewsletterEmail, isValidNewsletterEmail } from "./newsletterConsent";
import { transitionCampaign, type EmailCampaign } from "./newsletterCampaignState";
import { NewsletterProviderError, type NewsletterProviderResult } from "./newsletterProvider";
import {
  createConfiguredWeeklyBrevoMarketingProvider,
  getWeeklyBrevoErrorDetails,
  type WeeklyBrevoErrorDetails,
  type WeeklyBrevoMarketingProvider,
} from "./newsletterWeeklyBrevoProvider";
import { ensureWeeklyBrevoTestRecipient } from "./newsletterWeeklyBrevoTestRecipient";

const weeklyDeliveryLocks = new Map<string, Promise<void>>();

export type WeeklyMarketingDeliveryOptions = {
  store: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  provider?: WeeklyBrevoMarketingProvider;
  /**
   * Dependency-injection seam for tests. In the real runtime, when no provider
   * is injected, retryWeeklyMarketingTest prepares only NEWSLETTER_TEST_EMAIL
   * through ensureWeeklyBrevoTestRecipient before the single /sendTest.
   */
  ensureTestRecipient?: () => Promise<unknown>;
};

export type WeeklyMarketingTestSuccess = {
  campaign: EmailCampaign;
  providerResult: NewsletterProviderResult;
  providerCampaignCreated: true;
  providerCampaignCreatedThisAttempt: boolean;
  providerCampaignId: string;
  sendTestSucceeded: true;
};

export class WeeklyMarketingTestSendError extends Error {
  readonly provider = "BREVO" as const;
  readonly operation = "SEND_TEST" as const;
  readonly providerCampaignCreated = true as const;
  readonly sendTestSucceeded = false as const;

  constructor(
    public readonly providerCampaignId: string,
    public readonly providerCampaignCreatedThisAttempt: boolean,
    public readonly safeCode: string,
    public readonly providerError: WeeklyBrevoErrorDetails | null,
    public readonly sendTestResult: "failed" | "unknown",
    internalReason?: string | null,
  ) {
    super(internalReason ? `${safeCode}:${internalReason}` : safeCode);
    this.name = "WeeklyMarketingTestSendError";
  }
}

export function getWeeklyMarketingTestSendError(error: unknown): WeeklyMarketingTestSendError | null {
  return error instanceof WeeklyMarketingTestSendError ? error : null;
}

export async function sendWeeklyMarketingTest(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: WeeklyMarketingDeliveryOptions,
): Promise<WeeklyMarketingTestSuccess> {
  return withWeeklyDeliveryLock(campaign.id, async () => {
    const env = options.env || process.env;
    const current = await requireWeeklyTestCampaign(options.store, campaign.id);
    const testEmail = requireWeeklyTestEmail(env);
    const provider = options.provider || createConfiguredWeeklyBrevoMarketingProvider(env);

    let working = current;
    let brevoCampaignId = current.testProviderMessageId?.trim() || "";
    let providerCampaignCreatedThisAttempt = false;
    if (!brevoCampaignId) {
      const created = await provider.createCampaign({
        campaignId: current.id,
        name: buildBrevoCampaignName(current),
        subject: current.subject,
        htmlContent: current.bodyHtml,
      });
      brevoCampaignId = created.brevoCampaignId;
      providerCampaignCreatedThisAttempt = true;
      working = await options.store.updateCampaign({
        ...current,
        testProviderMessageId: brevoCampaignId,
      });
    }

    return sendWeeklyTestWithExistingProviderCampaign(
      working,
      actorTelegramId,
      brevoCampaignId,
      testEmail,
      providerCampaignCreatedThisAttempt,
      options,
    );
  });
}

/**
 * Retry humano fail-closed. Exige referência Brevo já persistida e nunca possui
 * fallback para createCampaign. No runtime real, prepara idempotentemente apenas
 * NEWSLETTER_TEST_EMAIL e então executa exatamente um /sendTest.
 */
export async function retryWeeklyMarketingTest(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: WeeklyMarketingDeliveryOptions,
): Promise<WeeklyMarketingTestSuccess> {
  return withWeeklyDeliveryLock(campaign.id, async () => {
    const env = options.env || process.env;
    const current = await requireWeeklyTestCampaign(options.store, campaign.id);
    const brevoCampaignId = current.testProviderMessageId?.trim() || "";
    if (!brevoCampaignId) throw new Error("WEEKLY_MARKETING_TEST_PROVIDER_REFERENCE_REQUIRED");
    if (
      current.counts.total !== 0
      || current.counts.success !== 0
      || current.counts.failed !== 0
      || current.counts.skipped !== 0
    ) {
      throw new Error("WEEKLY_MARKETING_TEST_REAL_RECIPIENTS_FORBIDDEN");
    }
    const testEmail = requireWeeklyTestEmail(env);

    // Runtime: self-heal do único destinatário de teste antes de qualquer sendTest.
    // Testes que injetam provider continuam herméticos; podem injetar explicitamente
    // ensureTestRecipient para validar esta etapa sem acessar a Brevo real.
    const ensureTestRecipient = options.ensureTestRecipient
      || (!options.provider ? () => ensureWeeklyBrevoTestRecipient({ env }) : null);
    if (ensureTestRecipient) await ensureTestRecipient();

    const provider = options.provider || createConfiguredWeeklyBrevoMarketingProvider(env);
    return sendWeeklyTestWithExistingProviderCampaign(
      current,
      actorTelegramId,
      brevoCampaignId,
      testEmail,
      false,
      options,
    );
  });
}

async function sendWeeklyTestWithExistingProviderCampaign(
  current: EmailCampaign,
  actorTelegramId: string,
  brevoCampaignId: string,
  testEmail: string,
  providerCampaignCreatedThisAttempt: boolean,
  options: WeeklyMarketingDeliveryOptions,
): Promise<WeeklyMarketingTestSuccess> {
  const provider = options.provider || createConfiguredWeeklyBrevoMarketingProvider(options.env || process.env);
  let sent: Awaited<ReturnType<WeeklyBrevoMarketingProvider["sendTest"]>>;
  try {
    sent = await provider.sendTest(brevoCampaignId, [testEmail]);
  } catch (error) {
    const details = getWeeklyBrevoErrorDetails(error);
    const safeCode = error instanceof NewsletterProviderError
      ? error.code
      : "WEEKLY_BREVO_SENDTEST_FAILED";
    const sendTestResult = details?.sendTestResult === "unknown" ? "unknown" : "failed";
    console.error(
      `[NEWSLETTER-WEEKLY] send_test_failed provider=BREVO operation=SEND_TEST kind=${details?.kind || "unknown"}` +
      ` status=${details?.status ?? "none"} code=${safeCode} result=${sendTestResult}`,
    );
    throw new WeeklyMarketingTestSendError(
      brevoCampaignId,
      providerCampaignCreatedThisAttempt,
      safeCode,
      details,
      sendTestResult,
      sanitizeInternalReason(error),
    );
  }

  const tested = transitionCampaign(
    current,
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
    providerCampaignCreated: true,
    providerCampaignCreatedThisAttempt,
    providerCampaignId: brevoCampaignId,
    sendTestSucceeded: true,
  };
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

async function requireWeeklyTestCampaign(store: NewsletterCampaignStore, campaignId: string): Promise<EmailCampaign> {
  const current = await requireCampaign(store, campaignId);
  if (!current.editionKey?.startsWith("weekly-test:") || current.campaignType !== "collection") {
    throw new Error("WEEKLY_MARKETING_TEST_CAMPAIGN_REQUIRED");
  }
  if (current.status === "test_sent" && current.testProviderMessageId?.trim()) {
    throw new Error("CAMPAIGN_TEST_ALREADY_SENT");
  }
  if (current.status !== "approved") throw new Error("CAMPAIGN_TEST_REQUIRES_APPROVAL");
  return current;
}

function requireWeeklyTestEmail(env: NodeJS.ProcessEnv): string {
  const testEmail = normalizeNewsletterEmail(env.NEWSLETTER_TEST_EMAIL);
  if (!testEmail || !isValidNewsletterEmail(testEmail)) {
    throw new Error("NEWSLETTER_TEST_EMAIL_MISSING");
  }
  return testEmail;
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

function sanitizeInternalReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim();
  return /^[A-Z0-9_:-]{1,80}$/.test(normalized) ? normalized : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
