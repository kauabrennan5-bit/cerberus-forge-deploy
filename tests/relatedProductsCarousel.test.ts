import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const productDetailSource = readFileSync(new URL('../src/components/ProductDetail.tsx', import.meta.url), 'utf8');

describe('related products carousel navigation', () => {
  it('keeps native horizontal touch scrolling and keyboard focus', () => {
    assert.match(productDetailSource, /relatedRailRef = useRef<HTMLDivElement>\(null\)/);
    assert.match(productDetailSource, /touch-auto/);
    assert.match(productDetailSource, /overflow-x-auto/);
    assert.match(productDetailSource, /role="region"/);
    assert.match(productDetailSource, /tabIndex=\{0\}/);
    assert.doesNotMatch(productDetailSource, /handleRelatedTouchMove/);
    assert.doesNotMatch(productDetailSource, /preventDefault\(\)/);
  });

  it('keeps explicit previous and next controls for narrow viewports', () => {
    assert.match(productDetailSource, /Ver recomendação anterior/);
    assert.match(productDetailSource, /Ver próxima recomendação/);
    assert.match(productDetailSource, /scrollRelatedProducts\(-1\)/);
    assert.match(productDetailSource, /scrollRelatedProducts\(1\)/);
  });
});
