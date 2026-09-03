import test from "node:test";
import assert from "node:assert";
import {
  extractCorrectPrice,
  extractShopeeCheckoutPriceOffer,
  extractShopeeCouponEvidence,
  extractShopeePromotionEvidence,
  extractShopeeVariantPriceMax,
  isShopeePromotionEvidenceFresh,
  SHOPEE_PROMOTION_EVIDENCE_TTL_MS,
} from "../server/services/scraper";

test("Mercado Livre prioriza o preço de venda e ignora preço original e parcela", () => {
  const html = `
    <div class="ui-pdp-price__original-value"><span class="andes-money-amount__fraction">599</span><span class="andes-money-amount__cents">00</span></div>
    <div class="ui-pdp-price__second-line"><span class="andes-money-amount__fraction">426</span><span class="andes-money-amount__cents">00</span></div>
    <p>em 6x de R$ 71,00 sem juros</p>
  `;
  assert.equal(extractCorrectPrice(html, null, null), 426);
});

test("descarta um valor que aparece apenas como parcela", () => {
  assert.equal(extractCorrectPrice(`<div class="price">em até 10x de R$ 71,00 sem juros</div>`, null, null), null);
});

test("não deixa JSON-LD de parcela sobrepor o preço atual exibido", () => {
  const html = `<script type="application/ld+json">{"offers":{"price":"71.00"}}</script><p>em 6x de R$ 71,00 sem juros</p><strong>Preço atual: R$ 426,00</strong>`;
  assert.equal(extractCorrectPrice(html, 71, null), 426);
});

test("descarta preço original riscado e aceita o valor de venda", () => {
  const html = `<span class="original-price">R$ 599,00</span><span class="price">R$ 426,00</span>`;
  assert.equal(extractCorrectPrice(html, null, null), 426);
});

test("Shopee extrai o menor preço atual em micro-unidades", () => {
  const html = `<script>window.__STATE__ = {"price_min":"7990000000","price_before_discount":"9990000000"};</script>`;
  assert.equal(extractCorrectPrice(html, null, null), 79.9);
});

test("Shopee extrai preço atual quando o estado está serializado de forma escapada", () => {
  const html = `<script>window.__STATE__ = "{\\"price\\":\\"129.90\\"}";</script>`;
  assert.equal(extractCorrectPrice(html, null, null), 129.9);
});

test("Shopee rejeita price_before_discount quando não existe preço atual confirmado", () => {
  const html = `<script>window.__STATE__ = {"price_before_discount":9900000000};</script>`;
  assert.equal(extractCorrectPrice(html, null, null), null);
});

test("Shopee lê preço atual dentro do PDP_BFF_DATA cachedMap", () => {
  const html = `<script>window.__INITIAL_STATE__={"DOMAIN_PDP":{"data":{"PDP_BFF_DATA":{"cachedMap":{"123/456":{"item":{"price":4599000000,"price_before_discount":5999000000}}}}}}};</script>`;
  assert.equal(extractCorrectPrice(html, null, null), 45.99);
});

test("Shopee não inventa preço quando o SSR cachedMap informa preço atual nulo", () => {
  const html = `<script>window.__INITIAL_STATE__={"DOMAIN_PDP":{"data":{"PDP_BFF_DATA":{"cachedMap":{"123/456":{"item":{"price":null,"price_min":null,"price_before_discount":5999000000}}}}}}};</script>`;
  assert.equal(extractCorrectPrice(html, null, null), null);
});

test("Shopee não inventa preço quando nenhuma fonte da publicação contém valor", () => {
  assert.equal(extractCorrectPrice(`<main>Produto sem valor</main>`, null, null), null);
});

test("Shopee preserva faixa de variante somente quando price_max é maior que o preço confirmado", () => {
  const html = `<script>window.__STATE__ = {"price_min":"7990000000","price_max":"11990000000"};</script>`;
  assert.equal(extractShopeeVariantPriceMax(html, 79.9), 119.9);
  assert.equal(extractShopeeVariantPriceMax(html, 129), null);
});

test("Shopee extrai preço no Pix com cupom somente quando valor e condição estão juntos no anúncio", () => {
  assert.deepEqual(extractShopeeCheckoutPriceOffer(`<div>R$ 460,00 no Pix com cupom</div>`), { price: 460, condition: "pix_with_coupon" });
});

test("Shopee não calcula cupom genérico ou desconto Pix sem preço explicitamente vinculado", () => {
  assert.deepEqual(extractShopeeCheckoutPriceOffer(`<div>Cupons disponíveis. Economize no Pix ao finalizar a compra.</div>`), { price: null, condition: null });
});

test("Shopee preserva cupom apenas quando um voucher estruturado informa rótulo e valor", () => {
  const coupon = extractShopeeCouponEvidence(`<script>window.__STATE__={"voucher":{"voucher_name":"R$20 OFF acima de R$179","discount_value":"2000000000","min_spend":"17900000000"}}</script>`);
  assert.deepEqual(coupon, { label: "R$20 OFF acima de R$179", amount: 20, minimumSpend: 179, source: "structured_voucher" });
});

test("Shopee rejeita cupom em banner solto, sem objeto estruturado do anúncio", () => {
  assert.equal(extractShopeeCouponEvidence(`<aside>R$20 OFF acima de R$179 · CUPOM DO DIA</aside>`), null);
});

test("Shopee cria evidência de preço Pix e cupom com expiração curta", () => {
  const observedAt = 1_700_000_000_000;
  const content = `<script>{"voucher":{"label":"Cupom R$20 OFF","discount_amount":"2000000000","minimum_spend":"17900000000"}}</script><div>R$ 460,00 no Pix com cupom</div>`;
  const offer = extractShopeeCheckoutPriceOffer(content);
  const evidence = extractShopeePromotionEvidence(content, offer, observedAt);
  assert.equal(evidence?.checkoutPrice, 460);
  assert.equal(evidence?.checkoutPriceCondition, "pix_with_coupon");
  assert.equal(evidence?.coupon?.amount, 20);
  assert.equal(evidence?.coupon?.minimumSpend, 179);
  assert.equal(evidence?.expiresAt, observedAt + SHOPEE_PROMOTION_EVIDENCE_TTL_MS);
  assert.equal(isShopeePromotionEvidenceFresh(evidence, observedAt + SHOPEE_PROMOTION_EVIDENCE_TTL_MS - 1), true);
  assert.equal(isShopeePromotionEvidenceFresh(evidence, observedAt + SHOPEE_PROMOTION_EVIDENCE_TTL_MS), false);
});

test("Shopee não cria evidência sem valor Pix vinculado ou voucher estruturado", () => {
  const content = `<div>Use cupom e pague no Pix para economizar</div>`;
  assert.equal(extractShopeePromotionEvidence(content, extractShopeeCheckoutPriceOffer(content), 1_700_000_000_000), null);
});
