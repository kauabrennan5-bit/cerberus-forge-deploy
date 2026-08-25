import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNewsletterQ7RpcArgs } from "../server/services/newsletterQ7.ts";
import {
  processNewsletterOutboxOnce,
  type NewsletterOutboxRow,
  type NewsletterOutboxStore,
} from "../server/services/newsletterOutboxWorker.ts";
import type { NewsletterProvider } from "../server/services/newsletterProvider.ts";

class PipelineStore implements NewsletterOutboxStore {
  row: NewsletterOutboxRow;
  private token: string | null = null;
  private claimed = false;

  constructor(email: string, idempotencyKey: string, correlationId: string) {
    const now = new Date().toISOString();
    this.row = {
      id: "nout-e2e-synthetic",
      subscriberEmail: email,
      eventType: "newsletter_subscribed",
      operationType: "project_to_provider",
      status: "pending",
      correlationId,
      causationId: null,
      idempotencyKey,
      payloadVersion: "1.0",
      payload: { template_key: "cerberus-newsletter-signup", locale: "pt-BR", campaign_id: "newsletter-signup", content_variant: "default" },
      attemptCount: 0,
      maxAttempts: 3,
      nextAttemptAt: now,
      leaseUntil: null,
      leaseToken: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      providerReference: null,
      createdAt: now,
      updatedAt: now,
      processingStartedAt: null,
      succeededAt: null,
      failedAt: null,
    };
  }

  async claimNext(): Promise<{ row: NewsletterOutboxRow; leaseToken: string } | null> {
    if (this.claimed) return null;
    this.claimed = true;
    this.token = "e2e-lease-token";
    this.row = { ...this.row, status: "processing", attemptCount: 1, leaseToken: this.token };
    return { row: { ...this.row }, leaseToken: this.token };
  }

  async readSubscriber(): Promise<{ status: "subscribed"; marketing_consent: true }> {
    return { status: "subscribed", marketing_consent: true };
  }

  async markSucceeded(id: string, leaseToken: string, providerReference?: string): Promise<NewsletterOutboxRow | null> {
    if (id !== this.row.id || leaseToken !== this.token) return null;
    this.row = { ...this.row, status: "succeeded", leaseToken: null, providerReference: providerReference || null };
    return { ...this.row };
  }

  async markCancelled(): Promise<NewsletterOutboxRow | null> { return null; }

  async markFailure(): Promise<NewsletterOutboxRow | null> { return null; }
}

describe("newsletter outbox synthetic E2E pipeline", () => {
  it("carries endpoint/Q7 intent metadata through pending outbox to fake provider success", async () => {
    const args = buildNewsletterQ7RpcArgs("q7-e2e@example.invalid", true);
    const q7Result = {
      result: "created" as const,
      subscriber_status: "subscribed" as const,
      outbox_id: "nout-e2e-synthetic",
      idempotency_key: args.p_idempotency_key,
      correlation_id: args.p_correlation_id,
      replayed: false,
    };
    assert.equal(q7Result.result, "created");
    const store = new PipelineStore("q7-e2e@example.invalid", q7Result.idempotency_key, q7Result.correlation_id);
    const providerCalls: string[] = [];
    const provider: NewsletterProvider = {
      async project(input, idempotencyKey) {
        providerCalls.push(`${input.eventType}:${idempotencyKey}`);
        return { status: "succeeded", providerReference: "fake-e2e-reference" };
      },
    };

    const processed = await processNewsletterOutboxOnce(store, provider);
    assert.equal(processed.outcome, "succeeded");
    assert.equal(processed.providerCalled, true);
    assert.equal(store.row.status, "succeeded");
    assert.deepEqual(providerCalls, [`newsletter_subscribed:${args.p_idempotency_key}`]);
  });
});
