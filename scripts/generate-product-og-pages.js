import fs from 'fs';
import path from 'path';
import { buildProductOpenGraphPage } from './productOpenGraph.js';

const distDir = path.resolve(process.cwd(), 'dist');
const templatePath = path.join(distDir, 'index.html');
const catalogPath = path.join(distDir, 'data', 'products.json');
const publicOrigin = process.env.STATIC_SITE_PUBLIC_URL || 'https://cerberusfinds.com';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPublicProduct(product) {
  return Boolean(
    product
    && product.ativo === true
    && product.status === 'published'
    && typeof product.slug === 'string'
    && product.slug.trim()
  );
}

function writeOpenGraphPages() {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template compilado ausente: ${templatePath}`);
  }
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catálogo estático ausente: ${catalogPath}`);
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const products = readJson(catalogPath).filter(isPublicProduct);

  for (const product of products) {
    const outputDir = path.join(distDir, 'produto', product.slug);
    const outputPath = path.join(outputDir, 'index.html');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, buildProductOpenGraphPage(template, product, publicOrigin), 'utf8');
  }

  console.log(`✅ [Build OG] ${products.length} página(s) Open Graph gerada(s) em dist/produto/.`);
}

writeOpenGraphPages();
