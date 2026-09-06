import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shopeePublicationPreflightInternals } from "../server/services/shopeePublicationPreflight";

const { shopeeImageAssetKey, sameShopeeImageAsset } = shopeePublicationPreflightInternals;

describe("Shopee publication preflight image identity", () => {
  it("treats cf.shopee.com.br and img.susercontent.com aliases as the same asset", () => {
    const card = "https://cf.shopee.com.br/file/br-11134207-820lr-ms1iqpn6kah306";
    const live = "https://down-br.img.susercontent.com/file/br-11134207-820lr-ms1iqpn6kah306";
    assert.equal(shopeeImageAssetKey(card), "br-11134207-820lr-ms1iqpn6kah306");
    assert.equal(shopeeImageAssetKey(live), "br-11134207-820lr-ms1iqpn6kah306");
    assert.equal(sameShopeeImageAsset(card, live), true);
  });

  it("matches the production alias observed for the Bauhaus pendant card", () => {
    const card = "https://cf.shopee.com.br/file/cn-11134207-820l4-mitvi9gtixona4";
    const live = "https://down-br.img.susercontent.com/file/cn-11134207-820l4-mitvi9gtixona4";
    assert.equal(sameShopeeImageAsset(card, live), true);
  });

  it("still blocks a genuinely different Shopee image asset", () => {
    const approved = "https://cf.shopee.com.br/file/br-11134207-approved";
    const changed = "https://down-br.img.susercontent.com/file/br-11134207-different";
    assert.equal(sameShopeeImageAsset(approved, changed), false);
  });

  it("does not normalize unrelated image hosts into Shopee asset identity", () => {
    const approved = "https://example.com/file/br-11134207-approved";
    const live = "https://down-br.img.susercontent.com/file/br-11134207-approved";
    assert.equal(shopeeImageAssetKey(approved), null);
    assert.equal(sameShopeeImageAsset(approved, live), false);
  });

  it("preserves exact-url equality for already canonical images", () => {
    const image = "https://images.example.com/product/photo.jpg";
    assert.equal(sameShopeeImageAsset(image, image), true);
  });
});
