import test from "node:test";
import assert from "node:assert";
import { detectMarketplace, resolveShortUrlIfNeeded } from "../server/services/marketplace";
import { ProductPipeline } from "../server/services/productPipeline";

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
