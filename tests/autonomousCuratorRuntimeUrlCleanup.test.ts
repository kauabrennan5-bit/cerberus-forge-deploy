import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../inspect_remote.py", import.meta.url), "utf8");

test("runtime helpers keep the storefront catalog fail-closed while production APIs target Supabase Edge", () => {
  assert.doesNotMatch(frontendApiSource, /cerberus-static-catalog/);
  assert.doesNotMatch(frontendApiSource, /cerberus-design-static\.onrender\.com/);
  assert.doesNotMatch(frontendApiSource, /cerberus-forge-deploy-backend\.onrender\.com/);
  assert.match(frontendApiSource, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1/);
  assert.match(frontendApiSource, /VITE_PUBLIC_CATALOG_EDGE_BASE/);
  assert.match(frontendApiSource, /VITE_RUNTIME_API_BASE/);
  assert.match(frontendApiSource, /cerberus-public-api/);
  assert.match(frontendApiSource, /cerberus-runtime-api/);
  assert.match(frontendApiSource, /data\/products\.json/);
  assert.match(frontendApiSource, /catalog-overlay/);
  assert.doesNotMatch(frontendApiSource, /juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api/);

  assert.doesNotMatch(inspectorSource, /cerberus-static-catalog/);
  assert.doesNotMatch(inspectorSource, /data\/products\.json/);
  assert.match(inspectorSource, /cerberus-public-api\/products/);
});
