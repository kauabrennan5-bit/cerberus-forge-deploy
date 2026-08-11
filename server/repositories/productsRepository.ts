import fs from "fs";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { INITIAL_PRODUCTS, generateSlug } from "../../src/data/initialProducts";
import { Product } from "../../src/types";

dotenv.config();

// Ensure data directory exists for file persistence fallback
const DATA_DIR = path.join(process.cwd(), "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize Supabase Client if credentials are provided in env vars
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

if (supabase) {
  console.log("⚡ Supabase PostgreSQL ativado e conectado no Repository!");
} else {
  console.log("ℹ️ Supabase não configurado no .env. Repository utilizando data/products.json.");
}

function getStoredProductsFromFile(): Product[] {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const raw = fs.readFileSync(PRODUCTS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("Erro ao ler produtos do arquivo:", err);
  }
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(INITIAL_PRODUCTS, null, 2), "utf-8");
  return INITIAL_PRODUCTS as Product[];
}

function saveStoredProductsToFile(products: Product[]) {
  try {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), "utf-8");
  } catch (err) {
    console.error("Erro ao salvar produtos no arquivo:", err);
  }
}

/**
 * Salva a lista de produtos no arquivo local e faz upsert no Supabase (se configurado)
 */
async function saveProducts(products: Product[]): Promise<void> {
  saveStoredProductsToFile(products);

  if (supabase) {
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

    const { error } = await supabase.from("products").upsert(formatted, { onConflict: "id" });
    if (error) {
      if (error.code === "PGRST205") {
        console.warn("⚠️ A tabela 'public.products' ainda não foi criada no Supabase.");
        return;
      }
      console.error("❌ ERRO CRÍTICO AO GRAVAR NO SUPABASE:", error.message);
      throw new Error(`Falha de persistência no banco Supabase: ${error.message}`);
    }
  }
}

/**
 * Busca todos os produtos ativos do banco/cache
 */
export async function getProducts(): Promise<Product[]> {
  if (supabase) {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      if (error.code === "PGRST205") {
        console.warn("⚠️ A tabela 'public.products' ainda não foi criada no Supabase.");
        return getStoredProductsFromFile();
      }
      console.error("❌ ERRO CRÍTICO NO SUPABASE ao buscar produtos:", error.message);
      throw new Error(`Falha de consulta no banco de dados Supabase: ${error.message}`);
    }

    if (Array.isArray(data) && data.length > 0) {
      return data.map((item: any) => ({
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
    }

    if (Array.isArray(data) && data.length === 0) {
      console.log("Seeding Supabase com catálogo inicial...");
      for (const p of INITIAL_PRODUCTS) {
        const { error: seedErr } = await supabase.from("products").insert({
          id: p.id,
          ref: p.ref || `REF-${Math.floor(100 + Math.random() * 900)}`,
          produto: p.produto,
          categoria: p.categoria,
          preco: p.preco,
          imagens: p.imagens,
          link: p.link,
          ativo: p.ativo,
          destaque: p.destaque,
          status: p.status || "published",
          slug: p.slug,
          descricao: p.descricao,
          pagina_ponte_url: p.paginaPonteUrl
        });
        if (seedErr) {
          throw new Error(`Falha ao popular catálogo inicial no Supabase: ${seedErr.message}`);
        }
      }
      return INITIAL_PRODUCTS as Product[];
    }
  }

  return getStoredProductsFromFile();
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
    link: input.link.trim(),
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

