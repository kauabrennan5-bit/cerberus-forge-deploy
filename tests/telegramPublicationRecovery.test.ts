import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runConfiguredShopeePublicationRecovery } from "../server/services/telegramPublicationRecovery";
import type { PendingReview } from "../server/services/telegramTypes";

function reviewFixture(): PendingReview {
  return {
    id: "autocur-bd3dd016-7fc2-41be-90bf-6a8ee3b24d03",
    chatId: 1976526372,
    senderId: 1976526372,
    firstName: "Cerberus",
    username: "autonomous_curator",
    createdAt: 1_788_761_563_614,
    expiresAt: 1_788_847_963_614,
    produto: "Relógio Flip Retrô",
    categoria: "Tecnologia",
    preco: 202.48,
    imagens: ["https://down-br.img.susercontent.com/file/example"],
    normalizedUrl: "https://shopee.com.br/product/1797503417/57017143839",
    status: "error",
    existingProduct: {
      source: "autonomous_curator",
      shopId: "1797503417",
      itemId: "57017143839",
      autonomousCuratorRunId: "run-1",
    },
    lifecycle: {
      id: "lifecycle-old",
      state: "APPROVED",
      audit: [],
      validation: { outcome: "PASS", warnings: [], errors: [] },
      humanApproved: true,
      operationId: "PUB-20260907164604-0004",
      diagnostic: {
        code: "SHOPEE_PREFLIGHT_CATEGORY_CHANGED",
      },
    } as any,
  };
}

describe("Telegram publication recovery", () => {
  it("reopens only the approved legacy category-drift failure for a fresh human click", async () => {
    let stored = reviewFixture();
    let notified = false;
    const now = 1_788_800_000_000;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => now,
        getReview: async () => stored,
        saveReview: async review => { stored = review; },
        notifyReview: async review => {
          notified = true;
          assert.equal(review.status, "pending");
        },
      },
    );

    assert.equal(result.status, "reopened");
    assert.equal(result.previousOperationId, "PUB-20260907164604-0004");
    assert.equal(stored.status, "pending");
    assert.equal(stored.lifecycle?.operationId, "PUB-20260907164604-0004");
    assert.equal(notified, true);
    assert.deepEqual(stored.existingProduct.publicationRecoveryHistory, [{
      recoveryType: "LEGACY_SHOPEE_CATEGORY_DRIFT",
      previousOperationId: "PUB-20260907164604-0004",
      previousDiagnosticCode: "SHOPEE_PREFLIGHT_CATEGORY_CHANGED",
      approvedCategory: "Tecnologia",
      requestedAt: new Date(now).toISOString(),
    }]);
  });

  it("fails closed when the previous failure was not the legacy category block", async () => {
    const stored = reviewFixture();
    (stored.lifecycle as any).diagnostic.code = "SHOPEE_PREFLIGHT_SCRAPER_IDENTITY_CHANGED";
    let notified = false;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => 1_788_800_000_000,
        getReview: async () => stored,
        saveReview: async () => undefined,
        notifyReview: async () => { notified = true; },
      },
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "LEGACY_CATEGORY_BLOCK_NOT_PRESENT");
    assert.equal(notified, false);
    assert.equal(stored.status, "error");
  });

  it("fails closed without prior human approval", async () => {
    const stored = reviewFixture();
    (stored.lifecycle as any).humanApproved = false;
    let notified = false;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => 1_788_800_000_000,
        getReview: async () => stored,
        saveReview: async () => undefined,
        notifyReview: async () => { notified = true; },
      },
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "HUMAN_APPROVAL_NOT_PRESENT");
    assert.equal(notified, false);
  });
});
