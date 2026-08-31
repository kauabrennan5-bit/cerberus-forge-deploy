import test from "node:test";
import assert from "node:assert/strict";
import { autonomousCuratorRouteInternals } from "../server/routes/autonomousCuratorRoutes";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertValidPng(bytes: Buffer, width: number, height: number): void {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature must be complete",
  );

  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, "PNG chunk header/footer must fit in the buffer");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    assert.ok(crcOffset + 4 <= bytes.length, "PNG chunk payload must fit in the buffer");

    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = crc32(bytes.subarray(typeStart, dataEnd));
    assert.equal(actualCrc, expectedCrc, `PNG ${type} CRC must be valid`);

    if (type === "IHDR") {
      assert.equal(length, 13);
      assert.equal(bytes.readUInt32BE(dataStart), width);
      assert.equal(bytes.readUInt32BE(dataStart + 4), height);
      sawIhdr = true;
    } else if (type === "IDAT") {
      sawIdat = true;
    } else if (type === "IEND") {
      assert.equal(length, 0);
      sawIend = true;
      assert.equal(crcOffset + 4, bytes.length, "IEND must terminate the PNG");
    }

    offset = crcOffset + 4;
  }

  assert.equal(sawIhdr, true, "PNG must contain IHDR");
  assert.equal(sawIdat, true, "PNG must contain IDAT");
  assert.equal(sawIend, true, "PNG must contain IEND");
}

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

test("OpenAI provider canary classifies exhausted prepaid credit as quota", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: { code: "credit_balance_exhausted", type: "insufficient_quota", message: "billing detail must remain private" },
  }), {
    status: 429,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({ OPENAI_API_KEY: "sk-test" }, fetchImpl);

  assert.equal(result.openai.status, "quota_exhausted");
  assert.equal("errorCode" in result.openai ? result.openai.errorCode : null, "credit_balance_exhausted");
  assert.equal(JSON.stringify(result).includes("billing detail"), false);
});

test("OpenAI provider canary exposes only a sanitized invalid parameter", async () => {
  const secret = "sk-test-never-return-this";
  const fetchImpl = (async () => new Response(JSON.stringify({
    error: {
      code: "invalid_value",
      type: "invalid_request_error",
      param: "input[0].content[1].image_url",
      message: `provider detail must stay private; secret=${secret}`,
    },
  }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({ OPENAI_API_KEY: secret }, fetchImpl);

  assert.equal(result.openai.status, "request_rejected");
  assert.equal("errorCode" in result.openai ? result.openai.errorCode : null, "invalid_value");
  assert.equal("errorParam" in result.openai ? result.openai.errorParam : null, "input[0].content[1].image_url");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("provider detail"), false);
});

test("OpenAI provider error parameter rejects unsafe diagnostic text", () => {
  assert.equal(autonomousCuratorRouteInternals.safeProviderErrorParam("input[0].content[1].image_url"), "input[0].content[1].image_url");
  assert.equal(autonomousCuratorRouteInternals.safeProviderErrorParam("input image_url secret=sk-test"), null);
  assert.equal(autonomousCuratorRouteInternals.safeProviderErrorParam("../etc/passwd"), null);
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

test("OpenAI provider canary sends an integrity-valid reviewable 256x256 PNG", async () => {
  let checked = false;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const dataUrl = String(body?.input?.[0]?.content?.[1]?.image_url || "");
    assert.match(dataUrl, /^data:image\/png;base64,/);
    const bytes = Buffer.from(dataUrl.split(",", 2)[1] || "", "base64");
    assertValidPng(bytes, 256, 256);
    checked = true;
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        images: [{ index: 1, decision: "unknown", confidence: "LOW", reason: "provider probe" }],
      }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const result = await autonomousCuratorRouteInternals.probeAutonomousCuratorProviders({ OPENAI_API_KEY: "sk-test" }, fetchImpl);
  assert.equal(result.openai.status, "ok");
  assert.equal(checked, true);
});
