import { createHash } from "node:crypto";
import { normalizeNewsletterEmail } from "./newsletterConsent";

export const NEWSLETTER_Q7_PAYLOAD_VERSION = "1.0" as const;
export const NEWSLETTER_Q7_PAYLOAD = Object.freeze({
  template_key: "cerberus-newsletter-signup",
  locale: "pt-BR",
  campaign_id: "newsletter-signup",
  content_variant: "default",
});

export type NewsletterQ7RpcArgs = {
  p_email: string;
  p_marketing_consent: boolean;
  p_correlation_id: string;
  p_causation_id: null;
  p_idempotency_key: string;
  p_payload_version: typeof NEWSLETTER_Q7_PAYLOAD_VERSION;
  p_payload: typeof NEWSLETTER_Q7_PAYLOAD;
};

export type NewsletterQ7RpcRow = {
  result: "created" | "replayed";
  subscriber_status: "subscribed";
  outbox_id: string;
  idempotency_key: string;
  correlation_id: string;
  replayed: boolean;
};

const KNOWN_Q7_ERRORS = [
  "NEWSLETTER_RECONSENT_REQUIRED",
  "NEWSLETTER_NOT_ELIGIBLE",
  "OUTBOX_IDEMPOTENCY_COLLISION",
  "INVALID_EMAIL",
  "CONSENT_REQUIRED",
] as const;

export type NewsletterQ7ErrorCode = (typeof KNOWN_Q7_ERRORS)[number] | "NEWSLETTER_Q7_UNAVAILABLE";

function buildStableIntentDigest(email: string): string {
  return createHash("sha256")
    .update(`newsletter-signup-v1:${email}`, "utf8")
    .digest("hex");
}

function buildStableIdempotencyKey(email: string): string {
  return `newsletter-signup-v1:${buildStableIntentDigest(email)}`;
}

export function buildNewsletterQ7RpcArgs(email: unknown, marketingConsent: unknown): NewsletterQ7RpcArgs {
  const normalizedEmail = normalizeNewsletterEmail(email);
  return {
    p_email: normalizedEmail,
    p_marketing_consent: marketingConsent === true,
    p_correlation_id: `newsletter-http-${buildStableIntentDigest(normalizedEmail)}`,
    p_causation_id: null,
    p_idempotency_key: buildStableIdempotencyKey(normalizedEmail),
    p_payload_version: NEWSLETTER_Q7_PAYLOAD_VERSION,
    p_payload: NEWSLETTER_Q7_PAYLOAD,
  };
}

export function extractNewsletterQ7Row(data: unknown): NewsletterQ7RpcRow | null {
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (row.result !== "created" && row.result !== "replayed") return null;
  if (row.subscriber_status !== "subscribed") return null;
  if (typeof row.outbox_id !== "string" || typeof row.idempotency_key !== "string" || typeof row.correlation_id !== "string") return null;
  if (typeof row.replayed !== "boolean") return null;
  return row as NewsletterQ7RpcRow;
}

export function classifyNewsletterQ7Error(error: unknown): NewsletterQ7ErrorCode {
  const candidate = error as { message?: unknown; code?: unknown } | null;
  const text = [candidate?.message, candidate?.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const known = KNOWN_Q7_ERRORS.find((code) => text.includes(code));
  return known || "NEWSLETTER_Q7_UNAVAILABLE";
}
