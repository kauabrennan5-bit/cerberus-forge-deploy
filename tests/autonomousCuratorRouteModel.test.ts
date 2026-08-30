import test from "node:test";
import assert from "node:assert/strict";
import { autonomousCuratorRouteInternals } from "../server/routes/autonomousCuratorRoutes";

test("autonomous curator uses high-throughput copy model for saturated defaults", () => {
  assert.equal(
    autonomousCuratorRouteInternals.resolveAutonomousCuratorCopyModel({}),
    "gemini-3.5-flash-lite",
  );
  assert.equal(
    autonomousCuratorRouteInternals.resolveAutonomousCuratorCopyModel({ GEMINI_PRODUCT_CURATOR_MODEL: "gemini-3.7-flash" }),
    "gemini-3.5-flash-lite",
  );
  assert.equal(
    autonomousCuratorRouteInternals.resolveAutonomousCuratorCopyModel({ GEMINI_PRODUCT_CURATOR_MODEL: "gemini-3.6-flash" }),
    "gemini-3.5-flash-lite",
  );
});

test("autonomous curator preserves explicit dedicated copy model override", () => {
  assert.equal(
    autonomousCuratorRouteInternals.resolveAutonomousCuratorCopyModel({
      GEMINI_PRODUCT_CURATOR_MODEL: "gemini-3.7-flash",
      GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL: "gemini-custom-copy",
    }),
    "gemini-custom-copy",
  );
});

test("autonomous curator preserves a non-saturated configured product curator model", () => {
  assert.equal(
    autonomousCuratorRouteInternals.resolveAutonomousCuratorCopyModel({ GEMINI_PRODUCT_CURATOR_MODEL: "gemini-custom-stable" }),
    "gemini-custom-stable",
  );
});

test("OpenAI provider canary stays inert when the key is absent", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({}, fetchImpl);

  assert.equal(calls, 0);
  assert.equal(result.openai.configured, false);
  assert.equal(result.openai.enabled, false);
  assert.equal(result.openai.status, "not_configured");
});

test("OpenAI provider canary reports quota without exposing the key", async () => {
  const secret = "sk-test-never-return-this";
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: { code: "insufficient_quota", type: "insufficient_quota", message: `secret=${secret}` },
  }), {
    status: 429,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({ OPENAI_API_KEY: secret }, fetchImpl);

  assert.equal(result.openai.status, "quota_exhausted");
  assert.equal("httpStatus" in result.openai ? result.openai.httpStatus : null, 429);
  assert.equal("errorCode" in result.openai ? result.openai.errorCode : null, "insufficient_quota");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("OpenAI provider canary proves a structured Responses API result", async () => {
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    assert.match(String(init?.headers && (init.headers as Record<string, string>).Authorization || ""), /^Bearer /);
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        images: [{ index: 1, decision: "unknown", confidence: "LOW", reason: "provider probe" }],
      }),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({
    OPENAI_API_KEY: "sk-test",
    OPENAI_PRODUCT_IMAGE_REVIEW_MODEL: "gpt-5.6-luna",
  }, fetchImpl);

  assert.equal(result.openai.status, "ok");
  assert.equal(result.openai.model, "gpt-5.6-luna");
  assert.equal("httpStatus" in result.openai ? result.openai.httpStatus : null, 200);
});
