const baseUrl = String(process.env.STOREFRONT_URL || 'https://cerberus-finds.pages.dev').replace(/\/+$/, '');
const expectedSha = String(process.env.EXPECTED_SHA || process.env.GITHUB_SHA || '').trim();
const expectedCount = Number.parseInt(String(process.env.EXPECTED_PRODUCT_COUNT || '30'), 10);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path) {
  const url = new URL(path, `${baseUrl}/`).toString();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  const body = await response.text();
  return { url, response, body };
}

function parseJson(label, body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function publicAssetPaths(html) {
  const refs = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi)) {
    refs.add(match[1]);
  }
  return [...refs];
}

async function verify() {
  invariant(Number.isSafeInteger(expectedCount) && expectedCount > 0, 'EXPECTED_PRODUCT_COUNT must be a positive integer');

  const root = await request('/');
  invariant(root.response.status === 200, `home returned HTTP ${root.response.status}`);
  invariant((root.response.headers.get('content-type') || '').includes('text/html'), 'home is not HTML');
  invariant(/<!doctype html>|<html[\s>]/i.test(root.body), 'home body is not an HTML document');

  const assets = publicAssetPaths(root.body);
  invariant(assets.some((asset) => /\.js(?:\?|$)/i.test(asset)), 'home did not reference a JS bundle');
  invariant(assets.some((asset) => /\.css(?:\?|$)/i.test(asset)), 'home did not reference a CSS bundle');
  for (const asset of assets) {
    const result = await request(asset);
    invariant(result.response.status === 200, `asset ${asset} returned HTTP ${result.response.status}`);
    const contentType = result.response.headers.get('content-type') || '';
    if (/\.js(?:\?|$)/i.test(asset)) invariant(/javascript|ecmascript/i.test(contentType), `JS asset ${asset} has unexpected content-type ${contentType}`);
    if (/\.css(?:\?|$)/i.test(asset)) invariant(/text\/css/i.test(contentType), `CSS asset ${asset} has unexpected content-type ${contentType}`);
    invariant(result.body.length > 0, `asset ${asset} is empty`);
  }

  const metaResult = await request('/deploy-meta.json');
  invariant(metaResult.response.status === 200, `deploy-meta.json returned HTTP ${metaResult.response.status}`);
  const meta = parseJson('deploy-meta.json', metaResult.body);
  invariant(meta?.platform === 'cloudflare-pages', `unexpected deployment platform: ${meta?.platform}`);
  if (expectedSha) invariant(meta?.sha === expectedSha, `deployment SHA mismatch: expected ${expectedSha}, got ${meta?.sha}`);

  const catalogResult = await request('/data/products.json');
  invariant(catalogResult.response.status === 200, `products.json returned HTTP ${catalogResult.response.status}`);
  const catalog = parseJson('products.json', catalogResult.body);
  invariant(Array.isArray(catalog), 'products.json is not an array');
  invariant(catalog.length === expectedCount, `expected ${expectedCount} public products, got ${catalog.length}`);

  const slugs = new Set();
  for (const product of catalog) {
    invariant(product?.ativo === true && product?.status === 'published', `non-public product leaked into snapshot: ${product?.id || 'unknown'}`);
    invariant(typeof product?.slug === 'string' && product.slug.trim().length > 0, `missing slug for ${product?.id || 'unknown'}`);
    invariant(!slugs.has(product.slug), `duplicate slug in snapshot: ${product.slug}`);
    slugs.add(product.slug);
    for (const internalField of ['curator_note', 'created_by', 'human_editorial_review_id', 'human_editorial_authorization_id']) {
      invariant(!(internalField in product), `internal field ${internalField} leaked for ${product.id}`);
    }
  }

  let productPagesVerified = 0;
  for (const product of catalog) {
    const result = await request(`/produto/${encodeURIComponent(product.slug)}`);
    invariant(result.response.status === 200, `product page ${product.slug} returned HTTP ${result.response.status}`);
    invariant((result.response.headers.get('content-type') || '').includes('text/html'), `product page ${product.slug} is not HTML`);
    invariant(/property=["']og:title["']/i.test(result.body), `product page ${product.slug} is missing og:title`);
    invariant(/property=["']og:url["']/i.test(result.body), `product page ${product.slug} is missing og:url`);
    productPagesVerified += 1;
  }

  const fallback = await request('/__cerberus_spa_probe__/nested/client-route');
  invariant(fallback.response.status === 200, `SPA fallback returned HTTP ${fallback.response.status}`);
  invariant((fallback.response.headers.get('content-type') || '').includes('text/html'), 'SPA fallback is not HTML');
  invariant(/<!doctype html>|<html[\s>]/i.test(fallback.body), 'SPA fallback did not return the application shell');
  invariant(publicAssetPaths(fallback.body).length > 0, 'SPA fallback did not reference application assets');

  for (const path of ['/server.cjs', '/dist/server.cjs']) {
    const result = await request(path);
    if (result.response.status === 404) continue;
    invariant(result.response.status === 200, `${path} returned unexpected HTTP ${result.response.status}`);
    const contentType = result.response.headers.get('content-type') || '';
    invariant(/text\/html/i.test(contentType), `${path} exposed a non-HTML payload (${contentType})`);
    invariant(/<!doctype html>|<html[\s>]/i.test(result.body), `${path} did not resolve only to SPA fallback`);
    for (const marker of ['TELEGRAM_BOT_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'express(', 'createServer(']) {
      invariant(!result.body.includes(marker), `${path} appears to expose backend bundle content (${marker})`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    platform: meta.platform,
    sha: meta.sha,
    storefront: baseUrl,
    products: catalog.length,
    productPagesVerified,
    assetsVerified: assets.length,
    spaFallback: true,
    backendBundleExposed: false,
  }));
}

verify().catch((error) => {
  console.error(`[cloudflare-storefront-verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
