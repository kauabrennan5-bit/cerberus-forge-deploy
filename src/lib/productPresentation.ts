import type { Product } from '../types';

/**
 * Seleciona exclusivamente o texto seguro para a vitrine. O título canônico
 * permanece como fallback durante a transição até que a migration editorial
 * seja aplicada e novos produtos tenham displayTitle persistido.
 */
export function getProductDisplayTitle(product: Pick<Product, 'produto' | 'displayTitle'>): string {
  const displayTitle = product.displayTitle?.replace(/\s+/g, ' ').trim();
  return displayTitle || product.produto.replace(/\s+/g, ' ').trim();
}
