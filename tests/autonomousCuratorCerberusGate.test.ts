import test from "node:test";
import assert from "node:assert/strict";
import type { ProductImageCuration } from "../src/lib/productImageCuration";
import { profileForCategory } from "../server/services/autonomousCuratorProfiles";
import { cheapProfileScore, hasBlockedProfileTerm, scoreAutonomousCandidate } from "../server/services/autonomousCuratorScoring";

const cleanCuration: ProductImageCuration = {
  status: "ready",
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean",
    confidence: "HIGH",
    reason: "Produto isolado, visualmente Cerberus e sem overlay.",
  }],
};

const twoCleanCuration: ProductImageCuration = {
  status: "ready",
  rawImageUrls: ["https://img.example.com/a.jpg", "https://img.example.com/b.jpg"],
  primaryImageUrl: "https://img.example.com/a.jpg",
  galleryImageUrls: ["https://img.example.com/b.jpg"],
  assessments: [
    { url: "https://img.example.com/a.jpg", decision: "clean", confidence: "HIGH", reason: "Foto comercial nítida do produto." },
    { url: "https://img.example.com/b.jpg", decision: "clean", confidence: "HIGH", reason: "Segunda vista limpa do produto." },
  ],
};

const hangerOnlyFashionCuration: ProductImageCuration = {
  status: "ready",
  rawImageUrls: [
    "https://img.example.com/promo.jpg",
    "https://img.example.com/detail.jpg",
    "https://img.example.com/hanger.jpg",
  ],
  primaryImageUrl: "https://img.example.com/hanger.jpg",
  galleryImageUrls: [],
  assessments: [
    { url: "https://img.example.com/promo.jpg", decision: "promotional", confidence: "HIGH", reason: "Imagem com texto promocional." },
    { url: "https://img.example.com/detail.jpg", decision: "technical", confidence: "HIGH", reason: "Detalhe técnico de costura e tecido." },
    { url: "https://img.example.com/hanger.jpg", decision: "clean", confidence: "HIGH", reason: "Foto frontal da peça inteira, mostrando corte e bolsos." },
  ],
};

const editorialFashionCuration: ProductImageCuration = {
  status: "ready",
  rawImageUrls: ["https://img.example.com/model.jpg"],
  primaryImageUrl: "https://img.example.com/model.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/model.jpg",
    decision: "clean",
    confidence: "HIGH",
    reason: "Foto editorial com modelo vestindo a peça e silhueta integral visível.",
  }],
};

const lowConfidenceCuration: ProductImageCuration = {
  ...cleanCuration,
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean",
    confidence: "LOW",
    reason: "Evidência visual insuficiente.",
  }],
};

function score(
  category: Parameters<typeof profileForCategory>[0],
  rawTitle: string,
  displayTitle: string,
  description: string,
  price: number,
  imageCuration: ProductImageCuration = cleanCuration,
) {
  return scoreAutonomousCandidate({
    profile: profileForCategory(category),
    rawTitle,
    displayTitle,
    description,
    category,
    price,
    imageCuration,
    pipelineScore: 100,
    existingProducts: [],
  });
}

test("evidência visual clean pode resgatar copy curta sem baixar o threshold", () => {
  const profile = profileForCategory("Cozinha & Mesa");
  assert.ok(cheapProfileScore(profile, "Jarra de Vidro Retrô para Bebidas") > -1000);
  const result = score(
    "Cozinha & Mesa",
    "Jarra 1,8L Vidro Transparente Luxo Grande Suco Chá Água Design Retrô Cozinha",
    "Jarra de Vidro Retrô para Bebidas",
    "Jarra de vidro transparente com design retrô para água, sucos e chás.",
    37.99,
  );
  assert.ok(result.styleFit >= 72);
  assert.ok(result.desirabilityFit >= 80);
  assert.ok(result.finalScore >= 88);
});

test("review visual LOW nunca resgata linguagem textual insuficiente", () => {
  const result = score(
    "Cozinha & Mesa",
    "Jarra 1,8L Vidro Transparente Luxo Grande Suco Chá Água Cozinha",
    "Jarra de Vidro para Bebidas",
    "Jarra de vidro transparente para água, sucos e chás em uso cotidiano.",
    37.99,
    lowConfidenceCuration,
  );
  assert.ok(result.styleFit < 72);
  assert.ok(result.finalScore <= 71);
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

test("preço acima do teto de auto-publicação nunca auto-publica mesmo dentro do teto de review", () => {
  const result = score(
    "Calçados & Acessórios",
    "Óculos Bauhaus Space Age Masculino Acetato Geométrico",
    "Óculos Bauhaus Geométrico em Acetato",
    "Óculos masculino de acetato com desenho geométrico e linguagem Bauhaus Space Age.",
    320,
    twoCleanCuration,
  );
  assert.ok(result.valueFit > 0);
  assert.ok(result.priceToAutoCap > 1);
  assert.ok(result.finalScore <= 71);
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

test("feedback humano: balde de gelo caro para distinção moderada não auto-publica", () => {
  const result = score(
    "Cozinha & Mesa",
    "Balde de Gelo e Copo Anos 70",
    "Balde de Gelo e Copo Anos 70",
    "Conjunto de balde de gelo e copo de vidro com estética dos anos 70 para bar e mesa.",
    190,
    twoCleanCuration,
  );
  assert.ok(result.priceToAutoCap > 0.55);
  assert.ok(result.styleFit < 94);
  assert.ok(result.finalScore <= 71);
});

test("feedback humano: bermuda em apresentação de produto sem styling editorial não auto-publica", () => {
  const result = score(
    "Vestuário",
    "Bermuda Cinza Alfaiataria Masculina Anos 70 Corte Reto",
    "Bermuda Cinza de Alfaiataria",
    "Bermuda masculina cinza de corte reto com cós estruturado, bolsos laterais e construção de alfaiataria.",
    70,
    hangerOnlyFashionCuration,
  );
  assert.equal(result.presentationFit, 55);
  assert.ok(result.finalScore <= 71);
});

test("moda bem apresentada em modelo continua elegível", () => {
  const result = score(
    "Vestuário",
    "Jaqueta Boxy Masculina Vintage Anos 70 Camurça",
    "Jaqueta Boxy Vintage em Camurça",
    "Jaqueta masculina boxy em camurça com proporção vintage e construção estruturada.",
    280,
    editorialFashionCuration,
  );
  assert.equal(result.presentationFit, 100);
  assert.ok(result.finalScore >= 88);
});

test("feedback humano: óculos simples próximos do teto de preço não auto-publicam", () => {
  const result = score(
    "Calçados & Acessórios",
    "Óculos Solar Geométrico Preto Acetato Masculino Minimalista",
    "Óculos Solares Geométricos Pretos",
    "Óculos solares masculinos de acetato preto com linhas geométricas e desenho minimalista.",
    269.99,
    twoCleanCuration,
  );
  assert.ok(result.priceToAutoCap > 0.8);
  assert.ok(result.valueFit < 80);
  assert.ok(result.finalScore <= 71);
});

test("feedback humano: brinquedo geométrico correto porém sem fator uau não auto-publica", () => {
  const result = score(
    "Infantil",
    "Quebra Cabeça Geométrico Madeira Formas Encaixe",
    "Quebra-Cabeça Geométrico de Madeira",
    "Jogo de encaixe em madeira com peças coloridas e formas geométricas para preencher um tabuleiro.",
    113.5,
    twoCleanCuration,
  );
  assert.equal(result.strongStyleHits, 0);
  assert.ok(result.desirabilityFit < 80);
  assert.ok(result.finalScore <= 71);
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

test("organizador aprovado continua elegível mesmo usando parcela alta do teto de preço", () => {
  const result = score(
    "Organização",
    "Organizador Modular Bauhaus Porta Objetos Geométrico",
    "Organizador Modular Bauhaus",
    "Organizador modular com nichos e bandejas geométricas em linguagem Bauhaus para pequenos objetos.",
    159.99,
    twoCleanCuration,
  );
  assert.ok(result.priceToAutoCap > 0.70);
  assert.ok(result.styleFit >= 94);
  assert.ok(result.desirabilityFit >= 90);
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
  assert.ok(result.desirabilityFit >= 90);
  assert.ok(result.finalScore >= 88);
});
