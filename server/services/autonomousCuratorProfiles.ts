import { PUBLIC_PRODUCT_CATEGORIES, type PublicProductCategory } from "../../src/lib/productCategory";

export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.9";

export type AutonomousCuratorCategoryProfile = {
  category: PublicProductCategory;
  queries: readonly string[];
  /** Sinais fortes do universo Cerberus. Um único hit já é evidência estética relevante. */
  strongStyleTerms: readonly string[];
  /** Forma/material/linguagem que só contam em conjunto; nunca devem aprovar sozinhos por um único hit. */
  signatureTerms: readonly string[];
  /** Compatibilidade com código antigo e ranking barato. */
  preferredTerms: readonly string[];
  blockedTerms: readonly string[];
  /** Curadoria de finds: preço acima disso nunca auto-publica. */
  maxAutoPrice: number;
  /** Acima disso o produto sequer entra em revisão automática. */
  maxReviewPrice: number;
};

const STRONG_STYLE_TERMS = [
  "bauhaus", "mid century", "mid-century", "space age", "space-age",
  "anos 60", "anos 70", "sixties", "seventies", "modernista", "modernism",
  "postmoderno", "postmodern", "memphis", "retro futurista", "retrofuturista",
  "brutalista", "art deco", "italian design", "design italiano vintage",
] as const;

const COMMON_BLOCKED = [
  "kit 50", "kit 100", "atacado", "lote", "revenda", "peça reposição", "peca reposicao",
  "logo", "adesivo", "capa protetora", "manual", "arquivo digital",
  "kawaii", "geek", "gamer rgb", "tematico", "temática", "tematica",
] as const;

const INFANTIL_COMMON_BLOCKED = COMMON_BLOCKED.filter(term => !["tematico", "temática", "tematica"].includes(term));

const BROAD_RECALL_QUERIES: Partial<Record<PublicProductCategory, readonly string[]>> = {
  "Iluminação": ["luminaria bauhaus", "abajur cogumelo", "luminaria retro", "abajur vintage"],
  "Decoração": ["decoracao bauhaus", "decoracao vintage", "vaso vintage", "espelho retro"],
  "Móveis": ["moveis vintage", "mesa lateral vintage", "cadeira cromada", "mesa apoio retro"],
  "Cozinha & Mesa": ["cozinha vintage", "copo vintage", "jarra vintage", "bandeja cromada"],
  "Organização": ["organizador vintage", "cabideiro retro", "porta revista vintage", "organizador acrilico"],
  "Vestuário": ["roupa masculina vintage", "jaqueta retro masculina", "camisa vintage masculina", "calca vintage masculina"],
  "Calçados & Acessórios": ["oculos retro masculino", "cinto vintage masculino", "bolsa vintage masculina", "mocassim retro masculino"],
  "Tecnologia": ["radio retro", "caixa som retro", "relogio retro mesa", "teclado vintage"],
  "Beleza & Bem-estar": ["espelho maquiagem retro", "necessaire vintage", "porta perfume vintage", "espelho maquiagem"],
  "Infantil": [
    "infantil", "brinquedo infantil", "quarto infantil",
    "brinquedo madeira", "brinquedo montessori", "mobile infantil",
  ],
};

function profile(input: Omit<AutonomousCuratorCategoryProfile, "strongStyleTerms" | "preferredTerms"> & { strongStyleTerms?: readonly string[] }): AutonomousCuratorCategoryProfile {
  const strongStyleTerms = input.strongStyleTerms || STRONG_STYLE_TERMS;
  return {
    ...input,
    queries: [...(BROAD_RECALL_QUERIES[input.category] || []), ...input.queries],
    strongStyleTerms,
    preferredTerms: [...strongStyleTerms, ...input.signatureTerms],
  };
}

/**
 * Perfil 1.9: preserva os gates técnicos e torna o recall Infantil compatível com
 * a busca manual /shopee. A query ampla `infantil` abre o mesmo universo do operador;
 * vocabulário de calçados/temas infantis só ajuda o ranking depois da categoria ser
 * validada. Segurança, imagem, pipeline, similaridade, preço e threshold final seguem ativos.
 */
export const AUTONOMOUS_CURATOR_PROFILES: readonly AutonomousCuratorCategoryProfile[] = [
  profile({
    category: "Iluminação",
    queries: [
      "luminaria cogumelo cromada space age", "abajur cogumelo bauhaus", "abajur cogumelo anos 60",
      "luminaria cromada anos 70", "luminaria opalina space age", "luminaria italiana vintage",
      "arandela bauhaus", "abajur retro futurista",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "cogumelo", "luminaria cogumelo", "luminária cogumelo", "abajur cogumelo", "lampada cogumelo", "lâmpada cogumelo", "candeeiro cogumelo",
    ],
    signatureTerms: ["cogumelo", "opalino", "opalina", "cromado", "cromada", "inox", "aluminio", "vidro fumê", "vidro fume", "globo", "retro", "vintage"],
    blockedTerms: [
      ...COMMON_BLOCKED,
      "fita led", "farol", "automotiva",
      "cupula luminaria", "cúpula luminária", "cupula para luminaria", "cúpula para luminária",
      "somente cupula", "somente cúpula", "sem soquete", "globo reposicao",
    ],
    maxAutoPrice: 550,
    maxReviewPrice: 800,
  }),
  profile({
    category: "Decoração",
    queries: [
      "espelho mid century", "vaso bauhaus", "castical space age cromado",
      "objeto decorativo anos 70", "escultura postmoderna retro", "relogio vintage design",
      "porta vela bauhaus", "decoracao italiana vintage",
      "vaso murano vintage anos 70", "cinzeiro vidro murano vintage",
      "relogio mesa space age", "castical cromado mid century",
    ],
    signatureTerms: ["organico", "orgânico", "cromado", "inox", "vidro ambar", "vidro âmbar", "ceramica", "cerâmica", "escultura", "metal", "couro", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "placa decorativa frase", "religioso", "festas", "resina anjo", "gnomo", "bicicleta decorativa", "moto decorativa"],
    maxAutoPrice: 350,
    maxReviewPrice: 600,
  }),
  profile({
    category: "Móveis",
    queries: [
      "mesa lateral mid century", "cadeira cromada bauhaus", "banqueta space age",
      "mesa auxiliar anos 70", "criado mudo mid century", "poltrona modernista",
      "mesa lateral italiana vintage", "banqueta tubular bauhaus",
      "mesa apoio cromada anos 70", "mesa lateral tubular cromada",
      "banqueta cromada vintage", "criado mudo retro madeira",
      "mesa lateral cromada vidro fume", "mesa auxiliar tubular cromada",
      "banqueta tubular cromada", "mesa pedestal tulipa retro",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "mesa lateral cromada", "mesa auxiliar cromada", "banqueta tubular", "tubular cromado",
      "vidro fumê", "vidro fume", "pedestal tulipa",
    ],
    signatureTerms: ["tubular", "cromado", "inox", "curvo", "curva", "modular", "nogueira", "teca", "vidro fumê", "vidro fume", "metal", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "capa para cadeira", "rodizio", "parafuso", "puxador", "eiffel", "eames", "cadeira gamer", "cadeira plastica", "cadeira plástica"],
    maxAutoPrice: 900,
    maxReviewPrice: 1500,
  }),
  profile({
    category: "Cozinha & Mesa",
    queries: [
      "jarra vintage vidro ambar", "bandeja inox mid century", "copo vidro anos 70",
      "talheres vintage inox", "xicaras bauhaus", "tigela vidro retro design",
      "porta guardanapo cromado vintage", "mesa posta mid century",
    ],
    signatureTerms: ["ambar", "âmbar", "borossilicato", "inox", "cromado", "vidro fumê", "vidro fume", "ceramica", "cerâmica", "geométrico", "geometrico", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "descartavel", "100 unidades", "industrial restaurante", "strass", "natal", "papai noel"],
    maxAutoPrice: 300,
    maxReviewPrice: 500,
  }),
  profile({
    category: "Organização",
    queries: [
      "organizador acrilico space age", "porta objetos bauhaus", "organizador cromado anos 70",
      "porta revistas mid century", "cabideiro vintage design", "gaveteiro bauhaus",
      "organizador modular retro", "porta objetos italiano vintage",
      "porta revistas cromado tubular", "cabideiro cromado vintage",
      "gaveteiro modular retro", "organizador acrilico fume",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "porta revistas cromado", "cabideiro cromado", "gaveteiro modular",
      "organizador acrilico", "organizador acrílico", "acrilico fume", "acrílico fumê",
    ],
    signatureTerms: ["acrilico", "acrílico", "cromado", "inox", "transparente", "modular", "tubular", "metal", "geométrico", "geometrico", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "organizador cabos 100", "etiqueta", "saco vacuo kit", "bicicleta", "motocicleta", "carro", "boneco", "porta caneta divertido"],
    maxAutoPrice: 220,
    maxReviewPrice: 350,
  }),
  profile({
    category: "Vestuário",
    queries: [
      "jaqueta vintage masculina anos 70", "camisa retro masculina design", "calca wide leg vintage masculina",
      "polo knit retro masculina", "jaqueta racing vintage masculina", "camisa modernista masculina",
      "jaqueta boxy vintage masculina", "alfaiataria masculina anos 70",
    ],
    signatureTerms: ["boxy", "wide leg", "corte reto", "tricot", "tricô", "knit", "camurca", "camurça", "veludo", "linho", "alfaiataria", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "fantasia", "uniforme", "camisa time", "replica", "feminina", "feminino", "mulher", "women"],
    maxAutoPrice: 650,
    maxReviewPrice: 900,
  }),
  profile({
    category: "Calçados & Acessórios",
    queries: [
      "oculos vintage anos 70 masculino", "cinto bauhaus masculino", "bolsa masculina mid century",
      "tenis retro masculino design", "carteira couro modernista", "bolsa ombro vintage masculina",
      "oculos space age masculino", "acessorio masculino anos 70",
      "oculos acetato retro masculino", "cinto couro vintage masculino",
      "mocassim retro masculino anos 70", "relogio digital retro masculino",
      "oculos acetato tartaruga vintage masculino", "oculos aviador metal anos 70 masculino",
      "mocassim camurca retro masculino", "bolsa carteiro couro vintage masculina",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "oculos acetato", "óculos acetato", "oculos aviador", "óculos aviador",
      "mocassim camurca", "mocassim couro", "bolsa carteiro",
      "relogio digital retro", "relógio digital retrô",
    ],
    signatureTerms: ["acetato", "couro", "camurca", "camurça", "metal", "cromado", "geométrico", "geometrico", "minimalista", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "replica", "inspirado marca", "falsificado", "feminina", "feminino", "mulher", "women", "strass", "pedraria"],
    maxAutoPrice: 300,
    maxReviewPrice: 450,
  }),
  profile({
    category: "Tecnologia",
    queries: [
      "radio bluetooth retro madeira vintage", "radio retro portatil bluetooth madeira", "caixa de som retro madeira bluetooth",
      "teclado mecanico vintage design", "relogio digital retro mesa", "hub usb aluminio retro design",
      "mouse transparente retro futurista", "carregador sem fio retro design",
      "radio vintage bluetooth", "caixa som madeira vintage",
      "relogio flip retro mesa", "telefone retro bluetooth",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "radio retro", "rádio retrô", "radio vintage", "rádio vintage", "mouse transparente",
    ],
    signatureTerms: ["transparente", "madeira", "amadeirado", "aluminio", "alumínio", "cromado", "digital", "analógico", "analogico", "compacto", "metal", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "espiao", "camera escondida", "rastreador oculto", "gamer", "rgb"],
    maxAutoPrice: 700,
    maxReviewPrice: 1200,
  }),
  profile({
    category: "Beleza & Bem-estar",
    queries: [
      "espelho maquiagem vintage design", "espelho maquiagem dobravel couro", "porta perfume bauhaus",
      "necessaire retro design", "porta pincel space age", "pente madeira modernista",
      "espelho maquiagem anos 70", "estojo maquiagem vintage minimalista",
      "espelho maquiagem mesa cromado vintage", "espelho maquiagem dupla face cromado anos 70",
      "necessaire couro minimalista vintage", "porta perfume vidro metal vintage",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "espelho mesa cromado", "espelho de mesa cromado",
      "espelho maquiagem retro", "espelho maquiagem retrô",
      "espelho dobravel", "espelho dobrável", "porta perfume vintage",
    ],
    signatureTerms: ["dobravel", "dobrável", "compacto", "couro", "acrilico", "acrílico", "metal", "espelho", "geométrico", "geometrico", "minimalista", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "medicamento", "remedio", "hormonio", "emagrecedor", "suplemento", "clareador ingerivel"],
    maxAutoPrice: 300,
    maxReviewPrice: 500,
  }),
  profile({
    category: "Infantil",
    queries: [
      "blocos bauhaus madeira infantil", "brinquedo madeira mid century", "brinquedo arco iris bauhaus",
      "brinquedo geometrico anos 70", "brinquedo madeira design escandinavo", "mobile infantil modernista",
      "brinquedo montessori bauhaus", "decoracao infantil mid century",
      "brinquedo madeira geometrico", "arco iris madeira montessori",
      "blocos madeira cores primarias", "mobile madeira geometrico infantil",
      "blocos madeira bauhaus cores primarias", "brinquedo equilibrio madeira escandinavo",
      "mobile madeira formas geometricas", "brinquedo empilhavel madeira geometrico",
      "brinquedo montessori madeira", "brinquedo waldorf madeira",
      "brinquedo encaixe madeira montessori", "brinquedo empilhavel montessori",
    ],
    strongStyleTerms: [
      ...STRONG_STYLE_TERMS,
      "brinquedo madeira", "blocos madeira", "brinquedo montessori", "montessori", "waldorf",
      "brinquedo geometrico", "brinquedo geométrico", "brinquedo encaixe madeira",
      "arco iris madeira", "arco-íris madeira",
      "blocos bauhaus", "blocos madeira cores primarias", "blocos madeira cores primárias",
      "brinquedo equilibrio madeira", "brinquedo equilíbrio madeira",
      "mobile geometrico", "mobile geométrico", "mobile madeira",
      "brinquedo empilhavel madeira", "brinquedo empilhável madeira",
      "babuch infantil", "calcado infantil", "calçado infantil", "sandalia infantil", "sandália infantil",
      "country infantil", "cowgirl infantil", "fazendinha infantil",
    ],
    signatureTerms: [
      "geométrico", "geometrico", "formas", "cores primarias", "cores primárias", "madeira natural",
      "madeira", "montessori", "waldorf", "encaixe", "empilhavel", "empilhável",
      "equilibrio", "equilíbrio", "design escandinavo", "retro", "vintage",
      "country", "cowgirl", "fazendinha", "rodeio", "babuch", "sandalia", "sandália",
    ],
    blockedTerms: [
      ...INFANTIL_COMMON_BLOCKED,
      "arma brinquedo", "pistola", "municao", "laser forte",
      "caminhao", "caminhão", "carro plastico", "carro plástico", "personagem",
    ],
    maxAutoPrice: 300,
    maxReviewPrice: 500,
  }),
] as const;

if (AUTONOMOUS_CURATOR_PROFILES.length !== PUBLIC_PRODUCT_CATEGORIES.length) {
  throw new Error("AUTONOMOUS_CURATOR_PROFILE_COVERAGE_INVALID");
}

export function profileForCategory(category: PublicProductCategory): AutonomousCuratorCategoryProfile {
  const found = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === category);
  if (!found) throw new Error(`AUTONOMOUS_CURATOR_PROFILE_MISSING:${category}`);
  return found;
}

/** Query diária determinística: retry do mesmo dia usa exatamente a mesma busca. */
export function queryForProfile(categoryProfile: AutonomousCuratorCategoryProfile, runDate: string): string {
  const seed = [...`${runDate}:${categoryProfile.category}`].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) >>> 0, 5381);
  return categoryProfile.queries[seed % categoryProfile.queries.length];
}