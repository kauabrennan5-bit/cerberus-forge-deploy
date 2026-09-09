import fs from "fs";
import path from "path";
import { getProducts } from "../repositories/productsRepository";
import { toPublicProductDTOs } from "../../supabase/functions/_shared/publicProductDTO";

/**
 * Script de exportação do catálogo público para formato estático (/public/data/products.json).
 * Aplica rigorosamente as regras de sanitização exigidas:
 * - Apenas produtos válidos, publicados e com URL válida.
 * - Eliminação de produtos fictícios, fantasmas ou sem dados essenciais.
 * - Sem inclusão de dados administrativos, senhas ou metadados internos da automação.
 * - Preservação dos campos essenciais para o frontend (id, ref quando existente, produto, preco, imagens, link e categoria).
 */
export async function exportStaticProductsJson(): Promise<number> {
  try {
    console.log("[Static Export] Iniciando exportação. Carregando produtos do Repository...");
    const rawProducts = await getProducts();
    console.log(`[Static Export] ${rawProducts.length} produtos carregados do Repository.`);
    
    const validProducts = toPublicProductDTOs(rawProducts);

    // Garantir que o diretório public/data existe
    const publicDataDir = path.join(process.cwd(), "public", "data");
    if (!fs.existsSync(publicDataDir)) {
      fs.mkdirSync(publicDataDir, { recursive: true });
    }

    const outputPath = path.join(publicDataDir, "products.json");
    fs.writeFileSync(outputPath, JSON.stringify(validProducts, null, 2), "utf-8");

    console.log(`[Static Export] SUCESSO! ${validProducts.length} produtos válidos exportados.`);
    console.log(`[Static Export] Caminho: ${outputPath}`);
    return validProducts.length;
  } catch (error) {
    console.error("[Static Export] Erro ao exportar products.json:", error);
    // Uma falha de leitura não pode substituir o catálogo canônico por um array vazio.
    throw error;
  }
}
