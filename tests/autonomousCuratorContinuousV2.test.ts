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
  discoveryPages,
  trustedEvidenceOverride,
  similarityUniverse,
  queueNote,
  parseQueueNote,
  liveCatalogTarget,
  activePublishedCount,
  inventoryDeficit,
  dueForCycle,
  categoryCounts,
  categoryDeficits,
  totalDeficit,
  autonomousGrowthStartDate,
  dailyTargetPerCategory,
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

test("every query starts from relevance page 1 and deep exploration remains bounded", () => {
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    let deep = 0;
    for (let queryIndex = 0; queryIndex < 12; queryIndex += 1) {
      const pages = discoveryPages(cycle, "Iluminação", queryIndex);
      assert.equal(pages[0], 1);
      assert.ok(pages.length === 1 || pages.length === 2);
      if (pages.length === 2) {
        deep += 1;
        assert.ok(pages[1] >= 2 && pages[1] <= 10);
      }
    }
    assert.ok(deep <= 4);
  }
});

test("continuous discovery compares qualified finalists instead of publishing the first passing item", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.match(source, /qualified\.push/);
  assert.match(source, /BEST_OF_\$\{qualified\.length\}_QUALIFIED_CANDIDATES/);
  assert.doesNotMatch(source, /if \(evaluated\.candidate\) return \{ candidate: evaluated\.candidate/);
  assert.match(source, /for \(const query of queries\) await collectPage\(query, 1\)/);
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
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision:\s*["']no_candidate["']/);
  assert.match(source, /continuous_cycles/);
  assert.match(source, /failedThisCycle \+= 1/);
});

test("continuous route is wired to the progressive v2 coordinator", async () => {
  const source = await readFile(new URL("../server/routes/autonomousCuratorRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /runAutonomousCuratorContinuousV2/);
  assert.doesNotMatch(source, /runAutonomousCuratorContinuous\s*\(/);
});

test("legacy base global floor remains bounded for compatibility", () => {
  assert.equal(liveCatalogTarget({} as NodeJS.ProcessEnv), 10);
  assert.equal(liveCatalogTarget({ AUTONOMOUS_CURATOR_LIVE_CATALOG_TARGET: "14" } as NodeJS.ProcessEnv), 14);
  assert.equal(liveCatalogTarget({ AUTONOMOUS_CURATOR_LIVE_CATALOG_TARGET: "999" } as NodeJS.ProcessEnv), 100);
});

test("legacy inventory deficit counts only active published products", () => {
  const product = (id: string, status: Product["status"], ativo: boolean): Product => ({
    id, produto: id, categoria: "Decoração", preco: 100, imagens: ["https://example.com/a.jpg"],
    link: `https://example.com/${id}`, ativo, destaque: false, status,
  });
  const products = [
    ...Array.from({ length: 6 }, (_, index) => product(`published-${index}`, "published", true)),
    product("queued", "paused", false),
    product("archived", "archived", false),
  ];
  assert.equal(activePublishedCount(products), 6);
  assert.equal(inventoryDeficit(products, {} as NodeJS.ProcessEnv), 4);
});

test("legacy emergency refill primitive still overrides cooldown only while its supplied deficit remains", () => {
  const now = new Date("2026-08-31T02:30:00.000Z");
  const justPublished = new Date(now.getTime() - 60_000).toISOString();
  assert.equal(dueForPublication(justPublished, now), false);
  assert.equal(dueForCycle(justPublished, now, true, 4), true);
  assert.equal(dueForCycle(justPublished, now, true, 1), true);
  assert.equal(dueForCycle(justPublished, now, true, 0), false);
  assert.equal(dueForCycle(justPublished, now, false, 0), false);
});

test("progressive coordinator derives day 3 target from the first autonomous publication", () => {
  const first: Product = {
    id: "auto-first",
    produto: "Primeiro find",
    categoria: "Decoração",
    preco: 100,
    imagens: ["https://example.com/a.jpg"],
    link: "https://example.com/auto-first",
    ativo: false,
    destaque: false,
    status: "archived",
    createdBy: "autonomous_curator_queue",
    createdAt: "2026-08-30T14:23:16.000Z",
  };
  const now = new Date("2026-09-01T16:30:00.000Z");
  assert.equal(autonomousGrowthStartDate([first], now, {} as NodeJS.ProcessEnv), "2026-08-30");
  assert.equal(dailyTargetPerCategory([first], now, {} as NodeJS.ProcessEnv), 3);
  assert.equal(dailyTargetPerCategory([first], now, { AUTONOMOUS_CURATOR_GROWTH_START_DATE: "2026-08-29" } as NodeJS.ProcessEnv), 4);
});

test("category deficits use today's cumulative target instead of an exact-two cap", () => {
  const product = (id: string, category: Product["categoria"], status: Product["status"] = "published", ativo = true): Product => ({
    id,
    produto: id,
    categoria: category,
    preco: 100,
    imagens: ["https://example.com/a.jpg"],
    link: `https://example.com/${id}`,
    ativo,
    destaque: false,
    status,
  });
  const products: Product[] = [
    product("lamp-1", "Iluminação"),
    product("lamp-2", "Iluminação"),
    product("decor-1", "Decoração"),
    product("shoe-archived", "Calçados & Acessórios", "archived", false),
  ];
  const counts = categoryCounts(products);
  const deficits = categoryDeficits(counts, 3);
  assert.equal(counts["Iluminação"], 2);
  assert.equal(counts["Decoração"], 1);
  assert.equal(counts["Calçados & Acessórios"], 0);
  assert.equal(deficits["Iluminação"], 1);
  assert.equal(deficits["Decoração"], 2);
  assert.equal(deficits["Calçados & Acessórios"], 3);
  assert.equal(totalDeficit(counts, 3), 27);
});

test("healthy publications accumulate instead of being selected for retirement", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /function retirementCandidates/);
  assert.doesNotMatch(source, /category_balance_retired_ids/);
  assert.match(source, /never archived merely because a category crossed a fixed cap/);
});
