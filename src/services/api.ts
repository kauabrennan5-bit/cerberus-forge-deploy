import { Product } from '../types';

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

function getApiUrl(path: string): string {
  if (typeof window !== 'undefined') {
    return path;
  }
  return `http://localhost:3000${path.startsWith('/') ? path : '/' + path}`;
}

/**
 * Cliente de API Centralizado para o Cerberus Finds
 */

/**
 * Busca a lista completa de produtos do catálogo
 */
export async function getProducts(): Promise<Product[]> {
  const response = await fetch(getApiUrl('/api/products'));
  if (!response.ok) {
    throw new Error(`Erro HTTP ${response.status} ao carregar produtos`);
  }
  const data: ApiResponse<Product> = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'Falha ao buscar produtos');
  }
  const productList = Array.isArray(data.products)
    ? data.products
    : (Array.isArray(data.data) ? data.data : []);
  return productList;
}

/**
 * Cria um novo produto no banco de dados (Requer autenticação admin)
 */
export async function createProduct(
  payload: CreateProductInput,
  adminPassword?: string
): Promise<ApiResponse<Product>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const password = adminPassword || payload.senha;
  if (password) {
    headers['x-admin-password'] = password;
  }

  const response = await fetch(getApiUrl('/api/products'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const resJson: ApiResponse<Product> = await response.json();
  if (!response.ok) {
    return {
      success: false,
      error: resJson.error || `Erro ${response.status} ao cadastrar produto`
    };
  }
  return resJson;
}

/**
 * Atualiza um produto existente (Requer autenticação admin)
 */
export async function updateProduct(
  id: string,
  payload: Partial<CreateProductInput>,
  adminPassword?: string
): Promise<ApiResponse<Product>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const password = adminPassword || payload.senha || (typeof window !== 'undefined' ? localStorage.getItem('cerberus_admin_password') || '' : '');
  if (password) {
    headers['x-admin-password'] = password;
  }

  try {
    const url = getApiUrl(`/api/products/${encodeURIComponent(id)}`);
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...payload, senha: password })
    });

    let resJson: ApiResponse<Product>;
    try {
      resJson = await response.json();
    } catch {
      resJson = {
        success: false,
        error: `Erro (${response.status}) ao ler resposta da atualização`
      };
    }

    if (response.status === 405) {
      const fallbackUrl = getApiUrl(`/api/products/${encodeURIComponent(id)}/edit`);
      const fallbackRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, senha: password })
      });
      return await fallbackRes.json();
    }

    if (!response.ok) {
      return {
        success: false,
        error: resJson.error || `Erro ${response.status} ao atualizar produto`
      };
    }
    return resJson;
  } catch (err: any) {
    console.error('Erro ao atualizar produto via API:', err);
    return {
      success: false,
      error: err.message || 'Falha de conexão ao atualizar produto'
    };
  }
}

/**
 * Exclui um produto do catálogo (Requer autenticação admin)
 */
export async function deleteProduct(
  id: string,
  adminPassword?: string
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const pass = adminPassword || (typeof window !== 'undefined' ? localStorage.getItem('cerberus_admin_password') || '' : '');
  if (pass) {
    headers['x-admin-password'] = pass;
  }

  const url = getApiUrl(`/api/products/${encodeURIComponent(id)}/delete`);
  console.log('[DELETE LOG 3] URL chamada pelo cliente de API:', url);
  console.log('[DELETE LOG 4] Headers enviados:', {
    'x-admin-password': pass ? 'ENVIADO (x-admin-password)' : 'NÃO ENVIADO'
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers
    });

    console.log('[DELETE LOG 5] Status HTTP retornado pelo backend:', response.status);

    let resJson: ApiResponse;
    try {
      resJson = await response.json();
    } catch {
      resJson = {
        success: false,
        error: `Erro (${response.status}) ao ler resposta da exclusão`
      };
    }

    console.log('[DELETE LOG 6] Resposta JSON do backend:', resJson);

    if (!response.ok) {
      return {
        success: false,
        error: resJson.error || `Erro ${response.status} ao remover produto`
      };
    }
    return resJson;
  } catch (err: any) {
    console.error('[DELETE LOG - API Error]', err);
    return {
      success: false,
      error: err.message || 'Falha de conexão ao excluir produto'
    };
  }
}

/**
 * Extrai dados e copy de produto via IA (Gemini)
 */
export async function extractProduct(
  url: string,
  rawText?: string,
  adminPassword?: string
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (adminPassword) {
    headers['x-admin-password'] = adminPassword;
  }

  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: url.trim(), rawText: (rawText || '').trim() })
    });

    let resData: any = {};
    try {
      resData = await response.json();
    } catch (e) {
      resData = { error: `Erro ao processar resposta do servidor (${response.status})` };
    }

    if (!response.ok) {
      return {
        success: false,
        error: resData.error || resData.details || `Erro ${response.status} na extração IA`
      };
    }
    return resData;
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Não foi possível conectar ao servidor para extração.'
    };
  }
}

/**
 * Envia submissão legada (Google Apps Script)
 */
export async function submitProduct(
  payload: any,
  adminPassword?: string
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (adminPassword) {
    headers['x-admin-password'] = adminPassword;
  }

  const response = await fetch('/api/submit-product', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  return await response.json();
}

/**
 * Interface do payload de registro de clique de produto
 */
export interface TrackClickPayload {
  productId: string;
  productSlug?: string;
  productName?: string;
  productPrice?: number;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  referrer?: string;
  landingPage?: string;
}

/**
 * Envia registro de clique de produto para o backend (/api/track-click)
 */
export async function trackProductClickApi(payload: TrackClickPayload): Promise<ApiResponse> {
  try {
    const response = await fetch('/api/track-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return { success: false, error: `Erro ${response.status} ao registrar clique` };
    }
    return await response.json();
  } catch (err: any) {
    return { success: false, error: err?.message || 'Falha de conexão ao registrar clique' };
  }
}

/**
 * Envia evento do Meta Conversions API (CAPI)
 */
export async function sendMetaCapiEvent(payload: any): Promise<ApiResponse> {
  const response = await fetch('/api/meta-capi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

/**
 * Faz fetch de proxy de CSV para contornar restrições de CORS
 */
export async function fetchProxyCsv(csvUrl: string): Promise<string> {
  const response = await fetch(`/api/proxy-csv?url=${encodeURIComponent(csvUrl)}`);
  if (!response.ok) {
    throw new Error(`Erro ao buscar proxy CSV: status ${response.status}`);
  }
  return await response.text();
}
