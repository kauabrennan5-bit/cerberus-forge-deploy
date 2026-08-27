import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateSlug } from "../../src/data/initialProducts";
import { Product, ProductStatus, PromotionOffer } from "../../src/types";
import { normalizePromotionOffer } from "../services/promotionOffer";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";

dotenv.config();

// Initialize Supabase Client prioritizing Service Role Key for server-side administrative access (bypassing RLS)
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || "";
// A migration editorial é um gate explícito. Antes de ela ser aplicada, o
// repositório continua escrevendo somente colunas existentes em produção.
const editorialFieldsEnabled = process.env.PRODUCT_EDITORIAL_FIELDS_ENABLED === "true";

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (supabase) {
  console.log("⚡ [Supabase] PostgreSQL ativado e conectado no Repository!");
  console.log(`⚡ [Supabase] URL: ${supabaseUrl}`);
} else {
  console.error("❌ [Supabase Config Error] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configurados nas variáveis de ambiente!");
}

/**
 * Garante que o cliente Supabase esteja ativo. Não permite fallback local.
 */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      "CONFIGURAÇÃO INCORRETA DO SISTEMA: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_KEY) são obrigatórios. O catálogo exige acesso direto à tabela public.products do Supabase como fonte única de verdade."
    );
  }
  return supabase;
}

/**
 * Valida se a URL de aquisição de um produto é um link válido de produto real
 */
export function isValidProductLink(link?: string): boolean {
  if (!link || typeof link !== "string") return false;
  const trimmed = link.trim();
  if (!trimmed || trimmed === "#") return false;
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.trim();
    // Rejeita links genéricos de home page (ex: https://shopee.com.br/ sem caminho)
    if ((path === "" || path === "/") && !parsed.search) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Salva a lista de produtos diretamente na tabela public.products do Supabase
 */
async function saveProducts(products: Product[], syncCatalog = true): Promise<void> {
  const client = requireSupabase();

  const formatted = products.map((p) => {
    const productRow: Record<string, unknown> = {
      id: p.id,
      ref: p.ref,
      produto: p.produto,
      categoria: p.categoria,
      preco: Number(p.preco) || 0,
      imagens: p.imagens,
      link: p.link,
      ativo: p.ativo !== undefined ? p.ativo : true,
      destaque: Boolean(p.destaque),
      status: p.status || "published",
      created_by: p.createdBy || "system",
      slug: p.slug || generateSlug(p.produto),
      descricao: p.descricao || "",
      pagina_ponte_url: p.paginaPonteUrl || "",
      oferta_promocional: normalizePromotionOffer(p.ofertaPromocional) || null,
    };
    if (editorialFieldsEnabled) {
      productRow.raw_title = p.rawTitle || p.produto;
      productRow.display_title = p.displayTitle || null;
      productRow.curator_note = p.curatorNote || null;
    }
    return productRow;
  });

  console.log(`[Supabase] Gravando ${formatted.length} produtos em public.products...`);
  const { error } = await client.from("products").upsert(formatted, { onConflict: "id" });
  if (error) {
    console.error("❌ [Supabase] ERRO CRÍTICO AO GRAVAR EM public.products:", error.message);
    throw new Error(`Falha de persistência no banco Supabase (public.products): ${error.message}`);
  }
  console.log("✅ [Supabase] Gravação em public.products concluída com sucesso!");

  // A projeção pública e a validação E2E fazem parte do contrato de uma mutação publicada.
  // O pipeline de publicação pode desabilitar esta etapa para controlar uma única sincronização transacional.
  if (syncCatalog) {
    const { syncCatalogAndDeploy } = await import("../services/catalogSync");
    const sync = await syncCatalogAndDeploy("mutação de produto");
    if (!sync.success) {
      throw new Error(`CATALOG_SYNC:${sync.diagnostic?.code || "PUBLICATION_ERROR"}:${sync.operationId}`);
    }
  }
}

/**
 * Busca todos os produtos diretamente da tabela public.products do Supabase
 */
export async function getProducts(): Promise<Product[]> {
  const client = requireSupabase();

  const { data, error } = await client
    .from("products")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("❌ ERRO CRÍTICO NO SUPABASE ao buscar produtos em public.products:", error.message);
    throw new Error(`Falha de consulta no banco de dados Supabase (public.products): ${error.message}`);
  }

  if (Array.isArray(data)) {
    const mapped = data.map((item: any) => ({
      id: item.id,
      ref: item.ref || item.ref_code,
      produto: item.produto || item.title || item.name,
      rawTitle: item.raw_title || item.rawTitle || undefined,
      displayTitle: item.display_title || item.displayTitle || undefined,
      categoria: resolvePublicProductCategory(item.categoria || item.category, {
        title: item.display_title || item.displayTitle || item.raw_title || item.produto || item.title || item.name,
        description: item.descricao || item.description,
      }),
      preco: Number(item.preco || item.price || 0),
      imagens: Array.isArray(item.imagens)
        ? item.imagens
        : typeof item.imagens === "string"
        ? JSON.parse(item.imagens)
        : [],
      link: item.link || item.affiliate_url,
      ativo: item.ativo !== undefined ? item.ativo : true,
      destaque: Boolean(item.destaque),
      status: item.status || "published",
      createdBy: item.created_by || item.createdBy,
      slug: item.slug || generateSlug(item.produto || ""),
      descricao: item.descricao || item.description || "",
      paginaPonteUrl: item.pagina_ponte_url || item.paginaPonteUrl || "",
      ofertaPromocional: normalizePromotionOffer(item.oferta_promocional ?? item.ofertaPromocional),
      curatorNote: item.curator_note || item.curatorNote || undefined,
      createdAt: item.created_at || item.createdAt,
    }));

    return mapped.filter((p: Product) => isValidProductLink(p.link));
  }

  return [];
}

/**
 * Busca produto por ID ou Slug
 */
export async function getProductByIdOrSlug(idOrSlug: string): Promise<Product | null> {
  const products = await getProducts();
  return products.find(
    (p) => p.id === idOrSlug || p.slug === idOrSlug || generateSlug(p.produto) === idOrSlug
  ) || null;
}

/**
 * Cria um novo produto no repositório canônico (Supabase + projeção sincronizada).
 * Com deduplicação inteligente por URL e ID de Marketplace.
 */
export async function createProduct(input: {
  produto: string;
  categoria: string;
  preco: number;
  imagens: string[] | string;
  link: string;
  destaque?: boolean;
  descricao?: string;
  paginaPonteUrl?: string;
  status?: ProductStatus;
  ref?: string;
  ofertaPromocional?: PromotionOffer;
  rawTitle?: string;
  displayTitle?: string;
  curatorNote?: string;
  imageEditorialStatus?: Product["imageEditorialStatus"];
  imageCuration?: Product["imageCuration"];
}, options: { syncCatalog?: boolean } = {}): Promise<Product> {
  const products = await getProducts();
  const inputLink = input.link.trim();

  // Deduplicação: verifica se um produto com o mesmo link já existe
  const existingProduct = products.find((p) => {
    if (!p.link) return false;
    if (p.link.trim() === inputLink) return true;
    try {
      const u1 = new URL(p.link);
      const u2 = new URL(inputLink);
      if (u1.hostname.toLowerCase() === u2.hostname.toLowerCase() && u1.pathname === u2.pathname) {
        return true;
      }
    } catch {}
    return false;
  });

  if (existingProduct) {
    console.log(`[Repository Deduplication] Produto duplicado detectado (ID: ${existingProduct.id}). Atualizando existente...`);
    const imagesArray = Array.isArray(input.imagens)
      ? input.imagens
      : typeof input.imagens === "string"
      ? input.imagens.split(" | ").filter(Boolean)
      : [];

    const updated = await updateProduct(existingProduct.id, {
      produto: input.produto.trim(),
      categoria: input.categoria.trim(),
      preco: Number(input.preco) || 0,
      imagens: imagesArray.length > 0 ? imagesArray : existingProduct.imagens,
      link: inputLink,
      descricao: (input.descricao || "").trim() || existingProduct.descricao,
      rawTitle: input.rawTitle?.trim() || existingProduct.rawTitle,
      displayTitle: input.displayTitle?.trim() || existingProduct.displayTitle,
      curatorNote: input.curatorNote?.trim() || existingProduct.curatorNote,
      status: input.status || "published",
      ofertaPromocional: normalizePromotionOffer(input.ofertaPromocional) || existingProduct.ofertaPromocional,
    }, options);

    if (updated) return updated;
  }

  const id = `prod-${Date.now()}`;
  const baseSlug = generateSlug(input.produto);
  const slug = products.some(product => product.slug === baseSlug)
    ? `${baseSlug}-${Date.now().toString(36).slice(-4)}`
    : baseSlug;
  const ref = input.ref || `REF-${(products.length + 1).toString().padStart(3, "0")}`;

  const imagesArray = Array.isArray(input.imagens)
    ? input.imagens
    : typeof input.imagens === "string"
    ? input.imagens.split(" | ").filter(Boolean)
    : [];

  const newProduct: Product = {
    id,
    ref,
    produto: input.produto.trim(),
    categoria: input.categoria.trim(),
    preco: Number(input.preco) || 0,
    imagens: imagesArray,
    link: inputLink,
    ativo: true,
    destaque: Boolean(input.destaque),
    status: input.status || "published",
    slug,
    descricao: (input.descricao || "").trim(),
    rawTitle: input.rawTitle?.trim() || input.produto.trim(),
    displayTitle: input.displayTitle?.trim(),
    curatorNote: input.curatorNote?.trim(),
    paginaPonteUrl: (input.paginaPonteUrl || "").trim(),
    ofertaPromocional: normalizePromotionOffer(input.ofertaPromocional),
    imageEditorialStatus: input.imageEditorialStatus,
    imageCuration: input.imageCuration,
  };

  products.unshift(newProduct);
  await saveProducts(products, options.syncCatalog !== false);
  return newProduct;
}

/**
 * Atualiza um produto por ID
 */
export async function updateProduct(
  id: string,
  updateData: Partial<Product>,
  options: { syncCatalog?: boolean } = {}
): Promise<Product | null> {
  const products = await getProducts();
  const index = products.findIndex((p) => p.id === id);
  if (index === -1) return null;

  const updatedProduct: Product = {
    ...products[index],
    ...updateData,
    ...(updateData.produto ? { slug: generateSlug(updateData.produto) } : {})
  };

  products[index] = updatedProduct;
  await saveProducts(products, options.syncCatalog !== false);
  return updatedProduct;
}

/**
 * Exclui produto por ID
 */
export async function deleteProduct(id: string): Promise<boolean> {
  console.log('[ARCHIVE] Entrada na função deleteProduct(); identificador recebido:', id);
  const products = await getProducts();
  const target = products.find(
    (p) => p.id === id || p.slug === id || generateSlug(p.produto) === id || p.ref === id
  );

  if (!target) {
    console.log('[DELETE] Nenhum produto correspondente encontrado em public.products.');
    return false;
  }

  const archived = await updateProduct(target.id, { ativo: false, status: "archived" });
  if (!archived) throw new Error(`Falha ao arquivar produto ${target.id}.`);
  console.log(`[Supabase] Produto "${target.produto}" arquivado em public.products; nenhum dado foi apagado.`);
  return true;
}

export async function pauseProduct(id: string): Promise<Product | null> {
  return updateProduct(id, { ativo: false, status: "paused" });
}

export async function reactivateProduct(id: string): Promise<Product | null> {
  return updateProduct(id, { ativo: true, status: "published" });
}

/**
 * Atualiza a oferta observada de uma peça já publicada sem tocar em `preco`.
 * A identidade é o link oficial da review; a projeção pública só é considerada
 * concluída após o mesmo sync+validação canônicos da publicação original.
 */
export async function updatePublishedPromotionByLink(
  reviewLink: string,
  ofertaPromocional: PromotionOffer,
): Promise<Product | null> {
  const normalizedOffer = normalizePromotionOffer(ofertaPromocional);
  if (!normalizedOffer) throw new Error("PROMOTION_VALIDATION_ERROR");
  const products = await getProducts();
  const target = products.find((product) => {
    if (!product.link) return false;
    if (product.link.trim() === reviewLink.trim()) return true;
    try {
      const existing = new URL(product.link);
      const incoming = new URL(reviewLink);
      return existing.hostname.toLowerCase() === incoming.hostname.toLowerCase()
        && existing.pathname === incoming.pathname;
    } catch {
      return false;
    }
  });
  if (!target || target.ativo === false || target.status !== "published") return null;

  const previousOffer = target.ofertaPromocional;
  const updated = await updateProduct(target.id, { ofertaPromocional: normalizedOffer }, { syncCatalog: false });
  if (!updated) throw new Error("PROMOTION_PERSISTENCE_ERROR");

  const { syncCatalogAndDeploy } = await import("../services/catalogSync");
  const sync = await syncCatalogAndDeploy(`oferta promocional atualizada: ${updated.produto}`, updated.id);
  if (sync.success) return updated;

  // Compensação não destrutiva: a review não deve afirmar uma oferta pública
  // se a projeção não foi validada. Mantém o preço-base e restaura a oferta anterior.
  await updateProduct(updated.id, { ofertaPromocional: previousOffer }, { syncCatalog: false });
  await syncCatalogAndDeploy(`rollback de oferta promocional: ${updated.produto}`, updated.id);
  throw new Error(`PROMOTION_SYNC_ERROR:${sync.diagnostic?.code || sync.error || "PUBLICATION_ERROR"}`);
}

export interface ProductClickData {
  productId: string;
  productSlug?: string;
  productName?: string;
  productPrice?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  referrer?: string;
  landingPage?: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Registra um clique exclusivamente em public.product_clicks no Supabase.
 * Falhas de configuração, schema ou persistência são propagadas ao chamador;
 * nenhum dado de analytics é gravado em arquivo local.
 */
export async function recordProductClick(clickData: ProductClickData): Promise<boolean> {
  const clickRecord = {
    product_id: clickData.productId,
    product_slug: clickData.productSlug || '',
    product_name: clickData.productName || '',
    product_price: Number(clickData.productPrice) || 0,
    utm_source: clickData.utm_source || null,
    utm_medium: clickData.utm_medium || null,
    utm_campaign: clickData.utm_campaign || null,
    utm_content: clickData.utm_content || null,
    utm_term: clickData.utm_term || null,
    fbclid: clickData.fbclid || null,
    gclid: clickData.gclid || null,
    ttclid: clickData.ttclid || null,
    referrer: clickData.referrer || null,
    landing_page: clickData.landingPage || null,
    user_agent: clickData.userAgent || null,
    ip_address: clickData.ipAddress || null,
    created_at: new Date().toISOString()
  };

  const client = requireSupabase();
  const { error } = await client.from("product_clicks").insert([clickRecord]);

  if (error) {
    console.error("❌ Erro ao registrar clique no Supabase public.product_clicks:", error.message);
    throw new Error(`Falha ao registrar clique no Supabase (public.product_clicks): ${error.message}`);
  }

  console.log(`📊 Clique no produto registrado no Supabase: ${clickData.productName || clickData.productId}`);
  return true;
}



export async function getAnalyticsSummary(): Promise<any> {
  let clicks: any[] = [];
  if (!supabase) {
    throw new Error("Supabase não está configurado para analytics operacionais.");
  }
  const { data, error } = await supabase.from("product_clicks").select("*");
  if (error) {
    throw new Error("Falha ao consultar public.product_clicks no Supabase: " + error.message);
  }
  clicks = data || [];

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let todayClicks = 0;
  let clicks7d = 0;
  let clicks30d = 0;
  const productCounts: Record<string, { name: string; count: number }> = {};
  const marketplaceCounts: Record<string, number> = { Shopee: 0, "Mercado Livre": 0 };

  for (const c of clicks) {
    const createdAt = c.created_at ? new Date(c.created_at) : new Date();
    const dateStr = createdAt.toISOString().slice(0, 10);
    if (dateStr === todayStr) todayClicks++;
    if (createdAt >= sevenDaysAgo) clicks7d++;
    if (createdAt >= thirtyDaysAgo) clicks30d++;

    const pName = c.product_name || c.product_id || "Desconhecido";
    if (!productCounts[pName]) {
      productCounts[pName] = { name: pName, count: 0 };
    }
    productCounts[pName].count++;

    const lowerName = pName.toLowerCase();
    if (lowerName.includes("mercadolivre") || lowerName.includes("meli") || lowerName.includes("mercado livre")) {
      marketplaceCounts["Mercado Livre"] = (marketplaceCounts["Mercado Livre"] || 0) + 1;
    } else {
      marketplaceCounts["Shopee"] = (marketplaceCounts["Shopee"] || 0) + 1;
    }
  }

  const topProducts = Object.values(productCounts).sort((a, b) => b.count - a.count).slice(0, 5);

  const products = await getProducts();
  const totalProducts = products.length;
  const activeProducts = products.filter(p => p.ativo !== false).length;

  return {
    totalProducts,
    activeProducts,
    inactiveProducts: totalProducts - activeProducts,
    totalClicks: clicks.length,
    todayClicks,
    clicks7d,
    clicks30d,
    marketplaceCounts,
    topProducts
  };
}

/**
 * Retorna os detalhes de analytics para um produto específico (por ID, REF ou Slug) e período (today, 7d, 30d, total)
 */
export async function getProductAnalytics(identifier: string, period: string = '7d'): Promise<any> {
  const products = await getProducts();
  const product = products.find(p => p.id === identifier || p.ref === identifier || p.slug === identifier || generateSlug(p.produto) === identifier);

  if (!product) {
    return null;
  }

  if (!supabase) {
    throw new Error("Supabase não está configurado para analytics operacionais.");
  }

  const { data, error } = await supabase
    .from("product_clicks")
    .select("*")
    .eq("product_id", product.id);

  if (error) {
    throw new Error("Falha ao consultar cliques do produto no Supabase: " + error.message);
  }

  const clicks = data || [];
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prev7DaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const prev30DaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  let todayClicks = 0;
  let yesterdayClicks = 0;
  let clicks7d = 0;
  let prevClicks7d = 0;
  let clicks30d = 0;
  let prevClicks30d = 0;
  const marketplaceCounts: Record<string, number> = { Shopee: 0, "Mercado Livre": 0 };
  let lastClickTime: string | null = null;
  let lastUtmSource: string | null = null;

  for (const c of clicks) {
    const createdAt = c.created_at ? new Date(c.created_at) : new Date();
    const dateStr = createdAt.toISOString().slice(0, 10);

    if (!lastClickTime || createdAt > new Date(lastClickTime)) {
      lastClickTime = c.created_at;
      if (c.utm_source) {
        lastUtmSource = c.utm_source;
      }
    }

    if (dateStr === todayStr) todayClicks++;
    if (dateStr === yesterdayStr) yesterdayClicks++;

    if (createdAt >= sevenDaysAgo) {
      clicks7d++;
    } else if (createdAt >= prev7DaysAgo) {
      prevClicks7d++;
    }

    if (createdAt >= thirtyDaysAgo) {
      clicks30d++;
    } else if (createdAt >= prev30DaysAgo) {
      prevClicks30d++;
    }

    const mkt = (c.product_name || "").toLowerCase().includes("mercado") ? "Mercado Livre" : "Shopee";
    marketplaceCounts[mkt] = (marketplaceCounts[mkt] || 0) + 1;
  }

  return {
    product,
    todayClicks,
    yesterdayClicks,
    clicks7d,
    prevClicks7d,
    clicks30d,
    prevClicks30d,
    totalClicks: clicks.length,
    marketplaceCounts,
    lastClickTime: lastClickTime ? new Date(lastClickTime).toLocaleString("pt-BR") : "Nunca",
    lastUtmSource: lastUtmSource || "Não identificada"
  };
}

/**
 * Retorna o ranking de produtos por cliques para um período específico ('today', '7d', '30d', 'total')
 */
export async function getProductAnalyticsRanking(period: string = '7d'): Promise<Array<{ product: Product; count: number }>> {
  const products = await getProducts();
  if (!supabase) {
    throw new Error("Supabase não está configurado para analytics operacionais.");
  }

  const { data, error } = await supabase.from("product_clicks").select("*");
  if (error) {
    throw new Error("Falha ao consultar public.product_clicks no Supabase: " + error.message);
  }

  const clicks = data || [];
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const countsMap: Record<string, number> = {};

  for (const c of clicks) {
    const createdAt = c.created_at ? new Date(c.created_at) : new Date();
    const dateStr = createdAt.toISOString().slice(0, 10);

    let match = false;
    if (period === 'today') {
      if (dateStr === todayStr) match = true;
    } else if (period === '7d') {
      if (createdAt >= sevenDaysAgo) match = true;
    } else if (period === '30d') {
      if (createdAt >= thirtyDaysAgo) match = true;
    } else {
      match = true; // total
    }

    if (match && c.product_id) {
      countsMap[c.product_id] = (countsMap[c.product_id] || 0) + 1;
    }
  }

  const ranking = products.map(product => ({
    product,
    count: countsMap[product.id] || 0
  })).sort((a, b) => b.count - a.count);

  return ranking;
}

/**
 * Retorna produtos com contagem de cliques para listagem analítica
 */
export async function getProductsForAnalytics(): Promise<Array<{ product: Product; totalClicks: number; todayClicks: number; clicks7d: number }>> {
  const products = await getProducts();
  if (!supabase) {
    throw new Error("Supabase não está configurado para analytics operacionais.");
  }

  const { data, error } = await supabase.from("product_clicks").select("*");
  if (error) {
    throw new Error("Falha ao consultar public.product_clicks no Supabase: " + error.message);
  }

  const clicks = data || [];
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const statsMap: Record<string, { total: number; today: number; d7: number }> = {};

  for (const c of clicks) {
    if (!c.product_id) continue;
    if (!statsMap[c.product_id]) {
      statsMap[c.product_id] = { total: 0, today: 0, d7: 0 };
    }
    statsMap[c.product_id].total++;
    const createdAt = c.created_at ? new Date(c.created_at) : new Date();
    if (createdAt.toISOString().slice(0, 10) === todayStr) {
      statsMap[c.product_id].today++;
    }
    if (createdAt >= sevenDaysAgo) {
      statsMap[c.product_id].d7++;
    }
  }

  return products.map(product => {
    const st = statsMap[product.id] || { total: 0, today: 0, d7: 0 };
    return {
      product,
      totalClicks: st.total,
      todayClicks: st.today,
      clicks7d: st.d7
    };
  }).sort((a, b) => b.clicks7d - a.clicks7d || b.totalClicks - a.totalClicks);
}
