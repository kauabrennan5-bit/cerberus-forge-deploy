import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../inspect_remote.py", import.meta.url), "utf8");

test("frontend runtime is serverless and preserves the governed legacy snapshot baseline", () => {
  assert.doesNotMatch(frontendApiSource, /cerberus-static-catalog/);
  assert.doesNotMatch(frontendApiSource, /cerberus-design-static\.onrender\.com/);
  assert.doesNotMatch(frontendApiSource, /cerberus-forge-deploy-backend\.onrender\.com/);
  assert.match(frontendApiSource, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-runtime-api/);
  assert.match(frontendApiSource, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-public-api/);
  assert.match(frontendApiSource, /VITE_PUBLIC_CATALOG_EDGE_BASE/);
  assert.match(frontendApiSource, /VITE_SERVERLESS_RUNTIME_BASE/);
  assert.match(frontendApiSource, /data\/products\.json/);
  assert.match(frontendApiSource, /catalog-overlay/);
  assert.doesNotMatch(frontendApiSource, /juiychcfdqxgnatffnla\.supabase\.co/);

  // The archived remote inspector is diagnostic-only and is not imported by the storefront.
  assert.doesNotMatch(inspectorSource, /cerberus-static-catalog/);
  assert.doesNotMatch(inspectorSource, /data\/products\.json/);
  assert.match(inspectorSource, /cerberus-public-api\/products/);
});
