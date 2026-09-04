import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Shopee price provenance is persisted in existing curator audit metadata without a new public products column", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuousV2Base.ts", import.meta.url), "utf8");
  assert.match(source, /priceEvidence: candidate\.priceEvidence/);
  assert.match(source, /scoreBreakdown: auditedBreakdown/);
  assert.doesNotMatch(source, /price_evidence\s*:/);
});
