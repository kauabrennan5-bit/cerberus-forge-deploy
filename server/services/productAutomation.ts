import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { Product } from "../../src/types";
import { generateSlug } from "../../src/data/initialProducts";
import * as productsRepository from "../repositories/productsRepository";
import { fetchProductDataFromUrl } from "./scraper";

dotenv.config();

// Initialize Gemini AI Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build"
    }
  }
});

export interface ProcessProductResult {
  success: boolean;
  action: "created" | "updated" | "unchanged" | "failed";
  product?: Product;
  oldPrice?: number;
  newPrice?: number;
  changedFields?: string[];
  reason?: string;
  marketplace?: string;
  normalizedUrl?: string;
}

// Map for active in-flight processing to ensure idempotency & prevent race conditions
const inFlightRequests = new Map<string, Promise<ProcessProductResult>>();

/**
 * Normaliza a URL do produto removendo parâmetros de tracking (utm_*, fbclid, etc)
 * mas PRESERVANDO parâmetros essenciais de afiliados e identificadores.
 */
export function normalizeProductUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  let urlStr = rawUrl.trim();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = "https://" + urlStr;
  }
  try {
    const parsed = new URL(urlStr);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "fbclid", "gclid", "ttclid", "spm", "_ga", "_gl", "x_src", "source_caller",
      "gbraid", "wbraid", "dclid", "msclkid"
    ];
    trackingParams.forEach((param) => parsed.searchParams.delete(param));

    parsed.hostname = parsed.hostname.toLowerCase();

    let cleanPath = parsed.pathname;
    if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
      cleanPath = cleanPath.slice(0, -1);
    }
    parsed.pathname = cleanPath;

    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Extrai um ID único do marketplace a partir da URL (ex: MLB-123456789 ou Shopee Item ID)
 */
export function extractMarketplaceId(url: string): string | null {
  if (!url) return null;

  // Mercado Livre: MLB-1234567890, MLB1234567890, MLA-12345678, etc.
  const mlMatch = url.match(/(ML[A-Z])[-]?(\d+)/i);
  if (mlMatch) {
    return `${mlMatch[1].toUpperCase()}${mlMatch[2]}`;
  }

  // Shopee: i.12345678.98765432 ou product/12345678/98765432
  const shopeeMatch1 = url.match(/i\.(\d+)\.(\d+)/i);
  if (shopeeMatch1) {
    return `shopee-${shopeeMatch1[1]}-${shopeeMatch1[2]}`;
  }
  const shopeeMatch2 = url.match(/product\/(\d+)\/(\d+)/i);
  if (shopeeMatch2) {
    return `shopee-${shopeeMatch2[1]}-${shopeeMatch2[2]}`;
  }

  return null;
}

/**
 * Detecta o marketplace pelo domínio ou URL
 */
export function detectMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("shopee.com.br") || hostname.includes("shope.ee")) return "Shopee";
    if (hostname.includes("mercadolivre.com.br") || hostname.includes("mercadolibre.com")) return "Mercado Livre";
    if (hostname.includes("amazon.com")) return "Amazon";
    if (hostname.includes("shein.com")) return "Shein";
    if (hostname.includes("aliexpress.com")) return "AliExpress";
    return "E-Commerce";
  } catch {
    if (url.includes("shopee") || url.includes("shope.ee")) return "Shopee";
    if (url.includes("mercadolivre") || url.includes("mercadolibre")) return "Mercado Livre";
    return "E-Commerce";
  }
}

/**
 * Procura um produto existente no repositório por URL, ID de marketplace, slug ou título
 */
export async function findExistingProduct(
  normalizedUrl: string,
  marketplaceId?: string | null,
  slug?: string | null,
  cleanedTitle?: string | null
): Promise<Product | null> {
  const products = await productsRepository.getProducts();
  if (!products || products.length === 0) return null;

  const normTarget = normalizeProductUrl(normalizedUrl);

  // 1. Busca por correspondência exata ou normalizada da URL
  const byUrl = products.find((p) => {
    if (!p.link) return false;
    if (normalizeProductUrl(p.link) === normTarget) return true;
    if (p.paginaPonteUrl && normalizeProductUrl(p.paginaPonteUrl) === normTarget) return true;
    return false;
  });
  if (byUrl) return byUrl;

  // 2. Busca por ID do Marketplace na URL cadastrada
  if (marketplaceId) {
    const byMktId = products.find((p) => {
      if (!p.link) return false;
      const extracted = extractMarketplaceId(p.link);
      return extracted && extracted === marketplaceId;
    });
    if (byMktId) return byMktId;
  }

  // 3. Busca por Slug
  if (slug) {
    const bySlug = products.find((p) => p.slug === slug || generateSlug(p.produto) === slug);
    if (bySlug) return bySlug;
  }

  // 4. Busca por combinação exata do título limpo
  if (cleanedTitle && cleanedTitle.trim().length > 5) {
    const targetTitleLower = cleanedTitle.trim().toLowerCase();
    const byTitle = products.find((p) => p.produto.trim().toLowerCase() === targetTitleLower);
    if (byTitle) return byTitle;
  }

  return null;
}

export interface ExtractedReviewData {
  normalizedUrl: string;
  marketplace: string;
  produto: string;
  categoria: string;
  preco: number | null;
  imagens: string[];
  descricao: string;
  existingProduct: Product | null;
}

/**
 * Extrai dados do produto (Scraper + Gemini) para revisão prévia no Telegram ou Admin
 * Sem criar diretamente no banco de dados.
 */
export async function extractProductForReview(rawUrl: string, rawTextOverride?: string): Promise<{
  success: boolean;
  data?: ExtractedReviewData;
  error?: string;
}> {
  const normalizedUrl = normalizeProductUrl(rawUrl);
  if (!normalizedUrl && !rawTextOverride) {
    return { success: false, error: "URL ou texto de produto inválido." };
  }

  try {
    const marketplace = detectMarketplace(normalizedUrl);
    const scraped = await fetchProductDataFromUrl(normalizedUrl, rawTextOverride);
    const scrapedTitle = scraped.title;
    const scrapedPrice = scraped.price;
    const scrapedImages = scraped.images;
    const rawContent = scraped.rawContent;

    let curatedTitle = scrapedTitle || "Produto Cerberus";
    let curatedDescription = "";
    let curatedCategory = inferCategoryFromTitle(curatedTitle);

    if (process.env.GEMINI_API_KEY) {
      try {
        const prompt = `DADOS EXTRAÍDOS DO SCRAPER:
- Título Bruto: "${scrapedTitle || 'Extrair do texto abaixo'}"
- Preço Real Detectado: ${scrapedPrice !== null ? `R$ ${scrapedPrice.toFixed(2)}` : 'NÃO ENCONTRADO'}
- Imagens Oficiais: ${scrapedImages.length}

CONTEÚDO DO ANÚNCIO:
"""
${rawContent.slice(0, 3000)}
"""

TAREFAS DO CURADOR:
1. "produto": Limpe e formate o título real em Português no estilo editorial e curatorial da marca Cerberus Finds. Remova jargões de marketplace como "PROMOÇÃO IMPERDÍVEL", "TOP SELLER", "ENVIO GRÁTIS", "FRETE GRÁTIS", "SHOPEE", "MERCADO LIVRE", "100% ORIGINAL", "OFERTA". (Exemplo: "Camiseta Heavy Cotton Oversized").
2. "descricao": Escreva uma descrição curta de no máximo 2 frases no tom cru, direto e curatorial da marca Cerberus (foco em tecido, corte, caimento e estética).
3. "categoria": Escolha EXATAMENTE uma das seguintes categorias: "Camisetas", "Calças", "Acessórios", "Calçados", "Jaquetas", "Moletons".`;

        const geminiRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: {
            systemInstruction: `Você é o assistente curador do Cerberus Finds Archive.
Sua função é APENAS formatar o nome do produto, escrever a descrição curatorial de 2 frases e sugerir a categoria.
NUNCA invente preços ou URLs.`,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                produto: { type: Type.STRING },
                descricao: { type: Type.STRING },
                categoria: { type: Type.STRING }
              },
              required: ["produto", "descricao", "categoria"]
            }
          }
        });

        const geminiText = geminiRes.text || "{}";
        const geminiJson = JSON.parse(geminiText);

        if (geminiJson.produto && geminiJson.produto.trim().length > 3) {
          curatedTitle = geminiJson.produto.trim();
        }
        if (geminiJson.descricao) {
          curatedDescription = geminiJson.descricao.trim();
        }
        if (geminiJson.categoria) {
          curatedCategory = geminiJson.categoria.trim();
        }
      } catch (geminiErr: any) {
        console.warn("[Product Review Extraction Warning] Gemini falhou, usando fallback:", geminiErr?.message);
      }
    }

    const mktId = extractMarketplaceId(normalizedUrl);
    const generatedSlug = generateSlug(curatedTitle);
    const existingProduct = await findExistingProduct(normalizedUrl, mktId, generatedSlug, curatedTitle);

    return {
      success: true,
      data: {
        normalizedUrl,
        marketplace,
        produto: curatedTitle,
        categoria: curatedCategory,
        preco: scrapedPrice,
        imagens: scrapedImages,
        descricao: curatedDescription,
        existingProduct
      }
    };
  } catch (err: any) {
    console.error("[Product Review Extraction Error]:", err);
    return {
      success: false,
      error: err?.message || "Falha ao extrair dados do produto."
    };
  }
}

/**
 * Infere a categoria com base em palavras-chave no título
 */
function inferCategoryFromTitle(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("calça") || t.includes("jeans") || t.includes("pant") || t.includes("bermuda") || t.includes("shorts")) return "Calças";
  if (t.includes("moletom") || t.includes("hoodie") || t.includes("blusão")) return "Moletons";
  if (t.includes("jaqueta") || t.includes("casaco") || t.includes("blazer") || t.includes("colete") || t.includes("parka")) return "Jaquetas";
  if (t.includes("tênis") || t.includes("sapato") || t.includes("bota") || t.includes("slipper") || t.includes("sandal") || t.includes("chinelo")) return "Calçados";
  if (t.includes("camiseta") || t.includes("t-shirt") || t.includes("regata") || t.includes("polo") || t.includes("shirt")) return "Camisetas";
  return "Acessórios";
}

/**
 * Executa o fluxo completo de automação: Scraper -> Gemini -> Validação -> Deduplicação -> Repository
 * Com controle de concorrência e idempotência.
 */
export async function processProductUrl(rawUrl: string, sourceInfo?: any): Promise<ProcessProductResult> {
  const normalizedUrl = normalizeProductUrl(rawUrl);
  if (!normalizedUrl) {
    return {
      success: false,
      action: "failed",
      reason: "URL de produto inválida ou não fornecida."
    };
  }

  // Se já houver um processamento em andamento para esta mesma URL, aguarda a promessa existente
  if (inFlightRequests.has(normalizedUrl)) {
    console.log(`[Product Automation] Reutilizando processamento em andamento para: ${normalizedUrl}`);
    return await inFlightRequests.get(normalizedUrl)!;
  }

  const processingPromise = (async (): Promise<ProcessProductResult> => {
    try {
      const marketplace = detectMarketplace(normalizedUrl);
      console.log(`[Product Automation] Iniciando automação para URL: ${normalizedUrl} (${marketplace})`);

      // 1. Executa o Scraper para extrair dados brutos
      const scraped = await fetchProductDataFromUrl(normalizedUrl);
      const scrapedTitle = scraped.title;
      const scrapedPrice = scraped.price;
      const scrapedImages = scraped.images;
      const rawContent = scraped.rawContent;

      // 2. Validação Estrita de Preço e Imagens
      if (scrapedPrice === null || scrapedPrice <= 0) {
        console.warn(`[Product Automation Error] Preço não foi identificado na URL: ${normalizedUrl}`);
        return {
          success: false,
          action: "failed",
          reason: "Não foi possível obter um preço válido no anúncio. Nenhum produto foi criado.",
          marketplace,
          normalizedUrl
        };
      }

      if (!scrapedImages || scrapedImages.length === 0) {
        console.warn(`[Product Automation Error] Nenhuma imagem encontrada na URL: ${normalizedUrl}`);
        return {
          success: false,
          action: "failed",
          reason: "Nenhuma imagem válida foi localizada no anúncio. Nenhum produto foi criado.",
          marketplace,
          normalizedUrl
        };
      }

      // 3. Curadoria via Gemini AI (limpeza de título, descrição e categoria)
      let curatedTitle = scrapedTitle || "Produto Cerberus";
      let curatedDescription = "";
      let curatedCategory = inferCategoryFromTitle(curatedTitle);

      if (process.env.GEMINI_API_KEY) {
        try {
          const prompt = `DADOS EXTRAÍDOS DO SCRAPER:
- Título Bruto: "${scrapedTitle || 'Extrair do texto abaixo'}"
- Preço Real Detectado: R$ ${scrapedPrice.toFixed(2)}
- Quantidade de Imagens Oficiais: ${scrapedImages.length}

CONTEÚDO DO ANÚNCIO:
"""
${rawContent.slice(0, 3000)}
"""

TAREFAS DO CURADOR:
1. "produto": Limpe e formate o título real em Português no estilo editorial e curatorial da marca Cerberus Finds. Remova jargões de marketplace como "PROMOÇÃO IMPERDÍVEL", "TOP SELLER", "ENVIO GRÁTIS", "FRETE GRÁTIS", "SHOPEE", "MERCADO LIVRE", "100% ORIGINAL", "OFERTA". (Exemplo: "Camiseta Heavy Cotton Oversized").
2. "descricao": Escreva uma descrição curta de no máximo 2 frases no tom cru, direto e curatorial da marca Cerberus (foco em tecido, corte, caimento e estética).
3. "categoria": Escolha EXATAMENTE uma das seguintes categorias: "Camisetas", "Calças", "Acessórios", "Calçados", "Jaquetas", "Moletons".`;

          const geminiRes = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              systemInstruction: `Você é o assistente curador do Cerberus Finds Archive.
Sua função é APENAS formatar o nome do produto, escrever a descrição curatorial de 2 frases e sugerir a categoria.
NUNCA invente preços ou URLs.`,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  produto: { type: Type.STRING },
                  descricao: { type: Type.STRING },
                  categoria: { type: Type.STRING }
                },
                required: ["produto", "descricao", "categoria"]
              }
            }
          });

          const geminiText = geminiRes.text || "{}";
          const geminiJson = JSON.parse(geminiText);

          if (geminiJson.produto && geminiJson.produto.trim().length > 3) {
            curatedTitle = geminiJson.produto.trim();
          }
          if (geminiJson.descricao) {
            curatedDescription = geminiJson.descricao.trim();
          }
          if (geminiJson.categoria) {
            curatedCategory = geminiJson.categoria.trim();
          }
        } catch (geminiErr: any) {
          console.warn("[Product Automation Warning] Gemini indisponível ou falhou, usando fallback curatorial:", geminiErr?.message);
        }
      }

      const mktId = extractMarketplaceId(normalizedUrl);
      const generatedSlug = generateSlug(curatedTitle);

      // 4. Verificação de Duplicidade no Repositório
      const existingProduct = await findExistingProduct(normalizedUrl, mktId, generatedSlug, curatedTitle);

      if (existingProduct) {
        console.log(`[Product Automation] Produto existente identificado (ID: ${existingProduct.id}, Título: "${existingProduct.produto}")`);

        const oldPrice = existingProduct.preco;
        const newPrice = scrapedPrice;
        const changedFields: string[] = [];
        const updatePayload: Partial<Product> = {};

        // Comparação de Preço
        if (Math.abs(oldPrice - newPrice) > 0.01) {
          updatePayload.preco = newPrice;
          changedFields.push(`preço atualizado (R$ ${oldPrice.toFixed(2).replace('.', ',')} → R$ ${newPrice.toFixed(2).replace('.', ',')})`);
        }

        // Comparação de Imagens
        if (scrapedImages.length > 0 && JSON.stringify(scrapedImages) !== JSON.stringify(existingProduct.imagens)) {
          updatePayload.imagens = scrapedImages;
          changedFields.push("imagens atualizadas");
        }

        // Comparação de Descrição (Apenas substitui se o registro atual estiver sem descrição)
        if (curatedDescription && !existingProduct.descricao) {
          updatePayload.descricao = curatedDescription;
          changedFields.push("descrição adicionada");
        }

        // Se houver alterações válidas, atualiza
        if (changedFields.length > 0) {
          const updatedProduct = await productsRepository.updateProduct(existingProduct.id, updatePayload);
          return {
            success: true,
            action: "updated",
            product: updatedProduct || existingProduct,
            oldPrice,
            newPrice,
            changedFields,
            marketplace,
            normalizedUrl
          };
        }

        // Caso nenhuma alteração relevante tenha sido detectada
        return {
          success: true,
          action: "unchanged",
          product: existingProduct,
          marketplace,
          normalizedUrl
        };
      }

      // 5. Criação de Novo Produto se não existir
      console.log(`[Product Automation] Criando novo produto: "${curatedTitle}" (Preço: R$ ${scrapedPrice.toFixed(2)})`);

      const createdProduct = await productsRepository.createProduct({
        produto: curatedTitle,
        categoria: curatedCategory,
        preco: scrapedPrice,
        imagens: scrapedImages,
        link: normalizedUrl,
        descricao: curatedDescription,
        status: "published"
      });

      return {
        success: true,
        action: "created",
        product: createdProduct,
        newPrice: scrapedPrice,
        marketplace,
        normalizedUrl
      };

    } catch (err: any) {
      console.error("[Product Automation Error] Exceção durante processamento:", err);
      return {
        success: false,
        action: "failed",
        reason: err?.message || "Erro interno durante o processamento da automação.",
        normalizedUrl
      };
    } finally {
      inFlightRequests.delete(normalizedUrl);
    }
  })();

  inFlightRequests.set(normalizedUrl, processingPromise);
  return await processingPromise;
}
