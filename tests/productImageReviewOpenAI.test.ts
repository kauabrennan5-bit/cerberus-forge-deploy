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

test("OpenAI visual fallback usa Luna por padrão e pode ser desativado explicitamente", () => {
  assert.equal(productImageReviewInternals.resolveOpenAIImageReviewModel({}), "gpt-5.6-luna");
  assert.equal(productImageReviewInternals.resolveOpenAIImageReviewModel({ OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "custom-openai-model" }), "custom-openai-model");
  assert.equal(productImageReviewInternals.resolveOpenAIImageReviewFallbackModel({}, "gpt-5.6-luna"), "gpt-4.1-mini");
  assert.equal(productImageReviewInternals.enabledUnlessFalse(undefined), true);
  assert.equal(productImageReviewInternals.enabledUnlessFalse("false"), false);
});

test("Gemini saudável continua primário e não gasta fallback OpenAI", async () => {
  let geminiCalls = 0;
  let openaiCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Luminária", {
    env: { GEMINI_API_KEY: "gemini-test", OPENAI_API_KEY: "openai-test" },
    budget: allowBudget,
    openaiBudget: allowBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    generateContent: async () => {
      geminiCalls += 1;
      return { text: JSON.stringify({ images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "produto limpo" }] }) };
    },
    openaiReview: async () => {
      openaiCalls += 1;
      return [];
    },
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openaiCalls, 0);
  assert.equal(result.status, "ready");
});

test("falha transitória dos dois modelos Gemini recai uma vez para OpenAI", async () => {
  let geminiCalls = 0;
  let openaiCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Luminária", {
    env: { GEMINI_API_KEY: "gemini-test", OPENAI_API_KEY: "openai-test" },
    budget: allowBudget,
    openaiBudget: allowBudget,
    allowRepair: false,
    delayImpl: async () => {},
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    generateContent: async () => {
      geminiCalls += 1;
      throw new Error("429 provider unavailable");
    },
    openaiReview: async input => {
      openaiCalls += 1;
      assert.equal(input.model, "gpt-5.6-luna");
      return [{ url: input.downloaded[0].url, decision: "clean", confidence: "HIGH", reason: "fallback visual válido" }];
    },
  });

  assert.equal(geminiCalls, 2);
  assert.equal(openaiCalls, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, "https://cdn.example.test/a.jpg");
});

test("OpenAI usa modelo secundário quando o primário não está disponível", async () => {
  const models: string[] = [];
  let reserves = 0;
  const openaiBudget = {
    reserve() {
      reserves += 1;
      return { allowed: true, used: reserves, limit: 256, resetAt: Date.now() + 60_000 };
    },
  };
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Luminária", {
    env: { OPENAI_API_KEY: "openai-test" },
    budget: denyBudget,
    openaiBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    openaiReview: async input => {
      models.push(input.model);
      if (input.model === "gpt-5.6-luna") throw new Error("OPENAI_IMAGE_REVIEW_HTTP_404");
      return [{ url: input.downloaded[0].url, decision: "clean", confidence: "HIGH", reason: "fallback visual compatível" }];
    },
  });
  assert.deepEqual(models, ["gpt-5.6-luna", "gpt-4.1-mini"]);
  assert.equal(reserves, 2);
  assert.equal(result.status, "ready");
});

test("OpenAI resolve apenas decisão ambígua e não sobrescreve rejeição forte do Gemini", async () => {
  const first = "https://cdn.example.test/first.jpg";
  const second = "https://cdn.example.test/second.jpg";
  let openaiCalls = 0;
  const result = await reviewProductImages([first, second], "Objeto", {
    env: { GEMINI_API_KEY: "gemini-test", OPENAI_API_KEY: "openai-test" },
    budget: allowBudget,
    openaiBudget: allowBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    generateContent: async () => ({
      text: JSON.stringify({
        images: [
          { index: 1, decision: "off_brand", confidence: "HIGH", reason: "genérico" },
          { index: 2, decision: "unknown", confidence: "LOW", reason: "incerto" },
        ],
      }),
    }),
    openaiReview: async input => {
      openaiCalls += 1;
      return [
        { url: input.downloaded[0].url, decision: "clean", confidence: "HIGH", reason: "não deve substituir rejeição forte" },
        { url: input.downloaded[1].url, decision: "clean", confidence: "HIGH", reason: "imagem comercial válida" },
      ];
    },
  });

  assert.equal(openaiCalls, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, second);
  assert.equal(result.assessments.find(item => item.url === first)?.decision, "off_brand");
  assert.equal(result.assessments.find(item => item.url === second)?.decision, "clean");
});

test("OpenAI pode sustentar o reviewer quando Gemini não está configurado", async () => {
  let openaiCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Cadeira", {
    env: { OPENAI_API_KEY: "openai-test" },
    openaiBudget: allowBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    openaiReview: async input => {
      openaiCalls += 1;
      return [{ url: input.downloaded[0].url, decision: "clean", confidence: "MEDIUM", reason: "produto coerente" }];
    },
  });

  assert.equal(openaiCalls, 1);
  assert.equal(result.status, "ready");
});

test("falha também na OpenAI permanece fail-closed sem imagem canônica", async () => {
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Objeto", {
    env: { GEMINI_API_KEY: "gemini-test", OPENAI_API_KEY: "openai-test" },
    budget: allowBudget,
    openaiBudget: allowBudget,
    allowRepair: false,
    delayImpl: async () => {},
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    generateContent: async () => { throw new Error("429 provider unavailable"); },
    openaiReview: async () => { throw new Error("OPENAI_IMAGE_REVIEW_HTTP_401"); },
  });

  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_model_unavailable");
  assert.equal(result.primaryImageUrl, undefined);
});

test("sem Gemini, orçamento OpenAI esgotado continua fail-closed", async () => {
  let openaiCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Objeto", {
    env: { OPENAI_API_KEY: "openai-test" },
    openaiBudget: denyBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse()) as typeof fetch,
    openaiReview: async () => {
      openaiCalls += 1;
      return [];
    },
  });

  assert.equal(openaiCalls, 0);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_budget_exhausted");
});

test("Responses API envia imagem em data URL, store=false e Structured Outputs estrito", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const assessments = await productImageReviewInternals.openaiReviewWithResponsesApi({
    rawImageUrls: ["https://cdn.example.test/a.jpg"],
    downloaded: [{ url: "https://cdn.example.test/a.jpg", mimeType: "image/jpeg", data: "AQIDBA==" }],
    title: "Luminária",
    model: "gpt-5.6-luna",
    apiKey: "secret-test-key",
    timeoutMs: 500,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "imagem válida" }] }),
          }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  assert.equal((capturedInit?.headers as Record<string, string>)?.Authorization, "Bearer secret-test-key");
  const body = JSON.parse(String(capturedInit?.body || "{}"));
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,AQIDBA==$/);
  assert.equal(assessments[0].decision, "clean");
});
