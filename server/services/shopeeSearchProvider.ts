import axios from "axios";
import * as cheerio from "cheerio";

export interface ShopeeSearchCandidate {
  url: string;
  shopId: string;
  itemId: string;
  rawTitle: string;
}

/**
 * Provedor de busca via DuckDuckGo HTML (sem JS).
 * Fonte de descoberta N2 para candidatos Shopee.
 */
export async function searchShopeeProductsDDG(keyword: string, limit: number = 20): Promise<ShopeeSearchCandidate[]> {
  const query = `site:shopee.com.br/product ${keyword}`;
  const url = "https://duckduckgo.com/lite/";
  
  try {
    const response = await axios.get(url, {
      params: { q: query },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (response.status !== 200 && response.status !== 202) {
      console.error(`[DDG Search] Erro HTTP: ${response.status}`);
      return [];
    }

    const $ = cheerio.load(response.data);
    const candidates: ShopeeSearchCandidate[] = [];

    // DuckDuckGo Lite usa a classe 'result-link' para os links de resultados
    // Mas também pode estar em seletores genéricos se o layout mudar
    const linkSelectors = [".result-link", "a.result-link", ".links_main a", ".result__a"];

    linkSelectors.forEach(selector => {
      $(selector).each((_, element) => {
        const href = $(element).attr("href");
        const title = $(element).text().trim();

        if (href) {
          // O DDG pode retornar URLs de redirecionamento ou diretas
          // Vamos tentar extrair a URL real da Shopee
          // Padrão 1: URL direta
          const shopeeMatch = href.match(/https:\/\/shopee\.com\.br\/product\/(\d+)\/(\d+)/);
          if (shopeeMatch) {
            candidates.push({
              url: `https://shopee.com.br/product/${shopeeMatch[1]}/${shopeeMatch[2]}`,
              shopId: shopeeMatch[1],
              itemId: shopeeMatch[2],
              rawTitle: title
            });
          } else if (href.includes("shopee.com.br/product")) {
            // Padrão 2: URL com parâmetros ou formatada diferentemente
            const parts = href.split("shopee.com.br/product/")[1]?.split("/");
            if (parts && parts.length >= 2) {
              const shopId = parts[0].split("?")[0];
              const itemId = parts[1].split("?")[0];
              if (/^\d+$/.test(shopId) && /^\d+$/.test(itemId)) {
                candidates.push({
                  url: `https://shopee.com.br/product/${shopId}/${itemId}`,
                  shopId,
                  itemId,
                  rawTitle: title
                });
              }
            }
          }
        }
      });
    });

    // Deduplicação por shopId e itemId
    const uniqueCandidates = Array.from(
      new Map(candidates.map(c => [`${c.shopId}-${c.itemId}`, c])).values()
    );

    return uniqueCandidates.slice(0, limit);
  } catch (error) {
    console.error("[DDG Search] Ered ao buscar:", error instanceof Error ? error.message : error);
    return [];
  }
}
