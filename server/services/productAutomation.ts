import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { Product } from "../../src/types";
import { generateSlug } from "../../src/data/initialProducts";
import * as productsRepository from "../repositories/productsRepository";
import { fetchProductDataFromUrl, extractTitleFromUrl } from "./scraper";

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
  action: "created" | "updated" | "unchanged" | "review" | "failed";
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
 * mas PRESERVANDO o caminho do produto e identificadores.
 */
export function normalizeProductUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  let urlStr = rawUrl.trim();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = "https://" + urlStr;
  }
  try {
    const parsed = new URL(urlStr);
    parsed.hostname = parsed.hostname.toLowerCase();

    // Relação abrangente de parâmetros de rastreamento / afiliados / campanhas a serem removidos
    const trackingParams = [
      "__mobile__", "exp_group", "gads_t_sig", "mmp_pid", "uls_trackid",
      "smtt", "sp_atk", "xptdk", "af_siteid", "pid", "af_click_lookback",
      "c", "is_from_signup", "deep_and_deferred", "st", "st_sig",
      "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
      "fbclid", "gclid", "ttclid", "spm", "_ga", "_gl", "x_src", "source_caller",
      "gbraid", "wbraid", "dclid", "msclkid", "matt_tool", "matt_word"
    ];

    trackingParams.forEach((param) => parsed.searchParams.delete(param));

    // Para Shopee, remova qualquer parâmetro de busca de tracking (começa com __, sp_, uls_, gads_, mmp_, af_, etc.)
    if (parsed.hostname.includes("shopee") || parsed.hostname.includes("shope.ee")) {
      const keys = Array.from(parsed.searchParams.keys());
      for (const k of keys) {
        if (
          k.startsWith("__") ||
          k.startsWith("sp_") ||
          k.startsWith("uls_") ||
          k.startsWith("gads_") ||
          k.startsWith("mmp_") ||
          k.startsWith("af_") ||
          trackingParams.includes(k.toLowerCase())
        ) {
          parsed.searchParams.delete(k);
        }
      }

      // Normalização Canônica para Shopee: /product/{shopid}/{itemid}
      let shopId: string | null = null;
      let itemId: string | null = null;

      // Padrão 1: /product/123456/789012
      const pMatch1 = parsed.pathname.match(/\/product\/(\d+)\/(\d+)/i);
      if (pMatch1) {
        shopId = pMatch1[1];
        itemId = pMatch1[2];
      }

      // Padrão 2: /{loja}/{shopid}/{itemid}
      if (!shopId) {
        const pMatch2 = parsed.pathname.match(/^\/([^\/]+)\/(\d+)\/(\d+)/i);
        if (pMatch2) {
          shopId = pMatch2[2];
          itemId = pMatch2[3];
        }
      }

      // Padrão 3: /{loja}/{slug}/{shopid}/{itemid}
      if (!shopId) {
        const pMatch3 = parsed.pathname.match(/^\/([^\/]+)\/([^\/]+)\/(\d+)\/(\d+)/i);
        if (pMatch3) {
          shopId = pMatch3[3];
          itemId = pMatch3[4];
        }
      }

      // Padrão 4: ...-i.{shopid}.{itemid}
      if (!shopId) {
        const pMatch4 = parsed.pathname.match(/i\.(\d+)\.(\d+)/i);
        if (pMatch4) {
          shopId = pMatch4[1];
          itemId = pMatch4[2];
        }
      }

      if (shopId && itemId) {
        parsed.pathname = `/product/${shopId}/${itemId}`;
      }
    }

    let cleanPath = parsed.pathname;
    if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
      cleanPath = cleanPath.slice(0, -1);
    }
    parsed.pathname = cleanPath;

    let res = parsed.toString();
    if (res.endsWith("?")) {
      res = res.slice(0, -1);
    }
    return res;
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

  // Shopee Format 1: i.12345678.98765432
  const shopeeMatch1 = url.match(/i\.(\d+)\.(\d+)/i);
  if (shopeeMatch1) {
    return `shopee-${shopeeMatch1[1]}-${shopeeMatch1[2]}`;
  }
  // Shopee Format 2: product/12345678/98765432
  const shopeeMatch2 = url.match(/product\/(\d+)\/(\d+)/i);
  if (shopeeMatch2) {
    return `shopee-${shopeeMatch2[1]}-${shopeeMatch2[2]}`;
  }
  // Shopee Format 3: {loja}/{shopid}/{itemid} ou {loja}/{slug}/{shopid}/{itemid}
  const shopeeMatch3 = url.match(/shopee\.com\.br\/[^\/]+\/(\d+)\/(\d+)/i);
  if (shopeeMatch3) {
    return `shopee-${shopeeMatch3[1]}-${shopeeMatch3[2]}`;
  }
  const shopeeMatch4 = url.match(/shopee\.com\.br\/[^\/]+\/[^\/]+\/(\d+)\/(\d+)/i);
  if (shopeeMatch4) {
    return `shopee-${shopeeMatch4[1]}-${shopeeMatch4[2]}`;
  }

  return null;
}

/**
 * Identifica se um título é genérico/inválido
 */
export function isGenericTitle(title?: string | null): boolean {
  if (!title || typeof title !== "string") return true;
  const clean = title.trim().toLowerCase();
  if (clean.length < 3) return true;
  if (
    clean === "produto cerberus" ||
    clean.includes("shopee brasil") ||
    clean.includes("ofertas incríveis") ||
    clean.includes("melhores preços") ||
    clean.includes("account verification") ||
    clean.includes("access denied") ||
    clean.includes("403 forbidden") ||
    clean.includes("404 not found") ||
    clean.includes("captcha") ||
    clean === "shopee" ||
    clean === "mercado livre" ||
    clean === "mercado libre" ||
    clean === "e-commerce" ||
    clean === "produto" ||
    clean === "sem título" ||
    clean === "sem titulo" ||
    clean === "opaanlp"
  ) {
    return true;
  }
  return false;
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
    const err = "URL ou texto de produto inválido.";
    console.log(`[TELEGRAM EXTRACTION] URL original: ${rawUrl}`);
    console.log(`[TELEGRAM EXTRACTION] URL normalizada: ${normalizedUrl}`);
    console.log(`[TELEGRAM EXTRACTION] Marketplace: Indefinido`);
    console.log(`[TELEGRAM EXTRACTION] Título: N/A`);
    console.log(`[TELEGRAM EXTRACTION] Preço: N/A`);
    console.log(`[TELEGRAM EXTRACTION] Quantidade de imagens: 0`);
    console.log(`[TELEGRAM EXTRACTION] Fonte dos dados: Validação de Entrada`);
    console.log(`[TELEGRAM EXTRACTION] Erro/bloqueio: ${err}`);
    return { success: false, error: err };
  }

  try {
    const marketplace = detectMarketplace(normalizedUrl);

    // Extract shop_id and item_id for logging
    let shopId: string | null = null;
    let itemId: string | null = null;
    const shopeeIdsMatch = normalizedUrl.match(/product\/(\d+)\/(\d+)/i) || normalizedUrl.match(/i\.(\d+)\.(\d+)/i) || normalizedUrl.match(/shopee\.com\.br\/[^\/]+\/(\d+)\/(\d+)/i);
    if (shopeeIdsMatch) {
      shopId = shopeeIdsMatch[1];
      itemId = shopeeIdsMatch[2];
    }

    const scraped = await fetchProductDataFromUrl(normalizedUrl, rawTextOverride);
    let scrapedTitle = scraped.title;
    const scrapedPrice = scraped.price;
    const scrapedImages = scraped.images || [];
    const rawContent = scraped.rawContent;

    // Tenta resgatar título pela URL se o Scraper retornou nulo ou título genérico
    if (!scrapedTitle || isGenericTitle(scrapedTitle)) {
      const urlTitle = extractTitleFromUrl(normalizedUrl);
      if (urlTitle && !isGenericTitle(urlTitle)) {
        scrapedTitle = urlTitle;
      }
    }

    // Regra 8: Se não houver título real nem imagens reais, rejeita a extração
    const hasInvalidTitle = !scrapedTitle || isGenericTitle(scrapedTitle);
    const hasNoImages = scrapedImages.length === 0;

    if (hasInvalidTitle || hasNoImages) {
      const blockError = "Não foi possível extrair os dados reais do anúncio. O marketplace bloqueou a requisição ou o anúncio não retornou título e imagens válidos.";

      const priceReason = scrapedPrice !== null
        ? "Preço identificado"
        : marketplace === "Shopee"
          ? "Preço indisponível no SSR da Shopee (requer API privada/autenticada)."
          : "Preço não localizado.";

      console.log(`[TELEGRAM EXTRACTION] URL original: ${rawUrl}`);
      console.log(`[TELEGRAM EXTRACTION] URL normalizada: ${normalizedUrl}`);
      console.log(`[TELEGRAM EXTRACTION] shop_id: ${shopId || "N/A"}`);
      console.log(`[TELEGRAM EXTRACTION] item_id: ${itemId || "N/A"}`);
      console.log(`[TELEGRAM EXTRACTION] URL canônica: ${normalizedUrl}`);
      console.log(`[TELEGRAM EXTRACTION] Título extraído: N/A`);
      console.log(`[TELEGRAM EXTRACTION] Quantidade de imagens: ${scrapedImages.length}`);
      console.log(`[TELEGRAM EXTRACTION] Preço encontrado: ${scrapedPrice !== null ? `R$ ${scrapedPrice.toFixed(2)}` : "null"}`);
      console.log(`[TELEGRAM EXTRACTION] Motivo caso o preço não esteja disponível: ${priceReason}`);
      console.log(`[TELEGRAM EXTRACTION] Erro/bloqueio: ${blockError}`);

      return {
        success: false,
        error: blockError
      };
    }

    let curatedTitle = scrapedTitle && !isGenericTitle(scrapedTitle) ? scrapedTitle : "";
    let curatedDescription = "";
    let curatedCategory = inferCategoryFromTitle(curatedTitle || "Acessórios");

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
          model: "gemini-1.5-flash",
          contents: prompt,
          config: {
            systemInstruction: `Você é o assistente curador do Cerberus Finds Archive.
Sua função é APENAS formatar o nome do produto, escrever a descrição curatorial de 2 frases e sugerir a categoria.
NUNCA invente preços, títulos fictícios ou URLs.`,
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

        if (geminiJson.produto && geminiJson.produto.trim().length > 3 && !isGenericTitle(geminiJson.produto)) {
          curatedTitle = geminiJson.produto.trim();
        }
        if (geminiJson.descricao) {
          curatedDescription = geminiJson.descricao.trim();
        }
        if (geminiJson.categoria) {
          curatedCategory = geminiJson.categoria.trim();
        }
      } catch (geminiErr: any) {
        console.warn("[Product Review Extraction Warning] Gemini falhou, mantendo dados brutos do scraper:", geminiErr?.message);
      }
    }

    if (!curatedTitle || isGenericTitle(curatedTitle)) {
      curatedTitle = scrapedTitle && !isGenericTitle(scrapedTitle) ? scrapedTitle : "Produto sem Título";
    }

    const mktId = extractMarketplaceId(normalizedUrl);
    const generatedSlug = generateSlug(curatedTitle);
    const existingProduct = await findExistingProduct(normalizedUrl, mktId, generatedSlug, curatedTitle);

    const priceReason = scrapedPrice !== null
      ? "Preço extraído com sucesso do anúncio."
      : marketplace === "Shopee"
        ? "Preço não disponível no SSR da Shopee (carregado via API restrita do marketplace)."
        : "Preço não localizado na estrutura do anúncio.";

    console.log(`[TELEGRAM EXTRACTION] URL original: ${rawUrl}`);
    console.log(`[TELEGRAM EXTRACTION] URL normalizada: ${normalizedUrl}`);
    console.log(`[TELEGRAM EXTRACTION] shop_id: ${shopId || "N/A"}`);
    console.log(`[TELEGRAM EXTRACTION] item_id: ${itemId || "N/A"}`);
    console.log(`[TELEGRAM EXTRACTION] URL canônica: ${normalizedUrl}`);
    console.log(`[TELEGRAM EXTRACTION] Título extraído: ${curatedTitle}`);
    console.log(`[TELEGRAM EXTRACTION] Quantidade de imagens: ${scrapedImages.length}`);
    console.log(`[TELEGRAM EXTRACTION] Preço encontrado: ${scrapedPrice !== null ? `R$ ${scrapedPrice.toFixed(2)}` : "null"}`);
    console.log(`[TELEGRAM EXTRACTION] Motivo caso o preço não esteja disponível: ${priceReason}`);
    console.log(`[TELEGRAM EXTRACTION] Erro/bloqueio: Nenhum`);

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
    const errorMsg = err?.message || "Falha ao extrair dados do produto.";

    console.log(`[TELEGRAM EXTRACTION] URL original: ${rawUrl}`);
    console.log(`[TELEGRAM EXTRACTION] URL normalizada: ${normalizedUrl}`);
    console.log(`[TELEGRAM EXTRACTION] Marketplace: ${detectMarketplace(normalizedUrl)}`);
    console.log(`[TELEGRAM EXTRACTION] Título: N/A`);
    console.log(`[TELEGRAM EXTRACTION] Preço: N/A`);
    console.log(`[TELEGRAM EXTRACTION] Quantidade de imagens: 0`);
    console.log(`[TELEGRAM EXTRACTION] Fonte dos dados: Scraper`);
    console.log(`[TELEGRAM EXTRACTION] Erro/bloqueio: ${errorMsg}`);

    return {
      success: false,
      error: errorMsg
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

  // Bloco 7: esta entrada de automação não cria nem publica produtos. A extração
  // apenas prepara uma proposta para a fila humana controlada no Telegram.
  const review = await extractProductForReview(normalizedUrl);
  if (!review.success || !review.data) {
    return {
      success: false,
      action: "failed",
      reason: review.error || "EXTERNAL_SERVICE_ERROR",
      normalizedUrl,
    };
  }
  return {
    success: true,
    action: "review",
    reason: "Produto preparado para validação e aprovação humana; nenhuma publicação foi executada.",
    marketplace: review.data.marketplace,
    normalizedUrl,
  };

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
