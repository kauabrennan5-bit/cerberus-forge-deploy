import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  parseShopeeCommand,
  buildShopeeBatchId,
  buildShopeeReviewId,
  runShopeeCommand,
} from "../server/services/shopeeCommand";
import * as telegramBotModule from "../server/services/telegramBot";
import * as telegramRepositoryModule from "../server/repositories/telegramRepository";
import * as discoveryModule from "../server/commercial/discovery/fetchShared";

// ---------------------------------------------------------------------------
// Mocks via globalThis.fetch (padrão do projeto) + overrides de módulo.
// O orquestrador usa o fetch global para Affiliate API e Telegram;
// a persistência usa Supabase (que também passa pelo fetch global —
// com fetch mockado, savePendingReview fail-safe grava só no backup local,
// então validamos presença via monkey-patch de savePendingReview).
// ---------------------------------------------------------------------------
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
    // "3.5" é truncado a 3 pelo parseInt (mesmo comportamento do dispatcher
    // legado): o validator de inteiro entre 1–10 aceita.
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

describe("runShopeeCommand — rejeição e ambiente", () => {
  it("rejeita sintaxe sem executar nada", async () => {
    const r = await runShopeeCommand("");
    assert.equal(r.processed, 0);
    assert.equal(r.ok, 0);
    assert.equal(r.failed, 0);
    assert.deepEqual(r.items, []);
  });

  it("reporta ambiente incompleto (sem credenciais Affiliate) com zero consultas", async () => {
    const origAppId = process.env.SHOPEE_AFFILIATE_APP_ID;
    const origAppSecret = process.env.SHOPEE_AFFILIATE_APP_SECRET;
    const origSecret2 = process.env.SHOPEE_APP_SECRET;
    const origId2 = process.env.SHOPEE_APP_ID;
    // TELEGRAM_ALLOWED_USER_IDS é mantida: o teste valida SOMENTE a ausência
    // das credenciais da Affiliate API (o contrato falha por item, sem consultas).
    const origAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
    process.env.TELEGRAM_ALLOWED_USER_IDS = "1976526372";
    delete process.env.SHOPEE_AFFILIATE_APP_ID;
    delete process.env.SHOPEE_AFFILIATE_APP_SECRET;
    delete process.env.SHOPEE_APP_ID;
    delete process.env.SHOPEE_APP_SECRET;
    try {
      const r = await runShopeeCommand("3 termo");
      assert.equal(r.processed, 0);
      assert.equal(r.failed, 3);
      assert.equal(r.affiliateClientAvailable, false);
      assert.equal(r.chatTargetConfigured, true);
      assert.equal(
        r.items.every((i) => i.status === "discovery_failed" && i.reason === "affiliate_auth_unavailable"),
        true,
      );
    } finally {
      process.env.TELEGRAM_ALLOWED_USER_IDS = origAllowed;
      process.env.SHOPEE_AFFILIATE_APP_ID = origAppId;
      process.env.SHOPEE_AFFILIATE_APP_SECRET = origAppSecret;
      process.env.SHOPEE_APP_ID = origId2;
      process.env.SHOPEE_APP_SECRET = origSecret2;
    }
  });
});

describe("runShopeeCommand — lote completo", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalAllowed: string | undefined;
  let savedReviews: any[] = [];
  let telegramModule: typeof telegramBotModule;

  beforeEach(async () => {
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

    // Supabase desativado nos testes (falha → backup local apenas).
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) {
        return AFFILIATE_RESPONSE as unknown as Response;
      }
      // Página de busca Shopee (connector) — HTML com links de produto.
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<html><body><a href="https://shopee.com.br/product/1530442944/23794344926">Produto Teste</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowed;
    telegramRepositoryModule.setTestSavePendingReview(null);
    telegramModule.setTestTelegramSenders(null, null);
    discoveryModule.discoveryRateLimiter.reset();
    discoveryModule.discoveryCircuitBreaker.reset();
  });

  it("envia card do item como foto quando o scraper retorna imagens", async () => {
    let capturedPhoto: any = null;
    telegramModule.setTestTelegramSenders(null, async (chatId: any, photoUrl: any, caption: any, markup?: any) => {
        capturedPhoto = { chatId, photoUrl, caption, markup };
        return { ok: true };
    });
    const r = await runShopeeCommand("1");
    assert.equal(r.processed, 1);
    assert.equal(r.ok, 1);
    assert.equal(r.failed, 0);
    assert.notEqual(capturedPhoto, null);
    assert.match(capturedPhoto.caption, /PREVIEW SHOPEE AFFILIATE/);
    assert.equal(capturedPhoto.caption.includes("shop_id=<code>1530442944</code>"), true);
    assert.equal(capturedPhoto.caption.includes("item_id=<code>23794344926</code>"), true);
    assert.match(capturedPhoto.caption, /LOTE/i);
    // Teclado de decisão humana: aprovação obrigatória.
    const kb = capturedPhoto.markup?.inline_keyboard;
    assert.equal(kb[0][0].callback_data.startsWith("approve_only:"), true);
    assert.equal(kb[1][0].callback_data.startsWith("cancel_rev:"), true);
    // Persistência no Supabase (via savePendingReview).
    assert.equal(savedReviews.length, 1);
    assert.equal(savedReviews[0].status, "pending");
    assert.equal(savedReviews[0].preco, 79.9);
    assert.equal(savedReviews[0].imagens.length, 1);
    assert.equal(savedReviews[0].existingProduct.priceScaleVerified, false);
    assert.match(savedReviews[0].descricao, /batch=/);
    assert.match(savedReviews[0].descricao, /position=1/);
    // Card final do lote enviado.
  });

  it("persiste o offerLink oficial na review e no card", async () => {
    let capturedPhoto: any = null;
    telegramModule.setTestTelegramSenders(null, async (chatId: any, photoUrl: any, caption: any, markup?: any) => {
        capturedPhoto = { chatId, photoUrl, caption, markup };
        return { ok: true };
    });
    await runShopeeCommand("1");
    assert.equal(savedReviews[0].existingProduct.affiliateUrl, "https://s.shopee.com.br/TESTE");
    assert.equal(capturedPhoto.caption.includes("s.shopee.com.br/TESTE"), true);
    assert.equal(savedReviews[0].normalizedUrl, "https://shopee.com.br/product/1530442944/23794344926");
  });

  it("preserva a escala NÃO verificada do preço no card (jamais rotula moeda)", async () => {
    let capturedPhoto: any = null;
    telegramModule.setTestTelegramSenders(null, async (chatId: any, photoUrl: any, caption: any, markup?: any) => {
        capturedPhoto = { chatId, photoUrl, caption, markup };
        return { ok: true };
    });
    await runShopeeCommand("1");
    assert.match(capturedPhoto.caption, /escala não verificada/);
    assert.match(capturedPhoto.caption, /observacional/);
    assert.equal(capturedPhoto.caption.includes("R$"), false);
    // Nem no texto da review o preço é apresentado como comprovado.
    assert.match(savedReviews[0].descricao, /preço exibido observacional/);
  });
});

describe("runShopeeCommand — fail-closed por item", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalAllowed: string | undefined;
  let savedReviews: any[] = [];
  let telegramModule: typeof telegramBotModule;

  beforeEach(async () => {
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
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowed;
    telegramRepositoryModule.setTestSavePendingReview(null);
    telegramModule.setTestTelegramSenders(null, null);
    discoveryModule.discoveryRateLimiter.reset();
    discoveryModule.discoveryCircuitBreaker.reset();
  });

  it("discovery sem links → lote falho sem card e sem review", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) return AFFILIATE_RESPONSE as unknown as Response;
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () => "<html><body>nenhum link</body></html>",
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("3");
    assert.equal(r.ok, 0);
    assert.equal(r.failed, 3);
    assert.equal(r.items.every((i) => i.status === "discovery_failed"), true);
    assert.equal(savedReviews.length, 0);
  });

  it("item não elegível na Affiliate API → sem card e sem review, com notificação", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { productOfferV2: { nodes: [] } } }),
        } as unknown as Response;
      }
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<html><body><a href="https://shopee.com.br/product/1/2">Produto</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("1");
    assert.equal(r.ok, 0);
    assert.equal(r.items[0].status, "affiliate_not_eligible");
    assert.equal(savedReviews.length, 0);
  });

  it("scraper com identidade divergente → falha fechada (sem card, sem review)", async () => {
    const automation = await import("../server/services/productAutomation");
    automation.setTestExtractProductForReview(async () => ({
      success: true,
      data: {
        normalizedUrl: "https://shopee.com.br/product/9999999999/9999999999",
        imagens: [],
        preco: 10,
        produto: "divergente",
      },
    }));
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) return AFFILIATE_RESPONSE as unknown as Response;
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<html><body><a href="https://shopee.com.br/product/1530442944/23794344926">Produto</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("1");
    assert.equal(r.ok, 0);
    assert.equal(r.items[0].status, "scraper_enrichment_failed");
    assert.equal(savedReviews.length, 0);
    automation.setTestExtractProductForReview(null);
  });

  it("falha do scraper genérica → falha fechada sem inventar dados", async () => {
    const automation = await import("../server/services/productAutomation");
    automation.setTestExtractProductForReview(async () => ({
      success: false,
      error: "scraper_extraction_failed",
    }));
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) return AFFILIATE_RESPONSE as unknown as Response;
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<html><body><a href="https://shopee.com.br/product/1530442944/23794344926">Produto</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("1");
    assert.equal(r.ok, 0);
    assert.equal(r.items[0].status, "scraper_enrichment_failed");
    assert.equal(savedReviews.length, 0);
    automation.setTestExtractProductForReview(null);
  });

  it("URL de discovery sem identificadores → item falho, sem card", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) return AFFILIATE_RESPONSE as unknown as Response;
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () => `<html><body><a href="https://shopee.com.br/termo">termo</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("1");
    assert.equal(r.ok, 0);
    assert.equal(r.items[0].status, "discovery_failed");
    assert.equal(savedReviews.length, 0);
  });

  it("lote heterogêneo: item bom passa, item sem identidade NÃO consulta a Affiliate API", async () => {
    const queried: string[] = [];
    const automation = await import("../server/services/productAutomation");
    automation.setTestExtractProductForReview(async () => {
      return {
        success: true,
        data: {
          normalizedUrl: "https://shopee.com.br/product/1530442944/23794344926",
          imagens: ["https://img.test/1.webp"],
          preco: 79.9,
          produto: "Produto",
        },
      };
    });
    const initBody = (i: any[]): string | null =>
      i && i.length > 1 && i[1] && typeof i[1].body === "string" ? i[1].body : null;
    globalThis.fetch = (async (...iargs: any[]) => {
      const input = iargs[0];
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) {
        const body = input instanceof Request
          ? await input.text()
          : String(initBody(iargs) ?? "");
        const m = /itemId:\s*(\d+),\s*shopId:\s*(\d+)/.exec(body);
        queried.push(m ? `${m[2]}/${m[1]}` : `unknown(body=${JSON.stringify(body)})`);
        return AFFILIATE_RESPONSE as unknown as Response;
      }
      if (url.includes("shopee.com.br")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<html><body><a href="https://shopee.com.br/product/1530442944/23794344926">Produto</a><a href="https://shopee.com.br/termo">termo</a></body></html>`,
          headers: { get: () => "text/html" },
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    const r = await runShopeeCommand("2");
    assert.equal(r.ok, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.items[1].status, "discovery_failed");
    // A aquisição oficial NUNCA foi chamada com item sem identidade.
    assert.deepEqual(queried, ["1530442944/23794344926"]);
    assert.equal(savedReviews.length, 1);
    automation.setTestExtractProductForReview(null);
  });
});

describe("runShopeeCommand — modo URL direta (shopee.com.br bloqueia /search com 403)", () => {
  const savedReviews: any[] = [];
  const telegramMessages: { chatId: number; text: string; photo?: boolean }[] = [];
  let discoveryReset = false;
  // setTestShopeeClient é resolvido por import dinâmico no beforeEach (não é
  // possível await de módulo no topo de describe com esbuild/tsx).
  let setTestShopeeClient: (c: any) => void = () => undefined;

  beforeEach(async () => {
    savedReviews.length = 0;
    telegramMessages.length = 0;
    const repo = await import("../server/repositories/telegramRepository");
    repo.setTestSavePendingReview(async (review: any) => {
      savedReviews.push(review);
      return review;
    });
    const capture = (photo: boolean) =>
      async (chatId: number | string, ...rest: any[]) => {
        // sendPhoto(chatId, photoUrl, caption, markup) — a legenda é o 2º arg.
        const text = typeof rest[1] === "string" ? rest[1] : typeof rest[0] === "string" ? rest[0] : "";
        telegramMessages.push({ chatId: Number(chatId), text, photo });
        return { ok: true } as any;
      };
    telegramBotModule.setTestTelegramSenders(capture(false), capture(true));
    discoveryModule.discoveryRateLimiter.reset();
    discoveryModule.discoveryCircuitBreaker.reset();
    discoveryReset = true;
    process.env.TELEGRAM_ALLOWED_USER_IDS = "1976526372";
    // Cliente Affiliate injetável via setTestShopeeClient (sem depender de
    // process.env, que sofre corrida quando suítes rodam em paralelo).
    const cmd = await import("../server/services/shopeeCommand");
    setTestShopeeClient = cmd.setTestShopeeClient;
    setTestShopeeClient({
      lookupProduct: async () => ({ status: "link_acquired", affiliateUrl: "https://s.shopee.com.br/TESTE", productLink: "https://shopee.com.br/product/1530442944/23794344926", shopId: "1530442944", itemId: "23794344926", name: "Produto Teste", raw: null, error: null }) as any,
      acquireAffiliateLink: async () => ({ status: "link_acquired", affiliateUrl: "https://s.shopee.com.br/TESTE", productLink: "https://shopee.com.br/product/1530442944/23794344926", shopId: "1530442944", itemId: "23794344926", name: "Produto Teste", raw: null, error: null }) as any,
      generateShortLink: async () => ({ status: "link_acquired", shortLink: "https://s.shopee.com.br/TESTE", longLink: null, error: null }) as any,
    });
    const automation = await import("../server/services/productAutomation");
    automation.setTestExtractProductForReview(async () => {
      return {
        success: true,
        data: {
          normalizedUrl: "https://shopee.com.br/product/1530442944/23794344926",
          imagens: ["https://img.test/1.webp"],
          preco: 79.9,
          produto: "Produto Teste",
        },
      };
    });
  });

  afterEach(async () => {
    process.env.SHOPEE_AFFILIATE_APP_ID = "";
    process.env.SHOPEE_AFFILIATE_APP_SECRET = "";
    process.env.SHOPEE_APP_ID = "";
    process.env.SHOPEE_APP_SECRET = "";
    setTestShopeeClient(null);
    telegramBotModule.setTestTelegramSenders(null, null);
    if (discoveryReset) {
      discoveryModule.discoveryRateLimiter.reset();
      discoveryModule.discoveryCircuitBreaker.reset();
    }
  });

  it("parseShopeeCommand entra no modo urls quando os argumentos são URLs Shopee", () => {
    const a = parseShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926");
    assert.equal(a.error, null);
    assert.equal(a.mode, "urls");
    assert.deepEqual(a.urls, ["https://shopee.com.br/product/1530442944/23794344926"]);
    // query registrada é a lista canônica (para o card do lote)
    assert.match(a.query, /1530442944/);

    const b = parseShopeeCommand("2 https://shopee.com.br/product/1/2 https://shopee.com.br/product/3/4");
    assert.equal(b.mode, "urls");
    assert.equal(b.count, 2);
    assert.equal(b.urls.length, 2);

    // URL não-Shopee mantém o modo termo (nada inventado — continua fail-closed via busca)
    const c = parseShopeeCommand("1 https://www.google.com/search?q=x");
    assert.equal(c.mode, "term");
    assert.equal(c.urls?.length ?? 0, 0);
    // URL sem identificadores também não entra no modo urls
    const d = parseShopeeCommand("1 https://shopee.com.br/termo");
    assert.equal(d.mode, "term");
  });

  it("URL com query string e trailing slash é normalizada para o padrão canônico", () => {
    const a = parseShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926?abc=1#frag");
    assert.equal(a.mode, "urls");
    assert.deepEqual(a.urls, ["https://shopee.com.br/product/1530442944/23794344926"]);

    const b = parseShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926/");
    assert.equal(b.mode, "urls");
    assert.deepEqual(b.urls, ["https://shopee.com.br/product/1530442944/23794344926"]);
  });

    it("lote por URL direta: discovery determinística, aquisição oficial, scraper e card como foto", async () => {
    // O cliente mock registra as consultas oficiais (substitui o fetch de teste).
    const queried: string[] = [];
    const mockAcquisition = {
      status: "link_acquired",
      affiliateUrl: "https://s.shopee.com.br/TESTE",
      productLink: "https://shopee.com.br/product/1530442944/23794344926",
      shopId: "1530442944",
      itemId: "23794344926",
      name: "Produto Teste",
      raw: null,
      error: null,
    } as any;
    setTestShopeeClient({
      lookupProduct: async () => mockAcquisition,
      acquireAffiliateLink: async (params: any) => {
        if (params?.shopId && params?.itemId) queried.push(`${params.shopId}/${params.itemId}`);
        return mockAcquisition;
      },
      generateShortLink: async () => ({ status: "link_acquired", shortLink: "https://s.shopee.com.br/TESTE", longLink: null, error: null }) as any,
    });
    const r = await runShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926");
    assert.equal(r.ok, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.items[0].status, "ok");
    assert.equal(r.items[0].publicUrl, "https://shopee.com.br/product/1530442944/23794344926");
    assert.equal(r.items[0].shopId, "1530442944");
    assert.equal(r.items[0].itemId, "23794344926");
    // NENHUMA busca pública: a única chamada foi a aquisição oficial do item.
    assert.deepEqual(queried, ["1530442944/23794344926"]);
    // Card enviado como foto (scraper retornou imagem) e offerLink preservado.
    const photos = telegramMessages.filter((m) => m.photo);
    assert.equal(photos.length, 1);
    assert.match(photos[0].text, /40ftCq|s\.shopee\.com\.br\/TESTE/);
    assert.equal(savedReviews.length, 1);
    assert.equal(savedReviews[0].existingProduct.affiliateUrl, "https://s.shopee.com.br/TESTE");
  });

  it("mais itens solicitados do que URLs: lote fecha fail-closed com aviso e motivo", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("open-api.affiliate.shopee")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { productOfferV2: { nodes: [] } } }),
        } as unknown as Response;
      }
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    setTestShopeeClient({
      lookupProduct: async () => ({ status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, raw: null, error: null }) as any,
      acquireAffiliateLink: async () => ({ status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, raw: null, error: null }) as any,
      generateShortLink: async () => ({ status: "link_acquired", shortLink: null, longLink: null, error: null }) as any,
    });
    const r = await runShopeeCommand("2 https://shopee.com.br/product/1530442944/23794344926");
    // posição 1 foi registrada; posição 2 ficou sem URL → url_missing_for_position
    assert.equal(r.items.length, 2);
    assert.equal(r.items[1].status, "discovery_failed");
    assert.equal(r.items[1].reason, "url_missing_for_position");
    // Aviso do lote com o motivo exato enviado ao Telegram (nada inventado)
    const avisos = telegramMessages.filter((m) => m.text.includes("url_missing_for_position"));
    assert.equal(avisos.length, 1);
    assert.equal(savedReviews.length, 0);
  });

  it("modo urls não consulta a busca pública mesmo quando /search está bloqueado", async () => {
    let searchCalled = false;
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("shopee.com.br/search")) searchCalled = true;
      if (url.includes("open-api.affiliate.shopee")) return AFFILIATE_RESPONSE as unknown as Response;
      throw new Error(`fetch inesperado: ${url}`);
    }) as typeof globalThis.fetch;
    await runShopeeCommand("1 https://shopee.com.br/product/1530442944/23794344926");
    assert.equal(searchCalled, false);
  });
});
