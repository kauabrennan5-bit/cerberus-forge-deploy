import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ProductImageCuration } from "../src/lib/productImageCuration";
import { AUTONOMOUS_CURATOR_PROFILES } from "../server/services/autonomousCuratorProfiles";
import {
  buildAutonomousCuratorHumanTasteModel,
  scoreAutonomousCuratorHumanTaste,
  setAutonomousCuratorHumanTasteModel,
} from "../server/services/autonomousCuratorHumanTaste";
import { scoreAutonomousCandidate } from "../server/services/autonomousCuratorScoring";

const NOW = Date.parse("2026-09-06T13:00:00.000Z");
const IMAGE = "https://down-br.img.susercontent.com/file/human-taste-test";

const cleanCuration: ProductImageCuration = {
  status: "ready",
  rawImageUrls: [IMAGE],
  primaryImageUrl: IMAGE,
  galleryImageUrls: [],
  assessments: [{
    url: IMAGE,
    decision: "clean",
    confidence: "HIGH",
    reason: "imagem comercial limpa",
  }],
};

const unreviewedCuration: ProductImageCuration = {
  status: "review_required",
  rawImageUrls: [IMAGE],
  primaryImageUrl: IMAGE,
  galleryImageUrls: [],
  assessments: [],
  reason: "image_review_unavailable",
};

function publishedProduct(title: string, category: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `prod-${title}`,
    ref: "CF-TEST",
    produto: title,
    displayTitle: title,
    rawTitle: title,
    categoria: category,
    preco: 120,
    imagens: [IMAGE],
    link: `https://s.shopee.com.br/${encodeURIComponent(title)}`,
    ativo: true,
    status: "published",
    descricao: `${title}. Seleção editorial aprovada pelo curador humano.`,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  } as any;
}

function review(title: string, category: string, status: "rejected" | "cancelled" | "published" | "error") {
  return {
    id: `review-${title}`,
    chatId: 1,
    senderId: 1,
    firstName: "Cerberus",
    username: "curator",
    createdAt: NOW - 30_000,
    produto: title,
    rawTitle: title,
    displayTitle: title,
    categoria: category,
    preco: 120,
    imagens: [IMAGE],
    imagemPrincipal: IMAGE,
    normalizedUrl: `https://shopee.com.br/product/1/${Math.abs(title.length * 117)}`,
    descricao: `${title}. Produto avaliado manualmente pelo curador.`,
    status,
    existingProduct: { source: "autonomous_curator" },
  } as any;
}

function illuminationProfile() {
  const profile = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === "Iluminação");
  assert.ok(profile);
  return profile;
}

afterEach(() => {
  setAutonomousCuratorHumanTasteModel(null);
});

describe("autonomous curator human taste learning", () => {
  it("treats current published catalog as positive examples and discard decisions as negative examples", () => {
    const approved = publishedProduct("Luminária Cogumelo de Mesa Cromada", "Iluminação");
    const inactive = publishedProduct("Luminária Genérica de Escritório", "Iluminação", { ativo: false });
    const rejected = review("Luminária de Piso Curve em LED", "Iluminação", "rejected");
    const cancelled = review("Plafon Genérico Branco", "Iluminação", "cancelled");
    const technicalError = review("Produto com erro técnico", "Iluminação", "error");

    const model = buildAutonomousCuratorHumanTasteModel(
      [approved, inactive],
      [rejected, cancelled, technicalError],
      NOW,
    );

    assert.deepEqual(model.approved.map(item => item.title), ["Luminária Cogumelo de Mesa Cromada"]);
    assert.deepEqual(
      model.rejected.map(item => item.title).sort(),
      ["Luminária de Piso Curve em LED", "Plafon Genérico Branco"].sort(),
    );
  });

  it("raises candidates similar to products the human published", () => {
    const model = buildAutonomousCuratorHumanTasteModel(
      [publishedProduct("Luminária Cogumelo de Mesa Cromada", "Iluminação")],
      [],
      NOW,
    );
    const score = scoreAutonomousCuratorHumanTaste({
      model,
      now: NOW,
      category: "Iluminação",
      title: "Abajur Cogumelo Cromado de Mesa",
      description: "Luminária retrô cromada de mesa com desenho cogumelo.",
      price: 150,
    });

    assert.ok(score.approvedSimilarity > score.rejectedSimilarity);
    assert.ok(score.fit > 50);
    assert.ok(score.adjustment > 0);
  });

  it("penalizes candidates similar to products the human discarded", () => {
    const model = buildAutonomousCuratorHumanTasteModel(
      [],
      [review("Kit de Brinquedos Educativos Montessori", "Infantil", "rejected")],
      NOW,
    );
    const score = scoreAutonomousCuratorHumanTaste({
      model,
      now: NOW,
      category: "Infantil",
      title: "Kit Montessori de Brinquedos Educativos",
      description: "Kit educativo infantil de madeira no estilo Montessori.",
      price: 80,
    });

    assert.ok(score.rejectedSimilarity > score.approvedSimilarity);
    assert.ok(score.fit < 50);
    assert.ok(score.adjustment < 0);
  });

  it("prefers an approved-like option over a discarded-like option inside the same category", () => {
    const model = buildAutonomousCuratorHumanTasteModel(
      [publishedProduct("Bolsa Mensageiro Masculina de Couro Vintage", "Calçados & Acessórios")],
      [review("Mocassim Masculino Casual em Couro Genuíno", "Calçados & Acessórios", "rejected")],
      NOW,
    );
    const approvedLike = scoreAutonomousCuratorHumanTaste({
      model,
      now: NOW,
      category: "Calçados & Acessórios",
      title: "Bolsa Carteiro Masculina em Couro Vintage",
      description: "Bolsa mensageiro masculina de couro com visual retrô.",
    });
    const rejectedLike = scoreAutonomousCuratorHumanTaste({
      model,
      now: NOW,
      category: "Calçados & Acessórios",
      title: "Mocassim Casual Masculino em Couro",
      description: "Mocassim masculino casual em couro genuíno.",
    });

    assert.ok(approvedLike.fit > rejectedLike.fit);
    assert.ok(approvedLike.adjustment > rejectedLike.adjustment);
  });

  it("feeds the learned preference into Cerberus ranking without overriding hard quality gates", () => {
    const model = buildAutonomousCuratorHumanTasteModel(
      [publishedProduct("Luminária Cogumelo de Mesa Cromada", "Iluminação")],
      [],
      NOW,
    );
    setAutonomousCuratorHumanTasteModel(model);

    const strong = scoreAutonomousCandidate({
      profile: illuminationProfile(),
      rawTitle: "Abajur Cogumelo Bauhaus Cromado",
      displayTitle: "Luminária Cogumelo Cromada",
      description: "Abajur de mesa cromado com desenho cogumelo e linguagem Bauhaus retrô.",
      category: "Iluminação",
      price: 120,
      imageCuration: cleanCuration,
      pipelineScore: 95,
      existingProducts: [],
    });
    assert.ok(strong.humanPreferenceAdjustment > 0);
    assert.ok(strong.humanPreferenceFit > 50);

    const technicallyUnreviewed = scoreAutonomousCandidate({
      profile: illuminationProfile(),
      rawTitle: "Abajur Cogumelo Bauhaus Cromado",
      displayTitle: "Luminária Cogumelo Cromada",
      description: "Abajur de mesa cromado com desenho cogumelo e linguagem Bauhaus retrô.",
      category: "Iluminação",
      price: 120,
      imageCuration: unreviewedCuration,
      pipelineScore: 95,
      existingProducts: [],
    });
    assert.ok(technicallyUnreviewed.humanPreferenceFit > 50);
    assert.ok(technicallyUnreviewed.finalScore <= 71);
  });

  it("is neutral when there is no human feedback yet", () => {
    const score = scoreAutonomousCuratorHumanTaste({
      model: buildAutonomousCuratorHumanTasteModel([], [], NOW),
      now: NOW,
      category: "Decoração",
      title: "Vaso de Vidro",
      description: "Vaso decorativo de vidro.",
    });
    assert.equal(score.fit, 50);
    assert.equal(score.confidence, 0);
    assert.equal(score.adjustment, 0);
  });
});
