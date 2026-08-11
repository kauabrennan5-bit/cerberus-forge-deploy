import fs from "fs";
import path from "path";
import { exportStaticProductsJson } from "./exportProductsJson";
import { getProducts } from "../repositories/productsRepository";

interface SyncLogResult {
  success: boolean;
  product?: string;
  productId?: string;
  supabaseCount: number;
  jsonCount: number;
  staticSiteUrl: string;
  error?: string;
}

/**
 * Serviço de Sincronização do Catálogo Estático (Static Site Sync)
 * Responsável por regenerar o products.json, disparar o deploy hook do Render Static Site
 * e registrar logs estruturados conforme exigido pela arquitetura.
 */
export async function syncCatalogAndDeploy(productTitle?: string, productId?: string): Promise<SyncLogResult> {
  const staticSiteUrl = "https://cerberus-static-catalog.onrender.com";
  const deployHookUrl = process.env.RENDER_STATIC_DEPLOY_HOOK_URL || "";

  console.log("\n==========================================");
  console.log("[STATIC CATALOG SYNC] Iniciando sincronização...");
  console.log(`Produto: ${productTitle || "Rebuild Manual / Geral"}`);
  console.log(`Product ID: ${productId || "N/A"}`);

  let supabaseCount = 0;
  let jsonCount = 0;
  let syncSuccess = false;
  let errorMsg: string | undefined;

  try {
    // 1. Busca produtos do Supabase (Fonte de verdade)
    const rawProducts = await getProducts();
    supabaseCount = rawProducts.length;
    console.log(`Supabase: ${supabaseCount} produtos carregados.`);

    // 2. Gera o /public/data/products.json atualizado e sanitizado
    jsonCount = await exportStaticProductsJson();
    console.log(`products.json gerado com sucesso. Quantidade de produtos válidos: ${jsonCount}`);

    // 3. Dispara o Deploy Hook do Render Static Site (se configurado)
    if (deployHookUrl) {
      console.log(`Deploy/Sync: Acionando Render Static Site Deploy Hook...`);
      const response = await fetch(deployHookUrl, { method: "POST" });
      if (response.ok) {
        syncSuccess = true;
        console.log(`Static Site: Deploy hook acionado com sucesso.`);
      } else {
        errorMsg = `Falha ao acionar deploy hook do Render: HTTP ${response.status}`;
        console.warn(`⚠️ ${errorMsg}`);
        // Consideramos sucesso parcial se o JSON foi gerado localmente no Web Service
        syncSuccess = true; 
      }
    } else {
      console.log(`Deploy/Sync: RENDER_STATIC_DEPLOY_HOOK_URL não configurada. Arquivo atualizado localmente no Web Service.`);
      syncSuccess = true;
    }

    console.log(`Resultado: ${syncSuccess ? "SUCESSO" : "FALHA"}`);
    console.log("==========================================\n");

    return {
      success: syncSuccess,
      product: productTitle,
      productId,
      supabaseCount,
      jsonCount,
      staticSiteUrl,
      error: errorMsg
    };
  } catch (err: any) {
    errorMsg = err.message || String(err);
    console.error("❌ [STATIC CATALOG SYNC] Erro crítico na sincronização:", err);
    console.log("==========================================\n");

    return {
      success: false,
      product: productTitle,
      productId,
      supabaseCount,
      jsonCount,
      staticSiteUrl,
      error: errorMsg
    };
  }
}
