import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("product detail always renders the listing price when there is no verified promotion", async () => {
  const source = await readFile(new URL("../src/components/ProductDetail.tsx", import.meta.url), "utf8");

  assert.match(source, /\{formattedPromotionPrice \? \(/);
  assert.match(source, /PREÇO DO ANÚNCIO/);
  assert.match(source, /\{formattedPrice\}/);
  assert.match(source, /\) : \(\s*<div className="border-y border-\[#3A342E\]/);
});

test("verified promotion still shows the original listing price for comparison", async () => {
  const source = await readFile(new URL("../src/components/ProductDetail.tsx", import.meta.url), "utf8");

  assert.match(source, /Preço do anúncio: \{formattedPrice\}/);
  assert.match(source, /PREÇO VERIFICADO/);
});
