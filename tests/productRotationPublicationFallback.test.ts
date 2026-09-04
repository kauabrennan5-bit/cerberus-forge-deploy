import assert from "node:assert/strict";
import test from "node:test";
import { productRotationPublicationInternals } from "../server/services/productRotationPublication";

test("autonomous title review falls back deterministically when Gemini is not configured", async () => {
  const result = await productRotationPublicationInternals.reviewDisplayTitle({
    rawTitle: "Shopee Luminária Cogumelo Retrô Vermelha Frete Grátis",
    category: "Iluminação",
    env: {} as NodeJS.ProcessEnv,
  });

  assert.match(result.model, /^deterministic-editorial-v1:/);
  assert.doesNotMatch(result.displayTitle, /shopee|frete grátis/i);
  assert.notEqual(result.displayTitle.toLocaleLowerCase("pt-BR"), "shopee luminária cogumelo retrô vermelha frete grátis");
});

test("deterministic title failover preserves the editorial title contract", () => {
  const title = productRotationPublicationInternals.deterministicDisplayTitle(
    "Oferta Cadeira Lounge Curva Madeira Vintage Top Seller",
  );

  assert.ok(title);
  assert.doesNotMatch(title!, /oferta|top seller/i);
  assert.ok(title!.split(/\s+/).length <= 10);
});
