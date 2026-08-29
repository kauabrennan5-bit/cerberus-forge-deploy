import { requireSupabase } from "../repositories/productsRepository";
import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";
import { createConfiguredWeeklyBrevoMarketingProvider } from "./newsletterWeeklyBrevoProvider";

export type WeeklyRuntimePreflight = {
  weeklyEnabledRawState: "true" | "other_or_missing";
  weeklyProductionEnabled: boolean;
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
    .select("id", { count: "exact", head: true })
    .eq("status", "subscribed")
    .eq("marketing_consent", true);
  if (error) throw error;
  return Number(count || 0);
}

export async function evaluateWeeklyRuntimePreflight(
  deps: WeeklyRuntimePreflightDeps = {},
): Promise<WeeklyRuntimePreflight> {
  const env = deps.env || process.env;
  const weeklyProductionEnabled = env.NEWSLETTER_WEEKLY_ENABLED === "true";
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

  return {
    weeklyEnabledRawState: weeklyProductionEnabled ? "true" : "other_or_missing",
    weeklyProductionEnabled,
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
