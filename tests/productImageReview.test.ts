import test from "node:test";
import assert from "node:assert/strict";
import { reviewProductImages, productImageReviewInternals } from "../server/services/productImageReview";

const allowBudget = {
  reserve() {
    return { allowed: true, used: 1, limit: 100, resetAt: Date.now() + 60_000 };
  },
};

const denyBudget = {
  reserve() {
    return { allowed: false, used: 100, limit: 100, resetAt: Date.now() + 60_000 };
  },
};

function imageResponse(status = 200): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status,
    headers: { "content-type": "image/jpeg" },
  });
}

test("reviewer visual é desacoplado do modelo de copy e usa Flash-Lite de alto throughput", () => {
  assert.equal(productImageReviewInternals.resolveImageReviewModel({}), "gemini-3.5-flash-lite");
  assert.equal(productImageReviewInternals.resolveImageReviewModel({ GEMINI_PRODUCT_CURATOR_MODEL: "gemini-3.7-flash" }), "gemini-3.5-flash-lite");
  assert.equal(productImageReviewInternals.resolveImageReviewModel({ GEMINI_PRODUCT_IMAGE_REVIEW_MODEL: "gemini-3.6-flash" }), "gemini-3.5-flash-lite");
  assert.equal(productImageReviewInternals.resolveImageReviewModel({ GEMINI_PRODUCT_IMAGE_REVIEW_MODEL: "custom-model" }), "custom-model");
  assert.equal(productImageReviewInternals.resolveImageReviewFallbackModel({}, "gemini-3.5-flash-lite"), "gemini-3.7-flash");
  assert.equal(productImageReviewInternals.resolveImageReviewFallbackModel({}, "gemini-3.7-flash"), "gemini-3.5-flash-lite");
  assert.equal(productImageReviewInternals.resolveImageReviewFallbackModel({ GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL: "gemini-3.7-flash" }, "gemini-3.7-flash"), null);
});

test("uma imagem CDN quebrada não invalida outra imagem revisável do mesmo produto", async () => {
  const bad = "https://cdn.example.test/bad.jpg";
  const good = "https://cdn.example.test/good.jpg";
  let generationCalls = 0;
  const result = await reviewProductImages([bad, good], "Abajur Cogumelo", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    timeoutMs: 50,
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url) === bad) return imageResponse(404);
      return imageResponse(200);
    }) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      return {
        text: JSON.stringify({
          images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "produto isolado" }],
        }),
      };
    },
  });
  assert.equal(generationCalls, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, good);
  assert.deepEqual(result.rawImageUrls, [bad, good]);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].url, good);
});

test("falha multimodal em lote recai para revisão isolada e preserva imagem limpa válida", async () => {
  const first = "https://cdn.example.test/first.jpg";
  const second = "https://cdn.example.test/second.jpg";
  let generationCalls = 0;
  const result = await reviewProductImages([first, second], "Luminária Retrô", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse(200)) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      if (generationCalls === 1) throw new Error("batch rejected by provider");
      if (generationCalls === 2) {
        return { text: JSON.stringify({ images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "produto limpo" }] }) };
      }
      return { text: JSON.stringify({ images: [{ index: 1, decision: "promotional", confidence: "HIGH", reason: "texto promocional" }] }) };
    },
  });
  assert.equal(generationCalls, 3);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, first);
  assert.equal(result.assessments.length, 2);
  assert.equal(result.assessments[0].url, first);
  assert.equal(result.assessments[0].decision, "clean");
  assert.equal(result.assessments[1].url, second);
  assert.equal(result.assessments[1].decision, "promotional");
});

test("429 faz um único failover multimodal após backoff e preserva budget", async () => {
  let generationCalls = 0;
  let reserves = 0;
  const models: string[] = [];
  const delays: number[] = [];
  const budget = {
    reserve() {
      reserves += 1;
      return { allowed: true, used: reserves, limit: 100, resetAt: Date.now() + 60_000 };
    },
  };
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key", GEMINI_PRODUCT_IMAGE_REVIEW_MODEL: "gemini-3.7-flash" },
    budget,
    allowRepair: false,
    delayImpl: async ms => { delays.push(ms); },
    fetchImpl: (async () => imageResponse(200)) as typeof fetch,
    generateContent: async request => {
      generationCalls += 1;
      models.push(String(request.model || ""));
      if (generationCalls === 1) throw new Error("429 RESOURCE_EXHAUSTED rate limit exceeded");
      return { text: JSON.stringify({ images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "produto limpo" }] }) };
    },
  });
  assert.equal(generationCalls, 2);
  assert.equal(reserves, 2);
  assert.deepEqual(delays, [2_000]);
  assert.deepEqual(models, ["gemini-3.7-flash", "gemini-3.5-flash-lite"]);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, "https://cdn.example.test/a.jpg");
});

test("erro permanente de modelo não dispara retries nem fallback que drenam o budget", async () => {
  let generationCalls = 0;
  let reserves = 0;
  const budget = {
    reserve() {
      reserves += 1;
      return { allowed: true, used: reserves, limit: 100, resetAt: Date.now() + 60_000 };
    },
  };
  const result = await reviewProductImages([
    "https://cdn.example.test/a.jpg",
    "https://cdn.example.test/b.jpg",
    "https://cdn.example.test/c.jpg",
  ], "Produto", {
    env: { GEMINI_API_KEY: "test-key", GEMINI_PRODUCT_IMAGE_REVIEW_MODEL: "gemini-3.7-flash" },
    budget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse(200)) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      throw new Error("404 model not found");
    },
  });
  assert.equal(generationCalls, 1);
  assert.equal(reserves, 1);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_model_unavailable");
});

test("quando todas as imagens falham no CDN o motivo fica explícito e o Gemini não é chamado", async () => {
  let generationCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    timeoutMs: 25,
    fetchImpl: (async () => imageResponse(404)) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      return { text: "{}" };
    },
  });
  assert.equal(generationCalls, 0);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_fetch_unavailable");
});

test("exaustão do orçamento visual é distinguida de falha de imagem", async () => {
  let fetchCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: denyBudget,
    allowRepair: false,
    fetchImpl: (async () => {
      fetchCalls += 1;
      return imageResponse(200);
    }) as typeof fetch,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_budget_exhausted");
});

test("erro transitório em ambos os modelos permanece fail-closed", async () => {
  let calls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    delayImpl: async () => {},
    fetchImpl: (async () => imageResponse(200)) as typeof fetch,
    generateContent: async () => {
      calls += 1;
      throw new Error("429 provider unavailable");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_model_unavailable");
  assert.equal(result.primaryImageUrl, undefined);
});
