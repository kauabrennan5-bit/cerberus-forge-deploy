import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  processNewsletterOutboxOnce,
  type NewsletterOutboxRow,
  type NewsletterOutboxStore,
} from "../server/services/newsletterOutboxWorker.ts";
import {
  NewsletterProviderError,
  type NewsletterProvider,
} from "../server/services/newsletterProvider.ts";

function makeRow(overrides: Partial<NewsletterOutboxRow> = {}): NewsletterOutboxRow {
  return {
    id: "nout-test-1",
    subscriberEmail: "synthetic@example.invalid",
    eventType: "newsletter_subscribed",
    operationType: "project_to_provider",
    status: "pending",
    correlationId: "corr-test-1",
    causationId: null,
    idempotencyKey: "newsletter-signup-v1:test-1",
    payloadVersion: "1.0",
    payload: { template_key: "cerberus-newsletter-signup" },
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: new Date().toISOString(),
    leaseUntil: null,
    leaseToken: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    providerReference: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processingStartedAt: null,
    succeededAt: null,
    failedAt: null,
    ...overrides,
  };
}

class FakeStore implements NewsletterOutboxStore {
  row: NewsletterOutboxRow | null;
  subscriber: { status: "subscribed" | "suppressed" | "unsubscribed"; marketing_consent: boolean } = { status: "subscribed", marketing_consent: true };
  claimCount = 0;
  private activeToken: string | null = null;

  constructor(row = makeRow()) {
    this.row = row;
  }

  async claimNext(): Promise<{ row: NewsletterOutboxRow; leaseToken: string } | null> {
    if (!this.row || ["succeeded", "dead_letter", "cancelled"].includes(this.row.status)) return null;
    if (this.row.status === "processing") return null;
    const token = `lease-${++this.claimCount}`;
    this.activeToken = token;
    this.row = { ...this.row, status: "processing", attemptCount: this.row.attemptCount + 1, leaseToken: token };
    return { row: { ...this.row }, leaseToken: token };
  }

  async readSubscriber(): Promise<{ status: "subscribed" | "suppressed" | "unsubscribed"; marketing_consent: boolean } | null> {
    return this.subscriber;
  }

  async markSucceeded(id: string, leaseToken: string, providerReference?: string): Promise<NewsletterOutboxRow | null> {
    if (!this.row || this.row.id !== id || this.activeToken !== leaseToken || this.row.status !== "processing") return null;
    this.row = { ...this.row, status: "succeeded", leaseToken: null, providerReference: providerReference || null, succeededAt: new Date().toISOString() };
    return { ...this.row };
  }

  async markCancelled(id: string, leaseToken: string, reason: string): Promise<NewsletterOutboxRow | null> {
    if (!this.row || this.row.id !== id || this.activeToken !== leaseToken || this.row.status !== "processing") return null;
    this.row = { ...this.row, status: "cancelled", leaseToken: null, lastErrorCode: "INELIGIBLE_SUBSCRIBER", lastErrorMessage: reason };
    return { ...this.row };
  }

  async markFailure(id: string, leaseToken: string, failure: NewsletterProviderError, attemptCount: number, maxAttempts: number): Promise<NewsletterOutboxRow | null> {
    if (!this.row || this.row.id !== id || this.activeToken !== leaseToken || this.row.status !== "processing") return null;
    const terminal = failure.kind === "permanent_4xx" || failure.kind === "unknown" || attemptCount >= maxAttempts;
    this.row = { ...this.row, status: terminal ? "dead_letter" : "retryable", leaseToken: null, lastErrorCode: failure.code, lastErrorMessage: failure.message, failedAt: terminal ? new Date().toISOString() : null };
    return { ...this.row };
  }
}

function providerWith(result: "succeeded" | "duplicate" | NewsletterProviderError, calls: string[] = []): NewsletterProvider {
  return {
    async project(_input, idempotencyKey) {
      calls.push(idempotencyKey);
      if (result instanceof NewsletterProviderError) throw result;
      return { status: result, providerReference: "provider-ref" };
    },
  };
}

describe("newsletter outbox worker", () => {
  it("revalidates eligibility, calls provider once and marks success", async () => {
    const store = new FakeStore();
    const calls: string[] = [];
    const result = await processNewsletterOutboxOnce(store, providerWith("succeeded", calls));
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.providerCalled, true);
    assert.deepEqual(calls, ["newsletter-signup-v1:test-1"]);
    assert.equal(store.row?.status, "succeeded");
  });

  it("does not call provider for suppressed or unsubscribed subscribers", async () => {
    for (const status of ["suppressed", "unsubscribed"] as const) {
      const store = new FakeStore();
      store.subscriber = { status, marketing_consent: false };
      let calls = 0;
      const result = await processNewsletterOutboxOnce(store, { project: async () => { calls += 1; return { status: "succeeded" }; } });
      assert.equal(result.outcome, "cancelled_ineligible");
      assert.equal(result.providerCalled, false);
      assert.equal(calls, 0);
      assert.equal(store.row?.status, "cancelled");
    }
  });

  it("treats provider duplicate as terminal success", async () => {
    const store = new FakeStore();
    const result = await processNewsletterOutboxOnce(store, providerWith("duplicate"));
    assert.equal(result.outcome, "duplicate");
    assert.equal(result.item?.status, "succeeded");
  });

  it("keeps transient failures retryable and permanent failures in dead_letter", async () => {
    const retryStore = new FakeStore();
    const retry = await processNewsletterOutboxOnce(retryStore, providerWith(new NewsletterProviderError("transient_5xx", "PROVIDER_HTTP_503", "Provider indisponível.")));
    assert.equal(retry.outcome, "retryable");
    assert.equal(retry.item?.status, "retryable");
    assert.equal(retry.item?.lastErrorCode, "PROVIDER_HTTP_503");

    const deadStore = new FakeStore();
    const dead = await processNewsletterOutboxOnce(deadStore, providerWith(new NewsletterProviderError("permanent_4xx", "PROVIDER_HTTP_400", "Provider rejeitou.")));
    assert.equal(dead.outcome, "dead_letter");
    assert.equal(dead.item?.status, "dead_letter");
  });

  it("prevents duplicate worker processing through a shared claim", async () => {
    const store = new FakeStore();
    const calls: string[] = [];
    const provider = providerWith("succeeded", calls);
    const results = await Promise.all([
      processNewsletterOutboxOnce(store, provider),
      processNewsletterOutboxOnce(store, provider),
    ]);
    assert.equal(store.claimCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(results.filter(result => result.outcome === "succeeded").length, 1);
    assert.equal(results.filter(result => result.outcome === "idle").length, 1);
  });

  it("dead-letters an invalid claimed event without calling provider", async () => {
    const store = new FakeStore(makeRow({ eventType: "unknown_event" }));
    let calls = 0;
    const result = await processNewsletterOutboxOnce(store, { project: async () => { calls += 1; return { status: "succeeded" }; } });
    assert.equal(result.outcome, "dead_letter");
    assert.equal(calls, 0);
    assert.equal(result.item?.lastErrorCode, "INVALID_OUTBOX_ITEM");
  });
});
