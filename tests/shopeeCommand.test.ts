
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  parseShopeeCommand,
  buildShopeeBatchId,
  buildShopeeReviewId,
  runShopeeCommand,
} from "../server/services/shopeeCommand";
import * as shopeeCmdTopo from "../server/services/shopeeCommand";
import * as telegramBotModule from "../server/services/telegramBot";
import * as telegramRepositoryModule from "../server/repositories/telegramRepository";
import * as discoveryModule from "../server/commercial/discovery/fetchShared";
import * as shopeeDiscoveryModule from "../server/services/shopeeDiscovery";

function buildSearchResponse(nodes: Record<string, unknown>[]): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: { productOfferSearch: { nodes } } }),
  } as unknown as Response;
}

function buildSearchNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: "23794344926",
    shopId: "1530442944",
    productName: "Produto Teste",
    price: "79.90",
    productLink: "https://shopee.com.br/product/1530442944/23794344926",
    offerLink: "https://s.shopee.com.br/TERM",
    ...overrides,
  };
}

type TermClientModule = typeof import("../server/commercial/affiliate/shopeeApiClient");

function installTermClient(cm: TermClientModule, mockFetch: any): void {
  shopeeCmdTopo.setTestShopeeClient(
    cm.createShopeeApiClient({
      appId: "fake_app_id",
      secret: "fake_app_secret",
      transport: mockFetch,
    }),
  );
}

function makeTermFetch(acquireResponse: unknown = AFFILIATE_RESPONSE): any {
  return (async (...iargs: any[]) => {
    const input = iargs[0];
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("open-api.affiliate.shopee")) {
      return acquireResponse as unknown as Response;
    }
    throw new Error(`fetch inesperado no modo termo: ${url}`);
  }) as any;
}

const AFFILIATE_RESPONSE = {
  ok: true,
  json: () =>
    Promise.resolve({
      data: {
        productOfferV2: {
          nodes: [
            {
              itemId: "23794344926",
              shopId: "1530442944",
              productName: "Produto Teste",
              price: "79.90",
              productLink: "https://shopee.com.br/product/1530442944/23794344926",
              offerLink: "https://s.shopee.com.br/TESTE",
            },
          ],
        },
      },
    }),
};

describe("parseShopeeCommand", () => {
  it("rejeita argumento vazio", () => {
    const p = parseShopeeCommand("");
    assert.equal(p.error !== null, true);
    assert.equal(p.count, 0);
  });

  it("rejeita N fora do intervalo 1–10", () => {
    assert.equal(parseShopeeCommand("0").error !== null, true);
    assert.equal(parseShopeeCommand("11").error !== null, true);
    assert.equal(parseShopeeCommand("abc").error !== null, true);
    assert.equal(parseShopeeCommand("-1").error !== null, true);
    assert.equal(parseShopeeCommand("3.5").count, 3);
  });

  it("aceita N=10 com termo e N=5 sem termo", () => {
    const a = parseShopeeCommand("10 achados cozinha");
    assert.equal(a.error, null);
    assert.equal(a.count, 10);
    assert.equal(a.query, "achados cozinha");

    const b = parseShopeeCommand("5");
    assert.equal(b.error, null);
    assert.equal(b.count, 5);
    assert.equal(b.query, "achados shopee");
  });
});

describe("identificadores do lote", () => {
  it("buildShopeeBatchId gera um lote com prefixo shopee-", () => {
    const id = buildShopeeBatchId();
    assert.match(id, /^shopee-[a-z0-9]+$/);
  });

  it("buildShopeeReviewId é determinístico para mesma URL+chat", () => {
    const a = buildShopeeReviewId("https://shopee.com.br/product/1/2", 42);
    const b = buildShopeeReviewId("https://shopee.com.br/product/1/2", 42);
    assert.equal(a, b);
    assert.match(a, /^affprev-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("runShopeeCommand — lote completo", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalAllowed: string | undefined;
  let savedReviews: any[] = [];
  let telegramModule: typeof telegramBotModule;
  let clientModule: TermClientModule;

  beforeEach(async () => {
    clientModule = await import("../server/commercial/affiliate/shopeeApiClient");
    originalFetch = globalThis.fetch;
    originalAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
    process.env.TELEGRAM_ALLOWED_USER_IDS = "1976526372";
    process.env.SHOPEE_AFFILIATE_APP_ID = "fake_app_id";
    process.env.SHOPEE_AFFILIATE_APP_SECRET = "fake_app_secret";

    savedReviews = [];
    telegramRepositoryModule.setTestSavePendingReview(async (review) => {
      savedReviews.push(review);
    });

    telegramModule = await import("../server/services/telegramBot");
    telegramModule.setTestTelegramSenders(async () => ({ ok: true }), async () => ({ ok: true }));
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async () => ({
      success: true,
      data: {
        normalizedUrl: "https://shopee.com.br/product/1530442944/23794344926",
        imagens: ["https://img.test/1.webp"],
        preco: 79.9,
        produto: "Produto Teste",
      },
    }));

    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: [{
        url: "https://shopee.com.br/product/1530442944/23794344926",
        shopId: "1530442944",
        itemId: "23794344926",
        title: "Produto Teste"
      }]
    }));

    globalThis.fetch = makeTermFetch() as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowed;
    telegramRepositoryModule.setTestSavePendingReview(null);
    telegramModule.setTestTelegramSenders(null, null);
    shopeeDiscoveryModule.setTestDiscoveryOverride(null);
    shopeeCmdTopo.setTestShopeeClient(null);
  });

  it("envia card do item como foto quando o scraper retorna imagens", async () => {
    let capturedPhoto: any = null;
    telegramModule.setTestTelegramSenders(null, async (chatId: any, photoUrl: any, caption: any, markup?: any) => {
        capturedPhoto = { chatId, photoUrl, caption, markup };
        return { ok: true };
    });
    const r = await runShopeeCommand("1");
    assert.equal(r.ok, 1);
    assert.notEqual(capturedPhoto, null);
    assert.match(capturedPhoto.caption, /PREVIEW SHOPEE AFFILIATE/);
    assert.equal(capturedPhoto.caption.includes("shop_id=<code>1530442944</code>"), true);
    assert.equal(capturedPhoto.caption.includes("item_id=<code>23794344926</code>"), true);
  });

  it("Gemini retorna produtos: pipeline canônico completo", async () => {
    const captured: string[] = [];
    telegramModule.setTestTelegramSenders(async (chatId: any, text: any) => { captured.push(String(text)); return { ok: true }; }, async (chatId: any, photoUrl: any, caption: any) => { captured.push(String(caption)); return { ok: true }; });

    shopeeDiscoveryModule.setTestDiscoveryOverride(async (q, limit) => ({
      success: true,
      products: Array(limit).fill({
        url: "https://shopee.com.br/product/1530442944/23794344926",
        shopId: "1530442944",
        itemId: "23794344926",
        title: "Produto Teste"
      })
    }));

    const r = await runShopeeCommand("3 cozinha");
    assert.equal(r.processed, 3);
    assert.equal(r.ok, 3);
    assert.equal(savedReviews.length, 3);
  });

  it("resposta vazia do Gemini → lote fail-closed", async () => {
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: []
    }));
    const r = await runShopeeCommand("3 cozinha");
    assert.equal(r.ok, 0);
    assert.equal(r.failed, 3);
    assert.equal(r.items.every((i) => i.reason === "no_products_found"), true);
  });

  it("erro do Gemini na busca → lote fail-closed com reason do erro", async () => {
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: false,
      products: [],
      error: "GEMINI_QUOTA_EXCEEDED"
    }));
    const r = await runShopeeCommand("3 cozinha");
    assert.equal(r.ok, 0);
    assert.equal(r.failed, 3);
    assert.equal(r.items.every((i) => i.reason === "GEMINI_QUOTA_EXCEEDED"), true);
  });
});
