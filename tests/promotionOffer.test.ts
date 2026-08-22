import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ProductPipeline } from "../server/services/productPipeline";
import { normalizePromotionOffer, promotionConditionLabel } from "../server/services/promotionOffer";

const confirmedOffer = {
  price: 264,
  condition: "pix" as const,
  benefits: ["Frete grátis"],
  source: "admin_confirmed" as const,
  confirmedAt: 1_787_361_177_000,
};

test("normaliza somente oferta administrativa explícita, sem alterar ou calcular preço-base", () => {
  assert.deepEqual(normalizePromotionOffer(confirmedOffer), confirmedOffer);
  assert.equal(normalizePromotionOffer({ ...confirmedOffer, source: "scraper" }), undefined);
  assert.equal(normalizePromotionOffer({ ...confirmedOffer, condition: "pix_sem_regra" }), undefined);
  assert.equal(normalizePromotionOffer({ ...confirmedOffer, price: 0 }), undefined);
  assert.equal(promotionConditionLabel("pix"), "no Pix");
  assert.equal(promotionConditionLabel("pix_with_coupon"), "no Pix com cupom");
});

test("pipeline canônico transporta a oferta confirmada como metadado separado do preço-base", async () => {
  let capturedCandidate: any = null;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async (candidate) => {
      capturedCandidate = candidate;
      return {
        id: "prod-promo-test",
        ref: "REF-PROMO",
        produto: candidate.produto,
        categoria: candidate.categoria,
        preco: candidate.preco || 0,
        imagens: candidate.imagens,
        link: candidate.link || candidate.normalizedUrl,
        ativo: true,
        destaque: false,
        status: "approved" as const,
        ofertaPromocional: candidate.ofertaPromocional,
      };
    },
    syncAndValidatePublication: async () => ({ success: true, operationId: "PUB-PROMO-TEST" }),
    pauseCanonicalProduct: async () => undefined,
  });

  let lifecycle = await pipeline.evaluate({
    normalizedUrl: "https://shopee.com.br/product/1/2",
    link: "https://s.shopee.com.br/oferta-confirmada",
    marketplace: "Shopee",
    produto: "Luminária de teste auditável",
    categoria: "Afiliado",
    descricao: "Peça de teste para regressão de oferta confirmada.",
    preco: 299,
    imagens: ["https://images.example.test/luminaria.jpg"],
    ofertaPromocional: confirmedOffer,
  });
  lifecycle = pipeline.approve(lifecycle);
  lifecycle = await pipeline.publish(lifecycle);

  assert.equal(lifecycle.state, "PUBLISHED");
  assert.equal(capturedCandidate.preco, 299, "preço-base continua canônico");
  assert.deepEqual(capturedCandidate.ofertaPromocional, confirmedOffer, "oferta confirmada acompanha o produto como dimensão separada");
});

test("projeção pública e renderização tratam a oferta como campo separado e preservam a ressalva de checkout", () => {
  const exportSource = readFileSync(new URL("../server/services/exportProductsJson.ts", import.meta.url), "utf8");
  const cardSource = readFileSync(new URL("../src/components/ProductCard.tsx", import.meta.url), "utf8");
  const detailSource = readFileSync(new URL("../src/components/ProductDetail.tsx", import.meta.url), "utf8");

  assert.match(exportSource, /ofertaPromocional: p\.ofertaPromocional/);
  assert.match(cardSource, /Preço do anúncio/i);
  assert.match(cardSource, /Oferta observada/i);
  assert.match(cardSource, /Confirme no checkout/i);
  assert.match(detailSource, /Condição confirmada manualmente/i);
  assert.match(detailSource, /preço do anúncio/i);
});
