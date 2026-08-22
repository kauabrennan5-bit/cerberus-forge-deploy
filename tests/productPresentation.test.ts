import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProductCardDescription,
  getProductCardPricePresentation,
  getProductDisplayTitle,
} from '../src/lib/productPresentation';

test('card mantém o preço canônico quando não existe oferta promocional', () => {
  const presentation = getProductCardPricePresentation({ preco: 269 });

  assert.deepEqual(presentation, {
    label: 'PREÇO DO ANÚNCIO',
    mainPrice: 269,
  });
});

test('card prioriza a oferta confirmada sem descartar o preço do anúncio', () => {
  const presentation = getProductCardPricePresentation({
    preco: 299,
    ofertaPromocional: {
      price: 264,
      condition: 'pix',
      benefits: [],
      source: 'admin_confirmed',
      confirmedAt: 1,
    },
  });

  assert.deepEqual(presentation, {
    label: 'PREÇO VERIFICADO',
    mainPrice: 264,
    condition: 'no Pix',
    announcementPrice: 299,
  });
});

test('card usa somente texto editorial persistido e título editorial quando disponíveis', () => {
  assert.equal(
    getProductCardDescription({ descricao: '  Iluminação  funcional\npara leitura. ' }),
    'Iluminação funcional para leitura.',
  );
  assert.equal(getProductCardDescription({ descricao: '   ' }), null);
  assert.equal(
    getProductDisplayTitle({ produto: 'Título bruto', displayTitle: '  Título editorial  ' }),
    'Título editorial',
  );
});
