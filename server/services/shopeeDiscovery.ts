
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Inicializa o cliente Gemini (reutilizando a lógica do projeto)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build"
    }
  }
});

export interface DiscoveredShopeeProduct {
  url: string;
  title?: string;
}

/**
 * Serviço de descoberta via Gemini Search Grounding.
 * Objetivo: Encontrar URLs reais de produtos Shopee para um termo de busca.
 * 
 * REGRAS DE GOVERNANÇA:
 * - O Gemini é usado APENAS para descoberta (N2 candidates).
 * - Nenhuma informação do Gemini é tratada como verdade canônica.
 * - As URLs encontradas DEVEM ser validadas pelo pipeline oficial.
 */
let testDiscoveryOverride: typeof discoverShopeeProducts | null = null;

export function setTestDiscoveryOverride(override: typeof discoverShopeeProducts | null): void {
  testDiscoveryOverride = override;
}

export async function discoverShopeeProducts(
  query: string,
  limit: number = 10
): Promise<{ success: boolean; products: DiscoveredShopeeProduct[]; error?: string }> {
  if (testDiscoveryOverride) {
    return testDiscoveryOverride(query, limit);
  }
  if (!process.env.GEMINI_API_KEY) {
    return { success: false, products: [], error: "GEMINI_API_KEY_MISSING" };
  }

  try {
    const prompt = `Encontre ${limit} links reais de produtos da Shopee Brasil (shopee.com.br) relacionados ao termo: "${query}".
Retorne apenas URLs válidas de produtos que sigam o padrão https://shopee.com.br/product/SHOP_ID/ITEM_ID ou https://shopee.com.br/NOME-DO-PRODUTO-i.SHOP_ID.ITEM_ID.
Não invente URLs. Retorne apenas resultados que você encontrar via busca real.`;

    const result = await ai.models.generateContent({
      model: "gemini-3.6-flash", // Atualizado para o modelo recomendado e testado com a nova chave
      contents: prompt,
      config: {
        systemInstruction: "Você é um assistente de descoberta de produtos. Sua tarefa é encontrar URLs reais de produtos na Shopee Brasil. Retorne os resultados em formato JSON.",
        // Habilitando Google Search Grounding
        tools: [{ googleSearchRetrieval: {} } as any],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            products: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  url: { type: Type.STRING },
                  title: { type: Type.STRING }
                },
                required: ["url"]
              }
            }
          },
          required: ["products"]
        }
      }
    });

    const text = result.text || "{\"products\":[]}";
    const data = JSON.parse(text);
    
    // Filtragem básica de segurança das URLs
    const validProducts = (data.products || [])
      .filter((p: any) => {
        const url = p.url || "";
        return url.includes("shopee.com.br") && (url.includes("/product/") || /i\.\d+\.\d+/.test(url));
      })
      .slice(0, limit);

    return {
      success: true,
      products: validProducts
    };
  } catch (err: any) {
    console.error("[Gemini Discovery Error]", err.message);
    return {
      success: false,
      products: [],
      error: err.message || "unknown_discovery_error"
    };
  }
}
