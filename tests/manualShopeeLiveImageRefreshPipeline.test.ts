import test from "node:test";
import assert from "node:assert/strict";
import { ProductPipeline, type LifecycleRecord } from "../server/services/productPipeline";

test("changed live image invalidates human approval before canonical persistence", async () => {
  const staleImage = "https://cf.shopee.com.br/file/sg-11134224-stale-card-asset";
  const liveImage = "https://down-br.img.susercontent.com/file/sg-11134224-current-live-asset";
  let createCalls = 0;

  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    preflightPublication: async candidate => {
      assert.equal(candidate.imagemPrincipal, staleImage);
      assert.notEqual(candidate.imagemPrincipal, liveImage);
      return { ok: false, code: "SHOPEE_PREFLIGHT_IMAGE_CHANGED", transient: false };
    },
    createCanonicalProduct: async candidate => {
      createCalls += 1;
      return {
        id: "prod-live-image-refresh",
        produto: candidate.produto,
        categoria: candidate.categoria,
        preco: candidate.preco || 1,
        imagens: candidate.imagens,
        imageEditorialStatus: candidate.imageEditorialStatus,
        imageCuration: candidate.imageCuration,
        link: candidate.link || candidate.normalizedUrl,
        descricao: candidate.descricao,
        ativo: false,
        status: "approved",
      } as any;
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
  });

  const record: LifecycleRecord = {
    id: "lifecycle-live-image-refresh",
    state: "APPROVED",
    humanApproved: true,
    candidate: {
      normalizedUrl: "https://shopee.com.br/product/1875215908/48265149278",
      link: "https://s.shopee.com.br/example",
      marketplace: "Shopee",
      produto: "Produto Shopee",
      descricao: "Descrição válida.",
      categoria: "Casa & Decoração",
      preco: 49.9,
      imagens: [staleImage],
      imagensOriginais: [staleImage],
      imagemPrincipal: staleImage,
      imageEditorialStatus: "clean",
      imageCuration: {
        status: "ready",
        rawImageUrls: [staleImage],
        primaryImageUrl: staleImage,
        galleryImageUrls: [],
        assessments: [],
      },
      slug: "produto-shopee",
      state: "APPROVED",
      discoveredAt: new Date().toISOString(),
    },
    validation: { outcome: "PASS", errors: [], warnings: [] },
    curation: {
      score: 90,
      category: "Casa & Decoração",
      confidence: "HIGH",
      reasons: [],
      risks: [],
      recommendation: "PUBLISH",
    },
    audit: [],
  };

  const result = await pipeline.publish(record, { humanManualApproval: true });

  assert.equal(result.state, "APPROVED");
  assert.equal(result.diagnostic?.code, "SHOPEE_PREFLIGHT_IMAGE_CHANGED");
  assert.equal(createCalls, 0);
  assert.equal(result.candidate.imagemPrincipal, staleImage);
  assert.equal(result.candidate.imageCuration?.primaryImageUrl, staleImage);
  assert.equal(result.candidate.imageEditorialStatus, "clean");
});
