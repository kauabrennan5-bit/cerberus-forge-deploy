import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

async function generateStaticCatalog() {
  console.log('[Build Catalog] Iniciando geração do catálogo estático a partir do Supabase...');

  let rawProducts = [];

  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('⚠️ [Build Catalog] Erro ao buscar produtos do Supabase no build:', error.message);
      } else if (Array.isArray(data)) {
        rawProducts = data;
        console.log(`⚡ [Build Catalog] ${rawProducts.length} produtos obtidos diretamente do Supabase.`);
      }
    } catch (err) {
      console.warn('⚠️ [Build Catalog] Exceção ao conectar ao Supabase no build:', err);
    }
  } else {
    console.log('ℹ️ [Build Catalog] Credenciais do Supabase não encontradas no build. Tentando fallback local.');
  }

  // Fallback para arquivo local se Supabase falhou ou retornou vazio
  if (rawProducts.length === 0) {
    const localFile = path.join(process.cwd(), 'data', 'products.json');
    if (fs.existsSync(localFile)) {
      try {
        rawProducts = JSON.parse(fs.readFileSync(localFile, 'utf-8'));
        console.log(`📁 [Build Catalog] ${rawProducts.length} produtos carregados do fallback local (data/products.json).`);
      } catch (e) {
        console.warn('⚠️ [Build Catalog] Erro ao ler fallback local:', e);
      }
    }
  }

  // Filtragem e sanitização rigorosa
  const validProducts = rawProducts.filter((p) => {
    if (!p.produto || typeof p.produto !== 'string' || p.produto.trim() === '') return false;
    if (!p.link || typeof p.link !== 'string' || p.link.trim() === '' || p.link.includes('exemplo.com')) return false;
    const price = Number(p.preco);
    if (isNaN(price) || price <= 0) return false;
    if (p.ativo === false || p.status === 'pending') return false;
    return true;
  }).map((p) => ({
    id: p.id,
    slug: p.slug || p.id,
    produto: p.produto.trim(),
    preco: Number(p.preco),
    precoAntigo: p.precoAntigo || p.preco_antigo ? Number(p.precoAntigo || p.preco_antigo) : undefined,
    imagens: Array.isArray(p.imagens) ? p.imagens : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : []),
    link: p.link || p.affiliate_url,
    categoria: p.categoria || 'Geral',
    marketplace: p.marketplace || 'Shopee',
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
  console.log(`✅ [Build Catalog] ${validProducts.length} produtos salvos com sucesso em ${outputPath}`);
}

generateStaticCatalog().catch((err) => {
  console.error('❌ [Build Catalog] Erro fatal:', err);
  process.exit(0); // Não quebra o build se houver falha de rede temporária
});
