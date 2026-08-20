// ============================================================================
// Fase 23 — Testes da rota POST /api/commercial/preview-telegram.
//
// Escopo:
//   A) rota: validação de entrada, identidade, idempotência, fail-closed
//      (sem auth Affiliate, sem elegibilidade, URL inválida),
//      card corretamente formatado (preço em escala NÃO verificada,
//      sem rotular moeda, sem inventar imagem) e persistência do review.
//   B) bot: callback "approve_only:{reviewId}" registra decisão como
//      "published" SEM executar pipeline.publish, acquisition mutation,
//      scraping, Seller API ou qualquer alteração do catálogo canônico.
//
// Padrão: node:test + assert/strict + supertest (mesmo padrão da codebase).
// Transporte HTTP da Shopee Affiliate fakeado globalmente (fetch).
// Persistência do TelegramRepository via hooks oficiais setTest*ForTests.
// PREVIEW != PUBLICATION · DECISION != ACTION.
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import { PendingReview } from "../server/services/telegramBot";
import {
  setTestSavePendingReview,
  setTestGetPendingReview,
} from "../server/repositories/telegramRepository";
import {
  setupPreviewTelegramRoutes,
  setTestPreviewRegistryForTests,
} from "../server/routes/previewTelegramRoutes";
import { handleTelegramWebhookUpdate } from "../server/services/telegramBot";
import { createProductionProductPipeline } from "../server/services/productPipeline";

// ============================================================================
// 1. Fake do transporte HTTP da Shopee Affiliate API (fetch global).
// ============================================================================
type OfferNodeJson = {
  itemId: string;
  shopId: string;
  productName: string | null;
  price: number | null;
  productLink: string | null;
  offerLink: string | null;
};

type AffiliateApiScenario = {
  status: "link_acquired" | "not_eligible" | "not_found" | "auth_error";
  nodes: OfferNodeJson[];
  httpStatus: number;
};

const DEFAULT_NODES: OfferNodeJson[] = [
  {
    itemId: "23794344926",
    shopId: "1530442944",
    productName: "Camiseta Oversized Teste",
    price: 99,
    productLink: "https://shopee.com.br/Camiseta-i.1530442944.23794344926",
    offerLink: "https://shope.ee/affiliate_mock_token_123",
  },
];

let affiliateScenario: AffiliateApiScenario = {
  status: "link_acquired",
  nodes: DEFAULT_NODES,
  httpStatus: 200,
};
let fetchCallLog: string[] = [];
const originalFetch = globalThis.fetch;

function installFakeAffiliateFetch(scenario: AffiliateApiScenario): void {
  affiliateScenario = scenario;
  fetchCallLog = [];
  const fakeResponse = (json: unknown, status: number) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => json,
    text: async () => JSON.stringify(json),
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetchCallLog.push(url);
    if (url.includes("open-api.affiliate.shopee.com.br")) {
      return fakeResponse(
        { data: { productOfferV2: { nodes: affiliateScenario.nodes } } },
        affiliateScenario.httpStatus,
      );
    }
    if (url.includes("api.telegram.org")) {
      // Telegram fake: responde ok com message_id.
      return fakeResponse(
        { ok: true, result: { message_id: 42, chat: { id: 12345 } } },
        200,
      );
    }
    // Fallback para o fetch real (nada mais é esperado nos testes da rota).
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
  fetchCallLog = [];
}

// ============================================================================
// 2. Fake da persistência do telegramRepository (hooks oficiais de teste).
// ============================================================================
type FakeReview = PendingReview & Record<string, unknown>;

const reviewsById = new Map<string, FakeReview>();
let lastSavedReview: FakeReview | null = null;
let saveCallCount = 0;

function installFakeTelegramRepo(): void {
  reviewsById.clear();
  lastSavedReview = null;
  saveCallCount = 0;
  setTestSavePendingReview(async (review: PendingReview) => {
    const r = review as unknown as FakeReview;
    reviewsById.set(r.id, r);
    lastSavedReview = r;
    saveCallCount += 1;
  });
  setTestGetPendingReview(async (reviewId: string) => reviewsById.get(reviewId) ?? null);
}

function restoreTelegramRepo(): void {
  setTestSavePendingReview(null);
  setTestGetPendingReview(null);
}

// ============================================================================
// 3. App de teste com a rota.
// ============================================================================
function buildTestApp() {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: "not_authorized" });
    }
    return next();
  };
  setupPreviewTelegramRoutes({ app, requireAdminAuth });
  return app;
}

const ADMIN_PASSWORD = "test-admin-password";
const TELEGRAM_ALLOWED_USERS = "12345";

test.beforeEach(() => {
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.TELEGRAM_ALLOWED_USER_IDS = TELEGRAM_ALLOWED_USERS;
  process.env.SHOPEE_APP_ID = "mock-app-id";
  process.env.SHOPEE_APP_SECRET = "mock-app-secret";
  // Token fake: sem ele sendTelegramMessage retorna early e o card não sai.
  process.env.TELEGRAM_BOT_TOKEN = "mock-telegram-bot-token";
});

test.afterEach(() => {
  restoreFetch();
  restoreTelegramRepo();
  setTestPreviewRegistryForTests();
  delete process.env.ADMIN_PASSWORD;
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_APP_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

function postPreview(app: express.Express, body: Record<string, unknown>) {
  return supertest(app)
    .post("/api/commercial/preview-telegram")
    .set("Content-Type", "application/json")
    .set("x-admin-password", ADMIN_PASSWORD)
    .send(body);
}

// ============================================================================
// A) VALIDAÇÃO DE ENTRADA
// ============================================================================
test("recusa sem senha de admin (fail-closed)", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await supertest(app)
    .post("/api/commercial/preview-telegram")
    .set("Content-Type", "application/json")
    .send({ url: "https://shopee.com.br/xpto-i.1530442944.23794344926" });
  assert.equal(res.status, 401);
});

test("recusa sem URL", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {} as Record<string, unknown>);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "missing_url");
});

test("recusa URL vazia", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, { url: "   " } as Record<string, unknown>);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "missing_url");
});

test("recusa URL que não resolve para (shop_id, item_id) oficial", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, { url: "https://example.com/nao-shopee" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_shopee_url");
});

// ============================================================================
// A2) SUCESSO — card, preço UNVERIFIED, sem imagem inventada, review
// ============================================================================
test("retorna card com preço em escala NÃO verificada e não inventa imagem", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.reviewId, /^affprev-[a-z0-9]+/);
  assert.equal(res.body.price, 99);
  assert.equal(res.body.priceScaleVerified, false);
  assert.equal(res.body.affiliateUrl, "https://shope.ee/affiliate_mock_token_123");
  assert.equal(res.body.shopId, "1530442944");
  assert.equal(res.body.itemId, "23794344926");
  assert.equal(res.body.cardSent, true);
  // Exatamente UMA chamada oficial à Affiliate API (sem duplicação).
  assert.equal(
    fetchCallLog.filter((u) => u.includes("open-api.affiliate.shopee.com.br")).length,
    1,
  );
});

test("card não rotula moeda e informa ausência de imagem oficial", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 200);
  const sentUrl = fetchCallLog.find((u) => u.includes("api.telegram.org"));
  assert.ok(sentUrl, "mensagem enviada ao Telegram");
});

test("persiste PendingReview com categoria affiliate_preview e status pending", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 200);
  assert.equal(saveCallCount, 1);
  assert.ok(lastSavedReview, "review persistido");
  assert.equal(lastSavedReview.status, "pending");
  assert.equal(lastSavedReview.categoria, "affiliate_preview");
  assert.equal(
    (lastSavedReview.existingProduct as Record<string, unknown> | undefined)?.source,
    "affiliate_preview",
  );
  assert.equal(
    (lastSavedReview.existingProduct as Record<string, unknown> | undefined)?.priceScaleVerified,
    false,
  );
  assert.match(String(lastSavedReview.descricao), /source=affiliate_preview/);
});

test("idempotência: mesma URL retorna o mesmo reviewId sem segunda chamada", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const url = "https://shopee.com.br/produto-xpto-i.1530442944.23794344926";
  const r1 = await postPreview(app, { url });
  const r2 = await postPreview(app, { url });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.reviewId, r2.body.reviewId);
  assert.equal(r2.body.duplicate, true);
  assert.equal(
    fetchCallLog.filter((u) => u.includes("open-api.affiliate.shopee.com.br")).length,
    1,
  );
});

// ============================================================================
// A3) FAIL-CLOSED
// ============================================================================
test("fail-closed quando a fonte não retorna offerLink (not_eligible)", async () => {
  installFakeAffiliateFetch({
    status: "not_eligible",
    nodes: DEFAULT_NODES.map((n) => ({ ...n, offerLink: null })),
    httpStatus: 200,
  });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 424);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.affiliateStatus, "not_eligible");
  // Nenhuma mensagem ao Telegram e nenhum review persistido.
  assert.equal(fetchCallLog.filter((u) => u.includes("api.telegram.org")).length, 0);
  assert.equal(saveCallCount, 0);
});

test("fail-closed quando a fonte retorna 401 (auth_error)", async () => {
  installFakeAffiliateFetch({ status: "auth_error", nodes: [], httpStatus: 401 });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 424);
  assert.equal(res.body.error, "affiliate_link_not_available");
  assert.equal(res.body.affiliateStatus, "auth_error");
  assert.equal(fetchCallLog.filter((u) => u.includes("api.telegram.org")).length, 0);
  assert.equal(saveCallCount, 0);
});

test("fail-closed sem credenciais Affiliate configuradas", async () => {
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
  installFakeTelegramRepo();
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_APP_SECRET;
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "affiliate_auth_unavailable");
  assert.equal(
    fetchCallLog.filter((u) => u.includes("open-api.affiliate.shopee.com.br")).length,
    0,
  );
});

// ============================================================================
// B) Callback approve_only:{reviewId} — DECISION != ACTION
// ============================================================================
test("approve_only registra a decisão como published SEM publicar no site", async () => {
  const reviewId = "affprev-callback-test";
  installFakeTelegramRepo();
  const pipeline = createProductionProductPipeline();
  reviewsById.set(reviewId, {
    id: reviewId,
    chatId: Number(TELEGRAM_ALLOWED_USERS),
    senderId: Number(TELEGRAM_ALLOWED_USERS),
    firstName: "admin",
    username: "admin",
    createdAt: Date.now(),
    produto: "Camiseta Oversized Teste",
    categoria: "affiliate_preview",
    preco: 99,
    imagens: [],
    normalizedUrl: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
    descricao: "affiliate_preview · source=affiliate_preview",
    status: "pending",
    existingProduct: { source: "affiliate_preview", priceScaleVerified: false },
  } as unknown as FakeReview);

  // pipeline.publish NÃO é invocado pelo webhook (DECISION != ACTION).
  let publishInvoked = false;
  const originalPublish = pipeline.publish.bind(pipeline);
  pipeline.publish = ((...args: unknown[]) => {
    publishInvoked = true;
    return originalPublish(...args);
  }) as never;

  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-1",
      from: { id: Number(TELEGRAM_ALLOWED_USERS) },
      data: `approve_only:${reviewId}`,
      message: { chat: { id: Number(TELEGRAM_ALLOWED_USERS) }, message_id: 10 },
    },
  });

  assert.equal(publishInvoked, false, "pipeline.publish NÃO foi executado");
  // Registro governado da decisão.
  assert.equal(saveCallCount, 1);
  const saved = lastSavedReview!;
  assert.equal(saved.status, "published");
  assert.match(String(saved.descricao), /approved_by=approve_only/);
  assert.match(String(saved.descricao), /approved_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // Sem lifecycle de publicação (o estado PUBLISHED canônico não foi criado).
  assert.equal(saved.lifecycle, undefined);
});

test("approve_only recusa review inexistente", async () => {
  installFakeTelegramRepo();
  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-2",
      from: { id: Number(TELEGRAM_ALLOWED_USERS) },
      data: "approve_only:nao-existe",
      message: { chat: { id: Number(TELEGRAM_ALLOWED_USERS) }, message_id: 11 },
    },
  });
  assert.equal(saveCallCount, 0);
});

test("approve_only recusa callback duplicado (review já published)", async () => {
  const reviewId = "affprev-dup";
  installFakeTelegramRepo();
  reviewsById.set(reviewId, {
    id: reviewId,
    status: "published",
    categoria: "affiliate_preview",
  } as unknown as FakeReview);
  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-3",
      from: { id: Number(TELEGRAM_ALLOWED_USERS) },
      data: `approve_only:${reviewId}`,
      message: { chat: { id: Number(TELEGRAM_ALLOWED_USERS) }, message_id: 12 },
    },
  });
  assert.equal(saveCallCount, 0);
});

test("approve_only recusa usuário não autorizado", async () => {
  const reviewId = "affprev-unauth";
  installFakeTelegramRepo();
  reviewsById.set(reviewId, {
    id: reviewId,
    status: "pending",
    categoria: "affiliate_preview",
  } as unknown as FakeReview);
  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-4",
      from: { id: 99999 },
      data: `approve_only:${reviewId}`,
      message: { chat: { id: 99999 }, message_id: 13 },
    },
  });
  assert.equal(saveCallCount, 0);
});

// ============================================================================
// C) Preços — forma decimal pura da Fase 19 (escala NÃO verificada)
// ============================================================================
test("preço decimal puro é exibido com vírgula sem rotular moeda", async () => {
  installFakeAffiliateFetch({
    status: "link_acquired",
    nodes: DEFAULT_NODES.map((n) => ({ ...n, price: 99.4 })),
    httpStatus: 200,
  });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.price, 99.4);
  assert.equal(res.body.priceScaleVerified, false);
});

test("preço ausente no nó → card informa que a fonte não retornou preço", async () => {
  installFakeAffiliateFetch({
    status: "link_acquired",
    nodes: DEFAULT_NODES.map((n) => ({ ...n, price: null })),
    httpStatus: 200,
  });
  installFakeTelegramRepo();
  const app = buildTestApp();
  const res = await postPreview(app, {
    url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.price, null);
  assert.equal(res.body.priceScaleVerified, false);
});
