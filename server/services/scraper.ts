import dotenv from "dotenv";
import { detectMarketplace } from "./marketplace";

dotenv.config();

export interface ExtractedProductData {
  title: string | null;
  price: number | null;
  images: string[];
  rawContent: string;
}

const SCRAPER_TIMEOUT_MS = 15_000;
const SCRAPER_MAX_HTML_BYTES = 750_000;
const SCRAPER_MAX_OVERRIDE_CHARS = 10_000;

function isSafeMarketplaceUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

async function fetchAllowedMarketplaceDocument(initialUrl: string, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(currentUrl);
    if (!isSafeMarketplaceUrl(parsed) || detectMarketplace(parsed.href) === "Outros") {
      throw new Error("URL não pertence a um marketplace permitido.");
    }
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "CerberusCatalogBot/1.0 (+catalog-validation)",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Cache-Control": "no-cache"
      },
      redirect: "manual",
      signal,
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: currentUrl };
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirecionamento do marketplace sem destino.");
    currentUrl = new URL(location, currentUrl).href;
  }
  throw new Error("Limite de redirecionamentos do marketplace excedido.");
}

async function readHtmlWithLimit(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SCRAPER_MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("Resposta do marketplace excedeu o limite de tamanho.");
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

/**
 * Extrator confiável para Shopee, Mercado Livre e E-commerce
 */
export async function fetchProductDataFromUrl(urlStr: string, rawTextOverride?: string): Promise<ExtractedProductData> {
  let targetUrl = urlStr.trim();
  if (targetUrl && !targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  let finalUrl = targetUrl;
  let html = "";
  
  if (targetUrl) {
    try {
      const parsedUrl = new URL(targetUrl);
      if (!isSafeMarketplaceUrl(parsedUrl) || detectMarketplace(parsedUrl.href) === "Outros") throw new Error("URL de rede privada, protocolo não permitido ou marketplace não autorizado.");
      targetUrl = parsedUrl.href;
      finalUrl = targetUrl;
    } catch (e) {
      console.warn(`[Scraper] URL inválida informada: "${urlStr}"`);
      targetUrl = "";
      finalUrl = "";
    }
  }

  const isShopee = targetUrl.includes("shopee") || targetUrl.includes("shope.ee");
  const isMercadoLivre = targetUrl.includes("mercadolivre") || targetUrl.includes("mercadolibre");

  let httpStatus = 0;
  let contentType = "";

  if (targetUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
      const { response, finalUrl: redirectedUrl } = await fetchAllowedMarketplaceDocument(targetUrl, controller.signal);
      try {
        finalUrl = redirectedUrl;
        httpStatus = response.status;
        contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) throw new Error("Tipo de conteúdo não é HTML.");
        html = await readHtmlWithLimit(response);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err: any) {
      console.warn(`[Scraper Fetch Warning] Falha ao efetuar fetch em ${targetUrl}: ${err.message}`);
    }
  }

  // Se o usuário passou texto copiado adicional, concatena ao HTML
  const combinedContent = `${html}\n\n${(rawTextOverride || "").slice(0, SCRAPER_MAX_OVERRIDE_CHARS)}`;

  // 1. EXTRAÇÃO DE JSON-LD
  const jsonLdResult = parseJsonLd(combinedContent);

  // 2. EXTRAÇÃO DE OPEN GRAPH
  const ogResult = parseOpenGraph(combinedContent);

  // 3. EXTRAÇÃO DE DADOS INTERNOS E CDN OFICIAL DE IMAGENS
  const shopeeImages = extractShopeeCdnImages(combinedContent);
  const mlImages = extractMercadoLivreCdnImages(combinedContent);

  // Unificar todas as fontes de imagem em ordem estrita de prioridade
  const rawImageCandidates = [
    ...jsonLdResult.images,
    ...ogResult.images,
    ...shopeeImages,
    ...mlImages
  ];

  const images = dedupeAndCleanImages(rawImageCandidates);

  // 4. EXTRAÇÃO DE TÍTULO
  let title: string | null = jsonLdResult.title || ogResult.title;

  if (!title && combinedContent) {
    const pageTitleMatch = combinedContent.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (pageTitleMatch && pageTitleMatch[1]) {
      const cleaned = cleanTitle(pageTitleMatch[1]);
      if (!cleaned.toLowerCase().includes("account-verification") && !cleaned.toLowerCase().includes("mercado libre")) {
        title = cleaned;
      }
    }
  }

  if (!title || title.length < 5) {
    title = extractTitleFromUrl(finalUrl || targetUrl);
  }

  if (title) {
    title = cleanTitle(title);
  }

  // 5. EXTRAÇÃO E SELEÇÃO DE PREÇO
  const price = extractCorrectPrice(combinedContent, jsonLdResult.price, ogResult.price);

  // LOG DE DEBUG SOLICITADO
  printScraperDebugLog({
    targetUrl,
    finalUrl,
    httpStatus,
    contentType,
    html,
    combinedContent,
    jsonLdImages: jsonLdResult.images,
    ogImages: ogResult.images,
    shopeeImages,
    mlImages,
    finalImages: images,
    jsonLdPrice: jsonLdResult.price,
    ogPrice: ogResult.price,
    finalPrice: price
  });

  if (price === null) {
    console.warn(`[Scraper Warning] Preço válido não foi identificado no anúncio.`);
  }

  // Texto cru para contexto
  const cleanBodyText = combinedContent
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const fullRawContent = `[URL Final]: ${finalUrl}
[Título Identificado]: ${title || 'N/A'}
[Preço Identificado]: ${price !== null ? `R$ ${price.toFixed(2)}` : 'N/A'}
[Total Imagens Oficiais]: ${images.length}
[Imagens extraídas]: ${JSON.stringify(images)}
[Conteúdo da Página]: ${cleanBodyText.slice(0, 2500)}`;

  return {
    title,
    price,
    images,
    rawContent: fullRawContent
  };
}

/**
 * 1. Parser de JSON-LD
 */
function parseJsonLd(content: string): { title: string | null; price: number | null; images: string[] } {
  let title: string | null = null;
  let price: number | null = null;
  const images: string[] = [];

  const scriptMatches = content.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptMatches) {
    if (!match[1]) continue;
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        // Título
        if (!title && item.name && typeof item.name === "string") {
          title = item.name.trim();
        }

        // Imagens
        if (item.image) {
          if (typeof item.image === "string") {
            images.push(item.image);
          } else if (Array.isArray(item.image)) {
            item.image.forEach((img: any) => {
              if (typeof img === "string") images.push(img);
              else if (img && typeof img.url === "string") images.push(img.url);
              else if (img && typeof img.contentUrl === "string") images.push(img.contentUrl);
            });
          } else if (typeof item.image === "object") {
            if (item.image.url) images.push(item.image.url);
            if (item.image.contentUrl) images.push(item.image.contentUrl);
          }
        }

        // Preço via offers
        if (item.offers) {
          const offerList = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const offer of offerList) {
            if (!offer) continue;
            const p = offer.price || offer.lowPrice || offer.priceSpecification?.price;
            if (p !== undefined && p !== null) {
              const numP = parseFloat(String(p).replace(",", "."));
              if (!isNaN(numP) && numP > 0) {
                if (price === null || numP < price) {
                  price = numP;
                }
              }
            }
          }
        }
      }
    } catch {
      // JSON-LD malformatado, ignorar
    }
  }

  return { title, price, images };
}

/**
 * 2. Parser de Open Graph / Twitter Cards
 */
function parseOpenGraph(content: string): { title: string | null; price: number | null; images: string[] } {
  let title: string | null = null;
  let price: number | null = null;
  const images: string[] = [];

  // Title
  const ogTitle = content.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                  content.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']/i);
  if (ogTitle && ogTitle[1]) {
    title = ogTitle[1].trim();
  }

  // Price
  const ogPrice = content.match(/<meta\s+(?:property|name)=["'](?:og:price:amount|product:price:amount|twitter:data1)["']\s+content=["']([^"']+)["']/i) ||
                  content.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["'](?:og:price:amount|product:price:amount|twitter:data1)["']/i);
  if (ogPrice && ogPrice[1]) {
    const parsed = parseBrlNumber(ogPrice[1]);
    if (parsed > 0) price = parsed;
  }

  // Images
  const ogImages = content.matchAll(/<meta\s+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["']\s+content=["']([^"']+)["']/gi);
  for (const m of ogImages) {
    if (m[1] && m[1].startsWith("http")) {
      images.push(m[1]);
    }
  }

  return { title, price, images };
}

/**
 * Extrai imagens do CDN oficial da Shopee
 */
function extractShopeeCdnImages(content: string): string[] {
  const images: string[] = [];

  // 1. Extrai matriz de hashes da galeria oficial do produto em blocos JSON ("images", "image_list", "imageList", "image_ids")
  const jsonImagesMatches = content.matchAll(/(?:\"images\"|\"image_list\"|\"imageList\"|\"image_ids\")\s*:\s*\[([^\]]+)\]/gi);
  for (const m of jsonImagesMatches) {
    if (m[1]) {
      const hashes = m[1].matchAll(/"([a-zA-Z0-9_\-]{20,50})"/g);
      const blockImages: string[] = [];
      for (const h of hashes) {
        if (h[1]) {
          const cleanHash = h[1].replace(/_(tn|b)$/i, "");
          const fullUrl = `https://down-br.img.susercontent.com/file/${cleanHash}`;
          if (!blockImages.includes(fullUrl)) {
            blockImages.push(fullUrl);
          }
        }
      }
      // Se encontramos o bloco da galeria principal com múltiplas imagens do produto,
      // retornamos diretamente para não capturar produtos recomendados ou anúncios.
      if (blockImages.length > 1) {
        return blockImages;
      }
      if (blockImages.length > 0 && images.length === 0) {
        images.push(...blockImages);
      }
    }
  }

  if (images.length > 0) {
    return images;
  }

  // 2. Fallback: Se não foi localizado bloco JSON de galeria, busca imagens do CDN no HTML
  const shopeeRegex = /https:\/\/(?:down-br\.img\.susercontent\.com|down-tx-br\.img\.susercontent\.com|sg-11134201-[^"'\s\)\\]+|cf\.shopee\.com\.br)\/file\/([a-zA-Z0-9_\-]+)/gi;
  
  const matches = content.matchAll(shopeeRegex);
  for (const m of matches) {
    if (m[1]) {
      // Limpa sufixos de miniatura (_tn, _b) para obter a imagem em alta resolução
      const cleanHash = m[1].replace(/_(tn|b)$/i, "");
      const fullUrl = `https://down-br.img.susercontent.com/file/${cleanHash}`;
      if (!images.includes(fullUrl)) {
        images.push(fullUrl);
      }
    }
  }
  return images;
}

/**
 * Extrai imagens do CDN oficial do Mercado Livre
 */
function extractMercadoLivreCdnImages(content: string): string[] {
  const images: string[] = [];
  // Padrão de imagens do Mercado Livre: D_NQ_NP_... ou D_NQ_...
  const mlRegex = /https:\/\/http2\.mlstatic\.com\/D_NQ_NP_[^"'\s\)\\]+/gi;
  
  const matches = content.matchAll(mlRegex);
  for (const m of matches) {
    let url = m[0].replace(/\\/g, "").replace(/["'\)]/g, "");
    // Converte miniaturas (-I, -V, -R) em imagem HD (-O ou -F)
    url = url.replace(/-[IVR]\.(webp|jpg|png|jpeg)/i, "-O.webp");
    if (!images.includes(url)) {
      images.push(url);
    }
  }
  return images;
}

/**
 * Deduplica e limpa a lista de URLs de imagens
 */
function dedupeAndCleanImages(candidates: string[]): string[] {
  const uniqueUrls: string[] = [];
  
  for (let url of candidates) {
    if (!url || typeof url !== "string") continue;
    url = url.trim().replace(/\\/g, "").replace(/["'\)]/g, "");

    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;

    // Normaliza http para https
    if (url.startsWith("http://")) {
      url = url.replace("http://", "https://");
    }

    // Filtrar rastreadores, logotipos, ícones e badges irrelevantes
    const lower = url.toLowerCase();
    if (
      lower.includes("favicon") ||
      lower.includes("logo") ||
      lower.includes("avatar") ||
      lower.includes("badge") ||
      lower.includes("icon") ||
      lower.includes("sprite") ||
      lower.includes("pixel") ||
      lower.includes("loading") ||
      lower.includes("placeholder") ||
      lower.includes("1x1")
    ) {
      continue;
    }

    if (!uniqueUrls.includes(url)) {
      uniqueUrls.push(url);
    }
  }

  return uniqueUrls;
}

/**
 * Extração resiliente de PREÇO PROMOCIONAL/VENDA ATUAL em 8 Estratégias Sequenciais.
 * NUNCA inventa preços. Retorna null se todas falharem.
 */
export function extractCorrectPrice(content: string, jsonLdPrice: number | null, ogPrice: number | null): number | null {
  const strategies: Array<{ name: string; find: () => number | null }> = [
    { name: "ESTRATÉGIA_1_JSON_LD", find: () => tryStrategy1JsonLd(content, jsonLdPrice) },
    { name: "ESTRATÉGIA_2_DADOS_INTERNOS", find: () => tryStrategy2InternalData(content) },
    { name: "ESTRATÉGIA_3_OPENGRAPH", find: () => tryStrategy3OpenGraph(content, ogPrice) },
    { name: "ESTRATÉGIA_4_META_TAGS", find: () => tryStrategy4MetaTags(content) },
    { name: "ESTRATÉGIA_5_HTML_SELECTORS", find: () => tryStrategy5HtmlSelectors(content) },
    { name: "ESTRATÉGIA_6_SHOPEE_SPECIFIC", find: () => tryStrategy6ShopeeSpecific(content) },
    { name: "ESTRATÉGIA_7_MERCADOLIVRE_SPECIFIC", find: () => tryStrategy7MercadoLivreSpecific(content) },
    { name: "ESTRATÉGIA_8_REGEX", find: () => tryStrategy8RegexFallback(content) },
  ];

  for (const strategy of strategies) {
    const candidate = strategy.find();
    if (candidate === null) continue;
    if (isContextuallyValidSalePrice(candidate, content)) return candidate;
    console.warn(`[Scraper Price Log] Valor R$ ${candidate.toFixed(2)} descartado após ${strategy.name}: associado a parcela ou preço original.`);
  }

  console.warn(`[Scraper Price Log] Nenhuma estratégia conseguiu identificar um preço válido no anúncio. Retornando null (Preço não encontrado automaticamente).`);
  return null;
}

/**
 * Evita o "preço fantasma": valores de parcelas (por exemplo, "3x de R$ 71"),
 * preços riscados/originais e valores anteriores não podem alimentar o catálogo.
 * O mesmo número é aceito somente se também ocorrer fora desses contextos. Para
 * JSON sem representação textual, não há evidência contextual para rejeição.
 */
function isContextuallyValidSalePrice(value: number, content: string): boolean {
  if (!Number.isFinite(value) || value <= 0 || value >= 100000) return false;

  const matches = Array.from(content.matchAll(/R\$\s*([0-9]+(?:[\.,][0-9]{1,2})?)/gi))
    .filter((match) => Math.abs(parseBrlNumber(match[1]) - value) < 0.005);

  if (matches.length === 0) return true;

  return matches.some((match) => {
    // As marcas de parcela e preço original antecedem o valor. Não olhamos o
    // conteúdo seguinte para não invalidar o preço à vista por uma parcela que
    // aparece logo abaixo na página do Mercado Livre.
    const priceIndex = match.index || 0;
    const genericStart = Math.max(0, priceIndex - 180);
    // Se o preço está em uma tag, restringe a verificação à própria tag e ao
    // respectivo texto. Assim um preço antigo em uma tag irmã não invalida o
    // preço atual que vem depois.
    const currentElementStart = content.lastIndexOf("<", priceIndex);
    const start = currentElementStart >= genericStart ? currentElementStart : genericStart;
    return !hasBlockedPriceContext(content.slice(start, priceIndex + match[0].length));
  });
}

function hasBlockedPriceContext(context: string): boolean {
  return /(?:\bparcela(?:s)?\b|\bem\s+at[eé]\b|\bsem\s+juros\b|\b\d{1,2}\s*x\s*(?:de\s*)?R?\$?|\bvezes\b|ui-pdp-price__original-value|andes-money-amount--previous|original-price|previous-price|old-price|strikethrough|riscad[oa]|<s\b|<del\b)/i.test(context);
}

/** 1. JSON-LD */
function tryStrategy1JsonLd(content: string, preParsedJsonLdPrice: number | null): number | null {
  if (preParsedJsonLdPrice !== null && preParsedJsonLdPrice > 0 && preParsedJsonLdPrice < 100000) {
    console.log(`[Scraper Price Log] Preço R$ ${preParsedJsonLdPrice.toFixed(2)} localizado via ESTRATÉGIA_1_JSON_LD`);
    return preParsedJsonLdPrice;
  }
  const parsed = parseJsonLd(content);
  if (parsed.price !== null && parsed.price > 0 && parsed.price < 100000) {
    console.log(`[Scraper Price Log] Preço R$ ${parsed.price.toFixed(2)} localizado via ESTRATÉGIA_1_JSON_LD`);
    return parsed.price;
  }
  return null;
}

/** 2. Dados Internos da Página (script tags, window state, JSON objects) */
function tryStrategy2InternalData(content: string): number | null {
  const scriptMatches = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scriptMatches) {
    const scriptBody = m[1];
    if (!scriptBody || scriptBody.length < 10) continue;

    // Shopee JSON state (price_min / price / price_before_discount em micro-centavos ou formato decimal)
    const shopeePriceMatch = scriptBody.match(/"price_min"\s*:\s*(\d+)/i) || scriptBody.match(/"price"\s*:\s*(\d+)/i);
    if (shopeePriceMatch && shopeePriceMatch[1]) {
      let rawNum = parseFloat(shopeePriceMatch[1]);
      if (rawNum > 10000000) rawNum = rawNum / 100000000;
      else if (rawNum > 100000) rawNum = rawNum / 100000;
      else if (rawNum > 10000) rawNum = rawNum / 100;
      
      if (rawNum > 0 && rawNum < 100000) {
        console.log(`[Scraper Price Log] Preço R$ ${rawNum.toFixed(2)} localizado via ESTRATÉGIA_2_DADOS_INTERNOS (Shopee JSON)`);
        return rawNum;
      }
    }

    // Mercado Livre / E-Commerce JSON state ("price": 249.9)
    const genericJson = scriptBody.match(/"current_price"\s*:\s*([0-9\.]+)/i) ||
                        scriptBody.match(/"sale_price"\s*:\s*([0-9\.]+)/i) ||
                        scriptBody.match(/"price"\s*:\s*([0-9\.]+)/i);
    if (genericJson && genericJson[1]) {
      const num = parseFloat(genericJson[1]);
      if (!isNaN(num) && num > 0 && num < 100000) {
        console.log(`[Scraper Price Log] Preço R$ ${num.toFixed(2)} localizado via ESTRATÉGIA_2_DADOS_INTERNOS (E-Commerce JS)`);
        return num;
      }
    }
  }
  return null;
}

/** 3. OpenGraph / Twitter Cards */
function tryStrategy3OpenGraph(content: string, preParsedOgPrice: number | null): number | null {
  if (preParsedOgPrice !== null && preParsedOgPrice > 0 && preParsedOgPrice < 100000) {
    console.log(`[Scraper Price Log] Preço R$ ${preParsedOgPrice.toFixed(2)} localizado via ESTRATÉGIA_3_OPENGRAPH`);
    return preParsedOgPrice;
  }
  const og = parseOpenGraph(content);
  if (og.price !== null && og.price > 0 && og.price < 100000) {
    console.log(`[Scraper Price Log] Preço R$ ${og.price.toFixed(2)} localizado via ESTRATÉGIA_3_OPENGRAPH`);
    return og.price;
  }
  return null;
}

/** 4. Meta Tags (itemprop="price", name="price", etc.) */
function tryStrategy4MetaTags(content: string): number | null {
  const metaMatches = content.matchAll(/<meta\s+[^>]*>/gi);
  for (const match of metaMatches) {
    const tag = match[0];
    if (/itemprop=["']price["']/i.test(tag) || /name=["'](?:price|product:price|amount)["']/i.test(tag)) {
      const contentAttr = tag.match(/content=["']([^"']+)["']/i);
      if (contentAttr && contentAttr[1]) {
        const parsed = parseBrlNumber(contentAttr[1]);
        if (parsed > 0 && parsed < 100000) {
          console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_4_META_TAGS`);
          return parsed;
        }
      }
    }
  }
  return null;
}

/** 5. HTML Renderizado (itemprop="price", class="price") */
function tryStrategy5HtmlSelectors(content: string): number | null {
  const itempropMatch = content.match(/itemprop=["']price["'][^>]*>(?:R\$\s*)?([0-9\.,]+)/i) ||
                        content.match(/>([0-9\.,]+)<\/[^>]*itemprop=["']price["']/i);
  if (itempropMatch && itempropMatch[1]) {
    const parsed = parseBrlNumber(itempropMatch[1]);
    if (parsed > 0 && parsed < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_5_HTML_SELECTORS (itemprop="price")`);
      return parsed;
    }
  }

  const priceClassMatches = content.matchAll(/<[^>]+class=["'][^"']*(?:price|preco|valor)[^"']*["'][^>]*>(?:R\$\s*)?([0-9\.,]+)/gi);
  for (const m of priceClassMatches) {
    const tag = m[0];
    if (/(?:original|old|previous|strike|de-preco|riscado)/i.test(tag)) continue;
    if (m[1]) {
      const parsed = parseBrlNumber(m[1]);
      if (parsed > 0 && parsed < 100000) {
        console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_5_HTML_SELECTORS (Class Price)`);
        return parsed;
      }
    }
  }
  return null;
}

/** 6. Seletores específicos da Shopee */
function tryStrategy6ShopeeSpecific(content: string): number | null {
  const shopeeMatch = content.match(/(?:class=["'][^"']*(?:pq_m|shopee-product-info|_5g0|_2m0|_1W6)[^"']*["'][^>]*>)\s*R\$\s*([0-9\.,]+)/i) ||
                      content.match(/R\$\s*([0-9]+(?:[\.,][0-9]{2}))\s*<\/div>\s*<\/div>\s*<div[^>]*class=["'][^"']*shopee/i);
  if (shopeeMatch && shopeeMatch[1]) {
    const parsed = parseBrlNumber(shopeeMatch[1]);
    if (parsed > 0 && parsed < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_6_SHOPEE_SPECIFIC`);
      return parsed;
    }
  }
  return null;
}

/** 7. Seletores específicos do Mercado Livre */
function tryStrategy7MercadoLivreSpecific(content: string): number | null {
  // Line 2 (Preço promocional/venda atual) no DOM do Mercado Livre
  const secondLineMatch = content.match(/ui-pdp-price__second-line[\s\S]*?(?:<\/div>|<\/section>)/i);
  if (secondLineMatch) {
    const snippet = secondLineMatch[0];
    const fractionMatch = snippet.match(/andes-money-amount__fraction["'][^>]*>([0-9\.]+)</i);
    if (fractionMatch && fractionMatch[1]) {
      const fraction = fractionMatch[1].replace(/\./g, "");
      const centsMatch = snippet.match(/andes-money-amount__cents["'][^>]*>([0-9]+)</i);
      const cents = centsMatch ? centsMatch[1] : "00";
      const parsed = parseFloat(`${fraction}.${cents}`);
      if (!isNaN(parsed) && parsed > 0 && parsed < 100000 && !hasBlockedPriceContext(snippet)) {
        console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_7_MERCADOLIVRE_SPECIFIC (second-line DOM)`);
        return parsed;
      }
    }
  }

  // andes-money-amount__fraction fora de blocos de preço original
  const mlFractionMatches = content.matchAll(/andes-money-amount__fraction["'][^>]*>([0-9\.]+)</gi);
  for (const m of mlFractionMatches) {
    if (!m[1]) continue;
    const matchIdx = m.index || 0;
    const snippet = content.slice(Math.max(0, matchIdx - 150), Math.min(content.length, matchIdx + 150));
    
    if (hasBlockedPriceContext(snippet)) {
      continue;
    }

    const centsMatch = snippet.match(/andes-money-amount__cents["'][^>]*>([0-9]+)</i);
    const fraction = m[1].replace(/\./g, "");
    const cents = centsMatch ? centsMatch[1] : "00";
    const parsed = parseFloat(`${fraction}.${cents}`);
    if (!isNaN(parsed) && parsed > 0 && parsed < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${parsed.toFixed(2)} localizado via ESTRATÉGIA_7_MERCADOLIVRE_SPECIFIC (andes-money-amount)`);
      return parsed;
    }
  }

  return null;
}

/** 8. Regex como último recurso */
function tryStrategy8RegexFallback(content: string): number | null {
  const dePorMatch = content.match(/(?:de|De)\s*R\$\s*[\d\.,]+\s*(?:por|Por|por apenas)\s*R\$\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i);
  if (dePorMatch && dePorMatch[1]) {
    const val = parseBrlNumber(dePorMatch[1]);
    if (val > 0 && val < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${val.toFixed(2)} localizado via ESTRATÉGIA_8_REGEX ('De ... Por')`);
      return val;
    }
  }

  const porApenasMatch = content.match(/(?:por\s+apenas|pre[çc]o\s+atual|por|pre[çc]o)\s*:?\s*R\$\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i);
  if (porApenasMatch && porApenasMatch[1]) {
    const val = parseBrlNumber(porApenasMatch[1]);
    if (val > 0 && val < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${val.toFixed(2)} localizado via ESTRATÉGIA_8_REGEX ('Por apenas / Preço')`);
      return val;
    }
  }

  const allBrlMatches = content.matchAll(/R\$\s*([0-9]+(?:[\.,][0-9]{1,2})?)/gi);
  for (const m of allBrlMatches) {
    if (!m || !m[1]) continue;
    const matchIdx = m.index || 0;
    const fullSnippet = content.slice(Math.max(0, matchIdx - 35), Math.min(content.length, matchIdx + 35));
    
    if (/(?:\d+x|em até|vezes|parcela)/i.test(fullSnippet)) continue;
    if (/(?:de|De)\s*R\$/i.test(fullSnippet) && !/(?:por|Por)\s*R\$/i.test(fullSnippet)) continue;
    if (/(?:original-price|previous|strikethrough|<s>)/i.test(fullSnippet)) continue;

    const val = parseBrlNumber(m[1]);
    if (val > 0 && val < 100000) {
      console.log(`[Scraper Price Log] Preço R$ ${val.toFixed(2)} localizado via ESTRATÉGIA_8_REGEX (Geral)`);
      return val;
    }
  }

  return null;
}

function parseBrlNumber(raw: string): number {
  if (!raw || typeof raw !== "string") return 0;
  let str = raw.trim().replace("R$", "").trim();
  if (str.includes(".") && str.includes(",")) {
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (str.includes(",")) {
    str = str.replace(",", ".");
  }
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

export function extractTitleFromUrl(url: string): string | null {
  if (!url) return null;

  // Shopee URL: shopee.com.br/SLUG-i.SHOPID.ITEMID
  const shopeeMatch1 = url.match(/shopee\.com\.br\/([^\?\/]+)-i\.(\d+)\.(\d+)/i);
  if (shopeeMatch1 && shopeeMatch1[1]) {
    const raw = decodeURIComponent(shopeeMatch1[1]).replace(/-/g, " ").trim();
    if (raw && raw.length > 2 && raw.toLowerCase() !== "product") return raw;
  }

  // Shopee URL com 4 segmentos: shopee.com.br/{loja}/{slug-do-produto}/{shopid}/{itemid}
  const shopeeMatch3 = url.match(/shopee\.com\.br\/[^\/]+\/([^\/]+)\/(\d+)\/(\d+)/i);
  if (shopeeMatch3 && shopeeMatch3[1] && !/^\d+$/.test(shopeeMatch3[1])) {
    const raw = decodeURIComponent(shopeeMatch3[1]).replace(/-/g, " ").trim();
    if (raw && raw.length > 2 && raw.toLowerCase() !== "product") return raw;
  }

  // Mercado Livre URL: MLB-3564024329-slug-name...
  const mlMatch = url.match(/MLB-?\d+-([a-zA-Z0-9\-]+)/i);
  if (mlMatch && mlMatch[1]) {
    const raw = mlMatch[1]
      .replace(/-_JM/gi, "")
      .replace(/-/g, " ")
      .trim();
    if (raw && raw.length > 2) return raw;
  }

  return null;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .replace(/\s*[\-\|]\s*(Mercado Livre|Shopee Brasil|Shopee|Magalu|Amazon|AliExpress).*$/i, "")
    .trim();
}

/**
 * Diagnostic logger requested by user
 */
function printScraperDebugLog(params: {
  targetUrl: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  html: string;
  combinedContent: string;
  jsonLdImages: string[];
  ogImages: string[];
  shopeeImages: string[];
  mlImages: string[];
  finalImages: string[];
  jsonLdPrice: number | null;
  ogPrice: number | null;
  finalPrice: number | null;
}) {
  const {
    targetUrl,
    finalUrl,
    httpStatus,
    contentType,
    combinedContent,
    jsonLdImages,
    ogImages,
    shopeeImages,
    mlImages,
    finalImages,
    jsonLdPrice,
    ogPrice,
    finalPrice
  } = params;

  const isShopee = targetUrl.includes("shopee") || targetUrl.includes("shope.ee") || finalUrl.includes("shopee");
  const isMercadoLivre = targetUrl.includes("mercadolivre") || targetUrl.includes("mercadolibre") || finalUrl.includes("mercadolivre");
  const marketplace = isShopee ? "Shopee" : isMercadoLivre ? "Mercado Livre" : "Outro / E-Commerce Generalista";

  // 1. IMAGENS POR FONTE
  // __NEXT_DATA__
  const nextDataMatch = combinedContent.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  const nextDataImages: string[] = [];
  if (nextDataMatch && nextDataMatch[1]) {
    const imgMatches = nextDataMatch[1].matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)/gi);
    for (const m of imgMatches) {
      if (!nextDataImages.includes(m[0])) nextDataImages.push(m[0]);
    }
  }

  // __INITIAL_STATE__
  const initialStateMatch = combinedContent.match(/__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i);
  const initialStateImages: string[] = [];
  if (initialStateMatch && initialStateMatch[1]) {
    const imgMatches = initialStateMatch[1].matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)/gi);
    for (const m of imgMatches) {
      if (!initialStateImages.includes(m[0])) initialStateImages.push(m[0]);
    }
  }

  // __PRELOADED_STATE__
  const preloadedStateMatch = combinedContent.match(/__PRELOADED_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i);
  const preloadedStateImages: string[] = [];
  if (preloadedStateMatch && preloadedStateMatch[1]) {
    const imgMatches = preloadedStateMatch[1].matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:jpg|jpeg|png|webp)/gi);
    for (const m of imgMatches) {
      if (!preloadedStateImages.includes(m[0])) preloadedStateImages.push(m[0]);
    }
  }

  // DOM Images
  const domImageMatches = combinedContent.matchAll(/<img[^>]+(?:src|data-src|data-zoom)=["']([^"']+)["']/gi);
  const domImages: string[] = [];
  for (const m of domImageMatches) {
    if (m[1] && m[1].startsWith("http") && !domImages.includes(m[1])) {
      domImages.push(m[1]);
    }
  }

  // Algoritmo que escolheu images[0]
  let image0Source = "Nenhuma imagem encontrada";
  if (finalImages.length > 0) {
    const firstImg = finalImages[0];
    if (jsonLdImages.includes(firstImg)) image0Source = "JSON-LD";
    else if (ogImages.includes(firstImg)) image0Source = "OpenGraph";
    else if (shopeeImages.includes(firstImg)) image0Source = "Shopee CDN Regex";
    else if (mlImages.includes(firstImg)) image0Source = "Mercado Livre CDN Regex";
    else if (nextDataImages.includes(firstImg)) image0Source = "__NEXT_DATA__";
    else if (initialStateImages.includes(firstImg)) image0Source = "__INITIAL_STATE__";
    else if (domImages.includes(firstImg)) image0Source = "DOM (<img src>)";
    else image0Source = "Dedupe/Outra Fonte";
  }

  // 2. PREÇO BRUTO
  let offersPriceRaw: string | null = null;
  let offersLowPriceRaw: string | null = null;
  let aggregateOfferRaw: string | null = null;
  let priceRaw: string | null = null;
  let priceMinRaw: string | null = null;
  let priceBeforeDiscountRaw: string | null = null;
  let priceMaxRaw: string | null = null;

  const mOffersPrice = combinedContent.match(/"offers"[\s\S]*?"price"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mOffersPrice) offersPriceRaw = mOffersPrice[1];

  const mOffersLowPrice = combinedContent.match(/"lowPrice"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mOffersLowPrice) offersLowPriceRaw = mOffersLowPrice[1];

  const mAggregateOffer = combinedContent.match(/"@type"\s*:\s*"AggregateOffer"[\s\S]*?"lowPrice"\s*:\s*"?([0-9\.,]+)"?/i) ||
                          combinedContent.match(/"@type"\s*:\s*"AggregateOffer"[\s\S]*?"price"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mAggregateOffer) aggregateOfferRaw = mAggregateOffer[1];

  const mPrice = combinedContent.match(/"price"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mPrice) priceRaw = mPrice[1];

  const mPriceMin = combinedContent.match(/"price_min"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mPriceMin) priceMinRaw = mPriceMin[1];

  const mPriceBeforeDiscount = combinedContent.match(/"price_before_discount"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mPriceBeforeDiscount) priceBeforeDiscountRaw = mPriceBeforeDiscount[1];

  const mPriceMax = combinedContent.match(/"price_max"\s*:\s*"?([0-9\.,]+)"?/i);
  if (mPriceMax) priceMaxRaw = mPriceMax[1];

  const formatRawAndConverted = (raw: string | null) => {
    if (!raw) return "Não encontrado";
    const num = parseFloat(raw);
    if (isNaN(num)) return `Bruto: "${raw}"`;
    if (num > 100000) {
      let converted = num;
      if (num > 10000000) converted = num / 100000000;
      else if (num > 100000) converted = num / 100000;
      return `Bruto: ${raw} -> Convertido: R$ ${converted.toFixed(2)}`;
    }
    return `Bruto: ${raw} (R$ ${num.toFixed(2)})`;
  };

  // DOM Selectors
  const domPriceSelectors: string[] = [];

  const itempropMatches = combinedContent.matchAll(/<[^>]+itemprop=["']price["'][^>]*>(?:R\$\s*)?([0-9\.,]+)?/gi);
  for (const m of itempropMatches) {
    domPriceSelectors.push(m[0].slice(0, 120));
  }

  const mlSecondLine = combinedContent.match(/ui-pdp-price__second-line[\s\S]*?(?:<\/div>|<\/section>)/i);
  if (mlSecondLine) {
    domPriceSelectors.push(`ui-pdp-price__second-line: "${mlSecondLine[0].replace(/\s+/g, ' ').slice(0, 150)}"`);
  }

  const classPriceMatches = combinedContent.matchAll(/<[^>]+class=["'][^"']*(?:price|preco|valor|andes-money-amount)[^"']*["'][^>]*>(?:R\$\s*)?([0-9\.,]+)?/gi);
  let countDom = 0;
  for (const m of classPriceMatches) {
    if (countDom++ < 5) {
      domPriceSelectors.push(m[0].slice(0, 120));
    }
  }

  let priceSource = "Nenhuma (null)";
  if (jsonLdPrice !== null) priceSource = "JSON-LD (offers.price / lowPrice)";
  else if (ogPrice !== null) priceSource = "OpenGraph (og:price:amount)";
  else if (priceMinRaw || priceRaw) priceSource = "Dados Internos JS (price_min / price)";
  else if (finalPrice !== null) priceSource = "Heurística DOM / Regex Fallback";

  let imagesSource = "Nenhuma";
  if (jsonLdImages.length > 0) imagesSource = "JSON-LD";
  else if (ogImages.length > 0) imagesSource = "OpenGraph";
  else if (shopeeImages.length > 0) imagesSource = "Shopee CDN Regex";
  else if (mlImages.length > 0) imagesSource = "Mercado Livre CDN Regex";
  else if (domImages.length > 0) imagesSource = "DOM";

  if (isShopee) {
    const shopeeFieldFound = priceMinRaw ? "price_min" : priceRaw ? "price" : "Nenhum (Campos de preço na estrutura SSR do MFE/BFF foram estripados/removidos pelo backend da Shopee e constam como null)";
    const shopeeRawVal = priceMinRaw || priceRaw || "null";
    const shopeePath = "initialState.DOMAIN_PDP.data.PDP_BFF_DATA.cachedMap[{shop_id}/{item_id}].item.price";
    const shopeeScale = (priceMinRaw || priceRaw) ? (parseFloat(shopeeRawVal) > 100000 ? "Divisão por 100.000 (micro-unidade)" : "Sem divisão") : "N/A (Campos nulos)";
    const shopeeConverted = finalPrice !== null ? `R$ ${finalPrice.toFixed(2)}` : "null";
    const shopeePriceType = finalPrice !== null ? "Preço promocional / atual" : "N/A";
    const shopeeSource = "HTML SSR MFE/BFF (Shopee)";
    const shopeeFinal = finalPrice !== null ? `R$ ${finalPrice.toFixed(2)}` : "null (Preço não disponível no SSR da Shopee)";

    console.log(`
[SHOPEE PRICE DEBUG]
URL canônica: ${finalUrl}
Campo encontrado: ${shopeeFieldFound}
Valor bruto: ${shopeeRawVal}
Caminho JSON: ${shopeePath}
Escala aplicada: ${shopeeScale}
Preço convertido: ${shopeeConverted}
Tipo de preço: ${shopeePriceType}
Fonte: ${shopeeSource}
Resultado final: ${shopeeFinal}
`);
  }

  console.log(`
=== SCRAPER DEBUG ===

Marketplace identificado: ${marketplace}
URL final após redirecionamentos: ${finalUrl}
Status HTTP: ${httpStatus}
Content-Type: ${contentType}

IMAGENS
- Quantas imagens foram encontradas no JSON-LD: ${jsonLdImages.length}
- Quantas no __NEXT_DATA__: ${nextDataImages.length}
- Quantas no __INITIAL_STATE__: ${initialStateImages.length}
- Quantas no __PRELOADED_STATE__: ${preloadedStateImages.length}
- Quantas no OpenGraph: ${ogImages.length}
- Quantas no DOM: ${domImages.length}

Primeiras URLs por fonte (até 10):
  * JSON-LD (${jsonLdImages.length}):
${jsonLdImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}
  * __NEXT_DATA__ (${nextDataImages.length}):
${nextDataImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}
  * __INITIAL_STATE__ (${initialStateImages.length}):
${initialStateImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}
  * __PRELOADED_STATE__ (${preloadedStateImages.length}):
${preloadedStateImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}
  * OpenGraph (${ogImages.length}):
${ogImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}
  * DOM (${domImages.length}):
${domImages.slice(0, 10).map(u => `    - ${u}`).join("\n") || "    (nenhuma)"}

Algoritmo que escolheu images[0]: ${image0Source} (URL: ${finalImages[0] || 'N/A'})

PREÇO

Valores brutos e convertidos:
- offers.price: ${formatRawAndConverted(offersPriceRaw)}
- offers.lowPrice: ${formatRawAndConverted(offersLowPriceRaw)}
- AggregateOffer: ${formatRawAndConverted(aggregateOfferRaw)}
- price: ${formatRawAndConverted(priceRaw)}
- price_min: ${formatRawAndConverted(priceMinRaw)}
- price_before_discount: ${formatRawAndConverted(priceBeforeDiscountRaw)}
- price_max: ${formatRawAndConverted(priceMaxRaw)}

Seletores DOM contendo preço encontrados:
${domPriceSelectors.map(s => `  - ${s}`).join("\n") || "  (nenhum seletor DOM de preço localizado)"}

RESULTADO FINAL

Fonte escolhida para imagens: ${imagesSource}
Fonte escolhida para preço: ${priceSource}
Quantidade final de imagens: ${finalImages.length}
Preço final: ${finalPrice !== null ? `R$ ${finalPrice.toFixed(2)}` : "null (não encontrado)"}
=====================
`);
}
