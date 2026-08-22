import assert from 'node:assert/strict';
import test from 'node:test';
import { getRelatedProducts } from '../src/lib/relatedProducts';
import type { Product } from '../src/types';

const product = (id: string, categoria: string, produto: string, descricao = ''): Product => ({
  id,
  produto,
  categoria,
  preco: 100,
  imagens: [],
  link: `https://example.com/${id}`,
  ativo: true,
  destaque: false,
  descricao,
});

test('produtos relacionados priorizam categoria, depois sinais de título, e nunca retornam o próprio produto', () => {
  const current = product('current', 'Iluminação', 'Luminária Pendente Bauhaus', 'Vidro âmbar e metal escovado');
  const sameCategory = product('same-category', 'Iluminação', 'Arandela de Parede', 'Metal escovado');
  const similarTitle = product('similar-title', 'Decoração', 'Luminária Bauhaus de Mesa');
  const fallback = product('fallback', 'Cozinha & Mesa', 'Bandeja de Madeira');

  const related = getRelatedProducts(current, [current, fallback, similarTitle, sameCategory]);

  assert.deepEqual(related.map((item) => item.id), ['same-category', 'similar-title', 'fallback']);
  assert.ok(!related.some((item) => item.id === current.id));
});
