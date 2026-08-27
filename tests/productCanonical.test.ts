import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessProductReadiness,
  probePublicImageUrl,
  resolveCanonicalProductImage,
  toCanonicalProduct,
} from "../src/lib/productCanonical.ts";
import type { Product } from "../src/types.ts";

const baseProduct: Product = {
  id: "prod-canonical-test",
  ref: "REF-CANONICAL",
  produto: "Produto canônico de teste",
  displayTitle: "Produto canônico de teste",
  categoria: "Teste",
  descricao: "Descrição suficiente para o teste local.",
  preco: 99.9,
  imagens: ["https://cdn.example.test/primary.jpg"],
  link: "https://shop.example.test/products/canonical-test",
  paginaPonteUrl: "https://cerberusfinds.com/produto/canonical-test",
  ativo: true,
  destaque: false,
};

test("resolve the first valid HTTPS image in database order", () => {
  const result = resolveCanonicalProductImage({
    imagens: [
      "https://cdn.example.test/first.jpg",
      "https://cdn.example.test/second.jpg",
    ],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, "https://cdn.example.test/first.jpg");
  assert.deepEqual(result.publicHttpsImageUrls, [
    "https://cdn.example.test/first.jpg",
    "https://cdn.example.test/second.jpg",
  ]);
});

test("ignores invalid, empty, HTTP and private image candidates while preserving valid order", () => {
  const result = resolveCanonicalProductImage({
    imagens: [
      "",
      "not-a-url",
      "http://cdn.example.test/insecure.jpg",
      "https://localhost/private.jpg",
      "data:image/png;base64,legacy-data",
      "https://cdn.example.test/valid-a.jpg",
      "https://cdn.example.test/valid-a.jpg",
      "https://cdn.example.test/valid-b.jpg",
    ],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, "https://cdn.example.test/valid-a.jpg");
  assert.deepEqual(result.publicHttpsImageUrls, [
    "https://cdn.example.test/valid-a.jpg",
    "https://cdn.example.test/valid-b.jpg",
  ]);
});

test("reports missing and no-valid-HTTPS images explicitly", async () => {
  const missing = resolveCanonicalProductImage({ imagens: [] });
  assert.equal(missing.status, "incomplete");
  assert.equal(missing.reason, "missing");
  assert.equal(missing.primaryImageUrl, undefined);

  const invalid = resolveCanonicalProductImage({ imagens: ["http://cdn.example.test/only-http.jpg"] });
  assert.equal(invalid.status, "incomplete");
  assert.equal(invalid.reason, "no_valid_https_image");
  const readiness = await assessProductReadiness({ ...baseProduct, imagens: ["http://cdn.example.test/only-http.jpg"] }, {
    channel: "campaign",
    verifyImageAccessibility: false,
  });
  assert.equal(readiness.ready, false);
  assert.match(readiness.errors.join(","), /PRODUCT_IMAGE_HTTPS_INVALID/);
});

test("fails readiness when the injected image probe reports inaccessible", async () => {
  const readiness = await assessProductReadiness(baseProduct, {
    channel: "campaign",
    verifyImageAccessibility: true,
    imageProbe: async () => false,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.imageAccessible, false);
  assert.match(readiness.errors.join(","), /PRODUCT_IMAGE_INACCESSIBLE/);
});

test("accepts an REF-016-shaped product without any product-id lookup", async () => {
  const ref016: Product = {
    ...baseProduct,
    id: "prod-1787351832260",
    ref: "REF-016",
    imagens: [
      "https://down-br.img.susercontent.com/file/sg-11134201-8258u-mqvn863wq3gn92",
      "https://down-br.img.susercontent.com/file/sg-11134201-8257y-mqvn86ihg26i2b",
    ],
  };
  const readiness = await assessProductReadiness(ref016, {
    channel: "campaign",
    verifyImageAccessibility: false,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.product.primaryImageUrl, ref016.imagens[0]);
});

test("accepts a fictional new product with a valid HTTPS image and no manual mapping", () => {
  const future = toCanonicalProduct({
    ...baseProduct,
    id: "prod-future-no-map",
    ref: "REF-FUTURE",
    imagens: ["https://cdn.example.test/future.webp"],
  });
  assert.equal(future.primaryImageUrl, "https://cdn.example.test/future.webp");
  assert.equal(future.destinationUrl, "https://cerberusfinds.com/produto/canonical-test");
});

test("main visual consumers use the shared canonical image resolver", () => {
  const consumers = [
    "src/components/ProductCard.tsx",
    "src/components/ProductDetail.tsx",
    "src/components/AdminForm.tsx",
    "server/services/newsletterInstitutional.ts",
    "server/services/newsletterCampaignService.ts",
    "server/services/newsletterCampaignTemplate.ts",
    "server/services/telegramBot.ts",
    "scripts/productOpenGraph.js",
  ];
  for (const relativePath of consumers) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.match(source, /resolveCanonicalProductImage|assessProductReadiness/);
    assert.doesNotMatch(source, /imagens[^\\n]*\\[0\\]/);
  }
});

test("probe accepts an image HEAD response and falls back to ranged GET", async () => {
  const headSuccess = await probePublicImageUrl("https://cdn.example.test/head.jpg", async () => new Response(null, {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  }));
  assert.equal(headSuccess, true);

  let calls = 0;
  const fallbackSuccess = await probePublicImageUrl("https://cdn.example.test/range.webp", async (_url, init) => {
    calls += 1;
    if (init?.method === "HEAD") return new Response(null, { status: 405 });
    return new Response(null, { status: 206, headers: { "content-type": "image/webp" } });
  });
  assert.equal(fallbackSuccess, true);
  assert.equal(calls, 2);
});
