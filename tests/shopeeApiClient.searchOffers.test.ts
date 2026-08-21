import assert from "node:assert/strict";
import test from "node:test";

import { createShopeeApiClient } from "../server/commercial/affiliate/shopeeApiClient";

test("searchOffers usa productOfferV2 com keyword e extrai candidatos oficiais", async () => {
  let payload = "";
  const client = createShopeeApiClient({
    appId: "test-app",
    secret: "test-secret",
    clock: () => 1_700_000_000_000,
    transport: async (_url, init) => {
      payload = init.body;
      return new Response(JSON.stringify({
        data: {
          productOfferV2: {
            nodes: [{
              shopId: 1530442944,
              itemId: 23794344926,
              productName: "Luminária Bauhaus",
              price: "79.90",
              productLink: "https://shopee.com.br/product/1530442944/23794344926",
              offerLink: "https://s.shopee.com.br/teste",
            }],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.searchOffers({ query: "luminária bauhaus", limit: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.shopId, "1530442944");
  assert.equal(result.items[0]?.itemId, "23794344926");
  assert.match(payload, /productOfferV2\(keyword:/);
  assert.match(payload, /listType: 0/);
  assert.doesNotMatch(payload, /productOfferSearch/);
});

test("acquireAffiliateLink preserva o preço atual retornado para o item oficial exato", async () => {
  const client = createShopeeApiClient({
    appId: "test-app",
    secret: "test-secret",
    transport: async () => new Response(JSON.stringify({
      data: {
        productOfferV2: {
          nodes: [{
            shopId: 1530442944,
            itemId: 23794344926,
            productName: "Luminária Bauhaus",
            price: "79.90",
            productLink: "https://shopee.com.br/product/1530442944/23794344926",
            offerLink: "https://s.shopee.com.br/teste",
          }],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const result = await client.acquireAffiliateLink({ shopId: "1530442944", itemId: "23794344926" });

  assert.equal(result.status, "link_acquired");
  assert.equal(result.price, 79.9);
});

test("inspectPromotionFields usa apenas introspecção e retorna nomes de campos promocionais disponíveis", async () => {
  const payloads: string[] = [];
  let call = 0;
  const client = createShopeeApiClient({
    appId: "test-app",
    secret: "test-secret",
    transport: async (_url, init) => {
      payloads.push(init.body);
      call += 1;
      const body = call === 1
        ? { data: { productOfferV2: { nodes: [{ __typename: "ProductOfferNode" }] } } }
        : { data: { __type: { fields: [{ name: "price" }, { name: "promotionPrice" }, { name: "couponLabel" }] } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.inspectPromotionFields();

  assert.equal(result.ok, true);
  assert.equal(result.nodeType, "ProductOfferNode");
  assert.deepEqual(result.fields, ["couponLabel", "price", "promotionPrice"]);
  assert.match(payloads[0] ?? "", /__typename/);
  assert.match(payloads[1] ?? "", /__type/);
  assert.doesNotMatch(payloads.join("\n"), /offerLink/);
});
