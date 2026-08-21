import test from "node:test";
import assert from "node:assert";
import { extractCorrectPrice, extractShopeeCheckoutPriceOffer, extractShopeeVariantPriceMax } from "../server/services/scraper";

test("Mercado Livre prioriza o preço de venda e ignora preço original e parcela", () => {
  const html = `
    <div class="ui-pdp-price__original-value"><span class="andes-money-amount__fraction">599</span><span class="andes-money-amount__cents">00</span></div>
    <div class="ui-pdp-price__second-line"><span class="andes-money-amount__fraction">426</span><span class="andes-money-amount__cents">00</span></div>
    <p>em 6x de R$ 71,00 sem juros</p>
  `;

  assert.equal(extractCorrectPrice(html, null, null), 426);
});

test("descarta um valor que aparece apenas como parcela", () => {
  const html = `<div class="price">em até 10x de R$ 71,00 sem juros</div>`;

  assert.equal(extractCorrectPrice(html, null, null), null);
});

test("não deixa JSON-LD de parcela sobrepor o preço atual exibido", () => {
  const html = `
    <script type="application/ld+json">{"offers":{"price":"71.00"}}</script>
    <p>em 6x de R$ 71,00 sem juros</p>
    <strong>Preço atual: R$ 426,00</strong>
  `;

  assert.equal(extractCorrectPrice(html, 71, null), 426);
});

test("descarta preço original riscado e aceita o valor de venda", () => {
  const html = `
    <span class="original-price">R$ 599,00</span>
    <span class="price">R$ 426,00</span>
  `;

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

test("Shopee usa preço regular real quando não há preço atual ou promocional", () => {
  const html = `<script>window.__STATE__ = {"price_before_discount":9900000000};</script>`;

  assert.equal(extractCorrectPrice(html, null, null), 99);
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
  const offer = extractShopeeCheckoutPriceOffer(`<div>R$ 460,00 no Pix com cupom</div>`);
  assert.deepEqual(offer, { price: 460, condition: "pix_with_coupon" });
});

test("Shopee não calcula cupom genérico ou desconto Pix sem preço explicitamente vinculado", () => {
  assert.deepEqual(
    extractShopeeCheckoutPriceOffer(`<div>Cupons disponíveis. Economize no Pix ao finalizar a compra.</div>`),
    { price: null, condition: null },
  );
});
