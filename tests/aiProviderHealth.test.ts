import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviderHealthInternals,
  checkGeminiVisualProviderHealth,
  checkOpenAIVisualProviderHealth,
} from "../server/services/aiProviderHealth";
import { OpenAIProviderError } from "../server/services/openAIProviderRuntime";

test.beforeEach(() => aiProviderHealthInternals.resetCache());

async function successfulOpenAICall(input: Parameters<NonNullable<Parameters<typeof checkOpenAIVisualProviderHealth>[0]["call"]>>[0]) {
  return JSON.stringify(input.request).includes("json_schema")
    ? { output_text: JSON.stringify({ ok: true }) }
    : { output_text: "OK" };
}

test("OpenAI health separates text, structured output and vision while preserving model fallback", async () => {
  const models: string[] = [];
  const phases: string[] = [];
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
      const phase = serialized.includes("input_image")
        ? "vision"
        : serialized.includes("json_schema")
          ? "structured"
          : "connectivity";
      phases.push(phase);
      if (model === "missing-primary") {
        throw new OpenAIProviderError({ code: "OPENAI_MODEL_UNAVAILABLE", httpStatus: 404, errorCode: "model_not_found", retryable: false });
      }
      if (phase === "connectivity") {
        assert.doesNotMatch(serialized, /input_image|json_schema/);
        return { output_text: "OK" };
      }
      if (phase === "structured") {
        assert.match(serialized, /json_schema/);
        assert.doesNotMatch(serialized, /input_image/);
        return { output_text: JSON.stringify({ ok: true }) };
      }
      assert.match(serialized, /input_image/);
      assert.doesNotMatch(serialized, /json_schema/);
      return { output_text: "OK" };
    },
  });
  assert.equal(health.status, "healthy");
  assert.equal(health.state, "OPENAI_PRIMARY_DOWN_FALLBACK_OK");
  assert.equal(health.effectiveModel, "working-fallback");
  assert.deepEqual(models, ["missing-primary", "working-fallback", "working-fallback", "working-fallback"]);
  assert.deepEqual(phases, ["connectivity", "connectivity", "structured", "vision"]);
  assert.equal(health.canaries?.connectivity.status, "ok");
  assert.equal(health.canaries?.structuredOutput.status, "ok");
  assert.equal(health.canaries?.vision.status, "ok");
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
  assert.equal(health.state, "OPENAI_PROVIDER_DOWN");
  assert.equal(health.errorCode, "insufficient_quota");
  assert.deepEqual(models, ["primary"]);
});

test("OpenAI reports OK only when all enabled canaries succeed", async () => {
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: { OPENAI_API_KEY: "secret", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary" } as NodeJS.ProcessEnv,
    call: successfulOpenAICall,
  });
  assert.equal(health.status, "healthy");
  assert.equal(health.state, "OPENAI_OK");
});

test("structured-output failure degrades only the structured canary", async () => {
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: { OPENAI_API_KEY: "secret", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary" } as NodeJS.ProcessEnv,
    call: async input => {
      if (JSON.stringify(input.request).includes("json_schema")) {
        throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 400, errorCode: "invalid_schema", errorParam: "text.format", retryable: false });
      }
      return successfulOpenAICall(input);
    },
  });
  assert.equal(health.state, "OPENAI_STRUCTURED_OUTPUT_FAILED");
  assert.equal(health.canaries?.connectivity.status, "ok");
  assert.equal(health.canaries?.structuredOutput.status, "failed");
  assert.equal(health.canaries?.vision.status, "ok");
});

test("vision failure degrades only the vision canary", async () => {
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: { OPENAI_API_KEY: "secret", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary" } as NodeJS.ProcessEnv,
    call: async input => {
      if (JSON.stringify(input.request).includes("input_image")) {
        throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 400, errorCode: "invalid_image", errorParam: "input[0].content[1]", retryable: false });
      }
      return successfulOpenAICall(input);
    },
  });
  assert.equal(health.state, "OPENAI_VISION_CANARY_FAILED");
  assert.equal(health.canaries?.connectivity.status, "ok");
  assert.equal(health.canaries?.structuredOutput.status, "ok");
  assert.equal(health.canaries?.vision.status, "failed");
});

test("invalid text connectivity payload is diagnosed separately from provider downtime", async () => {
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: { OPENAI_API_KEY: "secret", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary" } as NodeJS.ProcessEnv,
    call: async () => {
      throw new OpenAIProviderError({ code: "OPENAI_INVALID_RESPONSE", httpStatus: 400, errorCode: "invalid_value", errorParam: "input", retryable: false });
    },
  });
  assert.equal(health.state, "OPENAI_BAD_HEALTH_PAYLOAD");
  assert.equal(health.errorParam, "input");
  assert.equal(health.canaries?.structuredOutput.status, "not_run");
  assert.equal(health.canaries?.vision.status, "not_run");
});

test("empty text connectivity output is a bad probe payload, not provider downtime", async () => {
  const health = await checkOpenAIVisualProviderHealth({
    force: true,
    env: { OPENAI_API_KEY: "secret", OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "primary" } as NodeJS.ProcessEnv,
    call: async () => ({ output: [] }),
  });
  assert.equal(health.state, "OPENAI_BAD_HEALTH_PAYLOAD");
  assert.equal(health.errorCode, "health_output_invalid");
  assert.equal(health.canaries?.connectivity.status, "failed");
  assert.equal(health.canaries?.structuredOutput.status, "not_run");
  assert.equal(health.canaries?.vision.status, "not_run");
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
  assert.equal(openai.state, "OPENAI_CONFIG_MISSING");
  assert.equal(openai.configured, false);
  assert.equal(gemini.status, "not_configured");
  assert.equal(gemini.configured, false);
});
