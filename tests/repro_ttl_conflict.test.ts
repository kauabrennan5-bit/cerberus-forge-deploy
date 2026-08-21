import { 
  savePendingReview, 
  getPendingReview, 
  deletePendingReview 
} from "../server/repositories/telegramRepository";
import { PendingReview } from "../server/services/telegramBot";
import assert from "node:assert";

describe("Reprodução de Conflito de TTL (F02)", () => {
  const testReviewId = "test-ttl-repro-" + Date.now();

  afterAll(async () => {
    await deletePendingReview(testReviewId);
  });

  it("deve respeitar expiresAt de 24h e não expirar em 1h", async () => {
    const now = Date.now();
    const expiresAt = now + (24 * 60 * 60 * 1000); // 24 horas

    const review: PendingReview = {
      id: testReviewId,
      chatId: 12345,
      senderId: 12345,
      firstName: "Test",
      username: "testuser",
      produto: "Produto Teste TTL",
      categoria: "Teste",
      preco: 100,
      imagens: [],
      normalizedUrl: "https://shopee.com.br/product/1/1",
      descricao: "Teste de expiração",
      status: "pending",
      createdAt: now,
      expiresAt: expiresAt
    };

    // 1. Salva com 24h de expiração
    await savePendingReview(review);

    // 2. Recupera e verifica se o status continua pending e o expiresAt foi preservado
    const retrieved = await getPendingReview(testReviewId);
    
    assert.ok(retrieved, "Review deveria ter sido recuperada");
    assert.strictEqual(retrieved.status, "pending", "Status deveria ser pending");
    assert.strictEqual(retrieved.expiresAt, expiresAt, "expiresAt deveria ser 24h");
    
    // 3. Teste de falha real: Se o expiresAt fosse omitido ou calculado errado no get
    const fakeExpiredReviewId = "test-ttl-expired-" + Date.now();
    const expiredTime = now - (2 * 60 * 60 * 1000); // Criado há 2h
    
    const expiredReview: PendingReview = {
      ...review,
      id: fakeExpiredReviewId,
      createdAt: expiredTime,
      expiresAt: expiredTime + (1 * 60 * 60 * 1000) // Expirou há 1h
    };
    
    await savePendingReview(expiredReview);
    const retrievedExpired = await getPendingReview(fakeExpiredReviewId);
    
    assert.strictEqual(retrievedExpired?.status, "expired", "Status deveria ser expired para review antiga");
    await deletePendingReview(fakeExpiredReviewId);
  });
});

function describe(name: string, fn: () => void) {
  console.log(`\nSuite: ${name}`);
  fn();
}

function it(name: string, fn: () => Promise<void>) {
  // @ts-ignore
  import('node:test').then(t => {
    t.test(name, fn);
  });
}

function afterAll(fn: () => Promise<void>) {
  // @ts-ignore
  import('node:test').then(t => {
    t.after(fn);
  });
}
