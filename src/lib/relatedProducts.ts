import { Product } from '../types';
import { getProductDisplayTitle } from './productPresentation';

const GENERIC_TITLE_WORDS = new Set([
  'para', 'com', 'sem', 'por', 'das', 'dos', 'uma', 'uns', 'umas', 'que',
  'estilo', 'casa', 'sala', 'produto', 'peça', 'original', 'vintage',
]);

function meaningfulWords(product: Product): Set<string> {
  const source = `${getProductDisplayTitle(product)} ${product.descricao ?? ''}`
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

  return new Set(
    source
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !GENERIC_TITLE_WORDS.has(word)),
  );
}

/**
 * Mantém uma recomendação editorial simples e estável: categoria primeiro,
 * depois sinais coincidentes em título/descrição e, por fim, a ordem do acervo.
 */
export function getRelatedProducts(current: Product, products: Product[], limit = 4): Product[] {
  const currentWords = meaningfulWords(current);

  return products
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate, index) => {
      const candidateWords = meaningfulWords(candidate);
      const sharedWords = [...candidateWords].filter((word) => currentWords.has(word)).length;
      const sameCategory = candidate.categoria.trim().toLocaleLowerCase('pt-BR') === current.categoria.trim().toLocaleLowerCase('pt-BR');

      return {
        candidate,
        index,
        score: (sameCategory ? 100 : 0) + Math.min(sharedWords, 5) * 10,
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
