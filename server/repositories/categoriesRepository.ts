import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { syncCatalogAndDeploy } from "../services/catalogSync";

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

  const sync = await syncCatalogAndDeploy(`categoria adicionada: ${name}`);
  if (!sync.success) {
    throw new Error(`CATALOG_SYNC:${sync.diagnostic?.code || "PUBLICATION_ERROR"}:${sync.operationId}`);
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

    const sync = await syncCatalogAndDeploy(`categoria renomeada: ${oldName} → ${newName}`);
    if (!sync.success) {
      throw new Error(`CATALOG_SYNC:${sync.diagnostic?.code || "PUBLICATION_ERROR"}:${sync.operationId}`);
    }

    return true;
  } catch (err: any) {
    console.error("❌ [Categories Repo] Erro ao renomear categoria:", err.message);
    throw err;
  }
}
