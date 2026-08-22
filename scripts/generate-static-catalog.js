import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import https from 'https';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const backendUrl = process.env.CATALOG_API_URL || 'https://cerberus-forge-deploy-backend.onrender.com/api/products';

const RAW_PAYLOAD_MARKERS = [
  '[url final]',
  '[titulo identificado]',
  '[preco identificado]',
  '[total imagens oficiais]',
  '[imagens extraidas]',
  '[conteudo da pagina]'
];

const PROMOTION_CONDITIONS = new Set([
  'pix',
  'pix_with_coupon',
  'coupon',
  'other'
]);

function containsRawPayloadMarkers(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return RAW_PAYLOAD_MARKERS.some(marker => normalized.includes(marker));
}

// O build é executado diretamente pelo Node e não pode importar o módulo
// TypeScript do runtime. Esta projeção reproduz somente o contrato público
// validado: não calcula descontos, não aceita fonte não confirmada e não
// transporta campos internos de review para o catálogo estático.
function sanitizePromotionOffer(value) {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value;
  if (typeof candidate.price !== 'number' || !Number.isFinite(candidate.price) || candidate.price <= 0) return undefined;
  if (typeof candidate.condition !== 'string' || !PROMOTION_CONDITIONS.has(candidate.condition)) return undefined;
  if (candidate.source !== 'admin_confirmed') return undefined;
  if (typeof candidate.confirmedAt !== 'number' || !Number.isFinite(candidate.confirmedAt) || candidate.confirmedAt <= 0) return undefined;
  const benefits = Array.isArray(candidate.benefits)
    ? candidate.benefits.filter(benefit => typeof benefit === 'string' && benefit.trim().length > 0).map(benefit => benefit.trim()).slice(0, 8)
    : [];
  return {
    price: candidate.price,
    condition: candidate.condition,
    benefits,
    source: 'admin_confirmed',
    confirmedAt: candidate.confirmedAt
  };
}

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
          if (attempt < attempts) {
            setTimeout(run, 500 * attempt);
          } else {
            reject(error);
          }
        });
      });

      request.setTimeout(20_000, () => request.destroy(new Error('Timeout ao buscar API canônica.')));
      request.on('error', error => {
        if (attempt < attempts) {
          setTimeout(run, 500 * attempt);
        } else {
          reject(error);
        }
      });
    };

    run();
  });
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

  // O backend é apenas o caminho operacional alternativo para o mesmo Supabase;
  // nunca é permitido usar um arquivo local como fonte concorrente do catálogo.
  if (!sourceLoaded) {
    console.log(`ℹ️ [Build Catalog] Buscando a projeção canônica pela API do backend: ${backendUrl}`);
    try {
      const json = await requestCanonicalJson(backendUrl);
      const products = json.products || json.data;
      if (!Array.isArray(products)) {
        throw new Error('Resposta da API não contém uma lista de produtos.');
      }

      rawProducts = products;
      sourceLoaded = true;
      sourceName = 'backend /api/products (projeção de public.products)';
      console.log(`⚡ [Build Catalog] ${rawProducts.length} produtos obtidos via API do backend.`);
    } catch (apiErr) {
      throw new Error(`Nenhuma fonte canônica disponível: Supabase indisponível e API do backend falhou (${apiErr?.message || apiErr}).`);
    }
  }

  if (!sourceLoaded) {
    throw new Error('Nenhuma fonte canônica carregada; products.json não será gerado a partir de dados locais.');
  }

  // Filtragem e sanitização da projeção pública.
  const validProducts = rawProducts.filter((p) => {
    if (!p.produto || typeof p.produto !== 'string' || p.produto.trim() === '') return false;
    const productLink = p.link || p.affiliate_url;
    if (!productLink || typeof productLink !== 'string' || productLink.trim() === '' || productLink.includes('exemplo.com')) return false;
    const price = Number(p.preco);
    if (Number.isNaN(price) || price <= 0) return false;
    if (p.ativo === false || p.status !== 'published') return false;
    return true;
  }).map((p) => ({
    id: p.id,
    ref: p.ref,
    slug: p.slug || p.id,
    produto: p.produto.trim(),
    preco: Number(p.preco),
    precoAntigo: p.precoAntigo || p.preco_antigo ? Number(p.precoAntigo || p.preco_antigo) : undefined,
    imagens: Array.isArray(p.imagens) ? p.imagens : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : []),
    link: p.link || p.affiliate_url,
    categoria: p.categoria || 'Geral',
    descricao: containsRawPayloadMarkers(p.descricao || p.description || '') ? '' : (p.descricao || p.description || ''),
    paginaPonteUrl: p.paginaPonteUrl || p.pagina_ponte_url || '',
    createdAt: p.createdAt || p.created_at || undefined,
    ofertaPromocional: sanitizePromotionOffer(p.ofertaPromocional || p.oferta_promocional),
    ativo: true,
    status: 'published'
  }));

  const publicDataDir = path.join(process.cwd(), 'public', 'data');
  if (!fs.existsSync(publicDataDir)) {
    fs.mkdirSync(publicDataDir, { recursive: true });
  }

  const outputPath = path.join(publicDataDir, 'products.json');
  fs.writeFileSync(outputPath, JSON.stringify(validProducts, null, 2), 'utf-8');
  console.log(`✅ [Build Catalog] ${validProducts.length} produtos salvos em ${outputPath} a partir de ${sourceName}.`);
}

generateStaticCatalog().catch((err) => {
  console.error('⚠️ [Build Catalog] Erro não fatal na geração do catálogo estático:', err?.message || err);
  console.warn('⚠️ Continuando build sem atualizar products.json (comportamento permitido em ambiente de build isolado).');
  // process.exit(1); // Não falha o build se a rede estiver instável
});
