import assert from "node:assert/strict";
import test from "node:test";
import {
  createShopeeApiClient,
  SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL,
  type ShopeeHttpTransport,
} from "../server/commercial/affiliate/shopeeApiClient";

test("Shopee client falls back to official endpoint when baseUrl is empty", async () => {
  let requestedUrl: string | null = null;
  const transport: ShopeeHttpTransport = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ data: { productOfferV2: { nodes: [] } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createShopeeApiClient({
    appId: "test-app",
    secret: "test-secret",
    baseUrl: "",
    transport,
    clock: () => 1_700_000_000_000,
  });
  await client.searchOffers({ query: "luminaria", limit: 5 });
  assert.equal(requestedUrl, SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL);
});
