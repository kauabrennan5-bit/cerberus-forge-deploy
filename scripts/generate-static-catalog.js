import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const backendUrl = process.env.CATALOG_API_URL || 'https://cerberus-forge-deploy-backend.onrender.com/api/products';

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
      const response = await fetch(backendUrl);
      if (!response.ok) {
        throw new Error(`API retornou HTTP ${response.status}`);
      }

      const json = await response.json();
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
    if (!p.link || typeof p.link !== 'string' || p.link.trim() === '' || p.link.includes('exemplo.com')) return false;
    const price = Number(p.preco);
    if (Number.isNaN(price) || price <= 0) return false;
    if (p.ativo === false || p.status === 'pending') return false;
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
    marketplace: p.marketplace,
    cupom: p.cupom || '',
    freteGratis: Boolean(p.freteGratis || p.frete_gratis),
    descricao: p.descricao || p.description || '',
    paginaPonteUrl: p.paginaPonteUrl || p.pagina_ponte_url || '',
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
  console.error('❌ [Build Catalog] Erro fatal:', err?.message || err);
  process.exit(1);
});
