import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProductMarketplaceLabel } from '../src/lib/productPresentation';

describe('product marketplace labels', () => {
  it('identifies Shopee links, including short subdomains', () => {
    assert.equal(getProductMarketplaceLabel({ link: 'https://s.shopee.com.br/abc' }), 'Shopee');
  });

  it('identifies Mercado Livre links, including meli.la', () => {
    assert.equal(getProductMarketplaceLabel({ link: 'https://www.mercadolivre.com.br/item/123' }), 'Mercado Livre');
    assert.equal(getProductMarketplaceLabel({ link: 'https://meli.la/abc' }), 'Mercado Livre');
  });

  it('does not invent a marketplace for an unknown or invalid link', () => {
    assert.equal(getProductMarketplaceLabel({ link: 'https://example.com/item' }), 'Loja parceira');
    assert.equal(getProductMarketplaceLabel({ link: 'not-a-url' }), 'Loja parceira');
  });
});
