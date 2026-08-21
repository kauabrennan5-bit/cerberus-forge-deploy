import { extractShopeeIdentity } from "../server/commercial/marketplace/shopeeIdentity";
import { parseShopeePriceString } from "../server/commercial/affiliate/shopeeApiClient";
import { savePendingReview, getPendingReview, getLatestPendingReviewForUser } from "../server/repositories/telegramRepository";
import { PendingReview } from "../server/services/telegramBot";
import assert from "node:assert";
import test from "node:test";

/**
 * 🛡️ CERBERUS FINDS — GATE FINAL PRÉ-COMMIT
 * Suite de testes para validação rigorosa C-01 a C-05.
 */

test("C-01: TTL e Persistência", async (t) => {
  const chatId = 123456789;
  const reviewId = `test-ttl-${Date.now()}`;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24h no futuro

  const review: any = {
    id: reviewId,
    chatId,
    senderId: 123,
    firstName: "Test",
    username: "testuser",
    status: "pending",
    produto: "Test TTL",
    categoria: "Test",
    preco: 100,
    normalizedUrl: "https://shopee.com.br/product/1/1",
    imagens: [],
    createdAt: now,
    expiresAt
  };

  await t.test("Deve respeitar expiresAt de 24h e não expirar em 1h", async () => {
    await savePendingReview(review);
    const fetched = await getPendingReview(reviewId);
    assert.strictEqual(fetched?.id, reviewId, "Review de 24h deve estar disponível");
  });

  await t.test("Deve marcar como 'expired' quando expiresAt for no passado", async () => {
    const expiredReview = { ...review, id: reviewId + "-exp", expiresAt: now - 1000 };
    await savePendingReview(expiredReview);
    const fetched = await getPendingReview(expiredReview.id);
    assert.strictEqual(fetched?.status, "expired", "Review expirado deve ter status 'expired'");
  });
});

test("C-03: Identidade Shopee Canônica", (t) => {
  const cases = [
    { url: "https://shopee.com.br/product/123/456", expected: { shopId: "123", itemId: "456" } },
    { url: "https://shopee.com.br/slug-i.123.456", expected: { shopId: "123", itemId: "456" } },
    { url: "https://shopee.com.br/loja/123/456", expected: { shopId: "123", itemId: "456" } },
    { url: "https://shopee.com.br/loja/slug/123/456/", expected: { shopId: "123", itemId: "456" } },
    { url: "https://shopee.com.br/product/123/456?smtt=123", expected: { shopId: "123", itemId: "456" } },
    { url: "https://shopee.com.br/invalid", expected: { shopId: null, itemId: null } },
    { url: "https://mercadolivre.com.br/p/MLB123", expected: { shopId: null, itemId: null } }
  ];

  for (const c of cases) {
    const result = extractShopeeIdentity(c.url);
    assert.deepStrictEqual(result, c.expected, `Falha no caso: ${c.url}`);
  }
});

test("Preço Shopee (C-05/Fase 19)", (t) => {
  assert.strictEqual(parseShopeePriceString("129.90"), 129.9, "Deve aceitar decimal com ponto");
  assert.strictEqual(parseShopeePriceString("129,90"), null, "Deve rejeitar vírgula (fail-closed)");
  assert.strictEqual(parseShopeePriceString("R$ 129.90"), null, "Deve rejeitar símbolo de moeda");
  assert.strictEqual(parseShopeePriceString(""), null, "Deve rejeitar vazio");
});
