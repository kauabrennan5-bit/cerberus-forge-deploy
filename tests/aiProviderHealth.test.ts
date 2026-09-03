import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviderHealthInternals,
  checkGeminiVisualProviderHealth,
  checkOpenAIVisualProviderHealth,
} from "../server/services/aiProviderHealth";
import { OpenAIProviderError } from "../server/services/openAIProviderRuntime";

test.beforeEach(() => aiProviderHealthInternals.resetCache());

test("OpenAI visual health validates input_image structured output and falls back after model 404", async () => {
  const models: string[] = [];
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: {
      OPENAI_API_KEY: "sk-secret-must-not-leak",
      OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "missing-primary",
      OPENAI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL: "working-fallback",
      OPENAI_PROVIDER_HEALTH_TIMEOUT_MS: "100",
    } as NodeJS.ProcessEnv,
    call: async input => {
      const model = String(input.request.model);
      models.push(model);
      const serialized = JSON.stringify(input.request);
      assert.match(serialized, /input_image/);
      assert.match(serialized, /json_schema/);
      if (model === "missing-primary") {
        throw new OpenAIProviderError({ code: "OPENAI_MODEL_UNAVAILABLE", httpStatus: 404, errorCode: "model_not_found", retryable: false });
      }
      return { output_text: JSON.stringify({ ok: true }) };
    },
  });
  assert.equal(health.status, "healthy");
  assert.equal(health.effectiveModel, "working-fallback");
  assert.deepEqual(models, ["missing-primary", "working-fallback"]);
  assert.doesNotMatch(JSON.stringify(health), /sk-secret/);
});

test("OpenAI quota exhaustion is classified and does not try fallback", async () => {
  const models: string[] = [];
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: {
      OPENAI_API_KEY: "secret",
      OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary",
      OPENAI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL: "fallback",
    } as NodeJS.ProcessEnv,
    call: async input => {
      models.push(String(input.request.model));
      throw new OpenAIProviderError({ code: "OPENAI_QUOTA_EXHAUSTED", httpStatus: 429, errorCode: "insufficient_quota", retryable: false });
    },
  });
  assert.equal(health.status, "quota_exhausted");
  assert.equal(health.errorCode, "insufficient_quota");
  assert.deepEqual(models, ["primary"]);
});

test("Gemini visual health validates inline image and falls back after unavailable primary", async () => {
  const models: string[] = [];
  const health = await checkGeminiVisualProviderHealth({
    force: true,
    env: {
      GEMINI_API_KEY: "gemini-secret-must-not-leak",
      GEMINI_PRODUCT_IMAGE_REVIEW_MODEL: "missing-gemini",
      GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL: "working-gemini",
      GEMINI_PROVIDER_HEALTH_TIMEOUT_MS: "50",
    } as NodeJS.ProcessEnv,
    generate: async ({ model, request }) => {
      models.push(model);
      const serialized = JSON.stringify(request);
      assert.match(serialized, /inlineData/);
      assert.match(serialized, /responseSchema/);
      if (model === "missing-gemini") throw new Error("404 model not found");
      return { text: JSON.stringify({ ok: true }) };
    },
  });
  assert.equal(health.status, "healthy");
  assert.equal(health.effectiveModel, "working-gemini");
  assert.deepEqual(models, ["missing-gemini", "working-gemini"]);
  assert.doesNotMatch(JSON.stringify(health), /gemini-secret/);
});

test("provider health is fail-closed when API keys are absent", async () => {
  const openai = await checkOpenAIVisualProviderHealth({ force: true, env: {} as NodeJS.ProcessEnv });
  const gemini = await checkGeminiVisualProviderHealth({ force: true, env: {} as NodeJS.ProcessEnv });
  assert.equal(openai.status, "not_configured");
  assert.equal(openai.configured, false);
  assert.equal(gemini.status, "not_configured");
  assert.equal(gemini.configured, false);
});
