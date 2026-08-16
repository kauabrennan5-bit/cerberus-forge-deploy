import test from "node:test";
import assert from "node:assert/strict";
import {
  assessEvidenceQuality,
  detectContradictions,
} from "../server/commercial/discovery/researchQuality";

test("assessEvidenceQuality — KNOWN + marketplace_page + http 200 = HIGH", () => {
  const decision = assessEvidenceQuality({
    fieldState: "KNOWN",
    sourceType: "marketplace_page",
    httpStatus: 200,
  });
  assert.equal(decision.quality, "HIGH");
  assert.match(decision.rationale, /marketplace_page/);
  assert.match(decision.rationale, /200/);
});

test("assessEvidenceQuality — KNOWN + scrape (sem http confirmado) = MEDIUM", () => {
  const decision = assessEvidenceQuality({
    fieldState: "KNOWN",
    sourceType: "scrape",
  });
  assert.equal(decision.quality, "MEDIUM");
});

test("assessEvidenceQuality — DERIVED/url_slug = LOW, nunca é página", () => {
  const decision = assessEvidenceQuality({
    fieldState: "DERIVED",
    sourceType: "url_slug",
  });
  assert.equal(decision.quality, "LOW");
  assert.match(decision.rationale, /DERIVADO/);
  assert.match(decision.rationale, /NÃO confirmado/);
});

test("assessEvidenceQuality — search/page de resultados = LOW", () => {
  const decision = assessEvidenceQuality({
    fieldState: "KNOWN",
    sourceType: "marketplace_page",
    httpStatus: 200,
    fromSearch: true,
  });
  assert.equal(decision.quality, "LOW");
  assert.match(decision.rationale, /RESULTADOS/);
});

test("assessEvidenceQuality — COLLECTION_FAILED = UNKNOWN, falha identificável", () => {
  const failed = assessEvidenceQuality({
    fieldState: "COLLECTION_FAILED",
    sourceType: "scrape",
    httpStatus: 403,
  });
  assert.equal(failed.quality, "UNKNOWN");
  assert.match(failed.rationale, /COLLECTION_FAILED/);
  assert.match(failed.rationale, /403/);
  assert.match(failed.rationale, /falhou/);
});

test("assessEvidenceQuality — UNKNOWN = UNKNOWN, ausência ≠ valor negativo", () => {
  const decision = assessEvidenceQuality({
    fieldState: "UNKNOWN",
    sourceType: "marketplace_page",
  });
  assert.equal(decision.quality, "UNKNOWN");
  assert.match(decision.rationale, /ausência/);
});

test("assessEvidenceQuality — CONTRADICTED = MEDIUM, conflito preservado", () => {
  const decision = assessEvidenceQuality({
    fieldState: "CONTRADICTED",
    sourceType: "marketplace_page",
    httpStatus: 200,
  });
  assert.equal(decision.quality, "MEDIUM");
  assert.match(decision.rationale, /CONTRADITA/);
  assert.match(decision.rationale, /nenhum valor escolhido/);
});

// ============================================================================
// detectContradictions
// ============================================================================

test("detectContradictions — preço diferente → id anterior retornado", () => {
  const conflicts = detectContradictions(
    "price",
    149.9,
    [{ evidence_id: "evi-1", field_state: "KNOWN", field_value: { value: 99.9 } }],
  );
  assert.deepEqual(conflicts, ["evi-1"]);
});

test("detectContradictions — preço igual → sem conflito", () => {
  const conflicts = detectContradictions(
    "price",
    99.9,
    [{ evidence_id: "evi-1", field_state: "KNOWN", field_value: { value: 99.9 } }],
  );
  assert.deepEqual(conflicts, []);
});

test("detectContradictions — título diferente (case-insensitive) → conflito; igual → sem conflito", () => {
  const dif = detectContradictions(
    "title",
    "Luminária LED",
    [{ evidence_id: "evi-2", field_state: "KNOWN", field_value: { value: "Luminária Incandescente" } }],
  );
  assert.equal(dif.length, 1);

  const same = detectContradictions(
    "title",
    "Luminária LED",
    [{ evidence_id: "evi-2", field_state: "KNOWN", field_value: { value: "luminária led" } }],
  );
  assert.deepEqual(same, []);
});

test("detectContradictions — CONTRADIÇÃO com falha/ausência não conta (falha/UNKNOWN não contradiz)", () => {
  const conflicts = detectContradictions(
    "price",
    99.9,
    [
      { evidence_id: "evi-failed", field_state: "COLLECTION_FAILED", field_value: null },
      { evidence_id: "evi-unknown", field_state: "UNKNOWN", field_value: null },
      { evidence_id: "evi-unknown-val", field_state: "KNOWN", field_value: null },
    ],
  );
  assert.deepEqual(conflicts, []);
});

test("detectContradictions — imagens (arrays) divergentes → conflito; iguais → sem conflito", () => {
  const a = ["https://img1.jpg", "https://img2.jpg"];
  const b = ["https://img1.jpg", "https://img2.jpg", "https://img3.jpg"];
  assert.equal(detectContradictions("images", a, [{ evidence_id: "evi-x", field_state: "KNOWN", field_value: a as unknown as Record<string, unknown> }]).length, 0);
  assert.equal(detectContradictions("images", a, [{ evidence_id: "evi-x", field_state: "KNOWN", field_value: b as unknown as Record<string, unknown> }]).length, 1);
});

test("detectContradictions — múltiplas evidências anteriores divergentes → todas retornadas", () => {
  const conflicts = detectContradictions(
    "rating",
    4.8,
    [
      { evidence_id: "evi-a", field_state: "KNOWN", field_value: { value: 3.5 } },
      { evidence_id: "evi-b", field_state: "KNOWN", field_value: { value: 4.1 } },
      { evidence_id: "evi-c", field_state: "KNOWN", field_value: { value: 4.8 } },
    ],
  );
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.includes("evi-a"));
  assert.ok(conflicts.includes("evi-b"));
  assert.ok(!conflicts.includes("evi-c"));
});
