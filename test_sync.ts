import { syncCatalogToGitHub } from "./server/services/githubCatalogSync.ts";
import dotenv from "dotenv";
dotenv.config();

async function runTest() {
  console.log("🚀 Disparando sincronização GitHub manual para teste de remoção...");
  try {
    const result = await syncCatalogToGitHub("test: manual sync for product removal validation");
    console.log("✅ Sincronização concluída!");
    console.log("Resultado:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("❌ Erro na sincronização:", error);
  }
}

runTest();
