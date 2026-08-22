import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NEWSLETTER_CONSENT_POLICY_VERSION,
  NEWSLETTER_CONSENT_PURPOSE,
  NEWSLETTER_CONSENT_SOURCE,
  LEGACY_SUPPRESSION_REASON,
  NEWSLETTER_UNSUBSCRIBE_SOURCE,
  buildLegacySuppressionRecordUpdate,
  buildNewsletterSubscriptionRecord,
  buildSuppressionUpdate,
  buildUnsubscribeUpdate,
  canAutoReactivate,
  hashUnsubscribeToken,
  isExplicitMarketingConsent,
  isMarketingEligible,
  issueUnsubscribeToken,
  isValidNewsletterEmail,
  normalizeNewsletterEmail,
} from "../server/services/newsletterConsent.ts";

describe("newsletter consent contract", () => {
  const fixedNow = new Date("2026-08-22T22:30:00.000Z");

  it("normalizes and validates e-mails without exposing or persisting raw test data", () => {
    assert.equal(normalizeNewsletterEmail("  VALID@Example.COM "), "valid@example.com");
    assert.equal(isValidNewsletterEmail("valid@example.com"), true);
    assert.equal(isValidNewsletterEmail("invalid"), false);
    assert.equal(isValidNewsletterEmail("a@b.c"), false);
  });

  it("requires literal true for explicit marketing consent", () => {
    assert.equal(isExplicitMarketingConsent(true), true);
    assert.equal(isExplicitMarketingConsent(false), false);
    assert.equal(isExplicitMarketingConsent("true"), false);
    assert.equal(isExplicitMarketingConsent(1), false);
  });

  it("builds a subscribed record with auditable consent metadata", () => {
    const record = buildNewsletterSubscriptionRecord("valid@example.com", fixedNow);
    assert.deepEqual(record, {
      email: "valid@example.com",
      status: "subscribed",
      marketing_consent: true,
      consent_at: fixedNow.toISOString(),
      consent_source: NEWSLETTER_CONSENT_SOURCE,
      consent_purpose: NEWSLETTER_CONSENT_PURPOSE,
      consent_policy_version: NEWSLETTER_CONSENT_POLICY_VERSION,
      unsubscribe_at: null,
      unsubscribe_source: null,
      suppression_reason: null,
      unsubscribe_token_hash: null,
      unsubscribe_token_expires_at: null,
      updated_at: fixedNow.toISOString(),
    });
    assert.equal(isMarketingEligible(record), true);
  });

  it("classifies every legacy row as suppressed without inventing consent", () => {
    const update = buildLegacySuppressionRecordUpdate(fixedNow);
    assert.deepEqual(update, {
      status: "suppressed",
      marketing_consent: false,
      consent_at: null,
      consent_source: null,
      consent_purpose: null,
      consent_policy_version: null,
      suppression_reason: LEGACY_SUPPRESSION_REASON,
      updated_at: fixedNow.toISOString(),
    });
    assert.equal(isMarketingEligible({ status: update.status, marketing_consent: update.marketing_consent }), false);
    assert.equal(canAutoReactivate({ status: update.status }), false);
  });

  it("keeps unsubscribe and suppression states ineligible for future marketing", () => {
    const unsubscribe = buildUnsubscribeUpdate(fixedNow);
    assert.equal(unsubscribe.status, "unsubscribed");
    assert.equal(unsubscribe.unsubscribe_source, NEWSLETTER_UNSUBSCRIBE_SOURCE);
    assert.equal(isMarketingEligible({ status: unsubscribe.status, marketing_consent: true }), false);
    assert.equal(canAutoReactivate({ status: unsubscribe.status }), false);

    const suppression = buildSuppressionUpdate("hard_bounce", fixedNow);
    assert.equal(suppression.status, "suppressed");
    assert.equal(isMarketingEligible({ status: suppression.status, marketing_consent: true }), false);
    assert.equal(canAutoReactivate({ status: suppression.status }), false);
  });

  it("issues opaque unsubscribe tokens and stores only their hash", () => {
    const issued = issueUnsubscribeToken(fixedNow);
    assert.ok(issued.token.length >= 32);
    assert.notEqual(issued.token, issued.tokenHash);
    assert.equal(issued.tokenHash, hashUnsubscribeToken(issued.token));
    assert.equal(issued.expiresAt, "2026-09-21T22:30:00.000Z");
  });
});
