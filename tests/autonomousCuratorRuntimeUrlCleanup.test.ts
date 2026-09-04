import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../inspect_remote.py", import.meta.url), "utf8");

test("runtime helpers use only the canonical production storefront and public Edge catalog", () => {
  assert.doesNotMatch(frontendApiSource, /cerberus-static-catalog/);
  assert.match(frontendApiSource, /cerberus-design-static/);
  assert.match(frontendApiSource, /cerberus-public-api/);

  assert.doesNotMatch(inspectorSource, /cerberus-static-catalog/);
  assert.doesNotMatch(inspectorSource, /data\/products\.json/);
  assert.match(inspectorSource, /cerberus-public-api\/products/);
});
