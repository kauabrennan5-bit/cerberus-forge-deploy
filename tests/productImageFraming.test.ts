import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('catalog product previews fill their media stage instead of floating inside black padding', () => {
  assert.match(cssSource, /\[data-testid="product-card"\] > div > div:nth-child\(2\)\s*\{[^}]*padding:\s*0 !important;[^}]*background-color:\s*#181512 !important;/s);
  assert.match(cssSource, /\[data-testid="product-card"\] > div > div:nth-child\(2\) img\s*\{[^}]*object-fit:\s*cover !important;/s);
});

test('product detail removes the heavy inner matte without cropping the full gallery image', () => {
  assert.match(cssSource, /html\.product-detail-view main \.tech-frame\.group\.cursor-pointer\s*\{[^}]*padding:\s*0 !important;[^}]*background-color:\s*#181512 !important;/s);
  assert.match(cssSource, /html\.product-detail-view main \.tech-frame\.group\.cursor-pointer > img\s*\{[^}]*object-fit:\s*contain !important;/s);
});

test('product thumbnails use cover framing for a compact editorial grid', () => {
  assert.match(cssSource, /html\.product-detail-view main \.tech-frame\.group\.cursor-pointer \+ div img\s*\{[^}]*object-fit:\s*cover !important;/s);
});
