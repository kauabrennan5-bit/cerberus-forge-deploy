import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

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
  if (!supabase) return [];
  
  const { data, error } = await supabase
    .from("catalog_categories")
    .select("*")
    .order("name", { ascending: true });
    
  if (error) {
    console.error("❌ [Categories Repo] Erro ao buscar categorias:", error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Adiciona uma nova categoria
 */
export async function addCategory(name: string): Promise<Category | null> {
  if (!supabase) return null;
  
  const { data, error } = await supabase
    .from("catalog_categories")
    .insert([{ name }])
    .select()
    .single();
    
  if (error) {
    console.error("❌ [Categories Repo] Erro ao adicionar categoria:", error.message);
    return null;
  }
  
  return data;
}

/**
 * Renomeia uma categoria e atualiza todos os produtos vinculados (Cascata manual)
 */
export async function renameCategory(oldName: string, newName: string): Promise<boolean> {
  if (!supabase) return false;
  
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
      console.warn("⚠️ [Categories Repo] Categoria renomeada, mas falha ao atualizar produtos:", prodError.message);
    }
    
    return true;
  } catch (err: any) {
    console.error("❌ [Categories Repo] Erro ao renomear categoria:", err.message);
    return false;
  }
}
