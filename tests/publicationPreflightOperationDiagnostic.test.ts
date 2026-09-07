import test from "node:test";
import assert from "node:assert/strict";
import { ProductPipeline } from "../server/services/productPipeline";
import { formatDiagnosticForAdmin } from "../server/services/operationalDiagnostics";

test("preflight failure gets a real operation id and preserves the specific blocker code", async () => {
  let createCalled = false;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async () => {
      createCalled = true;
      throw new Error("should_not_create");
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
    preflightPublication: async () => ({
      ok: false,
      code: "SHOPEE_PREFLIGHT_IMAGE_CHANGED",
      transient: false,
    }),
  });

  let record = await pipeline.evaluate({
    normalizedUrl: "https://shopee.com.br/product/1875215908/48265149278",
    link: "https://shopee.com.br/product/1875215908/48265149278",
    marketplace: "Shopee",
    produto: "Luminária Bauhaus",
    descricao: "Peça selecionada para teste.",
    categoria: "Iluminação",
    preco: 199.9,
    imagens: ["https://cf.shopee.com.br/file/sg-11134224-825b3-mra1hjdhx2is4e"],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: ["https://cf.shopee.com.br/file/sg-11134224-825b3-mra1hjdhx2is4e"],
      primaryImageUrl: "https://cf.shopee.com.br/file/sg-11134224-825b3-mra1hjdhx2is4e",
      galleryImageUrls: [],
      assessments: [],
    },
  });

  assert.equal(record.state, "PENDING_APPROVAL");
  record = pipeline.approve(record);
  record = await pipeline.publish(record);

  assert.equal(createCalled, false);
  assert.match(record.operationId || "", /^PUB-/);
  assert.equal(record.diagnostic?.code, "SHOPEE_PREFLIGHT_IMAGE_CHANGED");
  assert.match(record.audit[0]?.reason || "", /SHOPEE_PREFLIGHT_IMAGE_CHANGED/);
  assert.match(record.audit[0]?.reason || "", /operação PUB-/);
  assert.ok(record.diagnostic);
  const adminText = formatDiagnosticForAdmin(record.diagnostic!);
  assert.match(adminText, /SHOPEE_PREFLIGHT_IMAGE_CHANGED/);
  assert.match(adminText, /PUB-/);
  assert.doesNotMatch(adminText, /sem-operation-id/);
});
