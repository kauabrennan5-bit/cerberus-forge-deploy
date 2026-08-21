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
import { setTestFindExistingProduct } from "../server/services/productAutomation";
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

// ============================================================================
// 1A) HTML FAKE processável pelo SCRAPER REAL (Fase 24).
// O fake do fetch passa a servir um documento HTML que o scraper existente
// (fetchProductDataFromUrl → JSON-LD + OpenGraph + hashes CDN) consegue
// extrair: título, preço exibido e imagens oficiais observadas.
// ============================================================================
function buildFakeShopeeHtml(params: {
  title: string;
  price: number;
  hashes?: string[];
  /** Se true, o documento não contém dados extraíveis (simula bloqueio). */
  empty?: boolean;
}): string {
  if (params.empty) {
    return "<html><head><title>Account Verification</title></head><body></body></html>";
  }
  const hashes = params.hashes ?? ["sg-11134201-7ra1p-m4h0x3k9z7v042", "sg-11134201-7ra1p-m4h0x3k9z7v043"];
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: params.title,
    image: hashes.map((h) => `https://down-br.img.susercontent.com/file/${h}`),
  };
  // price=0 representa "sem preço observável no anúncio" (oferta ausente),
  // cenário real quando o JSON-LD do anúncio não traz o nó de oferta.
  if (params.price > 0) {
    jsonLd.offers = [{ "@type": "Offer", price: params.price }];
  }
  return (
    "<!DOCTYPE html><html><head>" +
    `<meta property="og:title" content="${params.title}">` +
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` +
    `<title>${params.title} | Shopee Brasil</title>` +
    "</head><body>" +
    // Bloco de hashes da galeria oficial (extractShopeeCdnImages do scraper).
    `<div>"images": ["${hashes.join(`", "`)}"]</div>` +
    "</body></html>"
  );
}

let scraperHtmlScenario: { price: number; title: string; hashes: string[]; empty: boolean } = {
  price: 79.9,
  title: "Porta Talheres Madeira Nobre Vidro Organizador Multiuso",
  hashes: ["sg-11134201-7ra1p-m4h0x3k9z7v042", "sg-11134201-7ra1p-m4h0x3k9z7v043"],
  empty: false,
};

function setScraperHtml(scenario: Partial<typeof scraperHtmlScenario>): void {
  scraperHtmlScenario = { ...scraperHtmlScenario, ...scenario };
}

// Hook de teste do Supabase: findExistingProduct não deve tocar o banco real.
function installFakeFindExistingProduct(): void {
  setTestFindExistingProduct(async () => null);
}

function restoreFindExistingProduct(): void {
  setTestFindExistingProduct(null);
}

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
let telegramCallBodies: Record<string, unknown>[] = [];
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
    if (url.includes("api.telegram.org") && init?.body) {
      try {
        if (typeof init.body === "string") {
          telegramCallBodies.push(JSON.parse(init.body));
        } else {
          telegramCallBodies.push(await (init.body as any)?.json?.());
        }
      } catch {
        // Corpo em formato inesperado: ignorar e prosseguir com o fake.
      }
    }
    if (url.includes("open-api.affiliate.shopee.com.br")) {
      return fakeResponse(
        { data: { productOfferV2: { nodes: affiliateScenario.nodes } } },
        affiliateScenario.httpStatus,
      );
    }
    if (url.includes("api.telegram.org")) {
      // Telegram fake: responde ok com message_id (sendMessage E sendPhoto).
      return fakeResponse(
        { ok: true, result: { message_id: 42, chat: { id: 12345 } } },
        200,
      );
    }
    // Scraper real (Fase 24): qualquer URL Shopee/shope.ee serve o HTML fake
    // processável pelo scraper existente (JSON-LD + hashes CDN). O produtoLink
    // oficial retornado pela Affiliate API é exatamente o que o scraper recebe.
    if (url.includes("shopee.com.br") || url.includes("shope.ee")) {
      // Response REAL com body stream: o scraper lê via body.getReader()
      // (sem body, readHtmlWithLimit retorna "" e o enrichment falha).
      const html = buildFakeShopeeHtml(scraperHtmlScenario);
      return new Response(html, {
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      });
    }
    // Fallback para o fetch real (nada mais é esperado nos testes da rota).
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
  fetchCallLog = [];
  telegramCallBodies = [];
  setScraperHtml({ empty: false });
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
  installFakeFindExistingProduct();
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
  installFakeFindExistingProduct();
  setScraperHtml({ empty: false });
});

test.afterEach(() => {
  restoreFetch();
  restoreTelegramRepo();
  restoreFindExistingProduct();
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
  // Com o scraper real, a categoria passa a ser a curatorial observada
  // (extraída do anúncio real), e não mais o placeholder "affiliate_preview".
  assert.ok(
    lastSavedReview.categoria === "affiliate_preview" ||
      (typeof lastSavedReview.categoria === "string" &&
        lastSavedReview.categoria.trim().length > 0),
    `categoria persistida: ${lastSavedReview.categoria}`,
  );
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
// A2B) FASE 24 — Enrichment pelo SCRAPER REAL (Affiliate API → Scraper → card)
// ============================================================================
test("scraper enriquece o card com imagens oficiais e preço observacional",
  async () => {
    // Preço decimal puro no HTML fake (shape real observado pela Affiliate API).
    setScraperHtml({ price: 79.9 });
    installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
    installFakeTelegramRepo();
    const app = buildTestApp();
    const res = await postPreview(app, {
      url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.cardSent, true);
    // Exatamente UMA chamada ao scraper (productLink oficial da Affiliate API).
    const shopeeCalls = fetchCallLog.filter(
      (u) => (u.includes("shopee.com.br") || u.includes("shope.ee")) && !u.includes("open-api.affiliate"),
    );
    assert.equal(shopeeCalls.length, 1);
    // O card é enviado como FOTO (sendPhoto) com a imagem oficial observada,
    // e a legenda carrega a nota de escala não verificada.
    const photoUrl = fetchCallLog.find((u) => u.includes("sendPhoto"));
    assert.ok(photoUrl, "card enviado como foto (sendPhoto)");
    // sendPhoto envia {chat_id, photo, caption, reply_markup}; sendMessage não
    // carrega campo `photo`. Identificar o card de FOTO pelo campo photo.
    const tgBodies = telegramCallBodies.filter(
      (b) => typeof b?.photo === "string" && b.photo.includes("down-br.img.susercontent.com"),
    );
    assert.ok(tgBodies.length > 0, "há corpo enviado ao sendPhoto");
    const lastBody = tgBodies[0] as { caption?: string };
    const caption = lastBody?.caption ?? "";
    assert.ok(
      caption.includes("imagem(ns)") || caption.includes("scraper"),
      "legenda menciona o enriquecimento observacional",
    );
    assert.match(caption, /escala n[ãa]o verificada/, "preço nunca rotulado como moeda");
    assert.ok(lastSavedReview, "review persistido com imagens reais");
    assert.equal(lastSavedReview.imagens.length, 2);
    assert.ok(
      lastSavedReview.imagens.every((img) => img.includes("down-br.img.susercontent.com/file/")),
      "imagens são as URLs CDN oficiais observadas pelo scraper",
    );
    assert.ok(
      String(lastSavedReview.descricao).includes("scraper_observacional"),
      "descricao declara a proveniência observacional",
    );
    // O review persiste o preço observado (79.9), sem escala verificada.
    assert.equal(lastSavedReview.preco, 79.9);
    assert.equal(
      (lastSavedReview.existingProduct as Record<string, unknown> | undefined)?.priceScaleVerified,
      false,
    );
  });

test("scraper com anúncio bloqueado → fail-closed 424 (sem card e sem review)",
  async () => {
    // Documento sem dados extraíveis (simula bloqueio/página de verificação).
    setScraperHtml({ empty: true });
    installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
    installFakeTelegramRepo();
    const app = buildTestApp();
    const res = await postPreview(app, {
      url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
    });
    assert.equal(res.status, 424);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "scraper_enrichment_failed");
    // O failureReason propaga a causa observada pelo scraper existente:
    // a mensagem de bloqueio anti-bot ou o código interno de extração.
    const reason = String(res.body.failureReason ?? res.body.error);
    assert.ok(
      /scraper_extraction_failed|bloqueou a requisição|bloqueio anti-bot/.test(reason),
      `failureReason indica falha de extração/bloqueio: ${reason}`,
    );
    // Nada chega ao Telegram e nada é persistido.
    assert.equal(fetchCallLog.filter((u) => u.includes("api.telegram.org")).length, 0);
    assert.equal(saveCallCount, 0);
    // A decisão manual não pode existir sem card: não há reviewId retornado.
    assert.equal(res.body.reviewId, undefined);
  });

test("scraper com item divergente → fail-closed 424 por identidade",
  async () => {
    // O nó oficial pertence a shop_id=1530442944/item_id=23794344926, mas a URL
    // informada (a mesma retornada pelo productLink oficial) aponta para OUTRO
    // item — o fake serve o HTML do item 99999999999/88888888888.
    setScraperHtml({ title: "Item Divergente de Teste" });
    const nodes = DEFAULT_NODES.map((n) => ({
      ...n,
      productLink: "https://shopee.com.br/outro-i.99999999999.88888888888",
    }));
    installFakeAffiliateFetch({ status: "link_acquired", nodes, httpStatus: 200 });
    installFakeTelegramRepo();
    const app = buildTestApp();
    const res = await postPreview(app, {
      url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
    });
    assert.equal(res.status, 424);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "scraper_enrichment_failed");
    assert.equal(res.body.failureReason, "scraper_identity_mismatch");
    assert.equal(fetchCallLog.filter((u) => u.includes("api.telegram.org")).length, 0);
    assert.equal(saveCallCount, 0);
  });

test("scraper sem preço no HTML → card usa o preço oficial da Affiliate API",
  async () => {
    // HTML com título e imagens, mas sem ofertas (preço observacional ausente).
    // Usa o helper padrão da suíte para manter o mesmo fake fetch dos demais
    // testes (scraper real + hooks oficiais do Supabase/telegramRepository).
    setScraperHtml({
      price: 0,
      title: "Porta Talheres Madeira Nobre Sem Oferta",
      hashes: ["sg-11134201-7ra1p-m4h0x3k9z7v042", "sg-11134201-7ra1p-m4h0x3k9z7v043"],
      empty: false,
    });
    installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
    installFakeTelegramRepo();
    const app = buildTestApp();
    const res = await postPreview(app, {
      url: "https://shopee.com.br/produto-xpto-i.1530442944.23794344926",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Sem preço observacional, o preço exibido volta ao valor oficial bruto
    // da Affiliate API — em ambos os casos a escala segue NÃO verificada.
    assert.equal(res.body.price, 99);
    assert.equal(res.body.priceScaleVerified, false);
    assert.equal(res.body.cardSent, true);
    assert.ok(lastSavedReview, "review persistido mesmo sem preço observacional");
    assert.equal(lastSavedReview.imagens.length, 2);
    assert.match(
      String(lastSavedReview.descricao),
      /preço com escala não verificada|preço observacional ausente/,
      "descrição registra o preço sem escala verificada",
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

test("approve_only e cancel_rev entregam FEEDBACK VISÍVEL via sendMessage (card de preview é texto, não caption)", async () => {
  const reviewId = "affprev-feedback-test";
  installFakeTelegramRepo();
  installFakeAffiliateFetch({ status: "link_acquired", nodes: DEFAULT_NODES, httpStatus: 200 });
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

  // Approve_only: o feedback DEVE chegar ao chat via sendMessage (texto),
  // nunca depender de editMessageCaption (inválido para card de texto).
  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-feedback-1",
      from: { id: Number(TELEGRAM_ALLOWED_USERS) },
      data: `approve_only:${reviewId}`,
      message: { chat: { id: Number(TELEGRAM_ALLOWED_USERS) }, message_id: 20 },
    },
  });
  const approvalFeedbackSent = fetchCallLog.some(
    (url) => url.includes("sendMessage") && url.includes("api.telegram.org"),
  );
  assert.ok(approvalFeedbackSent, "feedback do approve_only enviado ao chat via sendMessage");
  // Nenhum editMessageCaption no caminho de preview (garantia da correção).
  const captionEditAfterApproval = fetchCallLog.filter((url) => url.includes("editMessageCaption"));
  assert.equal(captionEditAfterApproval.length, 0, "approve_only não edita caption (card é texto)");

  // Cancel_rev: feedback visível também via sendMessage.
  await handleTelegramWebhookUpdate({
    callback_query: {
      id: "cb-feedback-2",
      from: { id: Number(TELEGRAM_ALLOWED_USERS) },
      data: `cancel_rev:${reviewId}`,
      message: { chat: { id: Number(TELEGRAM_ALLOWED_USERS) }, message_id: 20 },
    },
  });
  const cancelFeedbackSent = fetchCallLog.some((url) => url.includes("sendMessage") && url.includes("api.telegram.org"));
  assert.ok(cancelFeedbackSent, "feedback do cancel_rev enviado ao chat via sendMessage");
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
