import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";

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
      },
      timeout: 10000
    });

    const candidates: ShopeeSearchCandidate[] = [];

    // Se o DDG retornar um desafio (bot detection) ou status 202, tentamos o fallback Gemini
    const isBotChallenge = response.data && typeof response.data === 'string' && response.data.includes("anomaly-modal");
    
    if (response.status === 200 && !isBotChallenge) {
      const $ = cheerio.load(response.data);

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

    } else {
      console.warn(`[DDG Search] Bloqueio ou desafio detectado (Status: ${response.status}). Acionando fallback Gemini Grounding.`);
    }

    // Fallback: Gemini 3.6 Flash com Grounding se o DDG falhar ou não encontrar nada
    if (candidates.length === 0 && process.env.GEMINI_API_KEY) {
      try {
        const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const result = await (genAI as any).models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: `Encontre ${limit} links de produtos reais da Shopee Brasil para "${keyword}". Retorne apenas os links no formato https://shopee.com.br/product/SHOPID/ITEMID` }] }],
          tools: [{ googleSearchRetrieval: {} }]
        });
        
        const links = result.text.match(/https:\/\/shopee\.com\.br\/product\/\d+\/\d+/g) || [];
        for (const link of links) {
          const parts = link.split("/");
          const shopId = parts[4];
          const itemId = parts[5];
          if (shopId && itemId) {
            candidates.push({
              url: `https://shopee.com.br/product/${shopId}/${itemId}`,
              shopId,
              itemId,
              rawTitle: keyword // Título temporário, será normalizado pelo orquestrador
            });
          }
        }
        console.log(`[Gemini Discovery] Encontrados ${links.length} candidatos via Grounding.`);
      } catch (geminiError: any) {
        console.error("[Gemini Discovery Fallback Error]", geminiError.message);
      }
    }

    // Deduplicação por shopId e itemId
    const uniqueCandidates = Array.from(
      new Map(candidates.map(c => [`${c.shopId}-${c.itemId}`, c])).values()
    );

    return uniqueCandidates.slice(0, limit);
  } catch (error: any) {
    console.error("[DDG Search Error]", error.message);
    
    // Fallback em caso de erro de rede/timeout do DDG
    if (process.env.GEMINI_API_KEY) {
      try {
        const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const result = await (genAI as any).models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: `Encontre ${limit} links de produtos reais da Shopee Brasil para "${keyword}". Retorne apenas os links no formato https://shopee.com.br/product/SHOPID/ITEMID` }] }],
          tools: [{ googleSearchRetrieval: {} }]
        });
        
        const links = result.text.match(/https:\/\/shopee\.com\.br\/product\/\d+\/\d+/g) || [];
        const geminiCandidates: ShopeeSearchCandidate[] = [];
        for (const link of links) {
          const parts = link.split("/");
          const shopId = parts[4];
          const itemId = parts[5];
          if (shopId && itemId) {
            geminiCandidates.push({
              url: `https://shopee.com.br/product/${shopId}/${itemId}`,
              shopId,
              itemId,
              rawTitle: keyword
            });
          }
        }
        return geminiCandidates.slice(0, limit);
      } catch (geminiError) {
        console.error("[Gemini Discovery Fallback Critical Error]", geminiError);
      }
    }
    return [];
  }
}
