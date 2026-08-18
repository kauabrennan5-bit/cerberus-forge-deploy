// ============================================================================
// Bloco N10 — Normalização única de Marketplace
// -----------------------------------------------------------------------------
// O projeto possui divergência histórica entre representações de marketplace:
//   - N2 canônico (UPPER):          "MERCADOLIVRE", "SHOPEE"
//   - N9 snake_case:                "mercadolivre", "shopee"
//   - N1 human:                     "Mercado Livre", "Shopee"
//   - N8:                           "MercadoLivre", "Shopee"
//
// Este módulo é o ÚNICO ponto de tradução do N10. Ele aceita os dialetos
// conhecidos e retorna o MarketplaceSource canônico exigido pelo N2.
//
// REGRA: valores de marketplace desconhecidos FALHAM FECHADO (null + reason),
// nunca retornam um palpite e nunca alteram silenciosamente os contratos
// internos do N2 — o adapter do N10 traduz antes de chamar o N2.
// ============================================================================
import { MarketplaceSource, isMarketplaceSource } from "../discovery/types";

export interface NormalizedMarketplace {
  readonly ok: boolean;
  readonly marketplace: MarketplaceSource | null;
  readonly reason: string | null;
}

// Tabela única de dialetos aceitos → canônico UPPER (N2).
const DIALECT_TO_CANONICAL: ReadonlyArray<{ dialect: string; canonical: MarketplaceSource }> = [
  { dialect: "MERCADOLIVRE", canonical: "MERCADOLIVRE" },
  { dialect: "mercadolivre", canonical: "MERCADOLIVRE" },
  { dialect: "mercado livre", canonical: "MERCADOLIVRE" },
  { dialect: "Mercado Livre", canonical: "MERCADOLIVRE" },
  { dialect: "MercadoLivre", canonical: "MERCADOLIVRE" },
  { dialect: "SHOPEE", canonical: "SHOPEE" },
  { dialect: "shopee", canonical: "SHOPEE" },
];

export function normalizeMarketplace(value: unknown): NormalizedMarketplace {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, marketplace: null, reason: "marketplace_ausente" };
  }
  const trimmed = value.trim();
  // Se já é o canônico do N2, aceita diretamente (autoridade N2 preservada).
  if (isMarketplaceSource(trimmed)) {
    return { ok: true, marketplace: trimmed as MarketplaceSource, reason: null };
  }
  const entry = DIALECT_TO_CANONICAL.find(e => e.dialect.toLowerCase() === trimmed.toLowerCase());
  if (!entry) {
    // Falha fechada: marketplace desconhecido NUNCA vira palpite.
    return { ok: false, marketplace: null, reason: "marketplace_desconhecido" };
  }
  return { ok: true, marketplace: entry.canonical, reason: null };
}
