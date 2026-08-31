import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const headerSource = fs.readFileSync(new URL('../src/components/Header.tsx', import.meta.url), 'utf8');
const productDetailSource = fs.readFileSync(new URL('../src/components/ProductDetail.tsx', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('product detail uses a compact header without a second visible back control', () => {
  assert.match(headerSource, /currentView === 'product-detail'/);
  assert.match(headerSource, /product-detail-view/);
  assert.match(headerSource, /h-14 max-w-7xl/);
  assert.doesNotMatch(headerSource, /ArrowLeft/);
  assert.doesNotMatch(headerSource, /Voltar ao acervo/);
  assert.match(productDetailSource, /Voltar ao Acervo/);
});

test('product detail footer stays compact, hides newsletter and does not add another back arrow', () => {
  assert.match(cssSource, /html\.product-detail-view footer form\s*\{\s*display: none !important;/s);
  assert.match(cssSource, /html\.product-detail-view footer\s*\{/);
  assert.doesNotMatch(cssSource, /button:first-child::before/);
});

test('product cards do not expose nested photo carousel arrows or pagination controls', () => {
  assert.match(cssSource, /\[data-testid="product-card"\] button\[aria-label="Foto anterior"\]/);
  assert.match(cssSource, /\[data-testid="product-card"\] button\[aria-label="Próxima foto"\]/);
  assert.match(cssSource, /\[data-testid="product-card"\] button\[aria-label\^="Ir para foto "\]/);
});

test('related recommendations use swipe instead of overlay navigation arrows on product pages', () => {
  assert.match(productDetailSource, /Deslize para explorar/);
  assert.match(productDetailSource, /data-testid="related-products-rail"/);
  assert.match(cssSource, /html\.product-detail-view button\[aria-label="Ver recomendação anterior"\]/);
  assert.match(cssSource, /html\.product-detail-view button\[aria-label="Ver próxima recomendação"\]/);
});

test('newsletter remains available on the catalog experience', () => {
  assert.match(appSource, /Receba novas seleções/);
  assert.match(appSource, /newsletter-consent/);
});
