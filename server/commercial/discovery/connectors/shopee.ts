// ============================================================================
// Bloco N2 — Conector Shopee (READ-ONLY).
// Caminho autorizado: páginas públicas (sem Open Platform, sem credenciais,
// sem APIs pagas). Search limitado à página pública de resultados.
// A Shopee possui anti-bot agressivo; falhas são reportadas como UNKNOWN /
// indisponível, nunca inventadas. FAIL-CLOSED.
// ============================================================================

import { MarketplaceConnector, MarketplaceSource, MARKETPLACE_SOURCE, RawListing, DISCOVERY_LIMITS } from "../types";
import { validateDiscoveryUrl } from "../evidence";
import { fetchListingPage, fetchSearchResultPage } from "../fetchShared";

const SH_SOURCE: MarketplaceSource = MARKETPLACE_SOURCE.SHOPEE;

function buildSearchUrl(query: string): string {
  const q = encodeURIComponent(query.trim().slice(0, 120));
  return `https://shopee.com.br/search?keyword=${q}`;
}

export class ShopeeConnector implements MarketplaceConnector {
  readonly marketplace: MarketplaceSource = SH_SOURCE;

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

    const page = await fetchSearchResultPage(SH_SOURCE, searchUrl);
    if (!page.ok) {
      return { ok: false, reason: page.reason, listings: [] };
    }

    const links: string[] = [];
    // Padrão: /{loja}/{shopid}/{itemid} ou /produto/{shopid}/{itemid}
    const pattern = /https?:\/\/shopee\.com\.br\/[^\s"'<>]*?\/(\d+)\/(\d+)/g;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(page.html)) !== null && links.length < cap) {
      let candidate = match[0].replace(/[#?].*$/, "").replace(/\/$/, "");
      if (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
      if (!links.includes(candidate)) links.push(candidate);
    }

    const listings: RawListing[] = [];
    for (const link of links) {
      const validation = validateDiscoveryUrl(link, SH_SOURCE);
      if (!validation.ok) continue;
      const result = await fetchListingPage({ marketplace: SH_SOURCE, source_url: link });
      if (result.ok && result.listing) {
        listings.push(result.listing);
      }
      if (listings.length >= cap) break;
    }

    return { ok: listings.length > 0 || links.length > 0, reason: listings.length === 0 && links.length === 0 ? page.reason : undefined, listings };
  }

  async fetchListing(url: string): Promise<{ ok: boolean; reason?: string; listing: RawListing | null }> {
    const validation = validateDiscoveryUrl(url, SH_SOURCE);
    if (!validation.ok) {
      return { ok: false, reason: validation.reason ?? "invalid_url", listing: null };
    }
    return fetchListingPage({ marketplace: SH_SOURCE, source_url: validation.url });
  }
}

export const shopeeConnector = new ShopeeConnector();
