import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const headerSource = fs.readFileSync(new URL('../src/components/Header.tsx', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('product detail uses a dedicated compact header shell', () => {
  assert.match(headerSource, /currentView === 'product-detail'/);
  assert.match(headerSource, /product-detail-view/);
  assert.match(headerSource, /Voltar ao acervo/);
  assert.match(headerSource, /h-14 max-w-7xl/);
});

test('product detail footer never renders the newsletter acquisition form', () => {
  assert.match(cssSource, /html\.product-detail-view footer form\s*\{\s*display: none !important;/s);
  assert.match(cssSource, /html\.product-detail-view footer\s*\{/);
});

test('newsletter remains available on the catalog experience', () => {
  assert.match(appSource, /Receba novas seleções/);
  assert.match(appSource, /newsletter-consent/);
});
