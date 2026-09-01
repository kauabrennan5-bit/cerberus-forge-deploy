import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES } from "../server/services/autonomousCuratorProfiles";
import { productImageReviewInternals } from "../server/services/productImageReview";

test("starved categories run first in the continuous curator", () => {
  assert.deepEqual(
    AUTONOMOUS_CURATOR_PROFILES.slice(0, 2).map(profile => profile.category),
    ["Infantil", "Calçados & Acessórios"],
  );
});

test("Infantil visual review treats child themes as category context instead of automatic novelty", () => {
  const prompt = productImageReviewInternals.buildReviewPrompt("Babuche Infantil Cowgirl Fazendinha");
  assert.match(prompt, /CONTEXTO DE CATEGORIA — Infantil/);
  assert.match(prompt, /NÃO são novelty por si só/);
  assert.match(prompt, /promotional/);
  assert.match(prompt, /collage/);
  assert.match(prompt, /incomplete/);
});

test("Calçados visual review does not require interior-design language", () => {
  const prompt = productImageReviewInternals.buildReviewPrompt("Cinto de Couro Vintage Masculino");
  assert.match(prompt, /CONTEXTO DE CATEGORIA — Calçados & Acessórios/);
  assert.match(prompt, /NÃO marque off_brand só por ser produto de moda comercial/);
  assert.match(prompt, /promotional/);
  assert.match(prompt, /incomplete/);
});

test("generic object review keeps the default Cerberus visual contract", () => {
  const prompt = productImageReviewInternals.buildReviewPrompt("Luminária Cromada Space Age");
  assert.doesNotMatch(prompt, /CONTEXTO DE CATEGORIA — Infantil/);
  assert.doesNotMatch(prompt, /CONTEXTO DE CATEGORIA — Calçados & Acessórios/);
  assert.match(prompt, /Bauhaus/);
  assert.match(prompt, /Mid-Century Modern/);
});
