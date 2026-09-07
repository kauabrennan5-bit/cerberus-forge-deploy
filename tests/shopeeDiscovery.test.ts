import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverShopeeProducts,
  setTestSearchProvider,
} from "../server/services/shopeeDiscovery";

afterEach(() => setTestSearchProvider(null));

describe("discoverShopeeProducts", () => {
  it("mantém shopId/itemId e metadados DDG apenas como candidatos", async () => {
    setTestSearchProvider(async () => ({
      provider: "duckduckgo",
      state: "DDG_OK",
      httpStatus: 200,
      reason: null,
      candidates: [{
        url: "https://shopee.com.br/product/10/20",
        shopId: "10",
        itemId: "20",
        rawTitle: "Título não canônico do DDG",
      }],
    }));

    const result = await discoverShopeeProducts("luminária", 3);

    assert.equal(result.success, true);
    assert.equal(result.state, "DDG_OK");
    assert.deepEqual(result.products, [{
      url: "https://shopee.com.br/product/10/20",
      shopId: "10",
      itemId: "20",
      title: "Título não canônico do DDG",
      source: "ddg_candidate",
    }]);
  });

  for (const state of ["DDG_BLOCKED", "DDG_UNAVAILABLE", "DDG_NO_RESULTS"] as const) {
    it(`propaga o estado estruturado ${state}`, async () => {
      setTestSearchProvider(async () => ({
        provider: "duckduckgo",
        state,
        httpStatus: null,
        reason: state.toLowerCase(),
        candidates: [],
      }));
      const result = await discoverShopeeProducts("copo", 2);
      assert.equal(result.success, false);
      assert.equal(result.state, state);
      assert.equal(result.error, state);
      assert.deepEqual(result.products, []);
    });
  }
});
