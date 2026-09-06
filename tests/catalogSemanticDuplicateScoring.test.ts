import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { maximumCatalogSimilarity } from "../server/services/autonomousCuratorScoring";

function catalogProduct(overrides: Partial<Product>): Product {
  return {
    id: "existing",
    ref: "REF-EXISTING",
    produto: "Produto existente",
    displayTitle: "Produto existente",
    categoria: "Cozinha & Mesa",
    preco: 23.99,
    imagens: ["https://example.com/image.jpg"],
    link: "https://s.shopee.com.br/example",
    ativo: true,
    destaque: false,
    status: "published",
    descricao: "Produto publicado existente para teste de duplicidade semântica.",
    ...overrides,
  } as Product;
}

test("outro anúncio da mesma jarra Nadir é tratado como forte similaridade de catálogo", () => {
  const existing = catalogProduct({
    produto: "Jarra Decanter de Vidro Vintage 1,2 Litros",
    displayTitle: "Jarra Decanter de Vidro Vintage 1,2 Litros",
    rawTitle: "Jarra Decanter Americano Vintage vidro Nadir c/ Tampa Plástica 1,2 litros",
    categoria: "Cozinha & Mesa",
  });

  const similarity = maximumCatalogSimilarity(
    "Jarra Decanter 1,2 litros SALDO DE FÁBRICA Americano Vintage vidro Nadir c/ tampa Jarra Decanter de Vidro com Tampa",
    "Cozinha & Mesa",
    [existing],
  );

  assert.ok(similarity >= 0.82, `expected semantic duplicate >= 0.82, got ${similarity}`);
});

test("packs diferentes do mesmo modelo de cadeira ficam abaixo de candidatos realmente novos", () => {
  const existing = catalogProduct({
    produto: "Kit de Duas Cadeiras Empilháveis em Aço",
    displayTitle: "Kit de Duas Cadeiras Empilháveis em Aço",
    rawTitle: "Kit 2 Cadeiras Empilháveis Base Aço Tubular Flash Cromado Branco",
    categoria: "Móveis",
  });

  const similarity = maximumCatalogSimilarity(
    "Kit 4 Cadeiras Empilháveis Base Aço Tubular Flash Cromado Branco Kit Quatro Cadeiras Empilháveis de Aço",
    "Móveis",
    [existing],
  );

  assert.ok(similarity >= 0.82, `expected chair semantic duplicate >= 0.82, got ${similarity}`);
});

test("produto diferente da mesma categoria não vira falso duplicado", () => {
  const existing = catalogProduct({
    produto: "Jarra Decanter de Vidro Vintage 1,2 Litros",
    displayTitle: "Jarra Decanter de Vidro Vintage 1,2 Litros",
    rawTitle: "Jarra Decanter Americano Vintage vidro Nadir c/ Tampa Plástica 1,2 litros",
    categoria: "Cozinha & Mesa",
  });

  const similarity = maximumCatalogSimilarity(
    "Cafeteira Italiana Moka em Alumínio 6 Xícaras",
    "Cozinha & Mesa",
    [existing],
  );

  assert.ok(similarity < 0.82, `expected distinct product < 0.82, got ${similarity}`);
});
