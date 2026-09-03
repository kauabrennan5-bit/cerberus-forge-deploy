import assert from "node:assert/strict";
import test from "node:test";
import {
  callOpenAIResponses,
  getOpenAIProviderRuntimeHealth,
  OpenAIProviderRuntimeError,
  openAIProviderRuntimeInternals,
} from "../server/services/openaiProviderRuntime";

function okResponse(value: unknown = { output_text: "{}" }): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function failureResponse(status: number, code: string, retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { code, type: code, param: "model" } }), {
    status,
    headers: retryAfter ? { "content-type": "application/json", "retry-after": retryAfter } : { "content-type": "application/json" },
  });
}

test.beforeEach(() => openAIProviderRuntimeInternals.resetForTests());

test("429 respects Retry-After and bounded exponential backoff before success", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await callOpenAIResponses({
    apiKey: "test-key",
    request: { model: "test-model", input: "same" },
    maxRetries: 3,
    jitterImpl: () => 0,
    delayImpl: async ms => { delays.push(ms); },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return failureResponse(429, "rate_limit_exceeded", "3");
      if (calls === 2) return failureResponse(429, "rate_limit_exceeded");
      if (calls === 3) return failureResponse(429, "rate_limit_exceeded");
      return okResponse({ ok: true });
    }) as typeof fetch,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [3_000, 2_000, 4_000]);
});

test("insufficient_quota opens circuit and never enters retry loop", async () => {
  let calls = 0;
  await assert.rejects(
    callOpenAIResponses({
      apiKey: "test-key",
      request: { model: "test-model", input: "quota" },
      delayImpl: async () => { throw new Error("delay must not run"); },
      fetchImpl: (async () => {
        calls += 1;
        return failureResponse(429, "insufficient_quota");
      }) as typeof fetch,
    }),
    (error: unknown) => error instanceof OpenAIProviderRuntimeError && error.code === "OPENAI_QUOTA_EXHAUSTED",
  );
  assert.equal(calls, 1);
  assert.equal(getOpenAIProviderRuntimeHealth().status, "circuit_open");

  await assert.rejects(
    callOpenAIResponses({
      apiKey: "test-key",
      request: { model: "test-model", input: "another" },
      fetchImpl: (async () => {
        calls += 1;
        return okResponse();
      }) as typeof fetch,
    }),
    (error: unknown) => error instanceof OpenAIProviderRuntimeError && error.code === "OPENAI_QUOTA_EXHAUSTED",
  );
  assert.equal(calls, 1);
});

test("identical concurrent requests are single-flight deduplicated", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const options = {
    apiKey: "test-key",
    request: { model: "test-model", input: [{ role: "user", content: "same" }] },
    dedupeKey: "same-semantic-request",
    fetchImpl: (async () => {
      calls += 1;
      await gate;
      return okResponse({ output_text: "done" });
    }) as typeof fetch,
  };

  const first = callOpenAIResponses(options);
  const second = callOpenAIResponses(options);
  await Promise.resolve();
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test("401, 404, timeout and malformed success are classified explicitly", async () => {
  for (const [status, expected] of [[401, "OPENAI_AUTH_ERROR"], [404, "OPENAI_MODEL_UNAVAILABLE"]] as const) {
    openAIProviderRuntimeInternals.resetForTests();
    await assert.rejects(
      callOpenAIResponses({
        apiKey: "test-key",
        request: { model: `status-${status}` },
        fetchImpl: (async () => failureResponse(status, status === 401 ? "invalid_api_key" : "model_not_found")) as typeof fetch,
      }),
      (error: unknown) => error instanceof OpenAIProviderRuntimeError && error.code === expected,
    );
  }

  openAIProviderRuntimeInternals.resetForTests();
  await assert.rejects(
    callOpenAIResponses({
      apiKey: "test-key",
      request: { model: "malformed" },
      fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    }),
    (error: unknown) => error instanceof OpenAIProviderRuntimeError && error.code === "OPENAI_INVALID_RESPONSE",
  );
});
