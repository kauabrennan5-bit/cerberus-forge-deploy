import test from "node:test";
import assert from "node:assert/strict";
import { autonomousCuratorInternals } from "../server/services/autonomousCurator";

test("autonomous curator extractor timeout uses bounded production defaults", () => {
  assert.equal(autonomousCuratorInternals.extractorTimeoutMs({}), 45_000);
  assert.equal(autonomousCuratorInternals.extractorTimeoutMs({ AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT_MS: "1000" }), 5_000);
  assert.equal(autonomousCuratorInternals.extractorTimeoutMs({ AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT_MS: "30000" }), 30_000);
  assert.equal(autonomousCuratorInternals.extractorTimeoutMs({ AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT_MS: "999999" }), 120_000);
});

test("autonomous curator timeout rejects a stalled candidate without inventing a result", async () => {
  const stalled = new Promise<string>(() => undefined);
  await assert.rejects(
    autonomousCuratorInternals.withTimeout(stalled, 5, "AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT"),
    /AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT/,
  );
});

test("autonomous curator timeout preserves a successful extraction", async () => {
  const result = await autonomousCuratorInternals.withTimeout(Promise.resolve("ok"), 50, "timeout");
  assert.equal(result, "ok");
});
