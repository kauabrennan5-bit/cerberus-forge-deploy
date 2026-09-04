import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");

test("Shopee price fallback uses only observed positive prices and blocks without evidence", () => {
  const scraped = source.indexOf("const scrapedPrice = Number(data.preco);");
  const acquisition = source.indexOf("const acquisitionPrice = Number(acquisition.price);");
  const discovery = source.indexOf("const discoveryPrice = Number(input.discoveryPrice);");
  const resolution = source.indexOf("const price = Number.isFinite(scrapedPrice) && scrapedPrice > 0 ? scrapedPrice");
  const block = source.indexOf('if (!Number.isFinite(price) || price <= 0) return { candidate: null, reason: "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK" };');

  assert.ok(scraped >= 0, "scraped/SSR price observation must exist");
  assert.ok(acquisition > scraped, "official acquisition/provider price must be the next evidence source");
  assert.ok(discovery > acquisition, "discovery/provider-observed price must remain available as final evidence fallback");
  assert.ok(resolution > discovery, "price resolution must happen only after all observed sources are available");
  assert.ok(block > resolution, "publication candidate must be blocked when no positive finite observed price exists");

  const resolver = source.slice(resolution, block);
  assert.match(resolver, /Number\.isFinite\(scrapedPrice\) && scrapedPrice > 0 \? scrapedPrice/);
  assert.match(resolver, /Number\.isFinite\(acquisitionPrice\) && acquisitionPrice > 0 \? acquisitionPrice/);
  assert.match(resolver, /Number\.isFinite\(discoveryPrice\) && discoveryPrice > 0 \? discoveryPrice : Number\.NaN/);
  assert.doesNotMatch(resolver, /\?\s*0\b|:\s*0\b|\|\|\s*\d+(?:\.\d+)?/,
    "price resolver must not invent a numeric default");
});
