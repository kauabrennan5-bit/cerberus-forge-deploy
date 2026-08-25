import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildNewsletterQ7RpcArgs,
  classifyNewsletterQ7Error,
  extractNewsletterQ7Row,
  NEWSLETTER_Q7_PAYLOAD,
} from "../server/services/newsletterQ7.ts";

describe("newsletter Q7 application adapter", () => {
  it("builds the exact seven RPC arguments with normalized and stable intent metadata", () => {
    const first = buildNewsletterQ7RpcArgs("  VALID@Example.COM ", true);
    const retry = buildNewsletterQ7RpcArgs("valid@example.com", true);
    const otherEmail = buildNewsletterQ7RpcArgs("other@example.com", true);

    assert.equal(first.p_email, "valid@example.com");
    assert.equal(first.p_marketing_consent, true);
    assert.equal(first.p_causation_id, null);
    assert.equal(first.p_payload_version, "1.0");
    assert.deepEqual(first.p_payload, NEWSLETTER_Q7_PAYLOAD);
    assert.equal(first.p_idempotency_key, retry.p_idempotency_key);
    assert.equal(first.p_correlation_id, retry.p_correlation_id);
    assert.notEqual(first.p_idempotency_key, otherEmail.p_idempotency_key);
    assert.match(first.p_idempotency_key, /^newsletter-signup-v1:[a-f0-9]{64}$/);
    assert.match(first.p_correlation_id, /^newsletter-http-[a-f0-9]{64}$/);
  });

  it("passes only literal true as explicit consent", () => {
    assert.equal(buildNewsletterQ7RpcArgs("valid@example.com", true).p_marketing_consent, true);
    assert.equal(buildNewsletterQ7RpcArgs("valid@example.com", false).p_marketing_consent, false);
    assert.equal(buildNewsletterQ7RpcArgs("valid@example.com", "true").p_marketing_consent, false);
  });

  it("accepts the official created/replayed row shape and rejects malformed data", () => {
    const row = {
      result: "created",
      subscriber_status: "subscribed",
      outbox_id: "nout-test",
      idempotency_key: "newsletter-signup-v1:test",
      correlation_id: "newsletter-http-test",
      replayed: false,
    };
    assert.deepEqual(extractNewsletterQ7Row([row]), row);
    assert.equal(extractNewsletterQ7Row([{ ...row, result: "collision" }]), null);
    assert.equal(extractNewsletterQ7Row(null), null);
  });

  it("connects the real newsletter route to Q7 instead of the legacy direct upsert", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    assert.match(server, /client\.rpc\("confirm_newsletter_consent_with_outbox", q7Args\)/);
    assert.doesNotMatch(server, /from\("newsletter_subscribers"\)\.upsert/);
  });

  it("classifies only known Q7 errors and sanitizes unknown errors", () => {
    assert.equal(classifyNewsletterQ7Error({ message: "OUTBOX_IDEMPOTENCY_COLLISION" }), "OUTBOX_IDEMPOTENCY_COLLISION");
    assert.equal(classifyNewsletterQ7Error({ code: "NEWSLETTER_RECONSENT_REQUIRED" }), "NEWSLETTER_RECONSENT_REQUIRED");
    assert.equal(classifyNewsletterQ7Error({ message: "connection details should not be logged" }), "NEWSLETTER_Q7_UNAVAILABLE");
  });
});
