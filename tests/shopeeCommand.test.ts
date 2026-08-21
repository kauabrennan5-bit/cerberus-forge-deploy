
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  parseShopeeCommand,
  buildShopeeBatchId,
  buildShopeeReviewId,
  runShopeeCommand,
  setTestShopeeLotPauseMs,
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
    setTestShopeeLotPauseMs(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowed;
    telegramRepositoryModule.setTestSavePendingReview(null);
    telegramModule.setTestTelegramSenders(null, null);
    shopeeDiscoveryModule.setTestDiscoveryOverride(null);
    shopeeCmdTopo.setTestShopeeClient(null);
    setTestShopeeLotPauseMs(null);
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

  it("usa busca oficial por termo antes do fallback externo e entrega card sem URL do administrador", async () => {
    let officialSearchCalls = 0;
    shopeeCmdTopo.setTestShopeeClient({
      searchOffers: async () => {
        officialSearchCalls += 1;
        return {
          ok: true,
          items: [{
            shopId: "1530442944",
            itemId: "23794344926",
            name: "Luminária Bauhaus",
            price: 79.9,
            productLink: "https://shopee.com.br/product/1530442944/23794344926",
            offerLink: "https://s.shopee.com.br/TESTE",
          }],
          httpStatus: 200,
          error: null,
        };
      },
      acquireAffiliateLink: async () => ({
        status: "link_acquired",
        shopId: "1530442944",
        itemId: "23794344926",
        name: "Luminária Bauhaus",
        productLink: "https://shopee.com.br/product/1530442944/23794344926",
        affiliateUrl: "https://s.shopee.com.br/TESTE",
      }),
    } as any);
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => {
      throw new Error("fallback externo não deveria ser chamado");
    });

    const result = await runShopeeCommand("1 luminária bauhaus");

    assert.equal(result.ok, 1);
    assert.equal(result.discoveryRounds, 1);
    assert.equal(officialSearchCalls, 1);
    assert.equal(result.items[0]?.status, "ok");
  });

  it("deduplica candidatos repetidos sem criar cards duplicados", async () => {
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
    assert.equal(r.ok, 1);
    assert.equal(r.searchExhausted, true);
    assert.equal(savedReviews.length, 1);
    assert.equal(r.items.filter((item) => item.reason === "duplicate_candidate").length, 0);
    assert.equal(r.poolCandidates, 1);
  });

  it("faz over-fetch e substitui candidato não elegível pelo próximo candidato válido", async () => {
    let requestedLimit = 0;
    shopeeDiscoveryModule.setTestDiscoveryOverride(async (_query, limit) => {
      requestedLimit = limit;
      return {
        success: true,
        products: [
          { url: "https://shopee.com.br/product/1530442944/11111111111", shopId: "1530442944", itemId: "11111111111", title: "Indisponível" },
          { url: "https://shopee.com.br/product/1530442944/23794344926", shopId: "1530442944", itemId: "23794344926", title: "Produto Teste" },
        ],
      };
    });
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        itemId === "11111111111"
          ? { status: "not_found" }
          : {
              status: "link_acquired",
              shopId: "1530442944",
              itemId: "23794344926",
              name: "Produto Teste",
              productLink: "https://shopee.com.br/product/1530442944/23794344926",
              affiliateUrl: "https://s.shopee.com.br/TESTE",
            },
    } as any);

    const result = await runShopeeCommand("1 cozinha");

    assert.equal(requestedLimit, 3);
    assert.equal(result.ok, 1);
    assert.equal(result.candidatesExamined, 2);
    assert.equal(result.items[0]?.reason, "not_found");
    assert.equal(result.items[1]?.status, "ok");
    assert.equal(savedReviews.length, 1);
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

  it("N=3 substitui dois NOT_FOUND por três candidatos válidos", async () => {
    const ids = ["11111111111", "22222222222", "33333333333", "44444444444", "55555555555"];
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: ids.map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })),
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        ids.slice(0, 2).includes(itemId)
          ? { status: "not_found" }
          : { status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" },
    } as any);

    const result = await runShopeeCommand("3 cozinha");
    assert.equal(result.ok, 3);
    assert.equal(result.candidatesExamined, 5);
    assert.equal(result.rejectedCandidates, 2);
    assert.equal(result.discoveryRounds, 1);
  });

  it("N=5 substitui seis rejeições por cinco candidatos válidos", async () => {
    const ids = Array.from({ length: 11 }, (_, index) => String(11111111111 + index));
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: ids.map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })),
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        ids.slice(0, 6).includes(itemId)
          ? { status: "not_found" }
          : { status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" },
    } as any);

    const result = await runShopeeCommand("5 cozinha");
    assert.equal(result.ok, 5);
    assert.equal(result.candidatesExamined, 11);
    assert.equal(result.rejectedCandidates, 6);
  });

  it("NOT_ELIGIBLE não consome slot e libera o próximo candidato", async () => {
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: ["11111111111", "22222222222"].map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })),
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        itemId === "11111111111"
          ? { status: "not_eligible" }
          : { status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" },
    } as any);

    const result = await runShopeeCommand("1 cozinha");
    assert.equal(result.ok, 1);
    assert.equal(result.items[0]?.reason, "not_eligible");
    assert.equal(result.candidatesExamined, 2);
  });

  it("quinze candidatos com cinco válidos entregam exatamente cinco cards", async () => {
    const ids = Array.from({ length: 15 }, (_, index) => String(21111111111 + index));
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: ids.map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })),
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        ids.slice(0, 10).includes(itemId)
          ? { status: "not_found" }
          : { status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" },
    } as any);

    const result = await runShopeeCommand("5 cozinha");
    assert.equal(result.ok, 5);
    assert.equal(result.candidatesExamined, 15);
    assert.equal(result.rejectedCandidates, 10);
    assert.equal(result.poolCandidates, 15);
  });

  it("todos os candidatos rejeitados terminam sem card falso e com resumo explícito", async () => {
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: Array.from({ length: 5 }, (_, index) => {
        const itemId = String(31111111111 + index);
        return { url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" };
      }),
    }));
    shopeeCmdTopo.setTestShopeeClient({ acquireAffiliateLink: async () => ({ status: "not_found" }) } as any);

    const result = await runShopeeCommand("5 cozinha");
    assert.equal(result.ok, 0);
    assert.equal(result.rejectedCandidates, 5);
    assert.equal(result.poolLocalExhausted, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.items.every((item) => item.status === "affiliate_not_eligible"), true);
  });

  it("executa nova rodada quando o pool inicial é insuficiente e elimina duplicatas entre rounds", async () => {
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    let calls = 0;
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => {
      calls += 1;
      const ids = calls === 1 ? ["11111111111"] : ["11111111111", "22222222222", "33333333333"];
      return { success: true, products: ids.map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })) };
    });
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) => ({ status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" }),
    } as any);

    const result = await runShopeeCommand("3 cozinha");
    assert.equal(result.ok, 3);
    assert.equal(result.discoveryRounds, 2);
    assert.equal(result.poolCandidates, 3);
    assert.equal(calls, 2);
    assert.equal(result.items.some((item) => item.reason === "duplicate_candidate"), false);
  });

  it("termina incompleto somente após esgotar o orçamento de discovery", async () => {
    let calls = 0;
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => {
      calls += 1;
      return { success: true, products: [] };
    });

    const result = await runShopeeCommand("3 cozinha");
    assert.equal(result.ok, 0);
    assert.equal(result.poolLocalExhausted, true);
    assert.equal(result.sourceExhausted, false);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.discoveryRounds, 3);
    assert.equal(calls, 3);
  });

  it("foto com ok:false usa fallback texto e só conta a confirmação lógica do texto", async () => {
    let photoCalls = 0;
    let messageCalls = 0;
    telegramModule.setTestTelegramSenders(
      async () => { messageCalls += 1; return { ok: true }; },
      async () => { photoCalls += 1; return { ok: false, description: "PHOTO_INVALID" }; },
    );

    const result = await runShopeeCommand("1");
    assert.equal(result.ok, 1);
    assert.equal(photoCalls, 1);
    assert.equal(messageCalls >= 3, true);
  });

  it("foto e texto com ok:false não contam card e permitem replacement", async () => {
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" },
    }));
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: ["11111111111", "22222222222"].map((itemId) => ({ url: `https://shopee.com.br/product/1530442944/${itemId}`, shopId: "1530442944", itemId, title: "Produto Teste" })),
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) => ({ status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" }),
    } as any);
    telegramModule.setTestTelegramSenders(async () => ({ ok: false, description: "MESSAGE_REJECTED" }), async () => ({ ok: false, description: "PHOTO_REJECTED" }));

    const result = await runShopeeCommand("1 cozinha");
    assert.equal(result.ok, 0);
    assert.equal(result.candidatesExamined, 2);
    assert.equal(result.items.every((item) => item.status === "telegram_send_failed"), true);
    assert.equal(result.budgetExhausted, true);
  });

  it("sendMessage com ok:false não conta card quando o candidato não tem imagem de entrega", async () => {
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => ({
      success: true,
      data: { normalizedUrl: url, imagens: [], preco: 79.9, produto: "Produto Sem Foto" },
    }));
    telegramModule.setTestTelegramSenders(async () => ({ ok: false, description: "MESSAGE_REJECTED" }), async () => ({ ok: true }));

    const result = await runShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926");
    assert.equal(result.ok, 0);
    assert.equal(result.sourceExhausted, true);
    assert.equal(result.items[0]?.status, "telegram_send_failed");
  });

  it("substitui rejeições mistas de identidade, Affiliate, scraper e Telegram até entregar N", async () => {
    const paModule = await import("../server/services/productAutomation");
    paModule.setTestExtractProductForReview(async (url) => {
      if (url.endsWith("33333333333")) return { success: false, error: "scraper_blocked" };
      return { success: true, data: { normalizedUrl: url, imagens: ["https://img.test/1.webp"], preco: 79.9, produto: "Produto Teste" } };
    });
    shopeeDiscoveryModule.setTestDiscoveryOverride(async () => ({
      success: true,
      products: [
        { url: "https://shopee.com.br/search?q=sem-identidade", shopId: null, itemId: null, title: "Inválido" },
        { url: "https://shopee.com.br/product/1530442944/22222222222", shopId: "1530442944", itemId: "22222222222", title: "Affiliate" },
        { url: "https://shopee.com.br/product/1530442944/33333333333", shopId: "1530442944", itemId: "33333333333", title: "Scraper" },
        { url: "https://shopee.com.br/product/1530442944/44444444444", shopId: "1530442944", itemId: "44444444444", title: "Telegram" },
        { url: "https://shopee.com.br/product/1530442944/55555555555", shopId: "1530442944", itemId: "55555555555", title: "Válido" },
      ],
    }));
    shopeeCmdTopo.setTestShopeeClient({
      acquireAffiliateLink: async ({ itemId }: { itemId: string }) =>
        itemId === "22222222222"
          ? { status: "not_found" }
          : { status: "link_acquired", shopId: "1530442944", itemId, name: "Produto Teste", productLink: `https://shopee.com.br/product/1530442944/${itemId}`, affiliateUrl: "https://s.shopee.com.br/TESTE" },
    } as any);
    let photoAttempts = 0;
    telegramModule.setTestTelegramSenders(async (_chatId, text) => ({ ok: !String(text).includes("PREVIEW SHOPEE AFFILIATE") || photoAttempts > 1 }), async () => {
      photoAttempts += 1;
      return photoAttempts === 1 ? { ok: false, description: "PHOTO_REJECTED" } : { ok: true };
    });

    const result = await runShopeeCommand("1 cozinha");
    assert.equal(result.ok, 1);
    assert.equal(result.candidatesExamined, 5);
    assert.equal(result.rejectedCandidates, 4);
    assert.equal(result.items.map((item) => item.status).join(","), "discovery_failed,affiliate_not_eligible,scraper_enrichment_failed,telegram_send_failed,ok");
  });
});
