import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Product } from "../src/types";
import { publishedProductHealthInternals } from "../server/services/publishedProductHealth";

const {
  DEFAULT_INTERVAL_MINUTES,
  HEALTH_VERSION,
  intervalMinutes,
  activePublished,
  isFresh,
} = publishedProductHealthInternals;

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-health-1",
    produto: "Produto",
    categoria: "Tecnologia",
    preco: 100,
    imagens: ["https://example.com/image.jpg"],
    link: "https://s.shopee.com.br/example",
    ativo: true,
    destaque: false,
    status: "published",
    ...overrides,
  };
}

test("published product health defaults to a bounded three-hour revalidation cadence", () => {
  assert.equal(HEALTH_VERSION, "1");
  assert.equal(DEFAULT_INTERVAL_MINUTES, 180);
  assert.equal(intervalMinutes({} as NodeJS.ProcessEnv), 180);
  assert.equal(intervalMinutes({ PUBLISHED_PRODUCT_HEALTH_INTERVAL_MINUTES: "60" } as NodeJS.ProcessEnv), 60);
  assert.equal(intervalMinutes({ PUBLISHED_PRODUCT_HEALTH_INTERVAL_MINUTES: "99999" } as NodeJS.ProcessEnv), 1440);
});

test("health audit only targets products that are actually visible and published", () => {
  assert.equal(activePublished(product()), true);
  assert.equal(activePublished(product({ ativo: false })), false);
  assert.equal(activePublished(product({ status: "archived" })), false);
});

test("fresh availability evidence suppresses repeated Shopee API calls inside the interval", () => {
  const now = new Date("2026-08-31T18:00:00.000Z");
  assert.equal(isFresh("2026-08-31T17:59:00.000Z", now, 3 * 60 * 60 * 1000), true);
  assert.equal(isFresh("2026-08-31T15:00:00.000Z", now, 3 * 60 * 60 * 1000), false);
});

test("health implementation archives only definitive exact-identity not_found results", async () => {
  const source = await readFile(new URL("../server/services/publishedProductHealth.ts", import.meta.url), "utf8");
  assert.match(source, /lookupProduct\(\{ shopId: identity\.shopId, itemId: identity\.itemId \}\)/);
  assert.match(source, /lookup\.status === "not_found"/);
  assert.match(source, /availability: "UNAVAILABLE"/);
  assert.match(source, /confidence: "HIGH"/);
  assert.match(source, /lookup\.error\?\.kind/);
  assert.match(source, /availability: "UNKNOWN"/);
  assert.match(source, /confidence: "INCONCLUSIVE"/);
});

test("balanced curator removes dead listings before calculating replacement deficits", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2.ts", import.meta.url), "utf8");
  const auditIndex = source.indexOf("auditPublishedProductHealth");
  const archiveIndex = source.indexOf("archiveUnavailableProducts(health.unavailableIds)");
  const countIndex = source.indexOf("const countsBefore = categoryCounts(productsBefore)");
  assert.ok(auditIndex >= 0);
  assert.ok(archiveIndex > auditIndex);
  assert.ok(countIndex > archiveIndex);
  assert.match(source, /published product health rollback/);
  assert.match(source, /Links Shopee indisponíveis removidos/);
});
