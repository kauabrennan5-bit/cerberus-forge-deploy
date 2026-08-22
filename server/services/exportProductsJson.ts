import fs from "fs";
import path from "path";
import { getProducts } from "../repositories/productsRepository";
import { Product } from "../../src/types";
import { containsRawPayloadMarkers } from "./productLifecycle";

/**
 * Script de exportação do catálogo público para formato estático (/public/data/products.json).
 * Aplica rigorosamente as regras de sanitização exigidas:
 * - Apenas produtos válidos, publicados e com URL válida.
 * - Eliminação de produtos fictícios, fantasmas ou sem dados essenciais.
 * - Sem inclusão de dados administrativos ou senhas.
 * - Preservação dos campos essenciais para o frontend (id, ref quando existente, produto, preco, imagens, link e categoria).
 */
export async function exportStaticProductsJson(): Promise<number> {
  try {
    console.log("[Static Export] Iniciando exportação. Carregando produtos do Repository...");
    const rawProducts = await getProducts();
    console.log(`[Static Export] ${rawProducts.length} produtos carregados do Repository.`);
    
    // Filtragem rigorosa conforme regras da migração estática
    const validProducts = rawProducts.filter((p: Product) => {
      // 1. Deve existir título/produto
      if (!p.produto || typeof p.produto !== 'string' || p.produto.trim() === '') {
        return false;
      }
      
      // 2. Deve possuir link de afiliação/compra válido
      if (!p.link || typeof p.link !== 'string' || p.link.trim() === '' || p.link.includes('exemplo.com')) {
        return false;
      }

      // 3. Excluir produtos fictícios ou teste óbvios
      const lowerTitle = p.produto.toLowerCase();
      if (lowerTitle.includes('produto teste') || lowerTitle.includes('item fictício') || lowerTitle.includes('placeholder')) {
        return false;
      }

      // 4. Deve possuir preço válido numérico maior que 0
      const price = Number(p.preco);
      if (isNaN(price) || price <= 0) {
        return false;
      }

      // 5. Somente produtos ativos efetivamente publicados. Estados de workflow
      // (approved, paused, archived, error) nunca são expostos como catálogo.
      if (p.ativo === false || (p.status !== undefined && p.status !== 'published')) {
        return false;
      }

      return true;
    }).map((p: Product) => ({
      id: p.id,
      ref: p.ref,
      slug: p.slug || p.id,
      produto: p.produto.trim(),
      displayTitle: p.displayTitle?.trim() || undefined,
      preco: Number(p.preco),
      precoAntigo: (p as any).precoAntigo ? Number((p as any).precoAntigo) : undefined,
      imagens: Array.isArray(p.imagens) ? p.imagens : [],
      link: p.link,
      categoria: p.categoria || 'Geral',
      descricao: containsRawPayloadMarkers(p.descricao) ? '' : p.descricao || '',
      curatorNote: p.curatorNote?.trim() || undefined,
      paginaPonteUrl: p.paginaPonteUrl || '',
      createdAt: p.createdAt,
      // A oferta observada é separada de `preco`; o frontend a rotula com
      // condição e ressalva, sem prometer total final de checkout.
      ofertaPromocional: p.ofertaPromocional,
      ativo: true,
      status: 'published'
    }));

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
