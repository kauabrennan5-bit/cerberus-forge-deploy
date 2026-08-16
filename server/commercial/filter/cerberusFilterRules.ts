// ============================================================================
// Bloco N4 — Regras versionadas do filtro Cerberus (cerberus_filter_v1).
//
// GOVERNANÇA:
// - As regras são ENTIDADE persistida (filter_definitions), nunca constantes
//   mágicas escondidas: este módulo é a fonte-canônica em código da v1,
//   espelhada em filter_definitions na migração 20260816_candidate_assessment.
// - Mudança futura = v2 em arquivo/repositório novo + superseded_by; v1 nunca
//   é sobrescrita silenciosamente.
// - Cada regra declara rationale textual auditável (rationale_by_axis).
// - CANDIDATE != FACT CANÔNICO · RECOMMENDATION != ACTION.
// ============================================================================

export const FILTER_VERSION = "cerberus_filter_v1" as const;
export const SCORING_VERSION = "cerberus_priority_v1" as const;

// -----------------------------------------------------------------------------
// Catálogos fechados de eixos e classificações
// -----------------------------------------------------------------------------

export const DIMENSION_NAMES = [
  "CERBERUS_FIT",
  "DISCOVERY_VALUE",
  "QUALITY_SIGNAL",
  "DEMAND_SIGNAL",
  "COMMERCIAL_POTENTIAL",
  "AFFILIATE_ECONOMICS",
  "AD_VIABILITY",
  "EVIDENCE_CONFIDENCE",
  "RISK",
] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];

export const CLASSIFICATIONS = [
  "WINNER",
  "HIDDEN_GEM",
  "NICHE_DROP",
  "INSUFFICIENT",
  "NOT_RECOMMENDED",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const RECOMMENDATIONS = [
  "NONE",
  "INVESTIGATE_FURTHER",
  "ADD_TO_NICHE",
  "PARK",
  "REJECT",
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const PRIORITY_LEVELS = ["HIGH", "MEDIUM", "LOW", "NO_ACTION"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export type AxisLabel =
  | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" | "INSUFFICIENT"
  | "STRONG" | "MODERATE" | "WEAK" | "INCONCLUSIVE";

// -----------------------------------------------------------------------------
// Nichos estéticos (catálogo fechado v1 — expansível em v2)
// -----------------------------------------------------------------------------

export const KNOWN_NICHES = [
  "VINTAGE",
  "BAUHAUS",
  "SPACE_AGE",
  "MID_CENTURY",
  "JAPANESE",
  "MINIMALIST",
  "INDUSTRIAL",
] as const;
export type KnownNiche = (typeof KNOWN_NICHES)[number];

/** Palavras-gatilho heurísticas por nicho (curadoria textual, quality LOW). */
export const NICHE_KEYWORDS: Record<KnownNiche, readonly string[]> = {
  VINTAGE: ["vintage", "retrô", "retro", "anos 60", "anos 70", "anos 80", "época", "proveniência", "provenance"],
  BAUHAUS: ["bauhaus", "walter gropius", "marcel breuer", "tubular", "geométrica"],
  SPACE_AGE: ["space age", "espacial", "inflatables", "inflável", "retrofuturista", "verpan", "panton"],
  MID_CENTURY: ["mid century", "mid-century", "mcm", "séc. XX", "danish", "eames", "jacobsen"],
  JAPANESE: ["japonesa", "japonês", "japanese", "wabi", "sabi", "zen", "nordico-japonês", "japandi"],
  MINIMALIST: ["minimalista", "minimalista", "minimal", "clean", "clean design"],
  INDUSTRIAL: ["industrial", "steampunk", "ferro", "metal exposto", "loft"],
};

// -----------------------------------------------------------------------------
// Pesos versionados (não são constantes mágicas: espelham filter_definitions)
// -----------------------------------------------------------------------------

export const V1_WEIGHTS: Record<DimensionName, number> = {
  CERBERUS_FIT: 0.20,
  DISCOVERY_VALUE: 0.15,
  QUALITY_SIGNAL: 0.15,
  DEMAND_SIGNAL: 0.10,
  COMMERCIAL_POTENTIAL: 0.10,
  AFFILIATE_ECONOMICS: 0.10,
  AD_VIABILITY: 0.05,
  EVIDENCE_CONFIDENCE: 0.10,
  RISK: 0.05,
};

// Labels → score 0..1 por eixo (explicável; usado APENAS na PRIORITY derivada).
export const V1_AXIS_SCORE: Record<string, number> = {
  HIGH: 1.0,
  STRONG: 1.0,
  MEDIUM: 0.6,
  MODERATE: 0.55,
  LOW: 0.25,
  WEAK: 0.2,
  UNKNOWN: 0.3, // presença parcial da hipótese; não é rejeição nem aprovação
  INCONCLUSIVE: 0.15,
  INSUFFICIENT: 0.0, // eixo dependente de evidência ausente → componente zera
};

// RISK: labels invertidos (risco alto reduz prioridade).
export const V1_RISK_SCORE: Record<string, number> = {
  LOW: 1.0,
  MEDIUM: 0.5,
  HIGH: 0.0,
};

// -----------------------------------------------------------------------------
// Critérios formais de classificação (hipóteses de v1 — em filter_definitions)
// -----------------------------------------------------------------------------

export const V1_CLASSIFICATION_RULES = {
  WINNER: {
    rationale: "forte combinação com a curadoria, qualidade observável e sinais comerciais ou de descoberta; risco controlado",
    require: { cerberusFit: ["HIGH", "MEDIUM"], qualitySignal: ["HIGH", "MEDIUM"], evidenceConfidence: ["HIGH", "MEDIUM"], riskMax: "MEDIUM", disqualify: { demandSignal: "WEAK_ONLY_IF_NO_DISCOVERY" } },
    logic: "FIT≥MEDIUM ∧ QUALITY≥MEDIUM ∧ (DEMAND≥MODERATE ∨ DISCOVERY_VALUE=HIGH) ∧ EVIDENCE≥MEDIUM ∧ RISK≤MEDIUM",
  },
  HIDDEN_GEM: {
    rationale: "produto excelente/diferenciado com pouca ou nenhuma evidência de demanda — demanda fraca NÃO é rejeição",
    logic: "FIT≥MEDIUM ∧ DISCOVERY_VALUE≥HIGH ∧ DEMAND∈{WEAK,UNKNOWN} ∧ RISK≤MEDIUM",
  },
  NICHE_DROP: {
    rationale: "encaixe identificável em um nicho estético do catálogo fechado (individual ou por leva)",
    logic: "nicho identificável por heurística textual ∧ FIT≥MEDIUM",
  },
  INSUFFICIENT: {
    rationale: "a evidência não permite conclusão confiável — recomendar mais pesquisa, não publicar",
    logic: "EVIDENCE_CONFIDENCE=INSUFFICIENT ∨ campos críticos (price/quality/descrição) UNKNOWN em maioria",
  },
  NOT_RECOMMENDED: {
    rationale: "incompatível com a curadoria, risco relevante não mitigável ou contradição crítica",
    logic: "RISK=HIGH não mitigável ∨ FIT=LOW ∨ (contradição crítica sem resolução)",
  },
} as const;

// -----------------------------------------------------------------------------
// Rationale por eixo (rationale_by_axis da v1)
// -----------------------------------------------------------------------------

export const V1_RATIONALE_BY_AXIS: Record<DimensionName, string> = {
  CERBERUS_FIT: "coerência com o universo Casa+Vida da curadoria: categoria, título, descrição e estética; produto pode ser de qualquer faixa de preço — caro, médio ou barato podem ser excelentes",
  DISCOVERY_VALUE: "critério de curadoria (não fato objetivo): desejabilidade, originalidade e potencial de compartilhamento; produtos comuns recebem valor baixo, incomuns recebem valor alto",
  QUALITY_SIGNAL: "sinais observáveis (rating, review_count, seller, materiais citados na descrição) separando evidência direta, inferência e ausência — nunca afirmar 'alta qualidade' sem evidência",
  DEMAND_SIGNAL: "proxy declarado (rating/review_count/reputação do vendedor); demanda NÃO é requisito absoluto — fraca ou desconhecida mantém elegibilidade HIDDEN_GEM/NICHE_DROP",
  COMMERCIAL_POTENTIAL: "posicionamento de preço dentro da categoria e atratividade; potencial ≠ venda realizada",
  AFFILIATE_ECONOMICS: "sem fonte de comissão integrada na v1 — UNKNOWN por construção; NUNCA inventar comissão, CPC, CPA ou ROI",
  AD_VIABILITY: "sem infraestrutura de anúncios na v1 — INCONCLUSIVE por construção; não transformar potencial em ROI",
  EVIDENCE_CONFIDENCE: "composição da qualidade e cobertura das evidências do N3 (vocabulário existente); INSUFFICIENT zera componentes dependentes",
  RISK: "contradições abertas, dados ausentes, falhas de coleta, sinais fracos e riscos de afiliado/anúncio — contradições nunca são silenciadas",
};

export const V1_RULES_RATIONALE =
  "Filtro curatorial v1: avaliação multidimensional explicável de candidatos (9 eixos), sem score mágico, com demanda fraca não rejeitando, nichos por catálogo fechado e economia de afiliado UNKNOWN até existir fonte real.";
