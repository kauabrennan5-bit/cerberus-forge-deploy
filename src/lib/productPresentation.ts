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

/**
 * Identifica a loja a partir do domínio do link canônico persistido.
 * Não inventa marketplace: URLs desconhecidas recebem "Loja parceira".
 */
export function getProductMarketplaceLabel(product: Pick<Product, 'link'>): string {
  const rawLink = product.link?.trim();
  if (!rawLink) return 'Loja parceira';

  try {
    const host = new URL(rawLink).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'shopee.com.br' || host.endsWith('.shopee.com.br') || host === 'shopee.com' || host.endsWith('.shopee.com')) {
      return 'Shopee';
    }
    if (host === 'mercadolivre.com.br' || host.endsWith('.mercadolivre.com.br') || host === 'mercadolibre.com' || host.endsWith('.mercadolibre.com') || host === 'meli.la') {
      return 'Mercado Livre';
    }
    if (host === 'amazon.com.br' || host.endsWith('.amazon.com.br')) {
      return 'Amazon';
    }
    if (host === 'magazineluiza.com.br' || host.endsWith('.magazineluiza.com.br')) {
      return 'Magalu';
    }
  } catch {
    return 'Loja parceira';
  }

  return 'Loja parceira';
}
