import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildShopeeBatchId,
  buildShopeeReviewId,
  parseShopeeCommand,
  runShopeeCommand,
  setTestShopeeClient,
  setTestShopeeIdentityChecker,
  setTestShopeeLotPauseMs,
} from "../server/services/shopeeCommand";
import { setTestTelegramSenders } from "../server/services/telegramBot";
import { setTestSavePendingReview } from "../server/repositories/telegramRepository";
import { setTestExtractProductForReview } from "../server/services/productAutomation";
import { setTestSearchProvider } from "../server/services/shopeeDiscovery";
import {
  inspectShopeeProviderEnv,
  safeShopeeLog,
  searchShopeeOffersWithRetry,
  ShopeeProviderRuntimeError,
} from "../server/services/shopeeProviderRuntime";

const SHOP_ID = "1530442944";
const ITEM_1 = "23794344926";
const ITEM_2 = "23794344927";
const PRODUCT_1 = `https://shopee.com.br/Luminaria-Bauhaus-i.${SHOP_ID}.${ITEM_1}`;
const PRODUCT_2 = `https://shopee.com.br/Luminaria-Cogumelo-i.${SHOP_ID}.${ITEM_2}`;
const IMAGE_1 = "https://img.example.com/lamp-1.webp";
const IMAGE_2 = "https://img.example.com/lamp-2.webp";

const originalEnv = {
  allowed: process.env.TELEGRAM_ALLOWED_USER_IDS,
  appId: process.env.SHOPEE_APP_ID,
  appSecret: process.env.SHOPEE_APP_SECRET,
  legacyAppId: process.env.SHOPEE_AFFILIATE_APP_ID,
  legacyAppSecret: process.env.SHOPEE_AFFILIATE_APP_SECRET,
  baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL,
};

function restoreEnv(name: keyof typeof process.env, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function offer(itemId: string, productLink: string, imageUrl = IMAGE_1) {
  return {
    shopId: SHOP_ID,
    itemId,
    name: itemId === ITEM_1 ? "Luminária Bauhaus de mesa" : "Luminária cogumelo de mesa",
    price: itemId === ITEM_1 ? 79.9 : 89.9,
    productLink,
    offerLink: `https://s.shopee.com.br/offer-${itemId.slice(-4)}`,
    imageUrl,
  };
}

function successAcquisition(itemId: string, productLink: string, values: Record<string, any> = {}) {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
  return {
    status: "link_acquired",
    affiliateUrl: `https://s.shopee.com.br/aff-${itemId.slice(-4)}`,
    productLink,
    shopId: SHOP_ID,
    itemId,
    name: has("name") ? values.name : (itemId === ITEM_1 ? "Luminária Bauhaus de mesa" : "Luminária cogumelo de mesa"),
    price: has("price") ? values.price : (itemId === ITEM_1 ? 79.9 : 89.9),
    imageUrl: has("imageUrl") ? values.imageUrl : (itemId === ITEM_2 ? IMAGE_2 : IMAGE_1),
    raw: null,
    error: null,
  };
}

function validReviewData(normalizedUrl: string) {
  const second = normalizedUrl.includes(ITEM_2);
  return {
    normalizedUrl,
    imagens: [second ? IMAGE_2 : IMAGE_1],
    imagensOriginais: [second ? IMAGE_2 : IMAGE_1],
    preco: second ? 89.9 : 79.9,
    rawTitle: second ? "Luminária cogumelo observada no anúncio" : "Luminária Bauhaus observada no anúncio",
    displayTitle: second ? "Luminária Cogumelo Retrô" : "Luminária de Mesa Bauhaus",
    produto: second ? "Luminária cogumelo observada no anúncio" : "Luminária Bauhaus observada no anúncio",
    descricao: "Luminária de apoio com construção compacta, acabamento verificável e proporções adequadas para interiores.",
    categoria: "Iluminação",
    imageEditorialStatus: "clean" as const,
  };
}

function clientWithOffers(items: any[], options: {
  search?: () => Promise<any>;
  acquire?: (input: { shopId: string; itemId: string }) => Promise<any>;
  lookup?: (input: { shopId: string; itemId: string }) => Promise<any>;
  discoveryState?: "DDG_OK" | "DDG_BLOCKED" | "DDG_UNAVAILABLE" | "DDG_NO_RESULTS";
} = {}) {
  const discoveryState = options.discoveryState ?? "DDG_OK";
  setTestSearchProvider(async () => ({
    provider: "duckduckgo",
    state: discoveryState,
    httpStatus: discoveryState === "DDG_OK" ? 200 : null,
    reason: discoveryState === "DDG_OK" ? null : discoveryState.toLowerCase(),
    candidates: discoveryState === "DDG_OK"
      ? items.map(item => ({
          url: `https://shopee.com.br/product/${item.shopId}/${item.itemId}`,
          shopId: item.shopId,
          itemId: item.itemId,
          rawTitle: `DDG NÃO CANÔNICO ${item.itemId}`,
        }))
      : [],
  }));
  return {
    searchOffers: options.search || (async () => ({ ok: true, items, httpStatus: 200, error: null, reason: null })),
    acquireAffiliateLink: options.acquire || (async ({ itemId }: { shopId: string; itemId: string }) => {
      const found = items.find((item) => item.itemId === itemId);
      return found
        ? successAcquisition(itemId, found.productLink, found)
        : { status: "not_found", affiliateUrl: null, productLink: null, shopId: null, itemId: null, name: null, price: null, imageUrl: null, raw: null, error: null };
    }),
    lookupProduct: options.lookup || (async ({ itemId }: { shopId: string; itemId: string }) => {
      const found = items.find(item => item.itemId === itemId);
      return found
        ? { status: "found", shopId: found.shopId, itemId: found.itemId, name: found.name, priceMinorUnits: found.price, productLink: found.productLink, imageUrl: found.imageUrl, httpStatus: 200, raw: null, error: null }
        : { status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, imageUrl: null, httpStatus: 200, raw: null, error: null };
    }),
    inspectPromotionFields: async () => ({ ok: false, nodeType: null, fields: [], reason: "not_tested" }),
    inspectPromotionOffer: async () => ({ ok: false, values: null, reason: "not_tested" }),
  } as any;
}

let savedReviews: any[] = [];
let textMessages: Array<{ text: string; markup: any }> = [];
let photoMessages: Array<{ photo: string; caption: string; markup: any }> = [];

beforeEach(() => {
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123456";
  delete process.env.SHOPEE_APP_ID;
  delete process.env.SHOPEE_APP_SECRET;
  delete process.env.SHOPEE_AFFILIATE_APP_ID;
  delete process.env.SHOPEE_AFFILIATE_APP_SECRET;
  delete process.env.SHOPEE_AFFILIATE_API_BASE_URL;

  savedReviews = [];
  textMessages = [];
  photoMessages = [];
  setTestShopeeLotPauseMs(0);
  setTestShopeeIdentityChecker(async () => false);
  setTestSavePendingReview(async review => { savedReviews.push(review); });
  setTestTelegramSenders(
    async (_chatId, text, markup) => {
      textMessages.push({ text: String(text), markup });
      return { ok: true };
    },
    async (_chatId, photo, caption, markup) => {
      photoMessages.push({ photo: String(photo), caption: String(caption), markup });
      return { ok: true };
    },
  );
  setTestExtractProductForReview(async (url: string) => ({ success: true, data: validReviewData(url) as any }));
  setTestSearchProvider(null);
});

afterEach(() => {
  setTestShopeeClient(null);
  setTestShopeeIdentityChecker(null);
  setTestShopeeLotPauseMs(null);
  setTestSavePendingReview(null);
  setTestTelegramSenders(null, null);
  setTestExtractProductForReview(null);
  setTestSearchProvider(null);
  restoreEnv("TELEGRAM_ALLOWED_USER_IDS", originalEnv.allowed);
  restoreEnv("SHOPEE_APP_ID", originalEnv.appId);
  restoreEnv("SHOPEE_APP_SECRET", originalEnv.appSecret);
  restoreEnv("SHOPEE_AFFILIATE_APP_ID", originalEnv.legacyAppId);
  restoreEnv("SHOPEE_AFFILIATE_APP_SECRET", originalEnv.legacyAppSecret);
  restoreEnv("SHOPEE_AFFILIATE_API_BASE_URL", originalEnv.baseUrl);
});

describe("parseShopeeCommand — contrato termo primeiro, quantidade por último", () => {
  it("aceita /shopee luminária 2", () => {
    assert.deepEqual(parseShopeeCommand("luminária 2"), { count: 2, query: "luminária", error: null, mode: "term", urls: [] });
  });

  it("preserva termo composto, acentos e normaliza múltiplos espaços", () => {
    const parsed = parseShopeeCommand("  mesa   lateral de   madeira   3  ");
    assert.equal(parsed.error, null);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.query, "mesa lateral de madeira");
  });

  it("aceita Unicode no termo", () => {
    const parsed = parseShopeeCommand("luminária décor retrô 1");
    assert.equal(parsed.query, "luminária décor retrô");
    assert.equal(parsed.count, 1);
  });

  it("rejeita quantidade ausente", () => {
    assert.match(parseShopeeCommand("luminária").error || "", /uso:/i);
  });

  it("rejeita último argumento textual em vez de reinterpretar o termo", () => {
    const parsed = parseShopeeCommand("luminária zero");
    assert.equal(parsed.count, 0);
    assert.match(parsed.error || "", /último argumento.*inteiro/i);
  });

  it("rejeita zero, negativo, decimal e quantidade excessiva", () => {
    for (const input of ["luminária 0", "luminária -1", "luminária 1.5", "luminária 50"]) {
      assert.notEqual(parseShopeeCommand(input).error, null, input);
    }
  });

  it("mantém URL direta quando quantidade vem por último", () => {
    const parsed = parseShopeeCommand(`${PRODUCT_1} 1`);
    assert.equal(parsed.error, null);
    assert.equal(parsed.mode, "urls");
    assert.deepEqual(parsed.urls, [PRODUCT_1]);
  });

  it("mantém compatibilidade antiga somente para quantidade + URL Shopee explícita", () => {
    const direct = parseShopeeCommand(`1 ${PRODUCT_1}`);
    assert.equal(direct.error, null);
    assert.equal(direct.mode, "urls");
    assert.deepEqual(direct.urls, [PRODUCT_1]);
    assert.notEqual(parseShopeeCommand("1 luminária").error, null);
  });
});

describe("identificadores auditáveis", () => {
  it("gera ids de lote e review sem depender de segredo", () => {
    assert.match(buildShopeeBatchId(), /^shopee-[a-z0-9]+$/);
    assert.match(buildShopeeReviewId(PRODUCT_1, 123456), /^affprev-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe("runShopeeCommand — discovery oficial e cards", () => {
  it("/shopee luminária 2 retorna dois cards para dois candidatos oficiais válidos", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1), offer(ITEM_2, PRODUCT_2)]));

    const result = await runShopeeCommand("luminária 2");

    assert.equal(result.errorCode, null);
    assert.equal(result.providerQueryExecuted, true);
    assert.equal(result.countRequested, 2);
    assert.equal(result.ok, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.discoverySource, "duckduckgo");
    assert.equal(result.candidatesDiscoveredViaDdg, 2);
    assert.equal(result.candidatesValidatedByAffiliateApi, 2);
    assert.equal(photoMessages.length, 2);
    assert.equal(savedReviews.length, 2);
    assert.deepEqual(savedReviews.map(review => review.existingProduct?.itemId), [ITEM_1, ITEM_2]);
  });

  it("preserva shopId, itemId e productLink oficiais na revisão autoritativa", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 1);
    assert.equal(savedReviews[0]?.normalizedUrl, PRODUCT_1);
    assert.equal(savedReviews[0]?.existingProduct?.shopId, SHOP_ID);
    assert.equal(savedReviews[0]?.existingProduct?.itemId, ITEM_1);
    assert.equal(savedReviews[0]?.affiliateUrl, undefined);
    assert.equal(savedReviews[0]?.existingProduct?.affiliateUrl, `https://s.shopee.com.br/aff-${ITEM_1.slice(-4)}`);
    assert.equal(photoMessages[0]?.photo, IMAGE_1);
  });

  it("substitui título, preço, link e imagem descobertos pelos dados oficiais", async () => {
    const official = { ...offer(ITEM_1, PRODUCT_1), name: "Luminária Oficial Shopee", price: 123.45, imageUrl: "https://down-br.img.susercontent.com/file/imagem-oficial" };
    setTestShopeeClient(clientWithOffers([official]));
    setTestExtractProductForReview(async () => ({
      success: true,
      data: {
        ...validReviewData(PRODUCT_1),
        imagens: [official.imageUrl],
        imagensOriginais: [official.imageUrl],
        imagemPrincipal: official.imageUrl,
      } as any,
    }));
    setTestSearchProvider(async () => ({
      provider: "duckduckgo",
      state: "DDG_OK",
      httpStatus: 200,
      reason: null,
      candidates: [{
        url: `https://shopee.com.br/product/${SHOP_ID}/${ITEM_1}`,
        shopId: SHOP_ID,
        itemId: ITEM_1,
        rawTitle: "Título incorreto do DDG por R$ 1,00",
      }],
    }));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 1);
    assert.equal(savedReviews[0]?.rawTitle, "Luminária Oficial Shopee");
    assert.equal(savedReviews[0]?.preco, 123.45);
    assert.equal(savedReviews[0]?.normalizedUrl, PRODUCT_1);
    assert.equal(savedReviews[0]?.imagemPrincipal, official.imageUrl);
    assert.equal(photoMessages[0]?.photo, official.imageUrl);
    assert.equal(JSON.stringify(savedReviews[0]).includes("Título incorreto do DDG"), false);
  });

  it("não expõe URL oficial completa nem link afiliado no card; usa referência mascarada", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    await runShopeeCommand("luminária 1");

    const caption = photoMessages[0]?.caption || "";
    assert.match(caption, /Referência de auditoria/);
    assert.match(caption, /••••/);
    assert.equal(caption.includes(PRODUCT_1), false);
    assert.equal(caption.includes("https://s.shopee.com.br/"), false);
    assert.equal(caption.includes(ITEM_1), false);
  });

  it("mantém aprovação humana no card", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    await runShopeeCommand("luminária 1");

    const buttons = photoMessages[0]?.markup?.inline_keyboard?.flat?.() || [];
    assert.equal(buttons.some((button: any) => String(button.callback_data || "").startsWith("confirm_pub:")), true);
    assert.equal(savedReviews[0]?.status, "pending");
  });

  it("rejeita URL que não prova a mesma identidade oficial, sem derivar uma substituta", async () => {
    const mismatched = `https://shopee.com.br/product/${SHOP_ID}/99999999999`;
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, mismatched)]));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.errorCode, "NO_QUALIFIED_REPLACEMENT_FOUND");
    assert.equal(result.rejectionCounts.OFFICIAL_PRODUCT_LINK_INVALID, 1);
    assert.equal(savedReviews.length, 0);
    assert.equal(photoMessages.length, 0);
  });

  it("rejeita identidade DDG não confirmada pelo lookup oficial e não tenta aquisição", async () => {
    let acquireCalls = 0;
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)], {
      lookup: async () => ({ status: "not_found", shopId: null, itemId: null, name: null, priceMinorUnits: null, productLink: null, imageUrl: null, httpStatus: 200, raw: null, error: null }),
      acquire: async () => { acquireCalls += 1; return successAcquisition(ITEM_1, PRODUCT_1); },
    }));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.rejectionCounts.OFFICIAL_IDENTITY_NOT_CONFIRMED, 1);
    assert.equal(result.candidatesValidatedByAffiliateApi, 0);
    assert.equal(acquireCalls, 0);
    assert.equal(savedReviews.length, 0);
  });

  it("rejeita candidato sem disponibilidade afiliada confirmada pela API oficial", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)], {
      acquire: async () => ({
        status: "not_eligible",
        affiliateUrl: null,
        productLink: PRODUCT_1,
        shopId: SHOP_ID,
        itemId: ITEM_1,
        name: "Luminária Bauhaus de mesa",
        price: 79.9,
        imageUrl: IMAGE_1,
        raw: null,
        error: null,
      }),
    }));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.rejectionCounts.AFFILIATE_not_eligible, 1);
    assert.equal(result.candidatesValidatedByAffiliateApi, 0);
    assert.equal(savedReviews.length, 0);
  });

  it("rejeita identidade já pertencente ao catálogo", async () => {
    setTestShopeeIdentityChecker(async () => true);
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.errorCode, "NO_QUALIFIED_REPLACEMENT_FOUND");
    assert.equal(result.items[0]?.status, "duplicate_rejected");
    assert.equal(result.items[0]?.reason, "SOURCE_IDENTITY_ALREADY_OWNED");
    assert.equal(savedReviews.length, 0);
  });

  it("rejeita candidato sem título e preço canônicos e distingue candidatos rejeitados", async () => {
    setTestShopeeClient(clientWithOffers([
      { ...offer(ITEM_1, PRODUCT_1), name: "" },
      { ...offer(ITEM_2, PRODUCT_2), price: null },
    ]));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.errorCode, "NO_QUALIFIED_REPLACEMENT_FOUND");
    assert.equal(result.candidatesReceived, 2);
    assert.equal(result.rejectionCounts.TITLE_MISSING, 1);
    assert.equal(result.rejectionCounts.PRICE_MISSING, 1);
  });

  it("rejeita imagem não HTTPS ou imagem em revisão antes de criar card", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    setTestExtractProductForReview(async (url: string) => ({
      success: true,
      data: {
        ...validReviewData(url),
        imagens: ["http://img.example.com/insegura.webp"],
        imageEditorialStatus: "review_required",
      } as any,
    }));

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 0);
    assert.equal(result.errorCode, "NO_QUALIFIED_REPLACEMENT_FOUND");
    assert.equal(result.items[0]?.status, "editorial_curation_failed");
    assert.match(result.items[0]?.reason || "", /imagem HTTPS válida ausente|IMAGE_REVIEW_REQUIRED/);
    assert.equal(savedReviews.length, 0);
  });

  it("usa fallback de entrega texto somente se sendPhoto falhar, sem mudar elegibilidade", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    let fallbackTextCards = 0;
    setTestTelegramSenders(
      async (_chatId, text) => {
        if (String(text).includes("PREVIEW SHOPEE AFFILIATE")) fallbackTextCards += 1;
        return { ok: true };
      },
      async () => ({ ok: false, failureReason: "photo_failed" }),
    );

    const result = await runShopeeCommand("luminária 1");

    assert.equal(result.ok, 1);
    assert.equal(fallbackTextCards, 1);
  });
});

describe("runShopeeCommand — configuração e falhas do provider", () => {
  it("TELEGRAM_ALLOWED_USER_IDS ausente bloqueia antes de qualquer consulta", async () => {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    let calls = 0;
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    setTestSearchProvider(async () => {
      calls += 1;
      return { provider: "duckduckgo", state: "DDG_NO_RESULTS", candidates: [], httpStatus: 200, reason: "test" };
    });

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "TELEGRAM_ALLOWED_USER_IDS_MISSING");
    assert.equal(result.providerQueryExecuted, false);
    assert.equal(calls, 0);
  });

  it("credenciais ausentes retornam SHOPEE_PROVIDER_NOT_CONFIGURED e não NO_RESULTS", async () => {
    setTestShopeeClient(null);
    delete process.env.SHOPEE_APP_ID;
    delete process.env.SHOPEE_APP_SECRET;
    delete process.env.SHOPEE_AFFILIATE_APP_ID;
    delete process.env.SHOPEE_AFFILIATE_APP_SECRET;

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "SHOPEE_PROVIDER_NOT_CONFIGURED");
    assert.equal(result.providerQueryExecuted, false);
    assert.match(textMessages.map(message => message.text).join("\n"), /SHOPEE_PROVIDER_NOT_CONFIGURED/);
  });

  it("autenticação inválida retorna SHOPEE_PROVIDER_AUTH_FAILED", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)], {
      lookup: async () => ({ status: "error", error: { kind: "SHOPEE_AUTH_ERROR" } }),
    }));

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "SHOPEE_PROVIDER_AUTH_FAILED");
    assert.equal(result.providerQueryExecuted, true);
    assert.equal(result.ok, 0);
  });

  it("autorização insuficiente é distinta de autenticação inválida", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)], {
      lookup: async () => ({ status: "error", error: { kind: "SHOPEE_FORBIDDEN" } }),
    }));

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "SHOPEE_PROVIDER_FORBIDDEN");
    assert.equal(result.providerQueryExecuted, true);
    assert.match(textMessages.map(message => message.text).join("\n"), /SHOPEE_PROVIDER_FORBIDDEN/);
  });

  it("DDG sem resultados orienta o modo urls sem consultar a API oficial", async () => {
    let lookupCalls = 0;
    setTestShopeeClient(clientWithOffers([], {
      discoveryState: "DDG_NO_RESULTS",
      lookup: async () => { lookupCalls += 1; return { status: "not_found" }; },
    }));

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "DDG_NO_RESULTS");
    assert.equal(result.providerQueryExecuted, false);
    assert.equal(result.candidatesReceived, 0);
    assert.equal(result.ok, 0);
    assert.equal(lookupCalls, 0);
    assert.match(textMessages.map(message => message.text).join("\n"), /descoberta automática.*não está disponível/is);
    assert.match(textMessages.map(message => message.text).join("\n"), /\/shopee https:\/\/shopee\.com\.br\/product/);
  });

  for (const state of ["DDG_BLOCKED", "DDG_UNAVAILABLE"] as const) {
    it(`${state} retorna estado claro e fallback para modo urls`, async () => {
      setTestShopeeClient(clientWithOffers([], { discoveryState: state }));
      const result = await runShopeeCommand("copo 1");
      assert.equal(result.errorCode, state);
      assert.equal(result.ok, 0);
      const messages = textMessages.map(message => message.text).join("\n");
      assert.match(messages, new RegExp(state));
      assert.match(messages, /modo <code>urls<\/code>/);
    });
  }

  it("preserva modo urls mesmo quando a descoberta DDG está bloqueada", async () => {
    let ddgCalls = 0;
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)]));
    setTestSearchProvider(async () => {
      ddgCalls += 1;
      return { provider: "duckduckgo", state: "DDG_BLOCKED", candidates: [], httpStatus: 202, reason: "test" };
    });

    const result = await runShopeeCommand(`${PRODUCT_1} 1`);

    assert.equal(ddgCalls, 0);
    assert.equal(result.errorCode, null);
    assert.equal(result.ok, 1);
    assert.equal(result.discoverySource, "direct_urls");
    assert.equal(savedReviews[0]?.normalizedUrl, PRODUCT_1);
  });

  it("resposta incompatível do provider recebe código próprio", async () => {
    setTestShopeeClient(clientWithOffers([offer(ITEM_1, PRODUCT_1)], {
      lookup: async () => ({ status: "error", error: { kind: "SHOPEE_INVALID_RESPONSE" } }),
    }));

    const result = await runShopeeCommand("copo 1");

    assert.equal(result.errorCode, "SHOPEE_PROVIDER_RESPONSE_INVALID");
    assert.equal(result.providerQueryExecuted, true);
  });

  it("timeout usa retry limitado e termina com código estável", async () => {
    let attempts = 0;
    const client = clientWithOffers([], {
      search: async () => {
        attempts += 1;
        return { ok: false, items: [], httpStatus: null, reason: "SHOPEE_TIMEOUT", error: { kind: "SHOPEE_TIMEOUT" } };
      },
    });

    await assert.rejects(
      searchShopeeOffersWithRetry({ client, query: "luminária", attempts: 2, backoffMs: 0 }),
      (error: any) => error instanceof ShopeeProviderRuntimeError && error.code === "SHOPEE_PROVIDER_TIMEOUT",
    );
    assert.equal(attempts, 2);
  });

  it("rate limit usa retry limitado e não entra em loop infinito", async () => {
    let attempts = 0;
    const client = clientWithOffers([], {
      search: async () => {
        attempts += 1;
        return { ok: false, items: [], httpStatus: 429, reason: "SHOPEE_RATE_LIMITED", error: { kind: "SHOPEE_RATE_LIMITED" } };
      },
    });

    await assert.rejects(
      searchShopeeOffersWithRetry({ client, query: "luminária", attempts: 3, backoffMs: 0 }),
      (error: any) => error instanceof ShopeeProviderRuntimeError && error.code === "SHOPEE_PROVIDER_RATE_LIMITED",
    );
    assert.equal(attempts, 3);
  });
});

describe("observabilidade Shopee", () => {
  it("inspeciona somente presença/estrutura sem retornar credenciais", () => {
    process.env.SHOPEE_APP_ID = "test-app-id-secret-value";
    process.env.SHOPEE_APP_SECRET = "test-app-secret-value";
    const status = inspectShopeeProviderEnv(process.env);
    const serialized = JSON.stringify(status);

    assert.equal(status.adapter, "ShopeeApiClient");
    assert.equal(status.credentialsConfigured, true);
    assert.equal(status.baseUrlStructurallyValid, true);
    assert.equal(serialized.includes("test-app-id-secret-value"), false);
    assert.equal(serialized.includes("test-app-secret-value"), false);
  });

  it("logs estruturados removem secrets, tokens, URLs e payloads sensíveis", () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: any[]) => { lines.push(args.map(String).join(" ")); };
    try {
      safeShopeeLog("test_event", {
        correlationId: "corr-1",
        requested: 2,
        secret: "must-not-appear",
        telegramToken: "must-not-appear-either",
        productUrl: PRODUCT_1,
        providerPayload: "sensitive-payload",
      });
    } finally {
      console.info = originalInfo;
    }
    const joined = lines.join("\n");
    assert.match(joined, /corr-1/);
    assert.equal(joined.includes("must-not-appear"), false);
    assert.equal(joined.includes(PRODUCT_1), false);
    assert.equal(joined.includes("sensitive-payload"), false);
  });
});
