import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("image review provider failure is a soft warning when official images exist", async () => {
  const source = await readFile(new URL("../server/services/productAutomation.ts", import.meta.url), "utf8");

  assert.match(source, /const fallbackImageUrls = /);
  assert.match(source, /const resolvedImageCuration: ProductImageCuration = /);
  assert.match(source, /if \(hasInvalidTitle \|\| hasNoImages\)/);
  assert.doesNotMatch(source, /if \(hasInvalidTitle \|\| hasNoImages \|\| hasNoCommercialImage\)/);
  assert.match(source, /Revisão visual indisponível; preservando imagens oficiais como fallback técnico/);
  assert.match(source, /imageEditorialStatus: resolvedImageCuration\.status === "ready" \? "clean" : "review_required"/);
  assert.match(source, /imageCuration: resolvedImageCuration/);
});
