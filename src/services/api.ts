export interface CreateProductInput {
  senha?: string;
  produto: string;
  categoria: string;
  preco: number;
  imagens: string[];
  link: string;
  destaque?: boolean;
  descricao?: string;
  paginaPonteUrl?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  products?: T[];
  data?: T;
  product?: T;
  error?: string;
  message?: string;
}

const PRODUCTION_API_BASE = 'https://cerberus-forge-deploy-backend.onrender.com';

function getApiUrl(path: string): string {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
      // Se estivermos no domínio estático de produção, usa o Web Service do Render
      if (hostname === 'cerberusfinds.com' || hostname.includes('cerberus-static-catalog')) {
        return `${PRODUCTION_API_BASE}${path.startsWith('/') ? path : '/' + path}`;
      }
      if (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('blob:')) {
        return `${window.location.origin}${path.startsWith('/') ? path : '/' + path}`;
      }
    }
  } catch {
    // Fallback
  }
  return `${PRODUCTION_API_BASE}${path.startsWith('/') ? path : '/' + path}`;
}

/**
 * Cliente de API para o Cerberus Finds
 * Consome o endpoint backend /api/products que reflete diretamente a tabela public.products do Supabase.
 */
export async function getProducts(): Promise<any[]> {
  try {
    const apiUrl = getApiUrl('/api/products');
    console.log('[Catalog API] Buscando catálogo dinâmico em:', apiUrl);
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      console.error(`[Catalog API Error] ${apiUrl} retornou HTTP ${response.status}.`);
      return [];
    }

    const resData = await response.json();
    const list = resData.products || resData.data || (Array.isArray(resData) ? resData : []);
    
    if (Array.isArray(list)) {
      console.log(`[Catalog API] ${list.length} produtos carregados.`);
      return list.map((p: any) => ({
        ...p,
        id: String(p.id || ''),
        produto: p.produto || '',
        preco: Number(p.preco) || 0,
        imagens: Array.isArray(p.imagens) ? p.imagens : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : (p.imagem ? [p.imagem] : [])),
        link: p.link || p.url || '',
        categoria: p.categoria || 'Geral',
        marketplace: p.marketplace || 'Shopee',
        ativo: p.ativo !== false,
        status: p.status || 'published'
      }));
    }
    
    return [];
  } catch (err: any) {
    console.error('[Catalog API Error] Erro ao carregar catálogo:', err?.message || err);
    return [];
  }
}

export async function verifyAdminPassword(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(getApiUrl('/api/admin/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) return { success: false, error: 'Senha incorreta.' };
    const data = await res.json();
    return { success: Boolean(data.success), error: data.error };
  } catch {
    return { success: false, error: 'Erro ao conectar ao servidor.' };
  }
}

export async function createProduct(payload: any, password?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl('/api/products'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, senha: password || payload.senha })
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao criar produto.' };
  }
}

export async function updateProduct(id: string, payload: any, password?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl(`/api/products/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, senha: password || payload.senha })
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao atualizar produto.' };
  }
}

export async function deleteProduct(id: string, password?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl(`/api/products/${id}`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: password })
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao remover produto.' };
  }
}

export async function sendMetaCapiEvent(eventData: any): Promise<boolean> {
  return true;
}

export async function trackProductClickApi(data: any): Promise<boolean> {
  return true;
}

export async function extractProduct(url: string, rawText?: string, adminPass?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl('/api/admin/extract'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, rawText, senha: adminPass })
    });
    const data = await res.json();
    return data;
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao extrair produto com IA.' };
  }
}

export async function verifyPasswordApi(password: string): Promise<boolean> {
  const res = await verifyAdminPassword(password);
  return res.success;
}

export async function fetchProxyCsv(url: string): Promise<string> {
  return '';
}
