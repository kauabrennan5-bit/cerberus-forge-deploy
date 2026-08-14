import test from "node:test";
import assert from "node:assert";
import { detectMarketplace, resolveShortUrlIfNeeded } from "../server/services/marketplace";

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
