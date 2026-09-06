import assert from "node:assert/strict";
import test from "node:test";
import { ProductPipeline, type ProductPublicationContext } from "../server/services/productPipeline";

const sourceProductUrl = "https://shopee.com.br/product/495461820/19277752799";
const affiliateUrl = "https://s.shopee.com.br/7psxyBbg6k";
const imageUrl = "https://down-br.img.susercontent.com/file/bauhaus-card";

test("approve() is the only transition that grants human manual publication authority", async () => {
  let capturedContext: ProductPublicationContext | undefined;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => ({
      id: "manual-card-product",
      ref: "MANUAL-CARD",
      produto: candidate.produto,
      rawTitle: candidate.rawTitle,
      displayTitle: candidate.displayTitle,
      categoria: candidate.categoria,
      preco: candidate.preco || 0,
      imagens: candidate.imagens,
      link: candidate.link,
      descricao: candidate.descricao,
      ativo: false,
      destaque: false,
      status: "approved",
    }),
    preflightPublication: async (_candidate, context) => {
      assert.equal(context?.humanManualApproval, true);
      assert.equal(context?.sourceProductUrl, sourceProductUrl);
      return { ok: true, code: "TEST_OK" };
    },
    syncAndValidatePublication: async (_product, operationId, context) => {
      capturedContext = context;
      return { success: true, operationId };
    },
    pauseCanonicalProduct: async () => {},
  });

  let record = await pipeline.evaluate({
    produto: "Pôsteres de Parede com Geometria Bauhaus",
    rawTitle: "Linhas abstratas Bauhaus",
    displayTitle: "Pôsteres de Parede com Geometria Bauhaus",
    categoria: "Decoração",
    preco: 12.2,
    imagens: [imageUrl],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [imageUrl],
      primaryImageUrl: imageUrl,
      galleryImageUrls: [],
      assessments: [],
    },
    normalizedUrl: sourceProductUrl,
    link: affiliateUrl,
    descricao: "Pôster geométrico inspirado na estética Bauhaus para decoração de parede.",
    marketplace: "Shopee",
  });

  assert.equal(record.state, "PENDING_APPROVAL");
  assert.notEqual(record.humanApproved, true);
  record = pipeline.approve(record);
  assert.equal(record.humanApproved, true);
  record = await pipeline.publish(record);
  assert.equal(record.state, "PUBLISHED");
  assert.equal(capturedContext?.humanManualApproval, true);
  assert.equal(capturedContext?.sourceProductUrl, sourceProductUrl);
});

test("publish without approve remains fail-closed", async () => {
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async () => { throw new Error("must not persist"); },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => {},
  });
  const record = await pipeline.evaluate({
    produto: "Objeto manual",
    rawTitle: "Objeto manual",
    displayTitle: "Objeto Manual",
    categoria: "Decoração",
    preco: 10,
    imagens: [imageUrl],
    normalizedUrl: sourceProductUrl,
    link: affiliateUrl,
    descricao: "Objeto decorativo com dados suficientes para revisão humana.",
    marketplace: "Shopee",
  });
  await assert.rejects(() => pipeline.publish(record), /APPROVAL_REQUIRED/);
});
