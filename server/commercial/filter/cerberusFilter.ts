// ============================================================================
// Bloco N4 — Serviço de avaliação de candidatos (filtro Cerberus v1).
//
// Fluxo: candidate (N1) → evidências (N3) → 9 eixos → riscos → prioridade →
// classificação → recommendation → (persistência no repository N4).
//
// GOVERNANÇA:
// - DETERMINÍSTICO: mesmas evidências + mesma versão de regras → mesmo output.
//   Sem LLM, sem chamadas externas, sem estado global mutável.
// - QUALITY_HEURISTIC (não probabilidade): cada eixo devolve label + basis
//   textual obrigatório + ponteiros de evidência (nunca cópia).
// - UNKNOWN ≠ rejeição nem aprovação; CONTRADICTED nunca é silenciado;
//   COLLECTION_FAILED é declarado como falha operacional; DERIVED ≠ KNOWN.
// - RECOMMENDATION != ACTION: is_actionable=false sempre.
// - CANDIDATE != FACT CANÔNICO: nada em products.
// ============================================================================
import { createHash } from "crypto";
import {
  listCandidateEvidence,
  listFieldEvidence,
  type EvidenceRecord,
} from "../../repositories/candidateEvidenceRepository";
import {
  getCandidate,
  type CandidateRecord,
} from "../../repositories/candidatesRepository";
import {
  V1_WEIGHTS,
  V1_AXIS_SCORE,
  V1_RISK_SCORE,
  V1_CLASSIFICATION_RULES,
  V1_RATIONALE_BY_AXIS,
  V1_RULES_RATIONALE,
  FILTER_VERSION,
  SCORING_VERSION,
  KNOWN_NICHES,
  NICHE_KEYWORDS,
  type DimensionName,
  type AxisLabel,
  type KnownNiche,
  type PriorityLevel,
} from "./cerberusFilterRules";

// -----------------------------------------------------------------------------
// Contratos
// -----------------------------------------------------------------------------

export interface AxisAssessment {
  label: AxisLabel;
  score: number; // 0..1 — usado SOMENTE na PRIORITY derivada, nunca sozinho
  basis: string; // rationale textual obrigatório
  evidence_refs: string[]; // ponteiros para evidence_id (nunca cópia)
}

export interface Dimensions {
  CERBERUS_FIT: AxisAssessment;
  DISCOVERY_VALUE: AxisAssessment;
  QUALITY_SIGNAL: AxisAssessment;
  DEMAND_SIGNAL: AxisAssessment;
  COMMERCIAL_POTENTIAL: AxisAssessment;
  AFFILIATE_ECONOMICS: AxisAssessment;
  AD_VIABILITY: AxisAssessment;
  EVIDENCE_CONFIDENCE: AxisAssessment;
  RISK: AxisAssessment;
}

export interface ClassificationResult {
  classification: "WINNER" | "HIDDEN_GEM" | "NICHE_DROP" | "INSUFFICIENT" | "NOT_RECOMMENDED";
  basis: string;
}

export interface RecommendationResult {
  recommendation: "NONE" | "INVESTIGATE_FURTHER" | "ADD_TO_NICHE" | "PARK" | "REJECT";
  basis: string;
}

export interface PriorityResult {
  priority_score: number | null; // 0..1 derivado; nulo quando não computável
  priority_level: "HIGH" | "MEDIUM" | "LOW" | "NO_ACTION";
  explanation: string; // "por que esta prioridade"
  weights: Record<string, number>;
}

export interface AssessResult {
  ok: boolean;
  reason?: string;
  dimensions?: Dimensions;
  classification?: ClassificationResult;
  recommendation?: RecommendationResult;
  priority?: PriorityResult;
  unknowns?: string[];
  contradictions?: string[];
  collectionFailures?: string[];
  evidenceRefs?: string[];
  inputSnapshot?: Record<string, unknown>;
  candidate?: CandidateRecord | null;
}

// -----------------------------------------------------------------------------
// Internos de curadoria heurística (textual, quality LOW, sem LLM)
// -----------------------------------------------------------------------------

const HOME_AND_LIFE_KEYWORDS = [
  "luminária", "luminaria", "lamp", "lâmpada", "lampada", "abajur", "sofa", "sofá",
  "poltrona", "cadeira", "mesa", "banco", "aparador", "estante", "espelho", "vaso",
  "xícara", "xicara", "caneca", "cortiça", "cortica", "tapete", "almofada", "manta",
  "cristaleira", "porta-retratos", "porta retratos", "porta-retrato", "bandeja",
  "jarra", "garrafa", "cálice", "calice", "relógio", "relogio", "despertador",
  "porta-joias", "porta joias", "porta-copos", "porta copos", "porte-monnaie",
  "carteira", "colher", "garfo", "facas", "panela", "fruteira", "saladeira",
  "porta-guardanapo", "porta guardanapo", "castiçal", "castical", "vela",
  "porta-tempero", "porta tempero", "saleiro", "pote", "cofre", "porta-óculos",
  "porta oculos", "porta-chaves", "porta chaves", "porta-cinzas", "porta cinzas",
  "porta-canetas", "porta canetas", "porta-cartão", "porta cartao", "porta-paleta",
  "porta paleta", "porta-revistir", "porta-revista", "porta revista", "porta-talheres",
  "porta talheres", "porta-toalhas", "porta toalhas", "porta-sabonete", "porta sabonete",
  "porta-escova", "porta escova", "porta-guarda-chuva", "porta guarda-chuva",
  "porta guarda-chuva", "porta-tempero", "porta tempero", "porta-casa", "casa",
  "casa de chave", "porta-moedas", "porta moedas", "porta-moeda", "porta moeda",
  "porta-napoins", "porta-napkins", "porta-sais", "porta sais", "porta-sal",
  "porta sal", "porta-saís", "porta-serviette", "porta-servicete",
];

const HOUSEHOLD_SECTIONS = ["casa", "para casa", "decoration", "decoração", "decoracao", "home", "household", "kitchen", "cozinha", "banho", "bathroom", "living", "quarto", "bedroom", "dining", "sala", "escritório", "escritorio", "office"];

function tokenize(text: string): string {
  return (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function hasAny(text: string, needles: readonly string[]): string[] {
  const lower = tokenize(text);
  const found: string[] = [];
  for (const n of needles) {
    if (lower.includes(tokenize(n))) found.push(n);
  }
  return found;
}

function matchNiche(text: string): KnownNiche | null {
  const lower = tokenize(text);
  for (const niche of KNOWN_NICHES) {
    for (const kw of NICHE_KEYWORDS[niche]) {
      if (lower.includes(tokenize(kw))) return niche;
    }
  }
  return null;
}

function isHomeLifeCandidate(candidate: CandidateRecord): boolean {
  const haystack = tokenize(`${candidate.category} ${candidate.title} ${candidate.description}`);
  const direct = [...HOME_AND_LIFE_KEYWORDS, ...HOUSEHOLD_SECTIONS];
  return direct.some(kw => haystack.includes(tokenize(kw)));
}

// -----------------------------------------------------------------------------
// Eixos
// -----------------------------------------------------------------------------

function latestEvidenceByField(evidences: EvidenceRecord[]): Record<string, EvidenceRecord> {
  const byField: Record<string, EvidenceRecord[]> = {};
  for (const e of evidences) {
    if (e.kind !== "FIELD" || !e.field_name) continue;
    (byField[e.field_name] ??= []).push(e);
  }
  const latest: Record<string, EvidenceRecord> = {};
  for (const [field, list] of Object.entries(byField)) {
    const sorted = [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    latest[field] = sorted[0];
  }
  return latest;
}

function refs(evidences: EvidenceRecord[]): string[] {
  return evidences.map(e => e.evidence_id).filter(id => typeof id === "string" && id.length > 0);
}

function axis(
  label: AxisLabel,
  score: number,
  basis: string,
  evidence: EvidenceRecord[],
): AxisAssessment {
  return { label, score, basis, evidence_refs: refs(evidence) };
}

function axisFromQuality(
  highLabel: AxisLabel,
  midLabel: AxisLabel,
  lowLabel: AxisLabel,
  unknownLabel: AxisLabel,
  basis: string,
  evidence: EvidenceRecord[],
): AxisAssessment {
  const quality = evidence[0]?.quality ?? "UNKNOWN";
  const label =
    quality === "HIGH" ? highLabel :
    quality === "MEDIUM" ? midLabel :
    quality === "LOW" ? lowLabel :
    unknownLabel;
  const score = V1_AXIS_SCORE[label] ?? 0;
  return axis(label, score, basis, evidence);
}

function assessCerberusFit(
  candidate: CandidateRecord,
): AxisAssessment {
  const isHome = isHomeLifeCandidate(candidate);
  const niche = matchNiche(`${candidate.category} ${candidate.title} ${candidate.description}`);
  if (!isHome) {
    return axis(
      "LOW", 0.25,
      "fora do universo Casa+Vida da curadoria: categoria/título/descrição sem identificação de uso doméstico ou vida (heurística textual por palavras; qualidade LOW)",
      [],
    );
  }
  const hasDescription = (candidate.description || "").trim().length > 20;
  const basis =
    niche
      ? `adequado ao universo Casa+Vida E encaixe identificável no nicho ${niche} (heurística textual de catálogo fechado; qualidade LOW). ${hasDescription ? "Descrição presente." : "Sem descrição detalhada."}`
      : `adequado ao universo Casa+Vida (${isHome ? "identificação textual de uso doméstico/vida" : ""}). ${hasDescription ? "Descrição presente." : "Sem descrição detalhada."} ${niche ? "" : "Nenhum nicho estético identificável por heurística textual — elegível apenas individualmente."}`;
  return axis(niche ? "HIGH" : "MEDIUM", niche ? 1.0 : 0.6, basis, []);
}

function assessDiscoveryValue(
  candidate: CandidateRecord,
  evidence: EvidenceRecord[],
): AxisAssessment {
  const niche = matchNiche(`${candidate.category} ${candidate.title} ${candidate.description}`);
  const desc = (candidate.description || "").toLowerCase();
  const rarityCues = hasAny(desc, [
    "edição limitada", "limited edition", "peça única", "peca unica", "raro",
    "difícil de encontrar", "nao se encontra", "não se encontra", "artesan", "feito à mão", "feito a mao", "handmade", "autoral",
  ]);
  const commonCues = hasAny(desc, ["genérico", "generico", "comum", "básico", "basico", "plástico comum", "descartável", "descartavel"]);
  const evidenceRefs = refs(evidence.filter(e => ["title", "category", "images"].includes(e.field_name ?? "")));
  if (niche || rarityCues.length > 0) {
    return axis(
      "HIGH", 1.0,
      `valor de descoberta alto: ${niche ? `encaixe em nicho estético (${niche})` : rarityCues.join(", ")} — incomum, diferenciado ou com identidade estética forte (curadoria heurística textual, quality LOW; não é fato objetivo)`,
      evidenceRefs.length > 0 ? evidence.filter(e => evidenceRefs.includes(e.evidence_id)) : [],
    );
  }
  if (commonCues.length > 0) {
    return axis(
      "LOW", 0.25,
      `valor de descoberta baixo: produto comum/generico ou descartável segundo a descrição (heurística textual)`,
      [],
    );
  }
  return axis(
    "MEDIUM", 0.6,
    "valor de descoberta intermediário: sem sinais claros de raridade nem de genericidade na descrição disponível (curadoria heurística)",
    [],
  );
}

function assessQualitySignal(
  candidate: CandidateRecord,
  evidences: EvidenceRecord[],
): AxisAssessment {
  const qualityEvidence: EvidenceRecord[] = [];
  const unknownFields: string[] = [];
  for (const field of ["rating", "review_count", "seller", "images", "price"]) {
    const byField = evidences.filter(e => e.field_name === field);
    const fieldEvidence = byField.filter(e => e.field_state !== "RESEARCH_SESSION" as unknown as string);
    for (const e of fieldEvidence) {
      if (e.field_state === "KNOWN") qualityEvidence.push(e);
      else if (e.field_state === "UNKNOWN" || e.field_state === "COLLECTION_FAILED") unknownFields.push(`${field}(${e.field_state})`);
      else if (e.field_state === "DERIVED") qualityEvidence.push(e); // sustenta, degrada confidence
      else if (e.field_state === "CONTRADICTED") qualityEvidence.push(e);
    }
  }
  const rating = candidate.observed_rating;
  const ratingCount = candidate.observed_rating_count;
  const availability = candidate.observed_availability;
  const directEvidence = qualityEvidence.filter(e => e.quality === "HIGH");
  const hasMaterialCues = hasAny(candidate.description, [
    "metal", "madeira", "maciço", "cerâmica", "ceramica", "vidro", "inox",
    "latão", "latao", "aço", "aco", "linho", "algodão", "algodao", "couro", "tela",
  ]);
  if (directEvidence.length === 0 && rating === null && ratingCount === null && availability === "UNKNOWN") {
    return axis(
      "INSUFFICIENT", 0,
      `sinais de qualidade insuficientes: sem evidência KNOWN de rating/review_count/seller/imagens/preço e disponibilidade desconhecida — não afirmar qualidade (${unknownFields.join(", ") || "nenhuma coleta"})`,
      [],
    );
  }
  const positive = (rating !== null && rating >= 4) || directEvidence.length >= 3;
  const mixed = (rating !== null && rating >= 3.5) || directEvidence.length >= 1;
  const basis = [
    `evidência direta de qualidade: ${directEvidence.length} campo(s) KNOWN`,
    rating !== null ? `rating observado ${rating}` : "rating ausente",
    ratingCount !== null ? `review_count ${ratingCount}` : "review_count ausente",
    hasMaterialCues.length > 0 ? `materiais citados na descrição: ${hasMaterialCues.join(", ")}` : "sem menção de materiais na descrição",
    availability !== "UNKNOWN" ? `disponibilidade ${availability}` : "disponibilidade desconhecida",
    unknownFields.length > 0 ? `campos não confirmados: ${unknownFields.join(", ")}` : null,
  ].filter(Boolean).join("; ");
  const label: AxisLabel = positive ? "HIGH" : mixed ? "MEDIUM" : "LOW";
  return axis(label, V1_AXIS_SCORE[label], basis, directEvidence);
}

function assessDemandSignal(
  candidate: CandidateRecord,
  evidences: EvidenceRecord[],
): AxisAssessment {
  const demandEvidence = evidences.filter(e =>
    ["rating", "review_count", "seller"].includes(e.field_name ?? "") && e.field_state === "KNOWN",
  );
  const ratingCount = candidate.observed_rating_count;
  const rating = candidate.observed_rating;
  const sellerEvidence = evidences.find(e => e.field_name === "seller" && e.field_state === "KNOWN");
  if (ratingCount === null || ratingCount === undefined) {
    return axis(
      "UNKNOWN", 0.3,
      "demanda desconhecida: review_count não observado — proxy de demanda ausente; isso NÃO é rejeição (elegível para HIDDEN_GEM/NICHE_DROP)",
      demandEvidence,
    );
  }
  if (ratingCount >= 100) {
    return axis(
      "STRONG", 1.0,
      `demanda forte por proxy declarado: ${ratingCount} avaliações (${rating !== null ? `rating ${rating}` : "rating ausente"}); ${sellerEvidence ? `vendedor conhecido (${(sellerEvidence.field_value as Record<string, unknown> | undefined)?.name ?? "ver evidência"})` : "sem evidência de seller"}`,
      demandEvidence,
    );
  }
  if (ratingCount >= 10) {
    return axis(
      "MODERATE", 0.55,
      `demanda moderada por proxy declarado: ${ratingCount} avaliações; ${rating !== null ? `rating ${rating}` : "rating ausente"}`,
      demandEvidence,
    );
  }
  return axis(
    "WEAK", 0.2,
    `demanda fraca por proxy declarado: ${ratingCount} avaliações; fraca ≠ rejeição automática — elegível para HIDDEN_GEM/NICHE_DROP`,
    demandEvidence,
  );
}

function assessCommercialPotential(
  candidate: CandidateRecord,
): AxisAssessment {
  const price = candidate.observed_price;
  const niche = matchNiche(`${candidate.category} ${candidate.title} ${candidate.description}`);
  const description = (candidate.description || "").toLowerCase();
  const hasDifferentiation = hasAny(description, [
    "diferenciado", "exclusivo", "exclusiva", "especial", "autoral", "design", "arquitet", "arquitetônic", "arquitetonic",
  ]);
  if (price === null || price === undefined) {
    return axis(
      "UNKNOWN", 0.3,
      "potencial comercial indeterminado: preço não confirmado (ou apenas DERIVED da URL) — preço = contexto dentro da categoria, sem faixa rígida (caro, médio ou barato podem ser excelentes)",
      [],
    );
  }
  const basis = [
    `preço observado R$ ${price.toFixed(2)} (contexto dentro de ${candidate.category || "categoria não informada"})`,
    niche ? `encaixe em nicho (${niche}) — diferenciação percebida` : "sem nicho estético identificável",
    hasDifferentiation.length > 0 ? `sinais de diferenciação na descrição: ${hasDifferentiation.join(", ")}` : null,
    "potencial ≠ venda realizada; sem dados de vendas no N4",
  ].filter(Boolean).join("; ");
  const label: AxisLabel = (niche || hasDifferentiation.length > 0) ? "HIGH" : price > 0 ? "MEDIUM" : "UNKNOWN";
  return axis(label, V1_AXIS_SCORE[label], basis, []);
}

function assessAffiliateEconomics(): AxisAssessment {
  return axis(
    "UNKNOWN", 0.3,
    "economia de afiliado desconhecida: NÃO existe fonte de comissão integrada na v1 (nenhuma comissão, CPC, CPA ou ROI existe no sistema) — não inventar números; decisão visível pronta para v2",
    [],
  );
}

function assessAdViability(): AxisAssessment {
  return axis(
    "INCONCLUSIVE", 0.15,
    "viabilidade de anúncio inconclusiva: NÃO existe infraestrutura de anúncios/acquisição na v1 — não transformar potencial em ROI; preparação apenas",
    [],
  );
}

function assessEvidenceConfidence(
  evidences: EvidenceRecord[],
): AxisAssessment {
  const fieldEvidences = evidences.filter(e => e.kind === "FIELD");
  if (fieldEvidences.length === 0) {
    return axis(
      "INSUFFICIENT", 0,
      "nenhuma evidência de campo para o candidato — o filtro não pode confiar em nada que não foi observado (INSUFFICIENT zera componentes dependentes)",
      [],
    );
  }
  const states = fieldEvidences.map(e => e.field_state);
  const known = states.filter(s => s === "KNOWN").length;
  const derived = states.filter(s => s === "DERIVED").length;
  const failed = states.filter(s => s === "COLLECTION_FAILED").length;
  const unknowns = states.filter(s => s === "UNKNOWN").length;
  const contradicted = states.filter(s => s === "CONTRADICTED").length;
  const total = states.length;
  const knownRatio = known / total;
  const basis = [
    `${total} evidência(s) de campo: ${known} KNOWN, ${derived} DERIVED, ${failed} COLLECTION_FAILED, ${unknowns} UNKNOWN, ${contradicted} CONTRADICTED`,
    failed > 0 ? "falhas de coleta presentes — declaradas, não silenciadas" : null,
    contradicted > 0 ? "contradições presentes — preservadas no histórico" : null,
    derived > 0 && known === 0 ? "todas as fontes são DERIVED — confiança baixa" : null,
  ].filter(Boolean).join("; ");
  const label: AxisLabel =
    knownRatio >= 0.7 && failed === 0 ? "HIGH" :
    knownRatio >= 0.3 ? "MEDIUM" :
    known > 0 ? "LOW" : "INSUFFICIENT";
  return axis(label, V1_AXIS_SCORE[label], basis, fieldEvidences);
}

function assessRisk(
  evidences: EvidenceRecord[],
  dimensions: Partial<Record<DimensionName, AxisAssessment>>,
): AxisAssessment {
  const problems: string[] = [];
  const evidence: EvidenceRecord[] = [];
  const fieldEvidences = evidences.filter(e => e.kind === "FIELD");
  for (const e of fieldEvidences) {
    if (e.field_state === "CONTRADICTED") {
      problems.push(`contradição aberta em ${e.field_name}: ${e.evidence_note || "valor conflitante com evidência anterior (contradiction_with)"}`);
      evidence.push(e);
    } else if (e.field_state === "COLLECTION_FAILED") {
      problems.push(`coleta falhou em ${e.field_name}: ${e.evidence_note || "sem motivo registrado"}`);
      evidence.push(e);
    }
  }
  const onlyDerived = fieldEvidences.length > 0 && fieldEvidences.every(e => e.field_state === "DERIVED");
  if (onlyDerived) {
    problems.push("todas as evidências são DERIVED (da URL) — nenhuma observação direta da página");
  }
  const unknownFields = fieldEvidences.filter(e => e.field_state === "UNKNOWN").length;
  if (unknownFields > 0) problems.push(`${unknownFields} campo(s) UNKNOWN — incerteza declarada, não fato negativo`);
  const lowFit = dimensions.CERBERUS_FIT?.label === "LOW";
  if (lowFit) problems.push("fora do universo Casa+Vida (FIT baixo) — risco de incompatibilidade com a curadoria");
  if (problems.length === 0) {
    return axis("LOW", 1.0, "nenhum problema aberto registrado: sem contradições, sem falhas de coleta, sem DERIVED como única fonte, sem incerteza crítica", evidence);
  }
  const label: AxisLabel = problems.length >= 2 || lowFit ? "HIGH" : "MEDIUM";
  return axis(
    label, V1_RISK_SCORE[label],
    `riscos declarados: ${problems.join("; ")}`,
    evidence,
  );
}

// -----------------------------------------------------------------------------
// Classificação v1 (hipóteses formais — persistidas em filter_definitions)
// -----------------------------------------------------------------------------

export function classify(
  dimensions: Dimensions,
  identifiedNiche: KnownNiche | null,
): ClassificationResult {
  const { CERBERUS_FIT: fit, DISCOVERY_VALUE: disc, QUALITY_SIGNAL: quality, DEMAND_SIGNAL: demand, EVIDENCE_CONFIDENCE: conf, RISK: risk } = dimensions;
  const riskMaxMedium = risk.label === "LOW" || risk.label === "MEDIUM";
  const fitAtLeastMedium = fit.label === "HIGH" || fit.label === "MEDIUM";

  // NOT_RECOMMENDED primeiro: incompatibilidade/risco crítico
  if (fit.label === "LOW" || risk.label === "HIGH") {
    return {
      classification: "NOT_RECOMMENDED",
      basis: `${fit.label === "LOW" ? "fora do universo Casa+Vida (FIT baixo)" : `risco alto (${risk.basis})`} — ${V1_CLASSIFICATION_RULES.NOT_RECOMMENDED.logic} (${V1_CLASSIFICATION_RULES.NOT_RECOMMENDED.rationale})`,
    };
  }

  // INSUFFICIENT: sem confiança para concluir
  if (conf.label === "INSUFFICIENT") {
    return {
      classification: "INSUFFICIENT",
      basis: `${V1_CLASSIFICATION_RULES.INSUFFICIENT.logic} (${V1_CLASSIFICATION_RULES.INSUFFICIENT.rationale}) — mais pesquisa, não publicação`,
    };
  }

  // WINNER
  const winnerDemand = demand.label === "STRONG" || demand.label === "MODERATE" || disc.label === "HIGH";
  if (fitAtLeastMedium && (quality.label === "HIGH" || quality.label === "MEDIUM") && winnerDemand && (conf.label === "HIGH" || conf.label === "MEDIUM") && riskMaxMedium) {
    return {
      classification: "WINNER",
      basis: `${V1_CLASSIFICATION_RULES.WINNER.logic} — ${V1_CLASSIFICATION_RULES.WINNER.rationale}`,
    };
  }

  // HIDDEN_GEM: demanda fraca/desconhecida NÃO rejeita
  if (fitAtLeastMedium && (disc.label === "HIGH") && (demand.label === "WEAK" || demand.label === "UNKNOWN") && riskMaxMedium) {
    return {
      classification: "HIDDEN_GEM",
      basis: `${V1_CLASSIFICATION_RULES.HIDDEN_GEM.logic} — ${V1_CLASSIFICATION_RULES.HIDDEN_GEM.rationale}`,
    };
  }

  // NICHE_DROP
  if (identifiedNiche && fitAtLeastMedium) {
    return {
      classification: "NICHE_DROP",
      basis: `${V1_CLASSIFICATION_RULES.NICHE_DROP.logic} (nicho identificado: ${identifiedNiche}) — ${V1_CLASSIFICATION_RULES.NICHE_DROP.rationale}`,
    };
  }

  return {
    classification: "INSUFFICIENT",
    basis: "nenhuma classificação positiva atendida pelos critérios formais da v1 — decisão conservadora: mais pesquisa antes de qualquer ação",
  };
}

export function recommend(classification: ClassificationResult): RecommendationResult {
  switch (classification.classification) {
    case "WINNER":
      return {
        recommendation: "ADD_TO_NICHE",
        basis: "forte combinação + sinais positivos — recomendado para curadoria de leva ou exposição individual (sem ação automática)",
      };
    case "HIDDEN_GEM":
      return {
        recommendation: "ADD_TO_NICHE",
        basis: "excelente produto com pouca exposição — recomendado para inclusão em leva/nicho temático (sem ação automática)",
      };
    case "NICHE_DROP":
      return {
        recommendation: "PARK",
        basis: "encaixe em nicho/leva identificado — estacionar aguardando a leva temática correspondente (sem ação automática)",
      };
    case "INSUFFICIENT":
      return {
        recommendation: "INVESTIGATE_FURTHER",
        basis: "evidência insuficiente — executar nova pesquisa de evidências (N3) antes de qualquer conclusão (sem ação automática)",
      };
    case "NOT_RECOMMENDED":
      return {
        recommendation: "REJECT",
        basis: "incompatível ou risco relevante — não prosseguir com este candidato (sem ação automática)",
      };
    default:
      return { recommendation: "NONE", basis: "sem recomendação" };
  }
}

// -----------------------------------------------------------------------------
// Prioridade derivada (composição explicável, weights versionados)
// -----------------------------------------------------------------------------

export function derivePriority(dimensions: Dimensions): PriorityResult {
  const weights = { ...V1_WEIGHTS };
  const parts: string[] = [];
  let weighted = 0;
  for (const dim of Object.keys(V1_WEIGHTS) as DimensionName[]) {
    const score = dimensions[dim].score;
    weighted += weights[dim] * score;
    parts.push(`${dim}=${dimensions[dim].label}(${score.toFixed(2)})×${weights[dim].toFixed(2)}`);
  }
  // Evidência insuficiente zera o componente: já tratado no score 0 de INSUFFICIENT.
  const score = Math.round(weighted * 10000) / 10000;
  const level: PriorityLevel =
    score >= 0.7 ? "HIGH" :
    score >= 0.45 ? "MEDIUM" :
    score > 0.15 ? "LOW" : "NO_ACTION";
  const explanation = `PRIORITY = Σ(peso × score por eixo) [${SCORING_VERSION}]: ${parts.join(" + ")} = ${score.toFixed(4)}. A prioridade NUNCA é exibida sem dimensions.`;
  return { priority_score: score, priority_level: level, explanation, weights };
}

// -----------------------------------------------------------------------------
// Entrada principal (determinística; injeta dependências para testes)
// -----------------------------------------------------------------------------

export interface FilterDeps {
  getCandidateById?: (candidateId: string) => Promise<{ ok: boolean; candidate?: CandidateRecord }>;
  getEvidenceForCandidate?: (candidateId: string) => Promise<{ ok: boolean; evidence: EvidenceRecord[] }>;
}

const DEFAULT_DEPS: FilterDeps = {
  getCandidateById: (id) => getCandidate(id),
  getEvidenceForCandidate: (id) =>
    listCandidateEvidence(id).then(r => ({ ok: r.ok, evidence: r.evidence })),
};

export async function assessCandidate(
  candidateId: string,
  deps: FilterDeps = DEFAULT_DEPS,
): Promise<AssessResult> {
  const { getCandidateById, getEvidenceForCandidate } = deps;
  if (!candidateId || typeof candidateId !== "string") {
    return { ok: false, reason: "invalid_candidate_id" };
  }
  const candidateResult = await (getCandidateById ?? DEFAULT_DEPS.getCandidateById!)(candidateId);
  if (!candidateResult.ok || !candidateResult.candidate) {
    return { ok: false, reason: "candidate_not_found" };
  }
  const candidate = candidateResult.candidate;

  const evidenceResult = await (getEvidenceForCandidate ?? DEFAULT_DEPS.getEvidenceForCandidate!)(candidateId);
  const evidences = evidenceResult.ok ? evidenceResult.evidence : [];

  const dimensions: Dimensions = {
    CERBERUS_FIT: assessCerberusFit(candidate),
    DISCOVERY_VALUE: assessDiscoveryValue(candidate, evidences),
    QUALITY_SIGNAL: assessQualitySignal(candidate, evidences),
    DEMAND_SIGNAL: assessDemandSignal(candidate, evidences),
    COMMERCIAL_POTENTIAL: assessCommercialPotential(candidate),
    AFFILIATE_ECONOMICS: assessAffiliateEconomics(),
    AD_VIABILITY: assessAdViability(),
    EVIDENCE_CONFIDENCE: assessEvidenceConfidence(evidences),
    RISK: assessRisk(evidences, {} as Partial<Record<DimensionName, AxisAssessment>>),
  };

  // RISK precisa das dimensions (recalcular com fit incorporado).
  dimensions.RISK = assessRisk(evidences, dimensions as Partial<Record<DimensionName, AxisAssessment>>);

  const identifiedNiche = matchNiche(`${candidate.category} ${candidate.title} ${candidate.description}`);
  const classificationResult = classify(dimensions, identifiedNiche);
  const recommendationResult = recommend(classificationResult);
  const priorityResult = derivePriority(dimensions);

  const unknowns = evidences.filter(e => e.field_state === "UNKNOWN").map(e => `${e.field_name}(${e.evidence_id})`);
  const contradictions = evidences.filter(e => e.field_state === "CONTRADICTED").map(e => `${e.field_name}(${e.evidence_id})`);
  const collectionFailures = evidences.filter(e => e.field_state === "COLLECTION_FAILED").map(e => `${e.field_name}(${e.evidence_id})`);
  const evidenceRefs = refs(evidences);

  const inputSnapshot = {
    candidate_id: candidate.candidate_id,
    filter_version: FILTER_VERSION,
    scoring_version: SCORING_VERSION,
    listing_key: candidate.listing_key,
    marketplace: candidate.marketplace,
    category: candidate.category,
    observed_price: candidate.observed_price,
    observed_rating: candidate.observed_rating,
    observed_rating_count: candidate.observed_rating_count,
    observed_availability: candidate.observed_availability,
    evidence_count: evidences.length,
    evidence_digest: createHash("sha256")
      .update(JSON.stringify(evidences.map(e => ({ id: e.evidence_id, field: e.field_name, state: e.field_state, value: e.field_value, quality: e.quality, hash: e.evidence_hash }))))
      .digest("hex"),
    evaluated_at: new Date().toISOString(),
  };

  return {
    ok: true,
    dimensions,
    classification: classificationResult,
    recommendation: recommendationResult,
    priority: priorityResult,
    unknowns,
    contradictions,
    collectionFailures,
    evidenceRefs,
    inputSnapshot,
    candidate,
  };
}
