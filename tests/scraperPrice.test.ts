import test from "node:test";
import assert from "node:assert";
import { extractCorrectPrice } from "../server/services/scraper";

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
