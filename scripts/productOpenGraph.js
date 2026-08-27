const DEFAULT_PUBLIC_ORIGIN = 'https://cerberusfinds.com';
import { resolveCanonicalProductImage } from '../src/lib/productCanonical.ts';

const DEFAULT_DESCRIPTION = 'Peça selecionada pela curadoria Cerberus Finds.';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeOrigin(value) {
  return (value || DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, '');
}

export function getProductPresentationTitle(product) {
  const displayTitle = typeof product?.displayTitle === 'string' ? product.displayTitle.trim() : '';
  const fallbackTitle = typeof product?.produto === 'string' ? product.produto.trim() : '';
  return displayTitle || fallbackTitle || 'Cerberus Finds';
}

export function buildProductPublicUrl(product, publicOrigin = DEFAULT_PUBLIC_ORIGIN) {
  const slug = typeof product?.slug === 'string' ? product.slug.trim() : '';
  if (!slug) throw new Error('Produto sem slug não pode gerar página Open Graph.');
  return `${normalizeOrigin(publicOrigin)}/produto/${encodeURIComponent(slug)}`;
}

export function buildProductOpenGraphTags(product, publicOrigin = DEFAULT_PUBLIC_ORIGIN) {
  const title = getProductPresentationTitle(product);
  const url = buildProductPublicUrl(product, publicOrigin);
  const image = resolveCanonicalProductImage(product).primaryImageUrl || '';

  const tags = [
    `<title>${escapeHtml(title)} | Cerberus Finds</title>`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(DEFAULT_DESCRIPTION)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    '<meta property="og:site_name" content="Cerberus Finds">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(DEFAULT_DESCRIPTION)}">`
  ];

  if (image) {
    tags.splice(5, 0, `<meta property="og:image" content="${escapeHtml(image)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`);
  }

  return tags.join('\n    ');
}

export function buildProductOpenGraphPage(indexHtml, product, publicOrigin = DEFAULT_PUBLIC_ORIGIN) {
  if (typeof indexHtml !== 'string' || !indexHtml.includes('</head>')) {
    throw new Error('Template HTML compilado não contém a tag de fechamento </head>.');
  }

  const tags = buildProductOpenGraphTags(product, publicOrigin);
  return indexHtml.replace('</head>', `    ${tags}\n  </head>`);
}
