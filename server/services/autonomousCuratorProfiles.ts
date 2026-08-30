import { PUBLIC_PRODUCT_CATEGORIES, type PublicProductCategory } from "../../src/lib/productCategory";

export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.0";

export type AutonomousCuratorCategoryProfile = {
  category: PublicProductCategory;
  queries: readonly string[];
  preferredTerms: readonly string[];
  blockedTerms: readonly string[];
};

const COMMON_BLOCKED = [
  "kit 50", "kit 100", "atacado", "lote", "revenda", "peça reposição", "reposicao",
  "logo", "adesivo", "capa protetora", "manual", "arquivo digital",
] as const;

export const AUTONOMOUS_CURATOR_PROFILES: readonly AutonomousCuratorCategoryProfile[] = [
  {
    category: "Iluminação",
    queries: ["luminaria bauhaus", "abajur cogumelo", "luminaria space age", "luminaria mid century"],
    preferredTerms: ["bauhaus", "cogumelo", "space age", "mid century", "retro", "vidro", "cromado", "opalino"],
    blockedTerms: [...COMMON_BLOCKED, "rgb gamer", "fita led", "farol", "automotiva"],
  },
  {
    category: "Decoração",
    queries: ["vaso decorativo retro", "espelho organico design", "objeto decorativo bauhaus", "escultura decorativa moderna"],
    preferredTerms: ["retro", "bauhaus", "mid century", "vidro", "inox", "cromado", "organico", "escultura"],
    blockedTerms: [...COMMON_BLOCKED, "placa decorativa frase", "religioso", "festas"],
  },
  {
    category: "Móveis",
    queries: ["mesa lateral retro", "cadeira design moderno", "banqueta cromada", "mesa auxiliar bauhaus"],
    preferredTerms: ["retro", "bauhaus", "mid century", "cromado", "inox", "madeira", "curvo", "modular"],
    blockedTerms: [...COMMON_BLOCKED, "capa para cadeira", "rodizio", "parafuso", "puxador"],
  },
  {
    category: "Cozinha & Mesa",
    queries: ["bandeja inox design", "copo vidro ambar", "jarra vidro retro", "talheres inox design"],
    preferredTerms: ["inox", "vidro", "ambar", "retro", "design", "cromado", "borossilicato"],
    blockedTerms: [...COMMON_BLOCKED, "descartavel", "100 unidades", "industrial restaurante"],
  },
  {
    category: "Organização",
    queries: ["organizador acrilico design", "caixa organizadora metal", "porta objetos retro", "organizador mesa minimalista"],
    preferredTerms: ["acrilico", "metal", "inox", "cromado", "minimalista", "modular", "transparente"],
    blockedTerms: [...COMMON_BLOCKED, "organizador cabos 100", "etiqueta", "saco vacuo kit"],
  },
  {
    category: "Vestuário",
    queries: ["camiseta oversized minimalista", "jaqueta retro masculina", "camisa masculina design", "calca masculina corte reto"],
    preferredTerms: ["oversized", "retro", "minimalista", "algodao", "corte reto", "boxy", "vintage"],
    blockedTerms: [...COMMON_BLOCKED, "fantasia", "uniforme", "camisa time", "replica"],
  },
  {
    category: "Calçados & Acessórios",
    queries: ["oculos retro masculino", "cinto couro minimalista", "bolsa crossbody design", "tenis retro minimalista"],
    preferredTerms: ["retro", "minimalista", "couro", "acetato", "metal", "vintage", "design"],
    blockedTerms: [...COMMON_BLOCKED, "replica", "inspirado marca", "falsificado"],
  },
  {
    category: "Tecnologia",
    queries: ["relogio digital retro", "caixa de som retro", "teclado retro minimalista", "luminaria relogio digital design"],
    preferredTerms: ["retro", "minimalista", "aluminio", "transparente", "design", "digital", "compacto"],
    blockedTerms: [...COMMON_BLOCKED, "espiao", "camera escondida", "rastreador oculto", "gamer rgb"],
  },
  {
    category: "Beleza & Bem-estar",
    queries: ["espelho maquiagem design", "necessaire minimalista", "porta perfume design", "organizador beleza acrilico"],
    preferredTerms: ["vidro", "acrilico", "minimalista", "retro", "design", "metal", "espelho"],
    blockedTerms: [...COMMON_BLOCKED, "medicamento", "remedio", "hormonio", "emagrecedor", "suplemento", "clareador ingerivel"],
  },
  {
    category: "Infantil",
    queries: ["brinquedo madeira montessori", "luminaria infantil design", "organizador infantil madeira", "brinquedo educativo madeira"],
    preferredTerms: ["madeira", "educativo", "montessori", "design", "sensorial", "minimalista"],
    blockedTerms: [...COMMON_BLOCKED, "arma brinquedo", "pistola", "municao", "laser forte"],
  },
] as const;

if (AUTONOMOUS_CURATOR_PROFILES.length !== PUBLIC_PRODUCT_CATEGORIES.length) {
  throw new Error("AUTONOMOUS_CURATOR_PROFILE_COVERAGE_INVALID");
}

export function profileForCategory(category: PublicProductCategory): AutonomousCuratorCategoryProfile {
  const profile = AUTONOMOUS_CURATOR_PROFILES.find(item => item.category === category);
  if (!profile) throw new Error(`AUTONOMOUS_CURATOR_PROFILE_MISSING:${category}`);
  return profile;
}

/** Query diária determinística: retry do mesmo dia usa exatamente a mesma busca. */
export function queryForProfile(profile: AutonomousCuratorCategoryProfile, runDate: string): string {
  const seed = [...`${runDate}:${profile.category}`].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) >>> 0, 5381);
  return profile.queries[seed % profile.queries.length];
}
