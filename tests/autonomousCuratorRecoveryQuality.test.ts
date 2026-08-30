import test from "node:test";
import assert from "node:assert/strict";
import { autonomousCuratorInternals } from "../server/services/autonomousCurator";
import { AUTONOMOUS_CURATOR_PROFILES } from "../server/services/autonomousCuratorProfiles";
import { scoreAutonomousCandidate } from "../server/services/autonomousCuratorScoring";

const cleanCuration = {
  status: "ready" as const,
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean" as const,
    confidence: "HIGH" as const,
    reason: "Imagem comercial limpa.",
  }],
};

test("recovery considera preenchida somente categoria publicada ou aguardando review", () => {
  assert.equal(autonomousCuratorInternals.fulfilledDecision("auto_published"), true);
  assert.equal(autonomousCuratorInternals.fulfilledDecision("review_required"), true);
  assert.equal(autonomousCuratorInternals.fulfilledDecision("rejected"), false);
  assert.equal(autonomousCuratorInternals.fulfilledDecision("duplicate"), false);
  assert.equal(autonomousCuratorInternals.fulfilledDecision("no_candidate"), false);
  assert.equal(autonomousCuratorInternals.fulfilledDecision("failed"), false);
});

test("produto sem evidência estética explícita não alcança threshold automático só pelos outros gates", () => {
  const profile = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === "Iluminação")!;
  const breakdown = scoreAutonomousCandidate({
    profile,
    rawTitle: "Produto de Mesa Modelo 123",
    displayTitle: "Produto de Mesa Modelo Compacto",
    description: "Objeto funcional compacto para uso cotidiano em ambientes internos.",
    category: "Iluminação",
    price: 100,
    imageCuration: cleanCuration,
    pipelineScore: 100,
    existingProducts: [],
  });

  assert.equal(breakdown.styleFit, 35);
  assert.ok(breakdown.finalScore < 88);
  assert.ok(breakdown.finalScore >= 72);
});

test("evidência estética/material real mantém candidato forte elegível para auto", () => {
  const profile = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === "Iluminação")!;
  const breakdown = scoreAutonomousCandidate({
    profile,
    rawTitle: "Abajur de Mesa em Vidro Opalino",
    displayTitle: "Abajur de Mesa em Vidro Opalino",
    description: "Peça compacta em vidro opalino para iluminação pontual de interiores.",
    category: "Iluminação",
    price: 100,
    imageCuration: cleanCuration,
    pipelineScore: 100,
    existingProducts: [],
  });

  assert.ok(breakdown.styleFit >= 60);
  assert.ok(breakdown.finalScore >= 88);
});
