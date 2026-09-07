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
  it("reopens only the approved legacy category-drift failure and produces a new operationId", async () => {
    let stored = reviewFixture();
    let callbackData = "";
    const now = 1_788_800_000_000;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => now,
        getReview: async () => stored,
        saveReview: async review => { stored = review; },
        handleUpdate: async update => {
          callbackData = update.callback_query.data;
          assert.equal(stored.status, "pending", "review must be explicitly reopened before replay");
          assert.equal(stored.categoria, "Tecnologia", "approved category must remain authoritative");
          stored = {
            ...stored,
            status: "published",
            lifecycle: {
              ...(stored.lifecycle as any),
              state: "PUBLISHED",
              operationId: "PUB-20260907180000-0005",
              publishedProductId: "prod-recovered",
            } as any,
          };
        },
      },
    );

    assert.equal(callbackData, `confirm_pub:${stored.id}`);
    assert.equal(result.status, "published");
    assert.equal(result.previousOperationId, "PUB-20260907164604-0004");
    assert.equal(result.operationId, "PUB-20260907180000-0005");
    assert.equal(result.publishedProductId, "prod-recovered");
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
    let replayed = false;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => 1_788_800_000_000,
        getReview: async () => stored,
        saveReview: async () => undefined,
        handleUpdate: async () => { replayed = true; },
      },
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "LEGACY_CATEGORY_BLOCK_NOT_PRESENT");
    assert.equal(replayed, false);
    assert.equal(stored.status, "error");
  });

  it("fails closed without prior human approval", async () => {
    const stored = reviewFixture();
    (stored.lifecycle as any).humanApproved = false;
    let replayed = false;

    const result = await runConfiguredShopeePublicationRecovery(
      { SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID: stored.id } as NodeJS.ProcessEnv,
      {
        now: () => 1_788_800_000_000,
        getReview: async () => stored,
        saveReview: async () => undefined,
        handleUpdate: async () => { replayed = true; },
      },
    );

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "HUMAN_APPROVAL_NOT_PRESENT");
    assert.equal(replayed, false);
  });
});
