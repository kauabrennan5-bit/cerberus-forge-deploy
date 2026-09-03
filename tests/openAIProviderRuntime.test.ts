import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callOpenAIResponses,
  OpenAIProviderError,
  openAIProviderRuntimeInternals,
} from "../server/services/openAIProviderRuntime";

function okResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { code, type: code, param: "model" } }), {
    status,
    headers: retryAfter ? { "content-type": "application/json", "retry-after": retryAfter } : { "content-type": "application/json" },
  });
}

test("OpenAI rate limit honors Retry-After and bounded exponential retry", async () => {
  openAIProviderRuntimeInternals.reset();
  let calls = 0;
  const waits: number[] = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return errorResponse(429, "rate_limit_exceeded", "3");
    if (calls === 2) return errorResponse(429, "rate_limit_exceeded");
    return okResponse({ output_text: "ok" });
  };
  const result = await callOpenAIResponses({
    apiKey: "test-key-rate",
    request: { model: "test-model", input: "x" },
    timeoutMs: 1000,
    fetchImpl: fetchImpl as typeof fetch,
    delayImpl: async ms => { waits.push(ms); },
    randomImpl: () => 0,
    maxAttempts: 4,
  }) as { output_text?: string };
  assert.equal(result.output_text, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 2000]);
});

test("OpenAI insufficient quota does not retry and opens a circuit breaker", async () => {
  openAIProviderRuntimeInternals.reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return errorResponse(429, "insufficient_quota");
  };
  const input = {
    apiKey: "test-key-quota",
    request: { model: "test-model", input: "quota" },
    timeoutMs: 1000,
    fetchImpl: fetchImpl as typeof fetch,
    delayImpl: async () => undefined,
    maxAttempts: 4,
  };
  await assert.rejects(
    callOpenAIResponses(input),
    (error: unknown) => error instanceof OpenAIProviderError && error.code === "OPENAI_QUOTA_EXHAUSTED",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    callOpenAIResponses({ ...input, request: { model: "other-model", input: "different" } }),
    (error: unknown) => error instanceof OpenAIProviderError && error.code === "OPENAI_QUOTA_EXHAUSTED",
  );
  assert.equal(calls, 1, "circuit breaker must prevent another provider call");
});

test("identical concurrent OpenAI requests are single-flight deduplicated", async () => {
  openAIProviderRuntimeInternals.reset();
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    await barrier;
    return okResponse({ output_text: "same" });
  };
  const request = { model: "test-model", input: [{ role: "user", content: [{ type: "input_text", text: "same" }] }] };
  const a = callOpenAIResponses({ apiKey: "test-key-dedup", request, timeoutMs: 1000, fetchImpl: fetchImpl as typeof fetch });
  const b = callOpenAIResponses({ apiKey: "test-key-dedup", request, timeoutMs: 1000, fetchImpl: fetchImpl as typeof fetch });
  release();
  const [left, right] = await Promise.all([a, b]);
  assert.deepEqual(left, right);
  assert.equal(calls, 1);
});

test("OpenAI error classifier distinguishes auth model timeout and provider failures", () => {
  const auth = openAIProviderRuntimeInternals.classifyHttpFailure({ status: 401, body: "{}", retryAfter: null, nowMs: 0 });
  const model = openAIProviderRuntimeInternals.classifyHttpFailure({ status: 404, body: "{}", retryAfter: null, nowMs: 0 });
  const timeout = openAIProviderRuntimeInternals.classifyHttpFailure({ status: 408, body: "{}", retryAfter: null, nowMs: 0 });
  const provider = openAIProviderRuntimeInternals.classifyHttpFailure({ status: 503, body: "{}", retryAfter: null, nowMs: 0 });
  assert.equal(auth.code, "OPENAI_AUTH_ERROR");
  assert.equal(model.code, "OPENAI_MODEL_UNAVAILABLE");
  assert.equal(timeout.code, "OPENAI_TIMEOUT");
  assert.equal(provider.code, "OPENAI_PROVIDER_UNAVAILABLE");
});
