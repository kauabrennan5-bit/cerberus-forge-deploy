/**
 * 🛡️ CERBERUS FINDS — IDENTIDADE SHOPEE
 * 
 * Módulo centralizado para extração e normalização de shopId e itemId.
 * Segue o princípio Fail-Closed: se o formato for ambíguo, retorna null.
 */

export interface ShopeeIdentity {
  shopId: string | null;
  itemId: string | null;
}

/**
 * Extrai shopId e itemId de uma URL Shopee.
 * Suporta formatos:
 * - /product/{shopId}/{itemId}
 * - i.{shopId}.{itemId}
 * - /{loja}/{shopId}/{itemId}
 * - /{loja}/{slug}/{shopId}/{itemId}
 */
export function extractShopeeIdentity(url: string): ShopeeIdentity {
  if (!url) return { shopId: null, itemId: null };

  try {
    const cleanUrl = url.trim().replace(/[#?].*$/, "").replace(/\/$/, "");
    
    // Padrão 1: /product/{shopId}/{itemId}
    const p1 = cleanUrl.match(/\/product\/(\d+)\/(\d+)/i);
    if (p1) return { shopId: p1[1], itemId: p1[2] };

    // Padrão 2: i.{shopId}.{itemId} (comum em links de compartilhamento)
    const p2 = cleanUrl.match(/i\.(\d+)\.(\d+)/i);
    if (p2) return { shopId: p2[1], itemId: p2[2] };

    // Padrão 3: /{loja}/{shopId}/{itemId}
    const p3 = cleanUrl.match(/\/([^\/]+)\/(\d+)\/(\d+)$/i);
    if (p3) return { shopId: p3[2], itemId: p3[3] };

    // Padrão 4: /{loja}/{slug}/{shopId}/{itemId}
    const p4 = cleanUrl.match(/\/([^\/]+)\/([^\/]+)\/(\d+)\/(\d+)$/i);
    if (p4) return { shopId: p4[3], itemId: p4[4] };

    return { shopId: null, itemId: null };
  } catch {
    return { shopId: null, itemId: null };
  }
}

/**
 * Normaliza uma URL Shopee para o formato canônico:
 * https://shopee.com.br/product/{shopId}/{itemId}
 */
export function canonicalizeShopeeUrl(url: string): string | null {
  const identity = extractShopeeIdentity(url);
  if (identity.shopId && identity.itemId) {
    return `https://shopee.com.br/product/${identity.shopId}/${identity.itemId}`;
  }
  return null;
}
