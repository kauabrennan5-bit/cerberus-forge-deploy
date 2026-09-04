import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autonomousCuratorContinuousV2Internals } from "../server/services/autonomousCuratorContinuousV2";

const source = readFileSync(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
const { priceEvidence, normalizePriceEvidence, resolvePriceEvidence, queueNote, parseQueueNote } = autonomousCuratorContinuousV2Internals;

test("Shopee price fallback preserves strict observed-source precedence", () => {
  const evidence = resolvePriceEvidence({
    shopId: "111",
    itemId: "222",
    scrapedPrice: 129.9,
    acquisitionPrice: 139.9,
    discoveryEvidence: priceEvidence("shopee_discovery_api", 149.9, "111", "222", "2026-09-04T18:00:00.000Z"),
    observedAt: "2026-09-04T18:05:00.000Z",
  });
  assert.equal(evidence?.source, "scraper_ssr");
  assert.equal(evidence?.price, 129.9);

  const providerFallback = resolvePriceEvidence({
    shopId: "111",
    itemId: "222",
    scrapedPrice: null,
    acquisitionPrice: 139.9,
    discoveryEvidence: priceEvidence("shopee_discovery_api", 149.9, "111", "222", "2026-09-04T18:00:00.000Z"),
    observedAt: "2026-09-04T18:05:00.000Z",
  });
  assert.equal(providerFallback?.source, "shopee_affiliate_api");
  assert.equal(providerFallback?.price, 139.9);

  const discoveryFallback = resolvePriceEvidence({
    shopId: "111",
    itemId: "222",
    scrapedPrice: null,
    acquisitionPrice: 0,
    discoveryEvidence: priceEvidence("shopee_discovery_api", 149.9, "111", "222", "2026-09-04T18:00:00.000Z"),
  });
  assert.equal(discoveryFallback?.source, "shopee_discovery_api");
  assert.equal(discoveryFallback?.price, 149.9);
});

test("invalid, zero and identity-mismatched provider price never becomes publication evidence", () => {
  assert.equal(priceEvidence("shopee_affiliate_api", 0, "111", "222"), null);
  assert.equal(priceEvidence("shopee_affiliate_api", -1, "111", "222"), null);
  assert.equal(priceEvidence("shopee_affiliate_api", Number.NaN, "111", "222"), null);

  const foreign = priceEvidence("shopee_discovery_api", 88.5, "999", "222", "2026-09-04T18:00:00.000Z");
  assert.ok(foreign);
  assert.equal(normalizePriceEvidence(foreign, "111", "222"), null);
  assert.equal(resolvePriceEvidence({ shopId: "111", itemId: "222", scrapedPrice: null, acquisitionPrice: null, discoveryEvidence: foreign }), null);
});

test("queue metadata persists provenance and legacy naked product price is not trusted as fallback", () => {
  const proof = priceEvidence("shopee_discovery_api", 79.9, "111", "222", "2026-09-04T18:00:00.000Z");
  assert.ok(proof);
  const encoded = queueNote({
    score: 94,
    profileVersion: "1.9",
    queuedAt: "2026-09-04T18:00:00.000Z",
    publishedAt: null,
    query: "radio retro madeira",
    shopId: "111",
    itemId: "222",
    sourceProductUrl: "https://shopee.com.br/product/111/222",
    imageUrl: "https://down-br.img.susercontent.com/file/example",
    priceEvidence: proof,
  });
  assert.deepEqual(parseQueueNote(encoded)?.priceEvidence, proof);

  assert.match(source, /discoveryPriceEvidence: meta\.priceEvidence \|\| null/);
  assert.doesNotMatch(source, /discoveryPrice(?:Evidence)?: input\.product\.preco/,
    "queued legacy numeric price must not become evidence by itself");
  assert.match(source, /priceEvidence: candidate\.priceEvidence/);
});

test("Shopee price contract remains fail-closed when no evidenced price exists", () => {
  const resolution = source.indexOf("const resolvedPriceEvidence = resolvePriceEvidence({");
  const block = source.indexOf('if (!resolvedPriceEvidence || !Number.isFinite(price) || price <= 0) return { candidate: null, reason: "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK" };');
  assert.ok(resolution >= 0);
  assert.ok(block > resolution);
  const resolver = source.slice(resolution, block);
  assert.match(resolver, /scrapedPrice: data\.preco/);
  assert.match(resolver, /acquisitionPrice: acquisition\.price/);
  assert.match(resolver, /discoveryEvidence: input\.discoveryPriceEvidence/);
  assert.doesNotMatch(resolver, /\?\s*0\b|:\s*0\b|\|\|\s*\d+(?:\.\d+)?/,
    "price resolver must not invent a numeric default");
});
