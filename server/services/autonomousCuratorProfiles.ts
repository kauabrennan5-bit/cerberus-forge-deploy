import { PUBLIC_PRODUCT_CATEGORIES, type PublicProductCategory } from "../../src/lib/productCategory";

export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.3";

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

function profile(input: Omit<AutonomousCuratorCategoryProfile, "strongStyleTerms" | "preferredTerms"> & { strongStyleTerms?: readonly string[] }): AutonomousCuratorCategoryProfile {
  const strongStyleTerms = input.strongStyleTerms || STRONG_STYLE_TERMS;
  return {
    ...input,
    strongStyleTerms,
    preferredTerms: [...strongStyleTerms, ...input.signatureTerms],
  };
}

/**
 * Perfil 1.3: descoberta estreita e precision-first. O Cerberus não tenta
 * preencher quota com itens genéricos. Zero por categoria é um resultado válido.
 */
export const AUTONOMOUS_CURATOR_PROFILES: readonly AutonomousCuratorCategoryProfile[] = [
  profile({
    category: "Iluminação",
    queries: [
      "abajur bauhaus", "luminaria cogumelo space age", "abajur mid century",
      "luminaria cromada anos 70", "luminaria italiana vintage", "arandela bauhaus",
      "luminaria opalina space age", "abajur retro futurista",
    ],
    signatureTerms: ["cogumelo", "opalino", "opalina", "cromado", "cromada", "inox", "aluminio", "vidro fumê", "vidro fume", "globo", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "fita led", "farol", "automotiva", "cupula", "cúpula", "somente cupula", "somente cúpula", "sem soquete", "globo reposicao"],
    maxAutoPrice: 550,
    maxReviewPrice: 800,
  }),
  profile({
    category: "Decoração",
    queries: [
      "espelho mid century", "vaso bauhaus", "castical space age cromado",
      "objeto decorativo anos 70", "escultura postmoderna retro", "relogio vintage design",
      "porta vela bauhaus", "decoracao italiana vintage",
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
    ],
    signatureTerms: ["acetato", "couro", "camurca", "camurça", "metal", "cromado", "geométrico", "geometrico", "minimalista", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "replica", "inspirado marca", "falsificado", "feminina", "feminino", "mulher", "women", "strass", "pedraria"],
    maxAutoPrice: 300,
    maxReviewPrice: 450,
  }),
  profile({
    category: "Tecnologia",
    queries: [
      "radio bluetooth retro design", "caixa de som mid century", "teclado mecanico vintage design",
      "relogio digital space age", "carregador bauhaus design", "hub usb aluminio minimalista vintage",
      "mouse transparente retro futurista", "tecnologia anos 70 design",
    ],
    signatureTerms: ["transparente", "aluminio", "alumínio", "cromado", "digital", "analógico", "analogico", "compacto", "metal", "retro", "vintage"],
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
    ],
    signatureTerms: ["geométrico", "geometrico", "formas", "cores primarias", "cores primárias", "madeira natural", "encaixe", "equilibrio", "equilíbrio", "design escandinavo", "retro", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "arma brinquedo", "pistola", "municao", "laser forte", "caminhao", "caminhão", "carro plastico", "carro plástico", "personagem"],
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
