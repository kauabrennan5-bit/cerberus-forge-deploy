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

export interface ProductCardPricePresentation {
  label: 'PREÇO VERIFICADO' | 'PREÇO DO ANÚNCIO';
  mainPrice: number;
  condition?: 'no Pix' | 'no Pix com cupom' | 'com cupom' | 'sob condição observada';
  announcementPrice?: number;
}

/**
 * O preço promocional confirmado é destacado quando existir. Sem promoção,
 * o preço canônico do anúncio continua visível — nunca se oculta nem se inventa.
 */
export function getProductCardPricePresentation(
  product: Pick<Product, 'preco' | 'ofertaPromocional'>,
): ProductCardPricePresentation {
  if (!product.ofertaPromocional) {
    return { label: 'PREÇO DO ANÚNCIO', mainPrice: product.preco };
  }

  const condition = product.ofertaPromocional.condition === 'pix'
    ? 'no Pix'
    : product.ofertaPromocional.condition === 'pix_with_coupon'
      ? 'no Pix com cupom'
      : product.ofertaPromocional.condition === 'coupon'
        ? 'com cupom'
        : 'sob condição observada';

  return {
    label: 'PREÇO VERIFICADO',
    mainPrice: product.ofertaPromocional.price,
    condition,
    announcementPrice: product.preco,
  };
}

/** Retorna somente a descrição curada efetivamente persistida, sem fallback inventado. */
export function getProductCardDescription(product: Pick<Product, 'descricao'>): string | null {
  const description = product.descricao?.replace(/\s+/g, ' ').trim();
  return description || null;
}
