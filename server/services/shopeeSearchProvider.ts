import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";

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
          const identity = extractShopeeIdentity(href);
          if (identity.shopId && identity.itemId) {
            candidates.push({
              url: `https://shopee.com.br/product/${identity.shopId}/${identity.itemId}`,
              shopId: identity.shopId,
              itemId: identity.itemId,
              rawTitle: title
            });
          }
        }
      });
    });

    } else {
      const reason = isBotChallenge ? "ddg_bot_challenge" : `ddg_http_${response.status}`;
      console.warn(`[DDG Search] Bloqueio ou desafio detectado: ${reason}. Acionando fallback Gemini Grounding.`);
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
          const identity = extractShopeeIdentity(link);
          if (identity.shopId && identity.itemId) {
            candidates.push({
              url: `https://shopee.com.br/product/${identity.shopId}/${identity.itemId}`,
              shopId: identity.shopId,
              itemId: identity.itemId,
              rawTitle: keyword // Título temporário, será normalizado pelo orquestrador
            });
          }
        }
        console.log(`[Gemini Discovery] Encontrados ${links.length} candidatos via Grounding.`);
      } catch (geminiError: any) {
        const isQuota = geminiError.message?.includes("429") || geminiError.message?.includes("RESOURCE_EXHAUSTED");
        const reason = isQuota ? "gemini_quota_exceeded" : "gemini_error";
        console.error(`[Gemini Discovery Fallback Error] ${reason}:`, geminiError.message);
        // Se ambos falharam, lançamos erro com o motivo para o orquestrador
        if (candidates.length === 0) {
          throw new Error(reason);
        }
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
          const identity = extractShopeeIdentity(link);
          if (identity.shopId && identity.itemId) {
            geminiCandidates.push({
              url: `https://shopee.com.br/product/${identity.shopId}/${identity.itemId}`,
              shopId: identity.shopId,
              itemId: identity.itemId,
              rawTitle: keyword
            });
          }
        }
        return geminiCandidates.slice(0, limit);
      } catch (geminiError: any) {
        const isQuota = geminiError.message?.includes("429") || geminiError.message?.includes("RESOURCE_EXHAUSTED");
        const reason = isQuota ? "gemini_quota_exceeded" : "gemini_error";
        console.error(`[Gemini Discovery Fallback Critical Error] ${reason}:`, geminiError.message);
        throw new Error(reason);
      }
    }
    throw error;
  }
}
