import { PUBLIC_PRODUCT_CATEGORIES, type PublicProductCategory } from "../../src/lib/productCategory";

export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.2";

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

/**
 * Perfis de descoberta deliberadamente misturam consultas amplas de tipo/material
 * com consultas de linguagem estética. A descoberta deve ter recall alto; os
 * gates caros (imagem, copy, categoria, preço, similaridade, score e lifecycle)
 * continuam sendo a autoridade para publicar.
 */
export const AUTONOMOUS_CURATOR_PROFILES: readonly AutonomousCuratorCategoryProfile[] = [
  {
    category: "Iluminação",
    queries: [
      "abajur mesa vidro", "luminaria mesa metal", "luminaria cogumelo", "arandela moderna",
      "luminaria pendente vidro", "luminaria retro", "luminaria mid century", "luminaria bauhaus",
    ],
    preferredTerms: ["bauhaus", "cogumelo", "space age", "mid century", "retro", "vidro", "metal", "cromado", "opalino", "aluminio"],
    blockedTerms: [...COMMON_BLOCKED, "rgb gamer", "fita led", "farol", "automotiva"],
  },
  {
    category: "Decoração",
    queries: [
      "vaso decorativo vidro", "espelho organico", "castical decorativo metal", "escultura decorativa",
      "porta vela decorativo", "objeto decorativo retro", "relogio parede decorativo", "decoracao bauhaus",
    ],
    preferredTerms: ["retro", "bauhaus", "mid century", "vidro", "inox", "cromado", "organico", "escultura", "metal", "ceramica"],
    blockedTerms: [...COMMON_BLOCKED, "placa decorativa frase", "religioso", "festas"],
  },
  {
    category: "Móveis",
    queries: [
      "mesa lateral madeira", "mesa lateral metal", "banqueta alta", "cadeira design",
      "mesa auxiliar", "criado mudo moderno", "banqueta cromada", "movel mid century",
    ],
    preferredTerms: ["retro", "bauhaus", "mid century", "cromado", "inox", "madeira", "curvo", "modular", "metal", "minimalista"],
    blockedTerms: [...COMMON_BLOCKED, "capa para cadeira", "rodizio", "parafuso", "puxador"],
  },
  {
    category: "Cozinha & Mesa",
    queries: [
      "bandeja inox", "copo vidro", "jarra vidro", "talheres inox",
      "tigela vidro", "xicaras ceramica", "porta guardanapo metal", "mesa posta design",
    ],
    preferredTerms: ["inox", "vidro", "ambar", "retro", "design", "cromado", "borossilicato", "ceramica", "metal"],
    blockedTerms: [...COMMON_BLOCKED, "descartavel", "100 unidades", "industrial restaurante"],
  },
  {
    category: "Organização",
    queries: [
      "organizador acrilico", "organizador metal", "organizador porta objetos", "organizador mesa",
      "caixa organizadora design", "gaveteiro mesa organizador", "cabideiro organizador metal", "organizador minimalista",
    ],
    preferredTerms: ["acrilico", "metal", "inox", "cromado", "minimalista", "modular", "transparente", "madeira"],
    blockedTerms: [...COMMON_BLOCKED, "organizador cabos 100", "etiqueta", "saco vacuo kit"],
  },
  {
    category: "Vestuário",
    queries: [
      "camiseta oversized masculina", "camisa manga curta masculina", "calca reta masculina", "jaqueta masculina leve",
      "camisa linho masculina", "polo masculina minimalista", "bermuda masculina alfaiataria", "roupa masculina retro",
    ],
    preferredTerms: ["oversized", "retro", "minimalista", "algodao", "linho", "corte reto", "boxy", "vintage", "alfaiataria"],
    blockedTerms: [...COMMON_BLOCKED, "fantasia", "uniforme", "camisa time", "replica"],
  },
  {
    category: "Calçados & Acessórios",
    queries: [
      "oculos retro masculino", "cinto couro masculino", "bolsa crossbody masculina", "tenis retro masculino",
      "carteira couro minimalista", "bone masculino minimalista", "bolsa ombro masculina", "acessorio masculino vintage",
    ],
    preferredTerms: ["retro", "minimalista", "couro", "acetato", "metal", "vintage", "design", "camurca"],
    blockedTerms: [...COMMON_BLOCKED, "replica", "inspirado marca", "falsificado"],
  },
  {
    category: "Tecnologia",
    queries: [
      "relogio digital mesa", "caixa de som bluetooth", "teclado mecanico retro", "carregador sem fio design",
      "hub usb aluminio", "suporte notebook aluminio", "mouse transparente", "tecnologia retro design",
    ],
    preferredTerms: ["retro", "minimalista", "aluminio", "transparente", "design", "digital", "compacto", "metal"],
    blockedTerms: [...COMMON_BLOCKED, "espiao", "camera escondida", "rastreador oculto", "gamer rgb"],
  },
  {
    category: "Beleza & Bem-estar",
    queries: [
      "espelho maquiagem", "necessaire maquiagem", "porta perfume", "estojo maquiagem",
      "escova cabelo design", "pincel maquiagem design", "pente cabelo madeira", "acessorio maquiagem viagem",
    ],
    preferredTerms: ["vidro", "acrilico", "minimalista", "retro", "design", "metal", "espelho", "couro", "maquiagem", "perfume"],
    blockedTerms: [...COMMON_BLOCKED, "medicamento", "remedio", "hormonio", "emagrecedor", "suplemento", "clareador ingerivel"],
  },
  {
    category: "Infantil",
    queries: [
      "brinquedo madeira educativo", "quebra cabeca madeira infantil", "blocos madeira infantil", "brinquedo sensorial infantil",
      "brinquedo encaixe madeira", "brinquedo montessori", "brinquedo equilibrio madeira", "decoracao infantil madeira",
    ],
    preferredTerms: ["madeira", "educativo", "montessori", "design", "sensorial", "minimalista", "encaixe", "equilibrio"],
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
