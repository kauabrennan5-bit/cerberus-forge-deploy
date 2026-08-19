// ============================================================================
// Bloco N14 — Registry versionado de faixas de preço plausíveis por
// categoria do varejo BR.
//
// GOVERNANÇA:
// - NENHUM número mágico espalhado pelo motor: a normalização relativa
//   do preço usa SOMENTE este registry.
// - Faixas são BASELINE determinístico inicial (referência de mercado
//   aproximada do e-commerce BR): NÃO são otimizadas empiricamente e
//   não representam o limite econômico real (ver
//   PRICE_RANGES_VERSION_NOTE).
// - O registry NUNCA inventa faixa: uma categoria sem entrada registrada
//   resulta em priceRange=null e o preço volta à normalização
//   ABSOLUTA (0-20.000.000), praticamente insensível — o rationale
//   registra `price_range:unknown` para auditoria (ver engine).
// - Versionamento: mudança de faixa gera NOVA versão (cb_price_ranges_v2)
//   com o registry anterior preservado; o digest carrega a versão para
//   garantir replay idempotente com a MESMA versão.
// - Lookup por categoria é case-insensível, com normalização por
//   keyword: "Eletrônicos"/"eletronicos"/"Eletronicos" → entry única.
// ============================================================================
import { PRICE_RANGES_VERSION_NOTE, PRICE_RANGES_VERSION } from "./contract";

export interface PriceRangeEntry {
  min: number;
  max: number;
  /** Keywords normalizadas (lowercase sem acentos) que apontam a entry. */
  keywords: ReadonlyArray<string>;
}

export interface PriceRangesRegistry {
  version: typeof PRICE_RANGES_VERSION;
  note: typeof PRICE_RANGES_VERSION_NOTE;
  ranges: ReadonlyArray<PriceRangeEntry>;
}

/** Registry v1 — faixas plausíveis do varejo BR (referência de mercado). */
export const PRICE_RANGES_V1: PriceRangesRegistry = {
  version: PRICE_RANGES_VERSION,
  note: PRICE_RANGES_VERSION_NOTE,
  ranges: [
    { min: 9.9, max: 499, keywords: ["casa e decoracao", "casa", "decoracao"] },
    { min: 19.9, max: 2_999, keywords: ["eletronicos", "eletrônicos", "eletronicos e informatica", "eletrônicos e informática"] },
    { min: 49.9, max: 5_999, keywords: ["informatica", "informática", "computadores"] },
    { min: 9.9, max: 599, keywords: ["esportes e lazer", "esportes", "lazer"] },
    { min: 29.9, max: 1_499, keywords: ["beleza e saude", "beleza", "saude", "saúde"] },
    { min: 29.9, max: 1_299, keywords: ["brinquedos", "infantil", "bebes", "bebês"] },
    { min: 39.9, max: 2_499, keywords: ["moda", "roupas", "acessorios", "acessórios", "calçados", "calcados"] },
    { min: 29.9, max: 999, keywords: ["livros", "livros e mídia", "midia", "mídia", "musicas", "músicas", "filmes"] },
    { min: 9.9, max: 799, keywords: ["supermercado", "mercado", "alimentos", "bebidas"] },
    { min: 19.9, max: 1_999, keywords: ["ferramentas", "jardim", "construção", "construcao", "automotivo"] },
  ],
} as const;

export const PRICE_RANGES_REGISTRY: ReadonlyArray<PriceRangesRegistry> = [
  PRICE_RANGES_V1,
] as const;

let activeRanges: PriceRangesRegistry = PRICE_RANGES_V1;

export function getPriceRanges(): PriceRangesRegistry {
  return activeRanges;
}

/** Apenas para testes governados: trocar o registry ativo. */
export function setPriceRangesForTests(next: PriceRangesRegistry): void {
  activeRanges = next;
}

export function resetPriceRangesForTests(): void {
  activeRanges = PRICE_RANGES_V1;
}

/** Normaliza uma string de categoria para lowercase sem acentos. */
export function normalizeCategoryKey(category: string): string {
  return category
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Busca determinística: retorna a entry da categoria ou null
 * (sem inventar faixa). */
export function lookupPriceRange(category: string | null | undefined): PriceRangeEntry | null {
  if (typeof category !== "string" || category.trim().length === 0) {
    return null;
  }
  const key = normalizeCategoryKey(category);
  if (key.length === 0) return null;
  for (const entry of activeRanges.ranges) {
    for (const kw of entry.keywords) {
      if (kw === key) return entry;
    }
  }
  return null;
}

export function validatePriceRangesRegistry(registry: PriceRangesRegistry): string | null {
  if (registry.ranges.length === 0) return "ranges_empty";
  for (const entry of registry.ranges) {
    if (!Number.isFinite(entry.min) || !Number.isFinite(entry.max)) return "invalid_range_bounds";
    if (entry.min < 0 || entry.max <= entry.min || entry.max > 20_000_000) {
      return "invalid_range_bounds";
    }
    if (entry.keywords.length === 0) return "missing_range_keywords";
  }
  return null;
}
