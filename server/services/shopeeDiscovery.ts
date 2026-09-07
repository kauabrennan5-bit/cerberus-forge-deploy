import {
  searchShopeeProductsDDG,
  type ShopeeSearchCandidate,
  type ShopeeSearchResult,
  type ShopeeSearchState,
} from "./shopeeSearchProvider";

export interface DiscoveredShopeeProduct {
  /** URL observada no resultado web; nunca é o link final/canônico. */
  url: string;
  /** Identidade candidata; exige confirmação exata pela Affiliate API. */
  shopId: string;
  itemId: string;
  /** Título de descoberta; nunca substitui o título oficial. */
  title: string;
  source: "ddg_candidate";
}

export interface DiscoveryResult {
  success: boolean;
  state: ShopeeSearchState;
  provider: "duckduckgo";
  products: DiscoveredShopeeProduct[];
  error?: Exclude<ShopeeSearchState, "DDG_OK">;
}

type DiscoveryOverride = (query: string, limit: number) => Promise<DiscoveryResult>;
type SearchProviderOverride = (query: string, limit: number) => Promise<ShopeeSearchResult>;

let discoveryOverride: DiscoveryOverride | null = null;
let searchProviderOverride: SearchProviderOverride | null = null;

export function setTestDiscoveryOverride(override: DiscoveryOverride | null): void {
  discoveryOverride = override;
}

export function setTestSearchProvider(override: SearchProviderOverride | null): void {
  searchProviderOverride = override;
}

/**
 * Orquestra somente a descoberta web. Nenhum dado retornado aqui é canônico:
 * o consumidor precisa confirmar cada shopId/itemId na Shopee Affiliate API.
 */
export async function discoverShopeeProducts(
  query: string,
  limit: number = 10,
): Promise<DiscoveryResult> {
  if (discoveryOverride) return discoveryOverride(query, limit);

  const search = searchProviderOverride
    ? await searchProviderOverride(query, limit)
    : await searchShopeeProductsDDG(query, limit);

  if (search.state !== "DDG_OK") {
    return {
      success: false,
      state: search.state,
      provider: "duckduckgo",
      products: [],
      error: search.state,
    };
  }

  const products = search.candidates.slice(0, limit).map((candidate: ShopeeSearchCandidate) => ({
    url: candidate.url,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    title: candidate.rawTitle,
    source: "ddg_candidate" as const,
  }));

  return {
    success: true,
    state: "DDG_OK",
    provider: "duckduckgo",
    products,
  };
}
