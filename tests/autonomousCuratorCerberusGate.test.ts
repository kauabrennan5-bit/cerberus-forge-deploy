import test from "node:test";
import assert from "node:assert/strict";
import { profileForCategory } from "../server/services/autonomousCuratorProfiles";
import { cheapProfileScore, hasBlockedProfileTerm, scoreAutonomousCandidate } from "../server/services/autonomousCuratorScoring";

const cleanCuration = {
  status: "ready" as const,
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean" as const,
    confidence: "HIGH" as const,
    reason: "Produto isolado e sem overlay.",
  }],
};

function score(category: Parameters<typeof profileForCategory>[0], rawTitle: string, displayTitle: string, description: string, price: number) {
  return scoreAutonomousCandidate({
    profile: profileForCategory(category),
    rawTitle,
    displayTitle,
    description,
    category,
    price,
    imageCuration: cleanCuration,
    pipelineScore: 100,
    existingProducts: [],
  });
}

test("retro sozinho não é identidade Cerberus", () => {
  const profile = profileForCategory("Cozinha & Mesa");
  assert.equal(cheapProfileScore(profile, "Jarra de Vidro Retrô para Bebidas"), -1000);
  const result = score(
    "Cozinha & Mesa",
    "Jarra 1,8L Vidro Transparente Luxo Grande Suco Chá Água Design Retrô Cozinha",
    "Jarra de Vidro Retrô para Bebidas",
    "Jarra de vidro transparente com design retrô para água, sucos e chás.",
    37.99,
  );
  assert.ok(result.styleFit < 72);
  assert.ok(result.finalScore < 72);
});

test("peça incompleta de luminária é bloqueada mesmo com Space Age e anos 70", () => {
  const profile = profileForCategory("Iluminação");
  const title = "Cúpula Luminária Vidro Opalino Verde Vintage Anos 70 Space Age";
  assert.equal(hasBlockedProfileTerm(profile, title), "cupula luminaria");
  const result = score(
    "Iluminação",
    title,
    "Cúpula Luminária Plafon Vidro Verde",
    "Cúpula de vidro opalino verde em linguagem space age dos anos 70.",
    196,
  );
  assert.equal(result.finalScore, 0);
});

test("menção descritiva a cúpula não bloqueia uma luminária completa", () => {
  const profile = profileForCategory("Iluminação");
  const text = "Abajur Cogumelo Bauhaus Retrô com cúpula arredondada e acabamento cromado";
  assert.equal(hasBlockedProfileTerm(profile, text), null);
  assert.ok(cheapProfileScore(profile, "Abajur Cogumelo Bauhaus Retro") > 0);
});

test("organizador novelty em formato de bicicleta fica fora do perfil", () => {
  const profile = profileForCategory("Organização");
  const title = "Porta-Objetos e Porta-Canetas com Bicicleta Retrô";
  assert.equal(hasBlockedProfileTerm(profile, title), "bicicleta");
  assert.equal(cheapProfileScore(profile, title), -1000);
});

test("cadeira Eiffel/Eames mass-market não passa como mid-century Cerberus", () => {
  const profile = profileForCategory("Móveis");
  const title = "Cadeira Eiffel Base Madeira Moderna Design Eames";
  assert.ok(["eiffel", "eames"].includes(String(hasBlockedProfileTerm(profile, title))));
  assert.equal(cheapProfileScore(profile, title), -1000);
});

test("acessório feminino genérico não entra no feed masculino Cerberus", () => {
  const profile = profileForCategory("Calçados & Acessórios");
  const title = "Cinto de couro feminino retrô minimalista fivela de cobre";
  assert.equal(hasBlockedProfileTerm(profile, title), "feminino");
  assert.equal(cheapProfileScore(profile, title), -1000);
});

test("jaqueta cara demais para find nunca atinge threshold de review", () => {
  const result = score(
    "Vestuário",
    "Jaqueta retrô masculina de lapela algodão casual de negócios",
    "Jaqueta Masculina Casual de Algodão",
    "Jaqueta masculina de lapela em estilo retrô, confeccionada em algodão.",
    1543.21,
  );
  assert.equal(result.valueFit, 0);
  assert.ok(result.finalScore < 72);
});

test("brinquedo Montessori genérico não basta sem linguagem de design do nicho", () => {
  const result = score(
    "Infantil",
    "Caminhão de Madeira Artesanato Brinquedo Educativo Montessori",
    "Caminhão de Brinquedo Artesanal em Madeira",
    "Brinquedo educativo tradicional de madeira para atividades infantis.",
    34.99,
  );
  assert.equal(result.finalScore, 0);
});

test("bom find Bauhaus com forma assinatura continua elegível", () => {
  const result = score(
    "Iluminação",
    "Abajur Cogumelo Bauhaus Cromado Retro",
    "Abajur Cogumelo Bauhaus de Mesa",
    "Abajur de mesa com forma cogumelo, acabamento cromado e linguagem Bauhaus.",
    249.9,
  );
  assert.ok(result.styleFit >= 94);
  assert.equal(result.valueFit, 100);
  assert.ok(result.finalScore >= 88);
});

test("espelho dobrável aprovado pelo usuário continua compatível por combinação de sinais de forma", () => {
  const result = score(
    "Beleza & Bem-estar",
    "Espelho de Maquiagem Dobrável para Viagem Ângulo Ajustável Design Compacto em Couro",
    "Espelho de Maquiagem Dobrável para Viagem",
    "Espelho dobrável de formato compacto com acabamento em couro e uso portátil.",
    180.32,
  );
  assert.ok(result.signatureHits >= 4);
  assert.ok(result.styleFit >= 75);
  assert.ok(result.finalScore >= 88);
});
