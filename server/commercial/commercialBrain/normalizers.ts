// ============================================================================
// Bloco N14 — Normalizadores puros de sinais comerciais.
//
// GOVERNANÇA:
// - FUNÇÕES PURAS: sem scraping, sem chamadas externas, sem efeitos
//   colaterais, sem horário.
// - Validação: tipo, faixa, currency, origem.
// - UNKNOWN é PRESERVADO: nunca convertido em 0 nem em score neutro.
// - Valores impossíveis → sinal rejeitado (UNKNOWN com reason).
// - Sem IA generativa: normalização 100% determinística.
// ============================================================================
import {
  CURRENCIES,
  SIGNAL_STATUSES,
  type CommercialSignal,
  type SignalStatus,
} from "./contract";
import type { CommercialSignalsInput } from "./contract";

/** Faixa de preço plausível por categoria (min, max). Definida no engine
 *  como PriceRangeBounds — este arquivo apenas referencia o shape. */
export interface PriceRangeBounds {
  min: number;
  max: number;
}

/** Domínio normalizado de price: 0-20.000.000 (faixa plausível de produto de
 *  varejo afiliado; acima disso é rejeitado como impossível). */
export const PRICE_MIN = 0;
export const PRICE_MAX = 20_000_000;

/** Domínio normalizado de commission: 0-1 (fração do preço). */
export const COMMISSION_MIN = 0;
export const COMMISSION_MAX = 1;

/** Rating: 0-5 (mesmo domínio da tabela candidates). */
export const RATING_MIN = 0;
export const RATING_MAX = 5;

export interface NormalizedSignal {
  signal: CommercialSignal;
  normalizedValue: number | null; // null = UNKNOWN persistente
  /** Motivo canônico de rejeição quando o input é inválido. */
  rejectedReason: string | null;
}

function validateStatus(status: unknown): SignalStatus {
  return SIGNAL_STATUSES.includes(status as SignalStatus) ? (status as SignalStatus) : "UNKNOWN";
}

function nonEmptySource(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "UNKNOWN_SOURCE";
}

function provenanceValid(provenance: unknown): string | null {
  if (typeof provenance === "string" && provenance.trim().length > 0) {
    return provenance.trim();
  }
  return null;
}

function parseIsoUtc(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

function numberInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < min || value > max || Number.isNaN(value)) {
    return null;
  }
  return value;
}

/**
 * normalizePrice — preço atual comprovado.
 * UNKNOWN (valor ausente/inválido/negativo) permanece UNKNOWN.
 */
export interface NormalizedSignalWithPriceRange extends NormalizedSignal {
  /** Faixa de preço por categoria usada na normalização relativa (ou null
   *  quando a categoria não tem faixa registrada — a normalização volta
   *  a ser absoluta e o rationale registra `price_range:unknown`). */
  priceRange?: PriceRangeBounds | null;
}
export interface PriceInput {
  value?: number | null;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
  provenance?: unknown;
  currency?: unknown;
  /** Faixa de preço plausível da categoria (nunca inventada). */
  priceRange?: PriceRangeBounds | null;
}
export function normalizePrice(input: PriceInput): NormalizedSignalWithPriceRange {
  const value = typeof input.value === "number" ? input.value : null;
  const numberOk = numberInRange(value, PRICE_MIN, PRICE_MAX);
  const status = validateStatus(input.status ?? (numberOk ? "KNOWN" : "UNKNOWN"));
  const source = nonEmptySource(input.source);
  const provenance = provenanceValid(input.provenance);
  const currency = CURRENCIES.includes(input.currency as (typeof CURRENCIES)[number])
    ? (input.currency as (typeof CURRENCIES)[number])
    : "UNKNOWN";
  // Faixa da categoria: só persiste se presente E válida (nunca inventada).
  const priceRange =
    input.priceRange !== undefined &&
    input.priceRange !== null &&
    typeof input.priceRange.min === "number" &&
    typeof input.priceRange.max === "number" &&
    Number.isFinite(input.priceRange.min) &&
    Number.isFinite(input.priceRange.max) &&
    input.priceRange.min < input.priceRange.max &&
    input.priceRange.min >= 0 &&
    input.priceRange.max <= PRICE_MAX
      ? { min: input.priceRange.min, max: input.priceRange.max }
      : null;
  if (numberOk === null && status === "KNOWN") {
    return {
      signal: {
        category: "price",
        value: null,
        status: "UNKNOWN",
        source,
        observedAt: parseIsoUtc(input.observedAt),
        provenance,
        currency,
        note: provenance === null ? "price_without_provenance" : "price_rejected_value",
      },
      priceRange,
      normalizedValue: null,
      rejectedReason:
        value === null || value === undefined ? "missing_price_value" : "price_value_out_of_range",
    };
  }
  const unknown = numberOk === null || provenance === null;
  return {
    signal: {
      category: "price",
      value: unknown ? null : numberOk,
      status: unknown ? "UNKNOWN" : status,
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      currency,
      note:
        unknown
          ? provenance === null
            ? "price_without_provenance"
            : "price_unknown_value"
          : priceRange === null
            ? "price_known_price_range_unknown"
            : "price_known",
    },
    priceRange,
    normalizedValue: unknown ? null : numberOk,
    rejectedReason: unknown ? (provenance === null ? "price_without_provenance" : "price_value_rejected") : null,
  };
}

/**
 * normalizeCommission — fração de comissão do provider afiliado, com
 * provenance obrigatória do provider (ex.: "n14:affiliate:shopee").
 * commission UNKNOWN NÃO significa comissão = 0.
 */
export function normalizeCommission(input: {
  value?: number | null;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
  provenance?: unknown;
}): NormalizedSignal {
  const value = typeof input.value === "number" ? input.value : null;
  const numberOk = numberInRange(value, COMMISSION_MIN, COMMISSION_MAX);
  const status = validateStatus(input.status ?? (numberOk ? "KNOWN" : "UNKNOWN"));
  const source = nonEmptySource(input.source);
  const provenance = provenanceValid(input.provenance);
  if (numberOk === null && status === "KNOWN") {
    return {
      signal: {
        category: "commission",
        value: null,
        status: "UNKNOWN",
        source,
        observedAt: parseIsoUtc(input.observedAt),
        provenance,
        note: provenance === null ? "commission_without_provenance" : "commission_rejected_value",
      },
      normalizedValue: null,
      rejectedReason:
        value === null || value === undefined ? "missing_commission_value" : "commission_value_out_of_range",
    };
  }
  const unknown = numberOk === null || provenance === null;
  return {
    signal: {
      category: "commission",
      value: unknown ? null : numberOk,
      status: unknown ? "UNKNOWN" : status,
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      note: unknown ? "commission_unknown_value" : "commission_known",
    },
    normalizedValue: unknown ? null : numberOk,
    rejectedReason: unknown ? "commission_unknown" : null,
  };
}

/**
 * normalizeAvailability — IN_STOCK/OUT_OF_STOCK/UNAVAILABLE/UNKNOWN.
 * KNOWN IN_STOCK → 1.0 ; KNOWN OUT_OF_STOCK → 0.0 ; UNAVAILABLE/UNKNOWN → null.
 */
export function normalizeAvailability(input: {
  value?: unknown;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
  provenance?: unknown;
}): NormalizedSignal {
  const AVAILABILITY_VALUES = ["IN_STOCK", "OUT_OF_STOCK", "UNAVAILABLE", "UNKNOWN"] as const;
  let value: string;
  if (typeof input.value === "string") {
    value = input.value.trim();
  } else if (typeof input.value === "number") {
    // Valor já normalizado (IN_STOCK=1, OUT_OF_STOCK=0) recebido por
    // derivadores internos — traduzir de volta ao estado canônico.
    value = input.value === 1 ? "IN_STOCK" : input.value === 0 ? "OUT_OF_STOCK" : "";
  } else {
    value = "";
  }
  const statusRaw = input.status ?? (AVAILABILITY_VALUES.includes(value as (typeof AVAILABILITY_VALUES)[number]) ? "KNOWN" : "UNKNOWN");
  const status = validateStatus(statusRaw);
  const source = nonEmptySource(input.source);
  const provenance = provenanceValid(input.provenance);
  const valueValid = AVAILABILITY_VALUES.includes(value as (typeof AVAILABILITY_VALUES)[number]);
  const valueNormalized = valueValid && status === "KNOWN" ? (value === "IN_STOCK" ? 1 : value === "OUT_OF_STOCK" ? 0 : null) : null;
  const unknown = !valueValid || valueNormalized === null || provenance === null;
  return {
    signal: {
      category: "availability",
      value: unknown ? null : valueNormalized,
      status: unknown ? "UNKNOWN" : status,
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      note: unknown ? "availability_unknown" : value === "IN_STOCK" ? "availability_in_stock" : "availability_out_of_stock",
    },
    normalizedValue: unknown ? null : valueNormalized,
    rejectedReason: unknown ? (!valueValid ? "availability_value_rejected" : provenance === null ? "availability_without_provenance" : "availability_unknown") : null,
  };
}

/**
 * normalizeRating — reputação do vendedor/produto: 0-5 comprovados.
 * UNKNOWN ≠ 0: seller sem evidência permanece UNKNOWN.
 */
export function normalizeRating(input: {
  value?: number | null;
  reviewCount?: number | null;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
  provenance?: unknown;
}): NormalizedSignal {
  const value = typeof input.value === "number" ? input.value : null;
  const count = typeof input.reviewCount === "number" && Number.isFinite(input.reviewCount) && input.reviewCount >= 0 ? Math.floor(input.reviewCount) : null;
  const numberOk = numberInRange(value, RATING_MIN, RATING_MAX);
  const status = validateStatus(input.status ?? (numberOk !== null ? "KNOWN" : "UNKNOWN"));
  const source = nonEmptySource(input.source);
  const provenance = provenanceValid(input.provenance);
  const unknown = numberOk === null || provenance === null;
  return {
    signal: {
      category: "seller",
      value: unknown ? null : numberOk,
      status: unknown ? "UNKNOWN" : status,
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      note: unknown
        ? "seller_rating_unknown"
        : count === null
          ? "seller_rating_no_review_count"
          : "seller_rating_known",
    },
    normalizedValue: unknown ? null : numberOk,
    rejectedReason: unknown ? (numberOk === null ? "seller_rating_value_rejected" : "seller_rating_without_provenance") : null,
  };
}

/**
 * normalizeMarketSignal — proxies de mercado SOMENTE com evidência real.
 * Aqui normalizamos proxies permitidos: review_count/sales comprovados.
 * Sem evidência → UNKNOWN. Nunca inferir demanda de visualização/ranking.
 */
export function normalizeMarketSignal(input: {
  /** Evidência real e proveniente: ex. review_count comprovado. */
  value?: number | null;
  /** Provenance da evidência de mercado (ex.: "n14:evidence:field:KNOWN"). */
  provenance?: unknown;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
}): NormalizedSignal {
  const value = typeof input.value === "number" ? input.value : null;
  const numberOk = value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  const provenance = provenanceValid(input.provenance);
  const source = nonEmptySource(input.source);
  const unknown = numberOk === null || provenance === null;
  return {
    signal: {
      category: "market",
      value: unknown ? null : numberOk,
      status: unknown ? "UNKNOWN" : (validateStatus(input.status) === "KNOWN" ? "KNOWN" : "UNKNOWN"),
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      note: unknown ? "market_unknown" : "market_evidence_known",
    },
    normalizedValue: unknown ? null : numberOk,
    rejectedReason: unknown ? (numberOk === null ? "market_value_rejected" : "market_without_provenance") : null,
  };
}

/**
 * normalizeCompetition — somente com evidência real e proveniente.
 * Caso contrário UNKNOWN (dimensão excluída do score sem penalizar).
 */
export function normalizeCompetition(input: {
  value?: number | null;
  provenance?: unknown;
  status?: unknown;
  source?: unknown;
  observedAt?: unknown;
}): NormalizedSignal {
  const value = typeof input.value === "number" ? input.value : null;
  const numberOk = value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  const provenance = provenanceValid(input.provenance);
  const source = nonEmptySource(input.source);
  const unknown = numberOk === null || provenance === null;
  return {
    signal: {
      category: "competition",
      value: unknown ? null : numberOk,
      status: unknown ? "UNKNOWN" : "KNOWN",
      source,
      observedAt: parseIsoUtc(input.observedAt),
      provenance,
      note: unknown ? "competition_unknown" : "competition_evidence_known",
    },
    normalizedValue: unknown ? null : numberOk,
    rejectedReason: unknown ? (numberOk === null ? "competition_value_rejected" : "competition_without_provenance") : null,
  };
}

/**
 * Normaliza um pacote de entrada completo. Sinais ausentes do pacote
 * permanecem desconhecidos (não são inferidos).
 */
export function normalizeSignalsInput(input: CommercialSignalsInput | null | undefined): {
  price: NormalizedSignal;
  commission: NormalizedSignal;
  availability: NormalizedSignal;
  seller: NormalizedSignal;
  market: NormalizedSignal;
  competition: NormalizedSignal;
} {
  const s = input ?? {};
  const priceInput = (s.price ?? {}) as PriceInput;
  return {
    price: normalizePrice(priceInput),
    commission: normalizeCommission(s.commission ?? {}),
    availability: normalizeAvailability(s.availability ?? {}),
    seller: normalizeRating(s.seller ?? {}),
    market: normalizeMarketSignal(s.market ?? {}),
    competition: normalizeCompetition(s.competition ?? {}),
  };
}
