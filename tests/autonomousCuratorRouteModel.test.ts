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
