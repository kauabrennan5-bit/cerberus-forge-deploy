import test from "node:test";
import assert from "node:assert/strict";
import {
  isEditorialDisplayTitle,
  productAiRecoveryInternals,
  recoverProductCandidateWithOpenAI,
} from "../server/services/productAiRecovery";
import { autonomousCuratorRecoveryInternals } from "../server/services/autonomousCuratorRecovery";
import type { ExtractedReviewData } from "../server/services/productAutomation";

const allowBudget = {
  reserve() {
    return { allowed: true, used: 1, limit: 100, resetAt: Date.now() + 60_000 };
  },
};

function responsePayload(input: {
  viable: boolean;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  title?: string;
  description?: string;
  category?: string;
  reason?: string;
  decision?: string;
}) {
  return {
    output_text: JSON.stringify({
      viable: input.viable,
      confidence: input.confidence || "HIGH",
      display_title: input.title || "Luminária de Mesa Escultural",
      descricao: input.description || "Forma arredondada com presença escultórica e proporções compactas para uso sobre mesa.",
      categoria: input.category || "Iluminação",
      reason_code: input.reason || (input.viable ? "recovered" : "off_brand"),
      images: [{
        index: 1,
        decision: input.decision || (input.viable ? "clean" : "off_brand"),
        confidence: "HIGH",
        reason: input.viable ? "foto comercial limpa" : "produto visualmente genérico",
      }],
    }),
  };
}

function recoveryFetch(payload: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://cdn.example.test/product.jpg") {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

test("editorial title validation rejects marketplace copy and accepts recovered copy", () => {
  assert.equal(isEditorialDisplayTitle("Luminária de Mesa Escultural"), true);
  assert.equal(isEditorialDisplayTitle("OFERTA SHOPEE Luminária Frete Grátis"), false);
  assert.equal(isEditorialDisplayTitle("Produto"), false);
  assert.equal(isEditorialDisplayTitle("https://example.test/item"), false);
});

test("OpenAI multimodal recovery rescues a good product from weak marketplace input", async () => {
  const result = await recoverProductCandidateWithOpenAI({
    rawTitle: "luminaria moderna retro decoracao sala quarto led oferta",
    trustedTitle: "luminaria moderna retro decoracao sala quarto led oferta",
    rawContent: "Anúncio com texto promocional pouco útil.",
    rawImages: ["https://cdn.example.test/product.jpg"],
  }, {
    env: { OPENAI_API_KEY: "test-key", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "gpt-5.6-luna" },
    budget: allowBudget,
    fetchImpl: recoveryFetch(responsePayload({ viable: true })),
  });

  assert.ok(result);
  assert.equal(result.viable, true);
  assert.equal(result.displayTitle, "Luminária de Mesa Escultural");
  assert.equal(result.category, "Iluminação");
  assert.equal(result.imageCuration.status, "ready");
  assert.equal(result.imageCuration.primaryImageUrl, "https://cdn.example.test/product.jpg");
  assert.equal(result.reasonCode, "recovered");
});

test("strong off-brand visual evidence is not rescued", async () => {
  const result = await recoverProductCandidateWithOpenAI({
    rawTitle: "luminaria qualquer",
    rawImages: ["https://cdn.example.test/product.jpg"],
  }, {
    env: { OPENAI_API_KEY: "test-key" },
    budget: allowBudget,
    fetchImpl: recoveryFetch(responsePayload({
      viable: false,
      reason: "off_brand",
      decision: "off_brand",
    })),
  });

  assert.ok(result);
  assert.equal(result.viable, false);
  assert.equal(result.reasonCode, "off_brand");
  assert.equal(result.imageCuration.status, "review_required");
});

test("explicit expected category remains a hard recovery boundary", async () => {
  const result = await recoverProductCandidateWithOpenAI({
    rawTitle: "luminaria de mesa",
    expectedCategory: "Móveis",
    rawImages: ["https://cdn.example.test/product.jpg"],
  }, {
    env: { OPENAI_API_KEY: "test-key" },
    budget: allowBudget,
    fetchImpl: recoveryFetch(responsePayload({ viable: true, category: "Iluminação" })),
  });

  assert.ok(result);
  assert.equal(result.viable, false);
  assert.equal(result.reasonCode, "category_mismatch");
});

test("without explicit expected category recovery does not invent a hidden category constraint", async () => {
  const downloaded = [{
    url: "https://cdn.example.test/product.jpg",
    mimeType: "image/jpeg",
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
  }];
  const result = await productAiRecoveryInternals.callRecoveryModel({
    model: "gpt-5.6-luna",
    apiKey: "test-key",
    rawImageUrls: ["https://cdn.example.test/product.jpg"],
    downloaded,
    rawTitle: "objeto de mesa",
    trustedTitle: "objeto de mesa",
    expectedCategory: "",
    rawContent: "",
    timeoutMs: 500,
    fetchImpl: recoveryFetch(responsePayload({ viable: true, category: "Iluminação" })),
  });
  assert.equal(result.viable, true);
  assert.equal(result.category, "Iluminação");
});

test("raw marketplace title equal to public title is routed through recovery", () => {
  const data = {
    rawTitle: "Luminária de Mesa Moderna",
    displayTitle: "Luminária de Mesa Moderna",
    produto: "Luminária de Mesa Moderna",
    descricao: "Descrição editorial suficientemente longa para este teste.",
    categoria: "Iluminação",
  } as ExtractedReviewData;
  assert.equal(autonomousCuratorRecoveryInternals.incompleteEditorialData(data), true);

  const recovered = {
    ...data,
    displayTitle: "Luminária de Mesa Escultural",
  } as ExtractedReviewData;
  assert.equal(autonomousCuratorRecoveryInternals.incompleteEditorialData(recovered), false);
});
