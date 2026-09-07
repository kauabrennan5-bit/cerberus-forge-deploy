import test from "node:test";
import assert from "node:assert/strict";
import { shopeePublicationPreflightInternals } from "../server/services/shopeePublicationPreflight";

const {
  shopeeImageAssetKey,
  sameShopeeImageAsset,
  hasApprovedImageEvidence,
  applyHumanManualLiveImageRefresh,
} = shopeePublicationPreflightInternals;

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

test("human approval refreshes a genuinely replaced Shopee asset to the current live image", () => {
  const saved = "https://cf.shopee.com.br/file/sg-11134224-825b3-mra1hjdhx2is4e";
  const currentPrimary = "https://down-br.img.susercontent.com/file/sg-11134224-NEW-LIVE-ASSET";
  const currentGallery = "https://down-br.img.susercontent.com/file/sg-11134224-NEW-LIVE-GALLERY";
  const candidate: any = {
    imagens: [saved],
    imagensOriginais: [saved],
    imagemPrincipal: saved,
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [saved],
      primaryImageUrl: saved,
      galleryImageUrls: [],
      assessments: [],
    },
  };

  assert.equal(hasApprovedImageEvidence(saved, [currentPrimary, currentGallery]), false);
  assert.equal(applyHumanManualLiveImageRefresh(candidate, {
    imagens: [currentPrimary, currentGallery],
    imagensOriginais: [currentPrimary, currentGallery],
    imagemPrincipal: currentPrimary,
  }, currentPrimary), true);

  assert.equal(candidate.imagemPrincipal, currentPrimary);
  assert.deepEqual(candidate.imagens, [currentPrimary, currentGallery]);
  assert.deepEqual(candidate.imagensOriginais, [currentPrimary, currentGallery]);
  assert.deepEqual(candidate.imagensGaleria, [currentGallery]);
  assert.equal(candidate.imageEditorialStatus, "clean");
  assert.equal(candidate.imageCuration.status, "ready");
  assert.equal(candidate.imageCuration.primaryImageUrl, currentPrimary);
});

test("live image refresh refuses a missing or non-HTTPS current image", () => {
  const candidate: any = { imagens: ["https://cf.shopee.com.br/file/original"] };
  const snapshot = structuredClone(candidate);

  assert.equal(applyHumanManualLiveImageRefresh(candidate, { imagens: [] }, ""), false);
  assert.deepEqual(candidate, snapshot);
  assert.equal(applyHumanManualLiveImageRefresh(candidate, { imagens: ["http://example.com/image.jpg"] }, "http://example.com/image.jpg"), false);
  assert.deepEqual(candidate, snapshot);
});