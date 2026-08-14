import assert from "node:assert/strict";
import test from "node:test";
import { ProductPipeline, getProductPipelineTelemetry } from "../server/services/productPipeline";
import { curateCandidate, detectDuplicate, normalizeCandidate, transitionProductState, validateCandidate } from "../server/services/productLifecycle";

const validInput = {
  normalizedUrl: "https://shopee.com.br/produto-i.123.456?utm_source=ad",
  marketplace: "Shopee",
  produto: "Jaqueta Utilitária Preta",
  categoria: "Jaquetas",
  preco: 199.9,
  imagens: ["https://cdn.example.com/product.jpg"],
  descricao: "Peça utilitária com corte reto.",
};

test("normalização remove UTMs sem inventar dados", () => {
  const candidate = normalizeCandidate(validInput);
  assert.equal(candidate.normalizedUrl.includes("utm_source"), false);
  assert.equal(candidate.produto, "Jaqueta Utilitária Preta");
  assert.equal(candidate.marketplace, "Shopee");
});

test("validação bloqueia dados obrigatórios ausentes", () => {
  const candidate = normalizeCandidate({ ...validInput, preco: 0, imagens: [], produto: "" });
  const validation = validateCandidate(candidate, []);
  assert.equal(validation.outcome, "FAIL");
  assert.ok(validation.errors.length >= 3);
});

test("duplicidade exata bloqueia e similaridade vai para revisão", () => {
  const candidate = normalizeCandidate(validInput);
  const exact = detectDuplicate(candidate, [{ id: "same", link: candidate.normalizedUrl, produto: "Outro" }]);
  assert.equal(exact?.potential, false);
  const similar = detectDuplicate(candidate, [{ id: "similar", link: "https://shopee.com.br/outro-i.9.9", produto: "Jaqueta Utilitária Preta" }]);
  assert.equal(similar?.potential, true);
});

test("curadoria estruturada usa somente sinais presentes", () => {
  const candidate = normalizeCandidate(validInput);
  const curation = curateCandidate(candidate, validateCandidate(candidate, []));
  assert.equal(curation.recommendation, "PUBLISH");
  assert.equal(curation.confidence, "HIGH");
  assert.ok(curation.reasons.length > 0);
});

test("máquina de estados rejeita transições inválidas", () => {
  assert.throws(() => transitionProductState("DISCOVERED", "PUBLISHED"), /INVALID_PRODUCT_TRANSITION/);
  assert.doesNotThrow(() => transitionProductState("PENDING_APPROVAL", "APPROVED"));
});

test("E2E mock segue discovered até published somente após aprovação e validação", async () => {
  let creates = 0;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => {
      creates += 1;
      return { id: "prod-1", ref: "REF-999", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false, status: "published" };
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
  });
  const record = await pipeline.evaluate(validInput);
  assert.equal(record.state, "PENDING_APPROVAL");
  await assert.rejects(() => pipeline.publish(record), /APPROVAL_REQUIRED/);
  pipeline.approve(record);
  await pipeline.publish(record);
  assert.equal(record.state, "PUBLISHED");
  assert.equal(creates, 1);
  await pipeline.publish(record);
  assert.equal(creates, 1);
});

test("falha de publicação não declara published e mantém erro auditável", async () => {
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => ({ id: "prod-2", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false, status: "published" }),
    syncAndValidatePublication: async () => ({ success: false, error: "PUBLICATION_ERROR" }),
    pauseCanonicalProduct: async () => undefined,
  });
  const record = await pipeline.evaluate(validInput);
  pipeline.approve(record);
  await pipeline.publish(record);
  assert.equal(record.state, "APPROVED");
  assert.equal(record.error, "PUBLICATION_ERROR");
  assert.equal(record.audit[0].type, "PRODUCT_PUBLICATION_FAILED");
});

test("pausa preserva produto e altera somente o lifecycle operacional", async () => {
  let paused = false;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => ({ id: "prod-3", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false, status: "published" }),
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => { paused = true; },
  });
  const record = await pipeline.evaluate(validInput);
  pipeline.approve(record);
  await pipeline.publish(record);
  await pipeline.pause(record);
  assert.equal(record.state, "PAUSED");
  assert.equal(paused, true);
});

test("rejeição e arquivamento não disparam publicação nem exclusão física", async () => {
  let creates = 0;
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => {
      creates += 1;
      return { id: "prod-4", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false, status: "published" };
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
  });
  const rejected = await pipeline.evaluate(validInput);
  pipeline.reject(rejected, "Referência duplicada em revisão humana.");
  assert.equal(rejected.state, "REJECTED");
  assert.equal(creates, 0);

  const published = await pipeline.evaluate({ ...validInput, normalizedUrl: "https://shopee.com.br/produto-i.123.789" });
  pipeline.approve(published);
  await pipeline.publish(published);
  await pipeline.pause(published);
  pipeline.archive(published);
  assert.equal(published.state, "ARCHIVED");
  assert.equal(creates, 1);
});

test("telemetria registra falhas e propostas sem conceder execução arbitrária", async () => {
  const pipeline = new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async candidate => ({ id: "prod-5", produto: candidate.produto, categoria: candidate.categoria, preco: candidate.preco!, imagens: candidate.imagens, link: candidate.normalizedUrl, ativo: true, destaque: false, status: "published" }),
    syncAndValidatePublication: async () => ({ success: false, error: "GITHUB_UNAVAILABLE" }),
    pauseCanonicalProduct: async () => undefined,
  });
  const record = await pipeline.evaluate({ ...validInput, normalizedUrl: "https://shopee.com.br/produto-i.123.999" });
  pipeline.approve(record);
  await pipeline.publish(record);
  const telemetry = getProductPipelineTelemetry();
  assert.ok(telemetry.total > 0);
  assert.ok(telemetry.errors > 0);
  assert.equal(telemetry.recent.some(item => item.error === "PUBLICATION_ERROR"), true);
});
