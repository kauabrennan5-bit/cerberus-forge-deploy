import fs from "fs";
import path from "path";
import { getProducts } from "../repositories/productsRepository";
import { Product } from "../../src/types";
import { containsRawPayloadMarkers } from "./productLifecycle";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { isAutonomousCuratorFloorFallback } from "./autonomousCuratorCatalogFloorPolicy";

function publicHttpsImages(images: readonly string[]): string[] {
  return images
    .filter((image): image is string => typeof image === "string")
    .map(image => image.trim())
    .filter(Boolean)
    .filter(image => {
      try {
        return new URL(image).protocol === "https:";
      } catch {
        return false;
      }
    })
    .filter((image, index, list) => list.indexOf(image) === index);
}

/**
 * Normal products remain fail-closed on the canonical clean-image contract.
 * The guaranteed catalog-floor fallback is the one explicit exception: its
 * official Shopee image is already technically probed, but may remain marked
 * review_required because editorial/visual filters are ranking signals rather
 * than a reason to leave a public category empty.
 */
function publicCatalogImages(product: Product): string[] {
  const canonical = resolveCanonicalProductImage(product);
  if (canonical.status === "ready" && canonical.primaryImageUrl) return canonical.publicHttpsImageUrls;
  return isAutonomousCuratorFloorFallback(product.createdBy) ? publicHttpsImages(product.imagens || []) : [];
}

/**
 * Script de exportação do catálogo público para formato estático (/public/data/products.json).
 * Aplica rigorosamente as regras da migração estática:
 * - Apenas produtos válidos, publicados e com URL válida.
 * - Eliminação de produtos fictícios, fantasmas ou sem dados essenciais.
 * - Sem inclusão de dados administrativos, senhas ou metadados internos da automação.
 * - Preservação dos campos essenciais para o frontend (id, ref quando existente, produto, preco, imagens, link e categoria).
 *
 * A única exceção editorial é o produto de floor fallback explicitamente
 * auditado: ele pode usar a imagem oficial tecnicamente válida mesmo quando a
 * revisão estética ficou review_required. Isso não altera gates de newsletter.
 */
export async function exportStaticProductsJson(): Promise<number> {
  try {
    console.log("[Static Export] Iniciando exportação. Carregando produtos do Repository...");
    const rawProducts = await getProducts();
    console.log(`[Static Export] ${rawProducts.length} produtos carregados do Repository.`);
    
    const validProducts = rawProducts.filter((p: Product) => {
      if (!p.produto || typeof p.produto !== "string" || p.produto.trim() === "") return false;
      if (!p.link || typeof p.link !== "string" || p.link.trim() === "" || p.link.includes("exemplo.com")) return false;

      const lowerTitle = p.produto.toLowerCase();
      if (lowerTitle.includes("produto teste") || lowerTitle.includes("item fictício") || lowerTitle.includes("placeholder")) return false;

      const price = Number(p.preco);
      if (Number.isNaN(price) || price <= 0) return false;

      if (p.ativo === false || (p.status !== undefined && p.status !== "published")) return false;

      if (publicCatalogImages(p).length === 0) return false;
      if (!resolvePublicProductCategory(p.categoria, { title: p.displayTitle || p.produto, description: p.descricao })) return false;

      return true;
    }).map((p: Product) => ({
      id: p.id,
      ref: p.ref,
      slug: p.slug || p.id,
      produto: p.produto.trim(),
      displayTitle: p.displayTitle?.trim() || undefined,
      preco: Number(p.preco),
      precoAntigo: (p as any).precoAntigo ? Number((p as any).precoAntigo) : undefined,
      imagens: publicCatalogImages(p),
      link: p.link,
      categoria: resolvePublicProductCategory(p.categoria, { title: p.displayTitle || p.produto, description: p.descricao }),
      descricao: containsRawPayloadMarkers(p.descricao) ? "" : p.descricao || "",
      paginaPonteUrl: p.paginaPonteUrl || "",
      createdAt: p.createdAt,
      ofertaPromocional: p.ofertaPromocional,
      ativo: true,
      status: "published",
    }));

    const publicDataDir = path.join(process.cwd(), "public", "data");
    if (!fs.existsSync(publicDataDir)) fs.mkdirSync(publicDataDir, { recursive: true });

    const outputPath = path.join(publicDataDir, "products.json");
    fs.writeFileSync(outputPath, JSON.stringify(validProducts, null, 2), "utf-8");

    console.log(`[Static Export] SUCESSO! ${validProducts.length} produtos válidos exportados.`);
    console.log(`[Static Export] Caminho: ${outputPath}`);
    return validProducts.length;
  } catch (error) {
    console.error("[Static Export] Erro ao exportar products.json:", error);
    throw error;
  }
}

export const exportProductsJsonInternals = {
  publicHttpsImages,
  publicCatalogImages,
};
