import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "../src/types";
import {
  assertCategoryPublicationAllowed,
  calculateCategoryPolicy,
  CategoryTargetSaturationError,
  categoryDeficits,
  fulfilledCategoryCount,
} from "../server/services/autonomousCuratorCategoryPolicy";

function productsFor(counts: Partial<Record<Product["categoria"], number>>): Product[] {
  const products: Product[] = [];
  let index = 0;
  for (const [category, count] of Object.entries(counts)) {
    for (let i = 0; i < Number(count || 0); i += 1) {
      index += 1;
      products.push({
        id: `p-${index}`,
        produto: `Produto ${index}`,
        displayTitle: `Produto ${index}`,
        displayTitleStatus: "reviewed",
        imageEditorialStatus: "clean",
        imageCuration: { status: "ready", rawImageUrls: ["https://example.com/image.jpg"], primaryImageUrl: "https://example.com/image.jpg", galleryImageUrls: [], assessments: [{ url: "https://example.com/image.jpg", decision: "clean", confidence: "HIGH", reason: "fixture" }] },
        categoria: category as Product["categoria"],
        preco: 100,
        imagens: ["https://example.com/image.jpg"],
        link: "https://s.shopee.com.br/example",
        ativo: true,
        destaque: false,
        status: "published",
      });
    }
  }
  return products;
}

test("category above target is blocked while another category has deficit", () => {
  const policy = calculateCategoryPolicy(productsFor({ Iluminação: 7, Móveis: 3 }), 4);
  assert.equal(policy.categoryDeficits.Iluminação, 0);
  assert.equal(policy.categoryDeficits.Móveis, 1);
  assert.ok(policy.deficitCategories.includes("Móveis"));
  assert.equal(policy.deficitCategories.includes("Iluminação"), false);

  assert.throws(
    () => assertCategoryPublicationAllowed({ category: "Iluminação", counts: policy.categoryCounts, dailyTargetPerCategory: 4 }),
    (error: unknown) => error instanceof CategoryTargetSaturationError
      && error.message === "CATEGORY_TARGET_ALREADY_SATISFIED_WHILE_DEFICITS_EXIST",
  );
  assert.doesNotThrow(() => assertCategoryPublicationAllowed({ category: "Móveis", counts: policy.categoryCounts, dailyTargetPerCategory: 4 }));
});

test("all ten complete allows normal future growth policy", () => {
  const counts = {
    Iluminação: 4,
    Decoração: 4,
    Móveis: 4,
    "Cozinha & Mesa": 4,
    Organização: 4,
    Vestuário: 4,
    "Calçados & Acessórios": 4,
    Tecnologia: 4,
    "Beleza & Bem-estar": 4,
    Infantil: 4,
  } as const;
  const policy = calculateCategoryPolicy(productsFor(counts), 4);
  assert.equal(policy.totalDeficit, 0);
  assert.equal(policy.fulfilledCategories, 10);
  assert.doesNotThrow(() => assertCategoryPublicationAllowed({ category: "Iluminação", counts: policy.categoryCounts, dailyTargetPerCategory: 4 }));
});

test("explicit replacement remains allowed even when other categories have deficits", () => {
  const policy = calculateCategoryPolicy(productsFor({ Iluminação: 7, Móveis: 3 }), 4);
  assert.doesNotThrow(() => assertCategoryPublicationAllowed({
    category: "Iluminação",
    counts: policy.categoryCounts,
    dailyTargetPerCategory: 4,
    mode: "replacement",
  }));
});

test("fulfilled categories is based only on Edge-v3 eligible public count >= target", () => {
  const policy = calculateCategoryPolicy(productsFor({
    Iluminação: 7,
    Decoração: 4,
    Móveis: 4,
    "Cozinha & Mesa": 4,
    Organização: 4,
    Vestuário: 3,
    "Calçados & Acessórios": 3,
    Tecnologia: 3,
    "Beleza & Bem-estar": 3,
    Infantil: 2,
  }), 4);
  assert.equal(fulfilledCategoryCount(policy.categoryCounts, 4), 5);
  assert.deepEqual(categoryDeficits(policy.categoryCounts, 4), {
    Iluminação: 0,
    Decoração: 0,
    Móveis: 0,
    "Cozinha & Mesa": 0,
    Organização: 0,
    Vestuário: 1,
    "Calçados & Acessórios": 1,
    Tecnologia: 1,
    "Beleza & Bem-estar": 1,
    Infantil: 2,
  });
});
