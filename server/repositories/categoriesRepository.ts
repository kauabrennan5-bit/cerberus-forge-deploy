import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { exportStaticProductsJson } from "../services/exportProductsJson";
import { syncCatalogToGitHub } from "../services/githubCatalogSync";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export interface Category {
  id: string;
  name: string;
  created_at?: string;
}

/**
 * Lista todas as categorias cadastradas no Supabase
 */
export async function getCategories(): Promise<Category[]> {
  if (!supabase) {
    throw new Error("Supabase não está configurado para categorias.");
  }
  
  const { data, error } = await supabase
    .from("catalog_categories")
    .select("*")
    .order("name", { ascending: true });
    
  if (error) {
    throw new Error(`Falha ao consultar categorias no Supabase: ${error.message}`);
  }
  
  return data || [];
}

/**
 * Adiciona uma nova categoria
 */
export async function addCategory(name: string): Promise<Category> {
  if (!supabase) {
    throw new Error("Supabase não está configurado para categorias.");
  }
  
  const { data, error } = await supabase
    .from("catalog_categories")
    .insert([{ name }])
    .select()
    .single();
    
  if (error) {
    throw new Error(`Falha ao adicionar categoria no Supabase: ${error.message}`);
  }

  await exportStaticProductsJson();
  const syncOk = await syncCatalogToGitHub(`update: add category ${name}`);
  if (!syncOk) {
    throw new Error("Categoria criada no Supabase, mas a projeção do catálogo não foi sincronizada no GitHub/main.");
  }

  return data;
}

/**
 * Renomeia uma categoria e atualiza todos os produtos vinculados (Cascata manual)
 */
export async function renameCategory(oldName: string, newName: string): Promise<boolean> {
  if (!supabase) {
    throw new Error("Supabase não está configurado para categorias.");
  }
  
  try {
    // 1. Atualiza a categoria na tabela de categorias
    const { error: catError } = await supabase
      .from("catalog_categories")
      .update({ name: newName })
      .eq("name", oldName);
      
    if (catError) throw catError;
    
    // 2. Atualiza todos os produtos que usam a categoria antiga
    const { error: prodError } = await supabase
      .from("products")
      .update({ categoria: newName })
      .eq("categoria", oldName);
      
    if (prodError) {
      throw new Error(`Categoria atualizada, mas os produtos não foram atualizados: ${prodError.message}`);
    }

    await exportStaticProductsJson();
    const syncOk = await syncCatalogToGitHub(`update: rename category ${oldName} to ${newName}`);
    if (!syncOk) {
      throw new Error("Categoria renomeada no Supabase, mas a projeção do catálogo não foi sincronizada no GitHub/main.");
    }

    return true;
  } catch (err: any) {
    console.error("❌ [Categories Repo] Erro ao renomear categoria:", err.message);
    throw err;
  }
}
