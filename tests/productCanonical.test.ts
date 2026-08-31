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
import { curateProductImages } from "../src/lib/productImageCuration.ts";
import { getProductDisplayCategory } from "../src/lib/productPresentation.ts";

const baseProduct: Product = {
  id: "prod-canonical-test",
  ref: "REF-CANONICAL",
  produto: "Produto canônico de teste",
  displayTitle: "Produto canônico de teste",
  categoria: "Decoração",
  descricao: "Descrição suficiente para o teste local.",
  preco: 99.9,
  imagens: ["https://cdn.example.test/primary.jpg"],
  link: "https://shop.example.test/products/canonical-test",
  paginaPonteUrl: "https://cerberusfinds.com/produto/canonical-test",
  ativo: true,
  destaque: false,
};

test("selects the only clean commercial image among five candidates", () => {
  const images = Array.from({ length: 5 }, (_, index) => `https://cdn.example.test/image-${index + 1}.jpg`);
  const curation = curateProductImages(images, [
    ...images.slice(0, 4).map(url => ({ url, decision: "technical" as const, confidence: "HIGH" as const, reason: "medidas embutidas" })),
    { url: images[4], decision: "clean", confidence: "HIGH", reason: "produto isolado sem overlay" },
  ]);
  assert.equal(curation.status, "ready");
  assert.equal(curation.primaryImageUrl, images[4]);
  assert.deepEqual(curation.galleryImageUrls, []);
  const result = resolveCanonicalProductImage({ imagens: [images[4]], imageCuration: curation, imageEditorialStatus: "clean" });
  assert.equal(result.primaryImageUrl, images[4]);
  assert.deepEqual(result.rawImageUrls, images);
});

test("blocks a product when every candidate image is technical", () => {
  const images = ["https://cdn.example.test/technical-a.jpg", "https://cdn.example.test/technical-b.jpg"];
  const curation = curateProductImages(images, images.map(url => ({ url, decision: "technical" as const, confidence: "HIGH" as const, reason: "cotas visíveis" })));
  assert.equal(curation.status, "review_required");
  assert.equal(curation.reason, "no_commercial_image:technical_high=2");
  const result = resolveCanonicalProductImage({ imagens: images, imageCuration: curation, imageEditorialStatus: "review_required" });
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "image_review_required");
});

test("canonical image resolution does not choose an unreviewed first raw image", () => {
  const raw = ["https://cdn.example.test/technical.jpg", "https://cdn.example.test/clean.jpg"];
  const curation = curateProductImages(raw, [
    { url: raw[0], decision: "technical", confidence: "HIGH", reason: "overlay" },
    { url: raw[1], decision: "clean", confidence: "HIGH", reason: "clean" },
  ]);
  const result = resolveCanonicalProductImage({ imagens: [raw[1]], imageCuration: curation, imageEditorialStatus: "clean" });
  assert.equal(result.primaryImageUrl, raw[1]);
  assert.deepEqual(result.galleryImageUrls, []);
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

test("readiness blocks internal category and image review required", async () => {
  const readiness = await assessProductReadiness({
    ...baseProduct,
    categoria: "affiliate_preview",
    imageEditorialStatus: "review_required",
    imageCuration: {
      status: "review_required",
      rawImageUrls: baseProduct.imagens,
      galleryImageUrls: [],
      assessments: [],
      reason: "no_commercial_image",
    },
  }, { channel: "campaign", verifyImageAccessibility: false });
  assert.equal(readiness.ready, false);
  assert.match(readiness.errors.join(","), /IMAGE_REVIEW_REQUIRED/);
  assert.match(readiness.errors.join(","), /PUBLIC_CATEGORY_REVIEW_REQUIRED/);
});

test("clean visual curation satisfies commercial image readiness", async () => {
  const primary = "https://cdn.example.test/clean-primary.jpg";
  const curation = curateProductImages([primary], [{ url: primary, decision: "clean", confidence: "HIGH", reason: "produto isolado" }]);
  const readiness = await assessProductReadiness({
    ...baseProduct,
    categoria: "Decoração",
    imagens: [primary],
    imageCuration: curation,
    imageEditorialStatus: "clean",
  }, { channel: "campaign", verifyImageAccessibility: false });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.product.primaryImageUrl, primary);
});

test("site, email and Telegram category projection share the same public lighting label", () => {
  const product = { ...baseProduct, produto: "Abajur LED Cogumelo", displayTitle: "Abajur LED Cogumelo", categoria: "affiliate_preview" };
  assert.equal(getProductDisplayCategory(product), "Iluminação");
  assert.equal(toCanonicalProduct(product).category, "Iluminação");
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
    "server/services/telegramProductRotation.ts",
    "server/routes/previewTelegramRoutes.ts",
    "server/services/shopeeCommand.ts",
    "scripts/productOpenGraph.js",
  ];
  for (const relativePath of consumers) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    assert.match(source, /resolveCanonicalProductImage|assessProductReadiness/);
    assert.doesNotMatch(source, /(?:imagens|images|finalImages)[^\n]*\[0\]/);
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