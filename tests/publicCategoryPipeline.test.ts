import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_PRODUCT_CATEGORIES, isPublicProductCategory, resolvePublicProductCategory } from "../src/lib/productCategory";
import { resolveProductCategoryForPersistence } from "../server/repositories/productsRepository";
import { preflightPublication, type PublicationRepositoryAdapter } from "../server/commercial/publication/publicationExecutor";

test("taxonomia pública resolve exemplos obrigatórios sem inventar categoria", () => {
  assert.equal(resolvePublicProductCategory("", { title: "Abajur LED Cogumelo" }), "Iluminação");
  assert.equal(resolvePublicProductCategory("", { title: "Organizador Porta-Talher" }), "Cozinha & Mesa");
  assert.equal(resolvePublicProductCategory("AFILIADO", { title: "Abajur LED Cogumelo" }), "Iluminação");
  assert.equal(resolvePublicProductCategory("affiliate_preview", { title: "Produto sem sinais" }), "");
  assert.equal(resolvePublicProductCategory("Acessórios", { title: "Bolsa feminina" }), "Calçados & Acessórios");
  assert.equal(resolvePublicProductCategory("Categoria inventada", { title: "Produto sem sinais" }), "");
  assert.equal(isPublicProductCategory("Iluminação"), true);
  assert.equal(isPublicProductCategory("AFILIADO"), false);
  assert.equal(isPublicProductCategory("Acessórios"), false);
  assert.ok(PUBLIC_PRODUCT_CATEGORIES.every(isPublicProductCategory));
});

test("persistência canônica normaliza alias e falha closed quando não há categoria pública", () => {
  assert.equal(resolveProductCategoryForPersistence({ categoria: "Acessórios", produto: "Bolsa de couro" }), "Calçados & Acessórios");
  assert.equal(resolveProductCategoryForPersistence({ categoria: "affiliate_preview", produto: "Abajur LED retrô" }), "Iluminação");
  assert.throws(
    () => resolveProductCategoryForPersistence({ categoria: "AFILIADO", produto: "Produto sem sinais" }),
    /PUBLIC_CATEGORY_REVIEW_REQUIRED/,
  );
});

function mockRepo(category: string, title = "Produto sem sinais"): PublicationRepositoryAdapter {
  return {
    async getCandidate() {
      return {
        candidateId: "candidate-category-test",
        status: "APPROVED",
        promotedProductId: null,
        sourceUrl: "https://example.com/produto/123",
        marketplace: "Teste",
        title,
        description: "",
        category,
        observedPrice: 10,
        images: ["https://example.com/product.jpg"],
        slug: "produto-category-test",
        ref: "REF-CATEGORY",
      };
    },
    async getLatestActionableAssessment() {
      return {
        assessmentId: "assessment-category-test",
        candidateId: "candidate-category-test",
        filterVersion: "1",
        classification: "APPROVED",
        isActionable: true,
        recommendation: "PROMOTE",
        recommendationBasis: "fixture",
        priorityLevel: "HIGH",
        priorityScore: 100,
        unknowns: [],
        contradictions: [],
        collectionFailures: [],
        evidenceRefs: [],
        inputSnapshot: {},
      };
    },
    async findDuplicateProduct() { return null; },
    async createCanonicalProduct() { throw new Error("not used in preflight"); },
    async linkPromotion() { return { ok: true }; },
    async restoreCreatedProduct() { return { ok: true }; },
    async recordOperationalEvent() { return { ok: true }; },
  };
}

test("publication preflight canonicaliza categoria antes da escrita", async () => {
  const resolved = await preflightPublication({ candidateId: "candidate-category-test", affiliateUrl: null }, mockRepo("affiliate_preview", "Abajur LED Cogumelo"));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.candidate?.category, "Iluminação");
});

test("publication preflight bloqueia categoria sem classificação pública", async () => {
  const blocked = await preflightPublication({ candidateId: "candidate-category-test", affiliateUrl: null }, mockRepo("AFILIADO", "Produto sem sinais"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failureCode, "PUBLIC_CATEGORY_REVIEW_REQUIRED");
});
