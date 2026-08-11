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

/**
 * Cliente de API Estático para o Cerberus Finds (Site Público)
 * Consome exclusivamente /data/products.json para garantir arquitetura 100% estática e gratuita.
 */
export async function getProducts(): Promise<any[]> {
  try {
    // Uso de caminho relativo puro para evitar erros de construção de URL (DOMException: expected pattern)
    const jsonPath = '/data/products.json';
    
    console.log(`[Static Catalog] Buscando catálogo em: ${jsonPath}`);
    
    const response = await fetch(jsonPath);
    
    if (!response.ok) {
      console.warn(`[Static Catalog] Falha ao carregar JSON (HTTP ${response.status}).`);
      return [];
    }

    const data = await response.json();
    
    if (Array.isArray(data)) {
      console.log(`[Static Catalog] ${data.length} produtos carregados.`);
      return data.map((p: any) => ({
        ...p,
        id: String(p.id || ''),
        produto: p.produto || '',
        preco: Number(p.preco) || 0,
        imagens: Array.isArray(p.imagens) ? p.imagens : (p.imagem ? [p.imagem] : []),
        link: p.link || p.url || '',
        categoria: p.categoria || 'Geral',
        marketplace: p.marketplace || 'Shopee',
        ativo: p.ativo !== false,
        status: p.status || 'published'
      }));
    }
    
    return [];
  } catch (err) {
    console.error('[Static Catalog Error] Erro ao carregar catálogo estático:', err);
    // Retornamos array vazio em vez de lançar erro para evitar o crash visual
    return [];
  }
}

// Stubs para compatibilidade de build (não funcionais no site público)
export async function createProduct(payload: any): Promise<ApiResponse<any>> {
  return { success: false, error: 'Ação não permitida no site estático.' };
}

export async function updateProduct(id: string, payload: any): Promise<ApiResponse<any>> {
  return { success: false, error: 'Ação não permitida no site estático.' };
}

export async function deleteProduct(id: string): Promise<ApiResponse<any>> {
  return { success: false, error: 'Ação não permitida no site estático.' };
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  return false;
}

export async function sendMetaCapiEvent(eventData: any): Promise<boolean> {
  return true;
}

export async function trackProductClickApi(data: any): Promise<boolean> {
  return true;
}

export async function extractProduct(url: string): Promise<ApiResponse<any>> {
  return { success: false, error: 'Ação não permitida no site estático.' };
}

export async function verifyPasswordApi(password: string): Promise<boolean> {
  return false;
}

export async function fetchProxyCsv(url: string): Promise<string> {
  return '';
}
