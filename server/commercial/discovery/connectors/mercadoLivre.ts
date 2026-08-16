// ============================================================================
// Bloco N2 — Conector Mercado Livre (READ-ONLY).
// Caminho autorizado: páginas públicas (sem API oficial, sem credenciais,
// sem APIs pagas). Search limitado à página pública de resultados do ML BR.
// ============================================================================

import { MarketplaceConnector, MarketplaceSource, MARKETPLACE_SOURCE, RawListing, DISCOVERY_LIMITS } from "../types";
import { validateDiscoveryUrl } from "../evidence";
import { buildRawListing, fetchListingPage, fetchSearchResultPage } from "../fetchShared";

const ML_SOURCE: MarketplaceSource = MARKETPLACE_SOURCE.MERCADOLIVRE;

// Página pública de busca do Mercado Livre Brasil (HTML público).
// Sem autenticação; comportamento de bot limitado por rate-limit local.
function buildSearchUrl(query: string): string {
  const q = encodeURIComponent(query.trim().slice(0, 120));
  return `https://lista.mercadolivre.com.br/${q}`;
}

export class MercadoLivreConnector implements MarketplaceConnector {
  readonly marketplace: MarketplaceSource = ML_SOURCE;

  async search(params: { query: string; limit?: number }): Promise<{
    ok: boolean;
    reason?: string;
    listings: RawListing[];
  }> {
    if (!params.query || typeof params.query !== "string" || params.query.trim().length === 0) {
      return { ok: false, reason: "empty_query", listings: [] };
    }
    const searchUrl = buildSearchUrl(params.query);
    const limit = Math.min(Math.max(0, Math.floor(params.limit ?? 5)) || 0, DISCOVERY_LIMITS.MAX_RESULTS);
    const cap = limit > 0 ? limit : DISCOVERY_LIMITS.MAX_RESULTS;

    const page = await fetchSearchResultPage(ML_SOURCE, searchUrl);
    if (!page.ok) {
      return { ok: false, reason: page.reason, listings: [] };
    }

    // Links extraídos da página de resultados (regex ML limitada ao domínio
    // permitido); truncada no servidor em `cap`.
    const links: string[] = [];
    const pattern = /https?:\/\/(?:www\.)?mercadolivre\.com\.br\/[A-Za-z0-9._-]+(?:\/|$)[^\s"'<>]*ML[A-Z][-]?[\d]+/gi;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(page.html)) !== null && links.length < cap) {
      const candidate = match[0].replace(/[#?].*$/, "").replace(/\/$/, "");
      if (!links.includes(candidate)) links.push(candidate);
    }

    const listings: RawListing[] = [];
    for (const link of links) {
      const validation = validateDiscoveryUrl(link, ML_SOURCE);
      if (!validation.ok) continue;
      const result = await fetchListingPage({ marketplace: ML_SOURCE, source_url: link });
      if (result.ok && result.listing) {
        listings.push(result.listing);
      }
      if (listings.length >= cap) break;
    }

    return { ok: listings.length > 0 || links.length > 0, reason: listings.length === 0 && links.length === 0 ? page.reason : undefined, listings };
  }

  async fetchListing(url: string): Promise<{ ok: boolean; reason?: string; listing: RawListing | null }> {
    const validation = validateDiscoveryUrl(url, ML_SOURCE);
    if (!validation.ok) {
      return { ok: false, reason: validation.reason ?? "invalid_url", listing: null };
    }
    return fetchListingPage({ marketplace: ML_SOURCE, source_url: validation.url });
  }
}

export const mercadoLivreConnector = new MercadoLivreConnector();
