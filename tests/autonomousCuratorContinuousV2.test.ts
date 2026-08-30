import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Product } from "../src/types";
import { createShopeeApiClient } from "../server/commercial/affiliate/shopeeApiClient";
import { autonomousCuratorContinuousV2Internals } from "../server/services/autonomousCuratorContinuousV2";

const {
  DAY_MS,
  dueForPublication,
  discoveryPage,
  trustedEvidenceOverride,
  similarityUniverse,
  queueNote,
  parseQueueNote,
} = autonomousCuratorContinuousV2Internals;

test("Shopee discovery accepts an explicit page and returns official imageUrl evidence", async () => {
  let requestBody = "";
  const client = createShopeeApiClient({
    appId: "test-app",
    secret: "test-secret",
    clock: () => 1_780_000_000_000,
    transport: async (_url, init) => {
      requestBody = init.body;
      return new Response(JSON.stringify({
        data: {
          productOfferV2: {
            nodes: [{
              itemId: "222",
              shopId: "111",
              productName: "Abajur Bauhaus Cromado Vintage",
              price: "199.90",
              productLink: "https://shopee.com.br/product/111/222",
              offerLink: "https://s.shopee.com.br/example",
              imageUrl: "https://down-br.img.susercontent.com/file/example",
            }],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.searchOffers({ query: "abajur bauhaus", page: 7, limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.page, 7);
  assert.equal(result.items[0]?.imageUrl, "https://down-br.img.susercontent.com/file/example");
  assert.match(requestBody, /page: 7/);
  assert.match(requestBody, /imageUrl/);
});

test("cycle pagination expands through all ten official result pages", () => {
  const pages = new Set<number>();
  for (let cycle = 1; cycle <= 10; cycle += 1) pages.add(discoveryPage(cycle, "Tecnologia", 0));
  assert.deepEqual([...pages].sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10]);
});

test("official image evidence is injected only as data and still goes through canonical image review", () => {
  const html = trustedEvidenceOverride(
    "Luminária Space Age Cromada",
    "https://down-br.img.susercontent.com/file/official-image",
  );
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /official-image/);
  assert.doesNotMatch(html, /price/);
});

test("queue metadata carries the real publication timestamp for the 24h cadence", () => {
  const publishedAt = "2026-08-30T06:00:00.000Z";
  const encoded = queueNote({
    score: 98,
    profileVersion: "1.3",
    queuedAt: "2026-08-29T06:00:00.000Z",
    publishedAt,
    query: "luminaria space age",
    shopId: "111",
    itemId: "222",
    sourceProductUrl: "https://shopee.com.br/product/111/222",
    imageUrl: "https://down-br.img.susercontent.com/file/official-image",
  });
  assert.equal(parseQueueNote(encoded)?.publishedAt, publishedAt);
  const now = new Date(Date.parse(publishedAt) + DAY_MS - 1);
  assert.equal(dueForPublication(publishedAt, now), false);
  assert.equal(dueForPublication(publishedAt, new Date(Date.parse(publishedAt) + DAY_MS)), true);
});

test("legacy paused rejects do not poison catalog similarity, but active and future queue products do", () => {
  const base = (id: string, status: Product["status"], ativo: boolean, createdBy?: string): Product => ({
    id,
    produto: id,
    categoria: "Decoração",
    preco: 100,
    imagens: ["https://example.com/image.jpg"],
    link: `https://example.com/${id}`,
    ativo,
    destaque: false,
    status,
    createdBy,
  });
  const legacyPaused = base("legacy-paused", "paused", false, "system");
  const publicProduct = base("public", "published", true, "system");
  const future = base("future", "paused", false, "autonomous_curator_queue");
  assert.deepEqual(similarityUniverse([legacyPaused, publicProduct, future]).map(product => product.id).sort(), ["future", "public"]);
});

test("continuous v2 never persists a no_candidate attempt over the daily category authority", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision:\s*["']no_candidate["']/);
  assert.match(source, /continuous_cycles/);
  assert.match(source, /failedThisCycle \+= 1/);
});

test("continuous route is wired to v2", async () => {
  const source = await readFile(new URL("../server/routes/autonomousCuratorRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /runAutonomousCuratorContinuousV2/);
  assert.doesNotMatch(source, /runAutonomousCuratorContinuous\s*\(/);
});
