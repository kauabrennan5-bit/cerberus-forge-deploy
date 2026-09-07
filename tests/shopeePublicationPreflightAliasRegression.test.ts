import test from "node:test";
import assert from "node:assert/strict";
import { shopeePublicationPreflightInternals } from "../server/services/shopeePublicationPreflight";

const { shopeeImageAssetKey, sameShopeeImageAsset, hasApprovedImageEvidence } = shopeePublicationPreflightInternals;

test("manual Shopee preflight recognizes the real production CDN alias as the same asset", () => {
  const saved = "https://cf.shopee.com.br/file/sg-11134224-825b3-mra1hjdhx2is4e";
  const current = "https://down-br.img.susercontent.com/file/sg-11134224-825b3-mra1hjdhx2is4e";

  assert.equal(shopeeImageAssetKey(saved), "sg-11134224-825b3-mra1hjdhx2is4e");
  assert.equal(shopeeImageAssetKey(current), "sg-11134224-825b3-mra1hjdhx2is4e");
  assert.equal(sameShopeeImageAsset(saved, current), true);
  assert.equal(hasApprovedImageEvidence(saved, [current]), true);
});

test("Shopee asset matching tolerates CDN rendition paths and querystrings without accepting foreign hosts", () => {
  const saved = "https://cf.shopee.com.br/file/sg-11134224-825ah-msaoioy9c0sobd";
  const rendition = "https://down-br.img.susercontent.com/file/sg-11134224-825ah-msaoioy9c0sobd/preview?width=800";
  const foreign = "https://example.com/file/sg-11134224-825ah-msaoioy9c0sobd";

  assert.equal(sameShopeeImageAsset(saved, rendition), true);
  assert.equal(shopeeImageAssetKey(foreign), null);
  assert.equal(sameShopeeImageAsset(saved, foreign), false);
});
