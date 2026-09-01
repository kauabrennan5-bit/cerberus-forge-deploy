import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankManualShopeeCandidates,
  runShopeeManualDeliveryCommand,
} from "../server/services/shopeeManualDelivery";

const SHOP_ID = "1530442944";
const ITEM_1 = "23794344926";
const ITEM_2 = "23794344927";
const PRODUCT_1 = `https://shopee.com.br/Brinquedo-Infantil-A-i.${SHOP_ID}.${ITEM_1}`;
const PRODUCT_2 = `https://shopee.com.br/Brinquedo-Infantil-B-i.${SHOP_ID}.${ITEM_2}`;
const IMAGE_1 = "https://down-br.img.susercontent.com/file/brinquedo-a";
const IMAGE_2 = "https://down-br.img.susercontent.com/file/brinquedo-b";

function hardReject(reason: string) {
  return {
    state: "HARD_REJECT" as const,
    reason,
    probe: {
      ok: true,
      httpStatus: 200,
      mimeType: "image/webp",
      width: 800,
      height: 800,
      format: "webp",
      byteLength: 1024,
      reason: null,
    },
    assessment: null,
    curationReason: "no_commercial_image" as const,
    visualScore: 0,
  };
}

function offer(itemId: string, name: string, productLink: string, imageUrl: string) {
  return {
    shopId: SHOP_ID,
    itemId,
    name,
    price: itemId === ITEM_1 ? 59.9 : 69.9,
    productLink,
    offerLink: `https://s.shopee.com.br/offer-${itemId.slice(-4)}`,
    imageUrl,
  };
}

describe("manual /shopee delivery guarantee", () => {
  it("keeps hard-rejected candidates rankable instead of deleting the pool", () => {
    const ranked = rankManualShopeeCandidates([
      {
        candidateIndex: 1,
        shopId: SHOP_ID,
        itemId: ITEM_1,
        name: "Brinquedo infantil educativo",
        price: 59.9,
        productLink: PRODUCT_1,
        imageUrl: IMAGE_1,
        round: 1,
        queryVariant: "brinquedo infantil",
        category: "Infantil",
        relevanceScore: 95,
        warnings: ["IMAGE_NOVELTY_HIGH"],
        qualification: hardReject("IMAGE_NOVELTY_HIGH"),
      },
      {
        candidateIndex: 2,
        shopId: SHOP_ID,
        itemId: ITEM_2,
        name: "Produto de outra categoria",
        price: 69.9,
        productLink: PRODUCT_2,
        imageUrl: IMAGE_2,
        round: 1,
        queryVariant: "brinquedo infantil",
        category: "Outros",
        relevanceScore: 0,
        warnings: ["CATEGORY_MISMATCH"],
        qualification: {
          ...hardReject("IMAGE_NOVELTY_HIGH"),
          state: "QUALIFIED" as const,
          reason: "IMAGE_CLEAN_HIGH",
          visualScore: 100,
        },
      },
    ]);

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.itemId, ITEM_1, "relevância da busca deve pesar mais do que um filtro visual editorial");
  });

  it("delivers the requested two cards even when both images are HARD_REJECT", async () => {
    const offers = [
      offer(ITEM_1, "Brinquedo infantil educativo madeira", PRODUCT_1, IMAGE_1),
      offer(ITEM_2, "Brinquedo infantil criativo montar", PRODUCT_2, IMAGE_2),
    ];
    const saved: any[] = [];
    const photos: Array<{ caption: string }> = [];
    const texts: string[] = [];
    const client = {
      searchOffers: async () => ({ ok: true, items: offers, httpStatus: 200, error: null, reason: null }),
      acquireAffiliateLink: async ({ itemId }: { shopId: string; itemId: string }) => {
        const found = offers.find(item => item.itemId === itemId)!;
        return {
          status: "link_acquired",
          affiliateUrl: `https://s.shopee.com.br/aff-${itemId.slice(-4)}`,
          productLink: found.productLink,
          shopId: found.shopId,
          itemId: found.itemId,
          name: found.name,
          price: found.price,
          raw: null,
          error: null,
        };
      },
      lookupProduct: async () => ({ status: "not_found" }),
      inspectPromotionFields: async () => ({ ok: false, nodeType: null, fields: [], reason: "not_tested" }),
      inspectPromotionOffer: async () => ({ ok: false, values: null, reason: "not_tested" }),
    } as any;

    const result = await runShopeeManualDeliveryCommand("brinquedo infantil 2", {
      client,
      chatId: 123456,
      cardPauseMs: 0,
      qualifyImage: async (_url, title) => hardReject(title.includes("madeira") ? "IMAGE_NOVELTY_HIGH" : "IMAGE_COLLAGE_HIGH"),
      identityAlreadyKnown: async () => false,
      saveReview: async review => { saved.push(review); },
      sendPhoto: async (_chatId, _photo, caption) => {
        photos.push({ caption: String(caption) });
        return { ok: true } as any;
      },
      sendMessage: async (_chatId, text) => {
        texts.push(String(text));
        return { ok: true } as any;
      },
    });

    assert.equal(result.countRequested, 2);
    assert.equal(result.candidatesReceived, 2);
    assert.equal(result.ok, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.errorCode, null);
    assert.equal(result.hardRejectCount, 2);
    assert.equal(photos.length, 2);
    assert.equal(saved.length, 2);
    assert.equal(saved.every(review => review.status === "pending"), true);
    assert.equal(saved.every(review => review.imageEditorialStatus === "review_required"), true);
    assert.equal(saved.every(review => review.existingProduct?.manualDeliveryContract === true), true);
    assert.match(photos[0]?.caption || "", /DECISÃO HUMANA/);
    assert.match(photos.map(card => card.caption).join("\n"), /IMAGE_NOVELTY_HIGH|IMAGE_COLLAGE_HIGH/);
    assert.match(texts.join("\n"), /LOTE SHOPEE ENTREGUE/);
  });
});
