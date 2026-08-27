import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductOpenGraphPage,
  buildProductOpenGraphTags,
  buildProductPublicUrl,
  getProductPresentationTitle
} from '../scripts/productOpenGraph.js';

const product = {
  slug: 'luminaria-pendente-de-vidro-estilo-bauhaus',
  produto: 'Luminaria Pendente De Vidro Estilo Bauhaus Luminaria Para Sala',
  displayTitle: 'Luminária Pendente de Vidro Estilo Bauhaus',
  imagens: [
    'http://images.example.com/insecure.jpg',
    'data:image/png;base64,not-a-public-image',
    'https://images.example.com/luminaria.jpg',
    'https://images.example.com/luminaria.jpg',
  ]
};

test('Open Graph estático usa displayTitle e URL pública canônica', () => {
  assert.equal(getProductPresentationTitle(product), 'Luminária Pendente de Vidro Estilo Bauhaus');
  assert.equal(
    buildProductPublicUrl(product),
    'https://cerberusfinds.com/produto/luminaria-pendente-de-vidro-estilo-bauhaus'
  );

  const tags = buildProductOpenGraphTags(product);
  assert.match(tags, /property="og:title" content="Luminária Pendente de Vidro Estilo Bauhaus"/);
  assert.match(tags, /property="og:image" content="https:\/\/images\.example\.com\/luminaria\.jpg"/);
  assert.match(tags, /name="twitter:card" content="summary_large_image"/);
});

test('Open Graph estático omite imagem quando não há URL HTTPS pública válida', () => {
  const tags = buildProductOpenGraphTags({ ...product, imagens: ['http://images.example.com/insecure.jpg', 'data:image/png;base64,not-a-public-image'] });
  assert.equal(tags.includes('property="og:image"'), false);
  assert.equal(tags.includes('name="twitter:image"'), false);
});

test('Open Graph estático preserva o template compilado que inicializa o SPA', () => {
  const template = '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';
  const page = buildProductOpenGraphPage(template, product);

  assert.match(page, /<meta property="og:title" content="Luminária Pendente de Vidro Estilo Bauhaus">/);
  assert.match(page, /<script type="module" src="\/assets\/app\.js"><\/script>/);
  assert.match(page, /<div id="root"><\/div>/);
});
