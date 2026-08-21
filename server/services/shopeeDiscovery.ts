import { GoogleGenAI, Type } from "@google/genai";
import * as dotenv from "dotenv";
import { searchShopeeProductsDDG, type ShopeeSearchCandidate } from "./shopeeSearchProvider";

dotenv.config();

let aiInstance: any = null;
function getAi() {
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || "",
    });
  }
  return aiInstance;
}

export function setTestAi(override: any): void {
  aiInstance = override;
}

export interface DiscoveredShopeeProduct {
  url: string;
  shopId: string;
  itemId: string;
  title: string;
}

export interface DiscoveryResult {
  success: boolean;
  products: DiscoveredShopeeProduct[];
  error?: string;
}

let discoveryOverride: ((query: string, limit: number) => Promise<DiscoveryResult>) | null = null;
export function setTestDiscoveryOverride(override: any): void {
  discoveryOverride = override;
}

let searchProviderOverride: ((query: string, limit: number) => Promise<ShopeeSearchCandidate[]>) | null = null;
export function setTestSearchProvider(override: any): void {
  searchProviderOverride = override;
}

/**
 * Orquestra a descoberta Shopee:
 * 1. Busca URLs reais via DuckDuckGo (Stage 1 & 2)
 * 2. Normaliza e seleciona via Gemini 3.6 Flash (Stage 3)
 */
export async function discoverShopeeProducts(
  query: string,
  limit: number = 10
): Promise<DiscoveryResult> {
  if (discoveryOverride) {
    return discoveryOverride(query, limit);
  }
  try {
    // 1. Descoberta de candidatos reais (Stage 1 & 2)
    const candidates = searchProviderOverride
      ? await searchProviderOverride(query, limit)
      : await searchShopeeProductsDDG(query, limit);

    if (candidates.length === 0) {
      return { success: true, products: [], error: "no_candidates_found_in_search" };
    }

    // 2. Normalização e Seleção via Gemini (Stage 3)
    const normalized = await rankAndNormalizeCandidates(candidates, query, limit);

    return {
      success: true,
      products: normalized
    };
  } catch (error: any) {
    console.error("[Shopee Discovery Error]", error);
    return {
      success: false,
      products: [],
      error: error.message
    };
  }
}

/**
 * Usa Gemini 3.6 Flash para normalizar títulos e selecionar candidatos.
 * GARANTIA ANTI-ALUCINAÇÃO: Valida que as URLs retornadas existem na entrada.
 */
async function rankAndNormalizeCandidates(
  candidates: ShopeeSearchCandidate[],
  query: string,
  limit: number
): Promise<DiscoveredShopeeProduct[]> {
  const ai = getAi();

  const prompt = `
    Você é um curador de ofertas. Selecione os ${limit} melhores produtos para o termo "${query}".

    REGRAS ESTRITAS:
    1. Use APENAS as URLs fornecidas na lista de candidatos.
    2. Retorne um JSON array de objetos: { "url": string, "normalizedTitle": string }.
    3. O título deve ser curto, chamativo e em Português.
    4. Não invente URLs.

    CANDIDATOS:
    ${JSON.stringify(candidates.map(c => ({ url: c.url, title: c.rawTitle })), null, 2)}
  `;

  try {
    // @ts-ignore - A tipagem do SDK v2.18.0 pode estar inconsistente no sandbox
    const result = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              url: { type: Type.STRING },
              normalizedTitle: { type: Type.STRING }
            },
            required: ["url", "normalizedTitle"]
          }
        }
      }
    });

    const responseText = result.text || "[]";
    const selected: any[] = JSON.parse(responseText);

    const finalProducts: DiscoveredShopeeProduct[] = [];
    const inputMap = new Map(candidates.map(c => [c.url, c]));

    for (const item of selected) {
      const original = inputMap.get(item.url);
      if (original) {
        finalProducts.push({
          url: original.url,
          shopId: original.shopId,
          itemId: original.itemId,
          title: item.normalizedTitle || original.rawTitle
        });
      } else {
        console.warn(`[Anti-Alucinação] Gemini inventou URL: ${item.url}`);
      }
    }

    // Fallback: se o Gemini não retornou nada válido, usa os brutos
    if (finalProducts.length === 0) {
      return candidates.slice(0, limit).map(c => ({
        url: c.url,
        shopId: c.shopId,
        itemId: c.itemId,
        title: c.rawTitle
      }));
    }

    return finalProducts;
  } catch (error) {
    console.error("[Gemini Normalization Error]", error);
    // Fallback para candidatos brutos em caso de erro no Gemini
    return candidates.slice(0, limit).map(c => ({
      url: c.url,
      shopId: c.shopId,
      itemId: c.itemId,
      title: c.rawTitle
    }));
  }
}
