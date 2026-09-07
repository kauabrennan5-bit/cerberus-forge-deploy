import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

test('dark storefront palette is loaded after product-detail cream overrides', () => {
  const productDetailIndex = mainSource.indexOf("./design-system-product-detail.css");
  const darkSurfaceIndex = mainSource.indexOf("./design-system-dark-surface.css");

  assert.ok(productDetailIndex >= 0, 'product detail stylesheet must remain imported');
  assert.ok(darkSurfaceIndex >= 0, 'dark surface stylesheet must remain imported');
  assert.ok(
    darkSurfaceIndex > productDetailIndex,
    'dark surface must load after product detail so the approved black palette wins the cascade',
  );
});
