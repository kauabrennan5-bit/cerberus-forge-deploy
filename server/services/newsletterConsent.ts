import { createHash, randomBytes } from "node:crypto";

export const NEWSLETTER_CONSENT_SOURCE = "site_newsletter_form" as const;
export const NEWSLETTER_CONSENT_PURPOSE = "new_selections_recommendations_promotional_offers" as const;
export const NEWSLETTER_CONSENT_POLICY_VERSION = "newsletter-consent-v1" as const;
export const LEGACY_SUPPRESSION_REASON = "legacy_without_structured_consent" as const;
export const NEWSLETTER_UNSUBSCRIBE_SOURCE = "newsletter_unsubscribe_link" as const;
export const NEWSLETTER_UNSUBSCRIBE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const NEWSLETTER_STATUSES = ["subscribed", "unsubscribed", "suppressed"] as const;
export type NewsletterStatus = (typeof NEWSLETTER_STATUSES)[number];

export type NewsletterSubscriptionRecord = {
  email: string;
  status: NewsletterStatus;
  marketing_consent: boolean;
  consent_at: string | null;
  consent_source: string | null;
  consent_purpose: string | null;
  consent_policy_version: string | null;
  unsubscribe_at: string | null;
  unsubscribe_source: string | null;
  suppression_reason: string | null;
  unsubscribe_token_hash?: string | null;
  unsubscribe_token_expires_at?: string | null;
  updated_at: string;
};

export function normalizeNewsletterEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidNewsletterEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
}

export function isExplicitMarketingConsent(value: unknown): value is true {
  return value === true;
}

export function buildNewsletterSubscriptionRecord(
  email: string,
  now = new Date(),
): NewsletterSubscriptionRecord {
  const normalizedEmail = normalizeNewsletterEmail(email);
  if (!isValidNewsletterEmail(normalizedEmail)) {
    throw new Error("INVALID_EMAIL");
  }

  const timestamp = now.toISOString();
  return {
    email: normalizedEmail,
    status: "subscribed",
    marketing_consent: true,
    consent_at: timestamp,
    consent_source: NEWSLETTER_CONSENT_SOURCE,
    consent_purpose: NEWSLETTER_CONSENT_PURPOSE,
    consent_policy_version: NEWSLETTER_CONSENT_POLICY_VERSION,
    unsubscribe_at: null,
    unsubscribe_source: null,
    suppression_reason: null,
    unsubscribe_token_hash: null,
    unsubscribe_token_expires_at: null,
    updated_at: timestamp,
  };
}

export function buildLegacySuppressionRecordUpdate(now = new Date()) {
  return {
    status: "suppressed" as const,
    marketing_consent: false,
    consent_at: null,
    consent_source: null,
    consent_purpose: null,
    consent_policy_version: null,
    suppression_reason: LEGACY_SUPPRESSION_REASON,
    updated_at: now.toISOString(),
  };
}

export function buildUnsubscribeUpdate(
  now = new Date(),
  source = NEWSLETTER_UNSUBSCRIBE_SOURCE,
) {
  return {
    status: "unsubscribed" as const,
    unsubscribe_at: now.toISOString(),
    unsubscribe_source: source,
    updated_at: now.toISOString(),
  };
}

export function buildSuppressionUpdate(reason: string, now = new Date()) {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error("SUPPRESSION_REASON_REQUIRED");
  return {
    status: "suppressed" as const,
    suppression_reason: normalizedReason,
    updated_at: now.toISOString(),
  };
}

export function isMarketingEligible(
  record: Pick<NewsletterSubscriptionRecord, "status" | "marketing_consent">,
): boolean {
  return record.status === "subscribed" && record.marketing_consent === true;
}

export function canAutoReactivate(
  record: Pick<NewsletterSubscriptionRecord, "status">,
): boolean {
  return record.status === "subscribed";
}

export function issueUnsubscribeToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashUnsubscribeToken(token);
  const expiresAt = new Date(now.getTime() + NEWSLETTER_UNSUBSCRIBE_TOKEN_TTL_MS).toISOString();
  return { token, tokenHash, expiresAt };
}

export function hashUnsubscribeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
