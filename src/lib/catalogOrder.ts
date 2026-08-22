import { Product } from '../types';

function getCanonicalCreatedAt(product: Product): number | undefined {
  if (product.createdAt) {
    const parsed = Date.parse(product.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }

  // Produtos históricos trazem o instante canônico no ID gerado pelo pipeline.
  // Se a identidade não tiver timestamp verificável, a ordem recebida é mantida.
  const generatedId = /^prod-(\d{10,})$/.exec(product.id);
  if (generatedId) {
    const parsed = Number(generatedId[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

/**
 * Ordena o acervo do mais antigo para o mais recente. O índice resultante é
 * preservado no produto para que filtros não renumerem os itens arquivais.
 */
export function orderCatalogProducts(products: Product[]): Product[] {
  return products
    .map((product, incomingIndex) => ({
      product,
      incomingIndex,
      createdAt: getCanonicalCreatedAt(product),
    }))
    .sort((left, right) => {
      if (left.createdAt !== undefined && right.createdAt !== undefined && left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      if (left.createdAt !== undefined && right.createdAt === undefined) return -1;
      if (left.createdAt === undefined && right.createdAt !== undefined) return 1;
      return left.incomingIndex - right.incomingIndex;
    })
    .map(({ product }, rawRowIndex) => ({ ...product, rawRowIndex }));
}
