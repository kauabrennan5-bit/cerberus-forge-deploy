import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectGroundedShopeeUrls } from "../server/services/shopeeSearchProvider";

describe("collectGroundedShopeeUrls", () => {
  it("combina URLs Shopee válidos do texto e das citações sem duplicá-los", () => {
    const urls = collectGroundedShopeeUrls({
      text: "https://shopee.com.br/product/10/20 e https://example.com/ignore",
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://shopee.com.br/produto-exemplo-i.30.40" } },
            { web: { uri: "https://shopee.com.br/product/10/20" } },
            { web: { uri: "https://example.com/fora" } },
          ],
        },
      }],
    });

    assert.deepEqual(urls, [
      "https://shopee.com.br/product/10/20",
      "https://shopee.com.br/produto-exemplo-i.30.40",
    ]);
  });
});
