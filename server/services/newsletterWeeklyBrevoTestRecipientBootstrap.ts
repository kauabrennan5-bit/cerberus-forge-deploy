import {
  createSupabaseNewsletterCampaignStore,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";
import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";
import {
  ensureWeeklyBrevoTestRecipient,
  WeeklyBrevoTestRecipientSetupError,
  type WeeklyBrevoTestRecipientSetupResult,
} from "./newsletterWeeklyBrevoTestRecipient";

export type WeeklyBrevoTestRecipientBootstrapStatus = {
  state: "not_started" | "running" | "skipped" | "ready" | "failed";
  reason?: "production_enabled" | "config_missing" | "no_pending_weekly_test";
  attemptedAt?: string;
  associated?: boolean;
  blacklisted?: boolean;
  contactCreated?: boolean;
  listCreated?: boolean;
  code?: string;
};

export type WeeklyBrevoTestRecipientBootstrapOptions = {
  env?: NodeJS.ProcessEnv;
  store?: NewsletterCampaignStore;
  now?: Date;
  ensureRecipient?: () => Promise<WeeklyBrevoTestRecipientSetupResult>;
};

let bootstrapStatus: WeeklyBrevoTestRecipientBootstrapStatus = { state: "not_started" };
let bootstrapInFlight: Promise<WeeklyBrevoTestRecipientBootstrapStatus> | null = null;

export function getWeeklyBrevoTestRecipientBootstrapStatus(): WeeklyBrevoTestRecipientBootstrapStatus {
  return { ...bootstrapStatus };
}

/**
 * Bootstrap de produção estritamente limitado ao destinatário de teste.
 * Só roda quando existe uma weekly-test aprovada, com referência Brevo já
 * persistida e contadores de recipients reais em zero. Nunca chama sendTest,
 * sendNow, createCampaign ou qualquer fluxo de subscribers do Cerberus.
 */
export async function bootstrapPendingWeeklyBrevoTestRecipient(
  options: WeeklyBrevoTestRecipientBootstrapOptions = {},
): Promise<WeeklyBrevoTestRecipientBootstrapStatus> {
  if (bootstrapInFlight) return bootstrapInFlight;

  bootstrapInFlight = runBootstrap(options).finally(() => {
    bootstrapInFlight = null;
  });
  return bootstrapInFlight;
}

async function runBootstrap(
  options: WeeklyBrevoTestRecipientBootstrapOptions,
): Promise<WeeklyBrevoTestRecipientBootstrapStatus> {
  const env = options.env || process.env;
  const attemptedAt = (options.now || new Date()).toISOString();

  if (env.NEWSLETTER_WEEKLY_ENABLED === "true") {
    return setStatus({ state: "skipped", reason: "production_enabled", attemptedAt });
  }

  const apiKey = (env.BREVO_API_KEY || "").trim();
  const testEmail = normalizeNewsletterEmail(env.NEWSLETTER_TEST_EMAIL);
  if (!apiKey || !testEmail || !isValidNewsletterEmail(testEmail)) {
    return setStatus({ state: "skipped", reason: "config_missing", attemptedAt });
  }

  bootstrapStatus = { state: "running", attemptedAt };

  try {
    const store = options.store || createSupabaseNewsletterCampaignStore();
    const recent = await store.listRecentCampaigns(20);
    const candidate = recent.find(campaign =>
      campaign.status === "approved"
      && campaign.campaignType === "collection"
      && Boolean(campaign.editionKey?.startsWith("weekly-test:"))
      && Boolean(campaign.testProviderMessageId?.trim())
      && !campaign.testSentAt
      && campaign.counts.total === 0
      && campaign.counts.success === 0
      && campaign.counts.failed === 0
      && campaign.counts.skipped === 0,
    );

    if (!candidate) {
      return setStatus({ state: "skipped", reason: "no_pending_weekly_test", attemptedAt });
    }

    const ensureRecipient = options.ensureRecipient
      || (() => ensureWeeklyBrevoTestRecipient({ env }));
    const result = await ensureRecipient();
    return setStatus({
      state: "ready",
      attemptedAt,
      associated: result.associated,
      blacklisted: result.blacklisted,
      contactCreated: result.contactCreated,
      listCreated: result.listCreated,
    });
  } catch (error) {
    const code = error instanceof WeeklyBrevoTestRecipientSetupError
      ? error.code
      : "WEEKLY_TEST_RECIPIENT_BOOTSTRAP_FAILED";
    return setStatus({ state: "failed", attemptedAt, code });
  }
}

function setStatus(status: WeeklyBrevoTestRecipientBootstrapStatus): WeeklyBrevoTestRecipientBootstrapStatus {
  bootstrapStatus = { ...status };
  return { ...bootstrapStatus };
}
