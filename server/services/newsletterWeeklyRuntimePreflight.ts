import { requireSupabase } from "../repositories/productsRepository";
import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";
import { createConfiguredWeeklyBrevoMarketingProvider } from "./newsletterWeeklyBrevoProvider";
import { readWeeklyProductionRuntimeConfig, type WeeklyProductionRuntimeConfig } from "./newsletterWeeklyProductionConfig";

export type WeeklyRuntimePreflight = {
  weeklyEnabledRawState: "true" | "other_or_missing";
  weeklyProductionEnabled: boolean;
  productionListConfigured: boolean;
  productionSyncVerified: boolean;
  productionAudienceReady: boolean;
  productionBrevoMembers: number | null;
  testEmailConfigured: boolean;
  testEmailValid: boolean;
  testEmailMasked: string | null;
  brevoApiKeyPresent: boolean;
  brevoMarketingProviderReady: boolean;
  eligibleSubscribers: number | null;
  readyForTest: boolean;
};

export type WeeklyRuntimePreflightDeps = {
  env?: NodeJS.ProcessEnv;
  countEligibleSubscribers?: () => Promise<number>;
  productionConfigLoader?: () => Promise<WeeklyProductionRuntimeConfig | null>;
};

export function parseSingleTestEmail(raw: unknown): {
  configured: boolean;
  valid: boolean;
  normalized: string;
  masked: string | null;
} {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { configured: false, valid: false, normalized: "", masked: null };
  if (/[;,\s]/.test(value)) return { configured: true, valid: false, normalized: "", masked: null };
  const normalized = normalizeNewsletterEmail(value);
  if (!normalized || !isValidNewsletterEmail(normalized)) {
    return { configured: true, valid: false, normalized: "", masked: null };
  }
  return { configured: true, valid: true, normalized, masked: maskEmail(normalized) };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function countEligibleNewsletterSubscribers(): Promise<number> {
  const client = requireSupabase();
  const { count, error } = await client
    .from("newsletter_subscribers")
    .select("email", { count: "exact", head: true })
    .eq("status", "subscribed")
    .eq("marketing_consent", true);
  if (error) throw error;
  return Number(count || 0);
}

export async function evaluateWeeklyRuntimePreflight(
  deps: WeeklyRuntimePreflightDeps = {},
): Promise<WeeklyRuntimePreflight> {
  const env = deps.env || process.env;
  const explicitTestEnv = Boolean(deps.env);
  const testEmail = parseSingleTestEmail(env.NEWSLETTER_TEST_EMAIL);
  const brevoApiKeyPresent = Boolean((env.BREVO_API_KEY || "").trim());

  let brevoMarketingProviderReady = false;
  try {
    createConfiguredWeeklyBrevoMarketingProvider(env);
    brevoMarketingProviderReady = true;
  } catch {
    brevoMarketingProviderReady = false;
  }

  let eligibleSubscribers: number | null = null;
  try {
    eligibleSubscribers = await (deps.countEligibleSubscribers || countEligibleNewsletterSubscribers)();
  } catch {
    eligibleSubscribers = null;
  }

  let productionConfig: WeeklyProductionRuntimeConfig | null = null;
  if (!explicitTestEnv || deps.productionConfigLoader) {
    try {
      productionConfig = await (deps.productionConfigLoader || readWeeklyProductionRuntimeConfig)();
    } catch {
      productionConfig = null;
    }
  }

  const weeklyProductionEnabled = productionConfig
    ? productionConfig.weeklyEnabled
    : env.NEWSLETTER_WEEKLY_ENABLED === "true";
  const productionListConfigured = productionConfig
    ? Boolean(productionConfig.brevoListId)
    : Boolean(Number.parseInt(env.BREVO_NEWSLETTER_LIST_ID || "", 10));
  const productionSyncVerified = productionConfig
    ? productionConfig.lastSyncStatus === "ready" && Boolean(productionConfig.contactSyncVerifiedAt)
    : env.BREVO_NEWSLETTER_CONTACT_SYNC_VERIFIED === "true";
  const productionBrevoMembers = productionConfig ? productionConfig.brevoMembersCount : null;
  const productionAudienceReady = Boolean(
    weeklyProductionEnabled
    && productionListConfigured
    && productionSyncVerified
    && eligibleSubscribers !== null
    && eligibleSubscribers > 0
    && productionConfig
    && productionConfig.eligibleSubscribersCount === eligibleSubscribers
    && productionConfig.brevoMembersCount === eligibleSubscribers,
  );

  return {
    weeklyEnabledRawState: weeklyProductionEnabled ? "true" : "other_or_missing",
    weeklyProductionEnabled,
    productionListConfigured,
    productionSyncVerified,
    productionAudienceReady,
    productionBrevoMembers,
    testEmailConfigured: testEmail.configured,
    testEmailValid: testEmail.valid,
    testEmailMasked: testEmail.masked,
    brevoApiKeyPresent,
    brevoMarketingProviderReady,
    eligibleSubscribers,
    readyForTest:
      !weeklyProductionEnabled &&
      testEmail.configured &&
      testEmail.valid &&
      brevoMarketingProviderReady,
  };
}
