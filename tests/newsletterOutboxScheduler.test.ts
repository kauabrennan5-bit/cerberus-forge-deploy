import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isNewsletterOutboxWorkerRunning, startNewsletterOutboxWorker, stopNewsletterOutboxWorker } from "../server/services/newsletterOutboxScheduler.ts";

afterEach(() => {
  stopNewsletterOutboxWorker();
  delete process.env.NEWSLETTER_OUTBOX_WORKER_ENABLED;
  delete process.env.BREVO_API_KEY;
  delete process.env.NEWSLETTER_SENDER_EMAIL;
});

describe("newsletter outbox scheduler", () => {
  it("stays off by default", () => {
    delete process.env.NEWSLETTER_OUTBOX_WORKER_ENABLED;
    assert.equal(startNewsletterOutboxWorker(), false);
    assert.equal(isNewsletterOutboxWorkerRunning(), false);
  });

  it("blocks closed when enabled without provider configuration", () => {
    process.env.NEWSLETTER_OUTBOX_WORKER_ENABLED = "true";
    delete process.env.BREVO_API_KEY;
    delete process.env.NEWSLETTER_SENDER_EMAIL;
    assert.equal(startNewsletterOutboxWorker(), false);
    assert.equal(isNewsletterOutboxWorkerRunning(), false);
  });
});
