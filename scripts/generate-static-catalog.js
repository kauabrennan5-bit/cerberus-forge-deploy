import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import https from 'https';
import path from 'path';
import dotenv from 'dotenv';
import { resolvePublicProductCategory } from '../src/lib/productCategory.ts';
import { toPublicProductDTO } from '../src/lib/publicProductDto.ts';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const publicCatalogUrl = process.env.PUBLIC_CATALOG_API_URL || process.env.PUBLIC_CATALOG_URL || 'https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products';

function requestCanonicalJson(url, attempts = 3) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const run = () => {
      attempt += 1;
      const request = https.get(url, { headers: { 'User-Agent': 'cerberus-catalog-builder' } }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Resposta da API canônica não contém JSON válido.'));
            }
            return;
          }

          const error = new Error(`API retornou HTTP ${response.statusCode || 'desconhecido'}`);
          if (attempt < attempts) setTimeout(run, 500 * attempt);
          else reject(error);
        });
      });

      request.setTimeout(20_000, () => request.destroy(new Error('Timeout ao buscar API canônica.')));
      request.on('error', error => {
        if (attempt < attempts) setTimeout(run, 500 * attempt);
        else reject(error);
      });
    };

    run();
  });
}

function isValidPublicProduct(product) {
  if (!product) return false;
  if (!product.produto || typeof product.produto !== 'string' || product.produto.trim() === '') return false;
  if (!product.link || typeof product.link !== 'string' || !/^https:\/\//i.test(product.link)) return false;
  if (!Number.isFinite(Number(product.preco)) || Number(product.preco) <= 0) return false;
  const category = resolvePublicProductCategory(product.categoria, {
    title: product.displayTitle || product.produto,
    description: product.descricao,
  });
  return Boolean(category);
}

async function generateStaticCatalog() {
  console.log('[Build Catalog] Iniciando geração do catálogo estático a partir da fonte canônica...');

  let rawProducts = [];
  let sourceLoaded = false;
  let sourceName = '';

  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('⚠️ [Build Catalog] Erro ao buscar produtos do Supabase:', error.message);
      } else if (Array.isArray(data)) {
        rawProducts = data;
        sourceLoaded = true;
        sourceName = 'Supabase public.products';
        console.log(`⚡ [Build Catalog] ${rawProducts.length} produtos obtidos diretamente do Supabase.`);
      }
    } catch (err) {
      console.warn('⚠️ [Build Catalog] Exceção ao conectar ao Supabase:', err?.message || err);
    }
  }

  // A Edge Function pública é o único fallback de rede para o mesmo Supabase;
  // nunca é permitido usar o backend ou um arquivo local como fonte concorrente do catálogo.
  if (!sourceLoaded) {
    console.log(`ℹ️ [Build Catalog] Buscando a projeção canônica pela Supabase Edge: ${publicCatalogUrl}`);
    try {
      const json = await requestCanonicalJson(publicCatalogUrl);
      const products = json.products || json.data;
      if (!Array.isArray(products)) throw new Error('Resposta da API não contém uma lista de produtos.');

      rawProducts = products;
      sourceLoaded = true;
      sourceName = 'Supabase Edge cerberus-public-api';
      console.log(`⚡ [Build Catalog] ${rawProducts.length} produtos obtidos via Supabase Edge.`);
    } catch (apiErr) {
      throw new Error(`Nenhuma fonte canônica disponível: Supabase indisponível e API pública Edge falhou (${apiErr?.message || apiErr}).`);
    }
  }

  if (!sourceLoaded) throw new Error('Nenhuma fonte canônica carregada; products.json não será gerado a partir de dados locais.');

  // A whitelist pública é compartilhada com a Edge e o restante da aplicação.
  // Produtos inativos/não publicados retornam null; campos internos nunca chegam ao arquivo.
  const validProducts = rawProducts
    .map(product => toPublicProductDTO(product))
    .filter(isValidPublicProduct)
    .map(product => ({
      ...product,
      categoria: resolvePublicProductCategory(product.categoria, {
        title: product.displayTitle || product.produto,
        description: product.descricao,
      }),
    }));

  const publicDataDir = path.join(process.cwd(), 'public', 'data');
  if (!fs.existsSync(publicDataDir)) fs.mkdirSync(publicDataDir, { recursive: true });

  const outputPath = path.join(publicDataDir, 'products.json');
  fs.writeFileSync(outputPath, JSON.stringify(validProducts, null, 2), 'utf-8');
  console.log(`✅ [Build Catalog] ${validProducts.length} produtos salvos em ${outputPath} a partir de ${sourceName}.`);
}

generateStaticCatalog().catch((err) => {
  console.error('⚠️ [Build Catalog] Erro não fatal na geração do catálogo estático:', err?.message || err);
  console.warn('⚠️ Continuando build sem atualizar products.json (comportamento permitido em ambiente de build isolado).');
  // process.exit(1); // Não falha o build se a rede estiver instável
});