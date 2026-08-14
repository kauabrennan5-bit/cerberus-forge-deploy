import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { detectMarketplace, isIntermediateMarketplaceUrl, resolveShortUrlIfNeeded } from "../server/services/marketplace";
import { ProductPipeline } from "../server/services/productPipeline";
import { containsRawPayloadMarkers, normalizeCandidate, validateCandidate } from "../server/services/productLifecycle";
import { buildProductListView } from "../server/services/telegramBot";

test("detectMarketplace reconhece Shopee diretamente", () => {
  assert.equal(detectMarketplace("https://shopee.com.br/produto-i.123.456"), "Shopee");
  assert.equal(detectMarketplace("https://shope.ee/abc123xyz"), "Shopee");
});

test("detectMarketplace reconhece Mercado Livre e meli.la", () => {
  assert.equal(detectMarketplace("https://www.mercadolivre.com.br/p/MLB12345"), "Mercado Livre");
  assert.equal(detectMarketplace("https://meli.la/1F1WZdR"), "Mercado Livre");
  assert.equal(detectMarketplace("meli.la/1F1WZdR"), "Mercado Livre");
});

test("detectMarketplace rejeita domínios desconhecidos ou maliciosos", () => {
  assert.equal(detectMarketplace("https://example.com"), "Outros");
  assert.equal(detectMarketplace("http://127.0.0.1/malicious"), "Outros");
  assert.equal(detectMarketplace("https://mercadolivre.com.br.fake.com"), "Outros");
});

test("resolveShortUrlIfNeeded classifica meli.la sem falhar mesmo sem rede", async () => {
  const result = await resolveShortUrlIfNeeded("https://meli.la/1F1WZdR");
  assert.equal(result.marketplace, "Mercado Livre");
  assert.ok(result.resolvedUrl.includes("meli.la"));
});

test("Pipeline avalia meli.la corretamente sem erro de marketplace não reconhecido", async () => {
  const mockAdapters = {
    getProducts: async () => [],
    createCanonicalProduct: async (c: any) => ({
      id: "1",
      ref: "REF-001",
      produto: c.produto,
      preco: c.preco,
      categoria: c.categoria,
      imagens: c.imagens,
      link: c.normalizedUrl,
      ativo: true,
      destaque: false,
      marketplace: c.marketplace
    }),
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => {}
  };

  const pipeline = new ProductPipeline(mockAdapters);
  const evaluation = await pipeline.evaluate({
    produto: "Tênis Esportivo Teste",
    categoria: "Calçados",
    preco: 129.90,
    imagens: ["https://http2.mlstatic.com/D_NQ_NP_609745-MLB48737248383_122021-O.webp"],
    normalizedUrl: "https://meli.la/1F1WZdR",
    marketplace: detectMarketplace("https://meli.la/1F1WZdR"),
    descricao: "Teste E2E meli.la"
  });

  assert.notEqual(evaluation.state, "ERROR");
  assert.equal(evaluation.candidate.marketplace, "Mercado Livre");
  assert.equal(evaluation.validation.outcome, "PASS");
});

test("/listar constrói a primeira página com cinco produtos e botão de próxima", () => {
  const products = Array.from({ length: 6 }, (_, index) => ({
    id: `prod-${index + 1}`,
    ref: `REF-${String(index + 1).padStart(3, "0")}`,
    produto: `Produto de teste ${index + 1}`,
    preco: 10 + index,
    ativo: true
  }));

  const view = buildProductListView(products, 0);
  assert.equal(view.total, 6);
  assert.equal(view.totalPages, 2);
  assert.equal(view.page, 0);
  assert.match(view.text, /Página 1 de 2/);
  assert.match(view.text, /Produto de teste 1/);
  assert.match(view.text, /Produto de teste 5/);
  assert.doesNotMatch(view.text, /Produto de teste 6/);
  assert.deepEqual(view.keyboard.inline_keyboard.at(-2), [{ text: "Próxima ▶️", callback_data: "products_list:1" }]);
});

test("products_list em página posterior preserva edição e navegação com message_id real", () => {
  const products = Array.from({ length: 6 }, (_, index) => ({
    id: `prod-${index + 1}`,
    ref: `REF-${String(index + 1).padStart(3, "0")}`,
    produto: `Produto de teste ${index + 1}`,
    preco: 10 + index,
    ativo: index !== 5
  }));

  const view = buildProductListView(products, 1);
  assert.equal(view.page, 1);
  assert.match(view.text, /Página 2 de 2/);
  assert.match(view.text, /Produto de teste 6/);
  assert.deepEqual(view.keyboard.inline_keyboard.at(-2), [{ text: "◀️ Anterior", callback_data: "products_list:0" }]);
});

test("/listar direto envia mensagem nova e não cria fakeCb nem depende de message_id", () => {
  const source = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
  const directStart = source.indexOf('if (text.startsWith("/listar") || text.startsWith("/produtos"))');
  const directEnd = source.indexOf('if (text.startsWith("/categorias"))', directStart);
  const directHandler = source.slice(directStart, directEnd);

  assert.ok(directStart >= 0 && directEnd > directStart);
  assert.match(directHandler, /renderProductList\(0\)/);
  assert.match(directHandler, /sendTelegramMessage\(chatId, listView\.text, listView\.keyboard\)/);
  assert.doesNotMatch(directHandler, /fakeCb|message_id|handleTelegramWebhookUpdate/);
  assert.match(source, /if \(data\.startsWith\("products_list:"\)\)[\s\S]{0,700}editTelegramMessageText/);
});

test("Telegram, automação e lifecycle usam somente o detector canônico", () => {
  const files = [
    "../server/services/telegramBot.ts",
    "../server/services/productAutomation.ts",
    "../server/services/productLifecycle.ts"
  ];

  for (const relativePath of files) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /from "\.\/marketplace"/);
    assert.doesNotMatch(source, /function detectMarketplace/);
  }
});


test("revisão do Telegram usa a extração editorial compartilhada e não publica rawContent como descricao", () => {
  const source = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");

  assert.match(source, /extractProductForReview as extractProductForReviewShared/);
  assert.match(source, /return extractProductForReviewShared\(url\)/);
  assert.doesNotMatch(source, /descricao:\s*scraped\.rawContent/);
  assert.match(source, /recoverableMissingPrice/);
  assert.match(source, /if \(data\.startsWith\("edit_price:"\)\)/);
  assert.match(source, /if \(data\.startsWith\("edit_cat:"\)\)/);
  assert.match(source, /action: "awaiting_category"/);
  assert.match(source, /if \(userState && userState\.action === "awaiting_category"\)/);
  assert.match(source, /await refreshReviewLifecycle\(targetReview\)/);
});

test("rawContent técnico em descricao é detectado e limpo na normalização", () => {
  const rawDescription = "[URL Final]: https://meli.la/demo\\n[Título Identificado]: Produto\\n[Preço Identificado]: R$ 10,00";
  assert.equal(containsRawPayloadMarkers(rawDescription), true);

  const candidate = normalizeCandidate({
    normalizedUrl: "https://www.mercadolivre.com.br/p/MLB123456",
    marketplace: "Mercado Livre",
    produto: "Produto editorial",
    categoria: "Acessórios",
    preco: 10,
    imagens: ["https://cdn.example.com/product.jpg"],
    descricao: rawDescription,
  });

  assert.equal(candidate.descricao, "");
  assert.equal(validateCandidate({ ...candidate, descricao: rawDescription }, []).outcome, "FAIL");
});

test("resolveShortUrlIfNeeded rejeita destino intermediário do Mercado Livre", async () => {
  const target = "https://meli.la/abc123";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ url: "https://www.mercadolivre.com.br/social/abc123" })) as unknown as typeof fetch;

  try {
    assert.equal(isIntermediateMarketplaceUrl("https://www.mercadolivre.com.br/social/abc123"), true);
    assert.equal(isIntermediateMarketplaceUrl("https://www.mercadolivre.com.br/MLB-123456789-produto"), false);
    const result = await resolveShortUrlIfNeeded(target);
    assert.equal(result.resolvedUrl, target);
    assert.equal(result.marketplace, "Mercado Livre");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publicação é bloqueada se descricao contaminada atravessar a revisão", async () => {
  let creates = 0;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => {
      creates += 1;
      return { id: "contaminated", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false };
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
  });

  const record = await pipeline.evaluate({
    normalizedUrl: "https://shopee.com.br/produto-i.123.456",
    marketplace: "Shopee",
    produto: "Produto editorial",
    categoria: "Acessórios",
    preco: 10,
    imagens: ["https://cdn.example.com/product.jpg"],
    descricao: "Descrição editorial limpa.",
  });
  pipeline.approve(record);
  record.candidate.descricao = "[Conteúdo da Página]: payload técnico";

  const result = await pipeline.publish(record);
  assert.equal(result.error, "VALIDATION_ERROR");
  assert.equal(result.state, "APPROVED");
  assert.equal(creates, 0);
});

test("gerador de build sanitiza descricao contaminada antes de escrever o catálogo público", () => {
  const source = readFileSync(new URL("../scripts/generate-static-catalog.js", import.meta.url), "utf8");

  assert.match(source, /function containsRawPayloadMarkers\(value\)/);
  assert.match(source, /descricao: containsRawPayloadMarkers\(p\.descricao \|\| p\.description \|\| ''\)/);
  assert.match(source, /\[conteudo da pagina\]/);
});
