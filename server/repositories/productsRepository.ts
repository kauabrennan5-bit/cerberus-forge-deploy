import fs from "fs";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { generateSlug } from "../../src/data/initialProducts";
import { Product } from "../../src/types";
import { exportStaticProductsJson } from "../services/exportProductsJson";
import { syncCatalogToGitHub } from "../services/githubCatalogSync";

dotenv.config();

// Ensure data directory exists for file persistence fallback
const DATA_DIR = path.join(process.cwd(), "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize Supabase Client prioritizing Service Role Key for server-side administrative access (bypassing RLS)
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || "";

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

function saveStoredProductsToFile(products: Product[]) {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), "utf-8");
  } catch (err) {
    console.warn("Aviso ao salvar cópia de backup local:", err);
  }
}

/**
 * Salva a lista de produtos diretamente na tabela public.products do Supabase
 */
async function saveProducts(products: Product[]): Promise<void> {
  const client = requireSupabase();

  saveStoredProductsToFile(products);

  const formatted = products.map((p) => ({
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
    pagina_ponte_url: p.paginaPonteUrl || ""
  }));

  console.log(`[Supabase] Gravando ${formatted.length} produtos em public.products...`);
  const { error } = await client.from("products").upsert(formatted, { onConflict: "id" });
  if (error) {
    console.error("❌ [Supabase] ERRO CRÍTICO AO GRAVAR EM public.products:", error.message);
    throw new Error(`Falha de persistência no banco Supabase (public.products): ${error.message}`);
  }
  console.log("✅ [Supabase] Gravação em public.products concluída com sucesso!");

  // Sincronização automática auxiliar (não-bloqueante se falhar)
  try {
    await exportStaticProductsJson();
    await syncCatalogToGitHub("update: catalog products updated via repository");
  } catch (syncErr: any) {
    console.warn("⚠️ [Sync Info] Aviso na sincronização estática/GitHub:", syncErr?.message);
  }
}

/**
 * Busca todos os produtos diretamente da tabela public.products do Supabase
 */
export async function getProducts(): Promise<Product[]> {
  if (!supabase) {
    console.warn("⚠️ [Supabase Warning] SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configurados nas variáveis de ambiente. Retornando lista vazia.");
    return [];
  }

  const { data, error } = await supabase
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
      categoria: item.categoria || item.category,
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
      paginaPonteUrl: item.pagina_ponte_url || item.paginaPonteUrl || ""
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
 * Cria um novo produto no repositório (Supabase + local fallback)
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
  status?: "pending" | "published";
  ref?: string;
}): Promise<Product> {
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
      status: input.status || "published"
    });

    if (updated) return updated;
  }

  const id = `prod-${Date.now()}`;
  const slug = generateSlug(input.produto);
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
    imagens: imagesArray.length > 0 ? imagesArray : ["https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=800&q=80"],
    link: inputLink,
    ativo: true,
    destaque: Boolean(input.destaque),
    status: input.status || "published",
    slug,
    descricao: (input.descricao || "").trim(),
    paginaPonteUrl: (input.paginaPonteUrl || "").trim()
  };

  products.unshift(newProduct);
  await saveProducts(products);
  return newProduct;
}

/**
 * Atualiza um produto por ID
 */
export async function updateProduct(
  id: string,
  updateData: Partial<Product>
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
  await saveProducts(products);
  return updatedProduct;
}

/**
 * Exclui produto por ID
 */
export async function deleteProduct(id: string): Promise<boolean> {
  console.log('[DELETE LOG 8] Entrada na função deleteProduct() do Repository. ID/Slug procurado:', id);
  let products = await getProducts();
  const target = products.find(
    (p) => p.id === id || p.slug === id || generateSlug(p.produto) === id || p.ref === id
  );

  if (!target) {
    console.log('[DELETE LOG 8] Nenhum produto correspondente encontrado na lista local.');
    return false;
  }

  const targetId = target.id;
  console.log(`[DELETE LOG 8] Produto localizado: "${target.produto}" (ID Real: ${targetId}).`);
  products = products.filter((p) => p.id !== targetId);

  await saveProducts(products);
  console.log(`[DELETE LOG 10] Resultado da exclusão no fallback local (products.json). Produtos restantes: ${products.length}.`);

  if (supabase) {
    try {
      const { data, error } = await supabase.from("products").delete().eq("id", targetId);
      if (error) {
        console.error('[DELETE LOG 9] Erro de exclusão no Supabase:', error);
      } else {
        console.log('[DELETE LOG 9] Resultado da exclusão no Supabase: Sucesso. Supabase data:', data);
      }
    } catch (e) {
      console.error('[DELETE LOG 9] Exceção ao excluir no Supabase:', e);
    }
  } else {
    console.log('[DELETE LOG 9] Supabase não configurado/desativado. Exclusão operando no armazenamento persistente local.');
  }

  // Sincroniza com GitHub (Dispara Rebuild Automático no Render) após remoção
  try {
    console.log(`[Sync] Sincronizando remoção de "${target.produto}" com GitHub...`);
    await syncCatalogToGitHub(`update: remove product ${target.ref} - ${target.produto}`);
  } catch (syncErr) {
    console.error("❌ [GitHub Sync Error] Falha ao sincronizar remoção no GitHub:", syncErr);
  }

  return true;
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
 * Registra o clique de um produto no Supabase (tabela product_clicks)
 * com fallback gracioso em arquivo local (data/clicks.json).
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

  // 1. Grava no Supabase se disponível
  if (supabase) {
    try {
      const { error } = await supabase.from("product_clicks").insert([clickRecord]);
      if (error) {
        if (error.code === "PGRST205" || error.message?.includes("does not exist")) {
          console.warn("⚠️ A tabela 'public.product_clicks' ainda não existe no Supabase. Gravando no fallback local.");
        } else {
          console.error("❌ Erro ao registrar clique no Supabase:", error.message);
        }
      } else {
        console.log(`📊 Clique no produto registrado no Supabase: ${clickData.productName || clickData.productId}`);
      }
    } catch (e: any) {
      console.warn("Exceção ao gravar clique no Supabase:", e?.message);
    }
  }

  // 2. Grava no fallback local em data/clicks.json
  try {
    const clicksFile = path.join(DATA_DIR, "clicks.json");
    let existingClicks: any[] = [];
    if (fs.existsSync(clicksFile)) {
      try {
        existingClicks = JSON.parse(fs.readFileSync(clicksFile, "utf-8"));
        if (!Array.isArray(existingClicks)) existingClicks = [];
      } catch {
        existingClicks = [];
      }
    }
    existingClicks.push(clickRecord);
    if (existingClicks.length > 10000) {
      existingClicks = existingClicks.slice(-10000);
    }
    fs.writeFileSync(clicksFile, JSON.stringify(existingClicks, null, 2), "utf-8");
  } catch (err) {
    console.error("Erro ao gravar clique no fallback local (clicks.json):", err);
  }

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
