// ============================================================================
// Bloco N14 — Commercial Brain (Commercial Brain de CANDIDATES) — CONTRATO V1
//
// PRINCÍPIO CENTRAL:
//   N13 = filtro de elegibilidade estrutural (PASS/FAIL/BLOCKED).
//   N14 = análise/score comercial dos candidatos (HIGH/MEDIUM/LOW/
//         INSUFFICIENT). NÃO decide publicação, aquisição nem
//         elegibilidade a afiliado.
//   N15 = governança/autorização (fora do escopo do N14).
//
//   N14 SÓ EXECUTA para candidato com assessment N13 válido:
//   filter_version = 'n13:curator_v1' E verdict = 'PASS'.
//   Qualquer outra condição → fail-closed: N14 NÃO calcula score,
//   NENHUM assessment N14 é criado, nenhum bypass (nem em testes).
//
//   score ≠ approval ≠ publication ≠ affiliate eligibility
//   score ≠ confidence: score = atratividade estimada pelos sinais;
//   coverage/confidence = completude e qualidade dos dados.
//
// DETERMINISMO: mesma entrada (candidate + sinais + snapshot comercial,
// versão do contrato e dos pesos) → mesmo score, mesma band, mesmo
// rationale, mesmo digest, mesma idempotency key. Sem horário na
// decisão, sem random, sem IA generativa, sem chamadas externas.
//
// FAIL-CLOSED: dúvida, ausência ou inconsistência → INSUFFICIENT ou
// erro governado. Nunca HIGH por fallback. Nunca UNKNOWN → 0.
//
// PROVENIÊNCIA: cada sinal comercial carrega value, status, source,
// observed_at e provenance. Sinal sem origem rastreável NUNCA é tratado
// como KNOWN confiável.
//
// SEPARAÇÃO DE EFEITOS: N14 NÃO cria/altera products, NÃO cria
// affiliate_links, NÃO chama N8/N15/N16, NÃO publica, NÃO cria jobs,
// NÃO dispara Telegram, NÃO executa qualquer efeito comercial.
// ============================================================================

/** Versão do contrato do Commercial Brain de candidates. */
export const COMMERCIAL_BRAIN_CONTRACT_VERSION = "commercial_brain_v1" as const;
/** Versão do conjunto de pesos (registry central e versionado). */
export const COMMERCIAL_BRAIN_WEIGHTS_VERSION = "cb_weights_v1" as const;
/** Namespace de filtro/persistência para o repo candidate_assessment. */
export const COMMERCIAL_BRAIN_FILTER_VERSION = "n14:commercial_brain_v1" as const;
/** Versão do registry de faixas de preço por categoria (price ranges). */
export const PRICE_RANGES_VERSION = "cb_price_ranges_v1" as const;
/** Registro explícito do status das faixas de preço: baseline determinístico
 * inicial, NÃO otimizado empiricamente. */
export const PRICE_RANGES_VERSION_NOTE =
  "commercial_brain_v1 price ranges are an initial deterministic baseline and are NOT empirically optimized." as const;
/** Provenance administrativa padrão do N14 (entrada manual/administrativa). */
export const COMMERCIAL_BRAIN_PROVENANCE = "n14:admin:manual" as const;
/**
 * Registro explícito do status dos pesos: baseline determinístico inicial,
 * NÃO otimizado empiricamente e NÃO representando peso econômico real.
 */
export const COMMERCIAL_BRAIN_WEIGHTS_NOTE =
  "commercial_brain_v1 weights are an initial deterministic baseline and are NOT empirically optimized." as const;

// ---------------------------------------------------------------------------
// Bandas comerciais (atratividade) — NÃO são aprovação.
// ---------------------------------------------------------------------------
export const COMMERCIAL_BANDS = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"] as const;
export type CommercialBand = (typeof COMMERCIAL_BANDS)[number];
export function isValidBand(value: unknown): value is CommercialBand {
  return typeof value === "string" && (COMMERCIAL_BANDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Status de um sinal individual (seguindo os estados do N3/N13).
// ---------------------------------------------------------------------------
export const SIGNAL_STATUSES = ["KNOWN", "UNKNOWN", "CONFLICT"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
export function isValidSignalStatus(value: unknown): value is SignalStatus {
  return typeof value === "string" && (SIGNAL_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Taxonomia de sinais comerciais (identificadores estáveis, prefixo s-).
// A. PRICE          preço atual comprovado + currency + observed_at.
// B. COMMISSION     comissão/percentual do provider afiliado, provenance.
// C. AVAILABILITY   IN_STOCK/OUT_OF_STOCK/UNAVAILABLE/UNKNOWN (mesmo
//                   catálogo da tabela candidates).
// D. MARKET         proxies de mercado SOMENTE com evidência real e
//                   proveniente (ex.: review_count comprovado,
//                   sales_report de API oficial). Sem evidência → UNKNOWN.
// E. SELLER         rating do vendedor e status, com provenance.
// F. COMPETITION    somente com evidência real e proveniente; senão UNKNOWN.
// G. RISK           camada explícita de risco (missing data, provenance
//                   inválida, inconsistência, dados antigos, conflito).
// ---------------------------------------------------------------------------
export const SIGNAL_CATEGORIES = [
  "price",
  "commission",
  "availability",
  "market",
  "seller",
  "competition",
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];
export function isValidSignalCategory(value: unknown): value is SignalCategory {
  return typeof value === "string" && (SIGNAL_CATEGORIES as readonly string[]).includes(value);
}

export const CURRENCIES = ["BRL", "USD", "EUR", "UNKNOWN"] as const;
export type SignalCurrency = (typeof CURRENCIES)[number];
export function isValidCurrency(value: unknown): value is SignalCurrency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** Sinal comercial com proveniência completa. */
export interface CommercialSignal {
  category: SignalCategory;
  /** Valor normalizado (ou null quando UNKNOWN). */
  value: number | null;
  /** Contagem de reviews associada (seller/market). */
  reviewCount?: number | null;
  status: SignalStatus;
  /** Fonte legível (ex.: "candidate:observed_price", "evidence:evd-...", "affiliate:shopee", "admin:manual"). */
  source: string;
  /** UTC ISO 8601 da observação. */
  observedAt?: string | null;
  /** Provenance rastreável (ex.: "n14:affiliate:shopee", "n10:telegram:url"). */
  // NOTE: exemplos de provenance são strings literais de documentação; a
  // verificação estática de isolamento (testes N14) considera apenas linhas
  // de import/require — comentários JSDoc não contam como efeito comercial.
  provenance?: string | null;
  currency?: SignalCurrency;
  /** Descrição canônica usada no rationale. */
  note?: string;
  /** Faixa de preço plausível da categoria (apenas price; min/max). NUNCA
   *  inventada: ausente → normalização absoluta e rationale registra
   *  `price_range:unknown`. */
  priceRange?: { min: number; max: number } | null;
}

/** Sinais de ENTRADA aceitos na avaliação (podem faltar → ausente, nunca UNKNOWN→0). */
export interface CommercialSignalsInput {
  price?: Omit<CommercialSignal, "category"> | null;
  commission?: Omit<CommercialSignal, "category"> | null;
  availability?: Omit<CommercialSignal, "category"> | null;
  market?: Omit<CommercialSignal, "category"> | null;
  seller?: Omit<CommercialSignal, "category"> | null;
  competition?: Omit<CommercialSignal, "category"> | null;
}

// ---------------------------------------------------------------------------
// Decisão comercial (saída do motor).
// ---------------------------------------------------------------------------
export interface CommercialDecision {
  contractVersion: typeof COMMERCIAL_BRAIN_CONTRACT_VERSION;
  weightsVersion: typeof COMMERCIAL_BRAIN_WEIGHTS_VERSION;
  candidateId: string;
  /** Score determinístico 0.0000-1.0000 (NaN/nulo quando INSUFFICIENT). */
  score: number | null;
  /** Completude: fração de dimensões avaliáveis em relação ao total. */
  coverage: number;
  band: CommercialBand;
  /** Confiança na completude/qualidade dos dados (não é o score). */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Marca explicita se houve conflito de sinais. */
  conflict: boolean;
  conflictDimensions: ReadonlyArray<string>;
  /** Dimensões que entraram no score. */
  dimensionsUsed: ReadonlyArray<string>;
  /** Dimensões não avaliáveis (UNKNOWN/ausentes/inválidas). */
  dimensionsUnknown: ReadonlyArray<string>;
  /** Penalização de risco aplicada (multiplicador 0-1) e seus motivos. */
  riskPenalty: number;
  riskFactors: ReadonlyArray<string>;
  /** Rationale canônico, determinístico (concatenação estável). */
  rationale: string;
  digest: string;
  idempotencyKey: string;
  /** only informational; never in digest. */
  evaluatedAt: string;
}

export const ASSESSMENT_OUTCOMES = ["evaluated", "identical_duplicate"] as const;
export type CommercialAssessmentOutcome = (typeof ASSESSMENT_OUTCOMES)[number];

export interface CommercialServiceResult {
  ok: boolean;
  outcome: CommercialAssessmentOutcome | string;
  decision?: CommercialDecision | null;
  error?: string;
  /** Motivos governados de recusa de execução (ex.: n13 gate reprovado). */
  gateReason?: string;
}

/** Faixa válida do score (inclusive nas pontas). */
export const SCORE_MIN = 0;
export const SCORE_MAX = 1;
/** Cobertura mínima (fração de dimensões KNOWN) para aceitar um score. */
export const MIN_DIMENSIONS_KNOWN = 2;
/** Penalização máxima de risco (multiplicador não pode cair abaixo). */
export const MAX_RISK_PENALTY_MULTIPLIER = 0.5;
/** Bandas: limiar superior e inferior (score normalizado após penalty). */
export const BAND_HIGH_MIN = 0.75;
export const BAND_LOW_MAX = 0.4;

// ---------------------------------------------------------------------------
// Requisitos do gate N13 (obrigatório para executar).
// ---------------------------------------------------------------------------
export const N13_REQUIRED_FILTER_VERSION = "n13:curator_v1" as const;
export const N13_REQUIRED_VERDICT = "PASS" as const;
/** Prefixo canônico de candidate_id (N1). */
export const CANDIDATE_ID_PATTERN = /^can-[A-Za-z0-9]{24,32}$/;
