import { SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";
import { resolvePublicProductCategory } from "../lib/productCategory";
import { sanitizePublicCuratorNote } from "../lib/publicCuratorNote";

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

export type PublicSocialLink = {
  network: SocialNetwork;
  label: string;
  url: string;
};

export interface ApiResponse<T = any> {
  success: boolean;
  products?: T[];
  data?: T;
  product?: T;
  error?: string;
  message?: string;
}

const PRODUCTION_API_BASE = 'https://cerberus-forge-deploy-backend.onrender.com';
const PUBLIC_CATALOG_EDGE_BASE = 'https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api';

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

function getPublicCatalogApiUrl(): string {
  return `${PUBLIC_CATALOG_EDGE_BASE}/products?t=${Date.now()}`;
}

/**
 * Leituras públicas do catálogo são servidas exclusivamente pela Edge Function.
 * O backend Render permanece reservado a operações administrativas e mutações.
 */
export async function getPublicSocialLinks(): Promise<PublicSocialLink[]> {
  try {
    const res = await fetch(getApiUrl('/api/institutional/social-links'), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || data.success !== true || !Array.isArray(data.links)) return [];
    return data.links.filter((link: any): link is PublicSocialLink =>
      typeof link?.network === 'string' &&
      Object.prototype.hasOwnProperty.call(SOCIAL_LABELS, link.network) &&
      typeof link?.label === 'string' &&
      /^https:\/\/[^\s]+$/i.test(link?.url || '')
    );
  } catch {
    return [];
  }
}

export async function getProducts(): Promise<any[]> {
  const response = await fetch(getPublicCatalogApiUrl(), { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Catálogo indisponível: API pública retornou HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.products)
      ? payload.products
      : Array.isArray(payload?.data)
        ? payload.data
        : null;
  if (!list) {
    throw new Error('Catálogo indisponível: API pública não contém uma lista válida.');
  }

  console.log(`[Catalog] ${list.length} registros carregados da API pública canônica.`);
  const normalized = list.map((p: any) => ({
    ...p,
    id: String(p.id || ''),
    produto: p.produto || '',
    displayTitle: typeof (p.displayTitle || p.display_title) === 'string' ? (p.displayTitle || p.display_title).trim() : undefined,
    curatorNote: sanitizePublicCuratorNote(p.curatorNote || p.curator_note),
    preco: Number(p.preco) || 0,
    imagens: Array.isArray(p.imagens)
      ? p.imagens
      : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : (p.imagem ? [p.imagem] : [])),
    link: p.link || p.url || '',
    categoria: resolvePublicProductCategory(p.categoria || p.category, {
      title: p.displayTitle || p.display_title || p.produto || p.title || p.name,
      description: p.descricao || p.description,
    }),
    createdAt: typeof (p.createdAt || p.created_at) === 'string' ? (p.createdAt || p.created_at) : undefined,
    ativo: p.ativo !== false,
    status: p.status || 'published'
  }));
  const publicProducts = normalized.filter((product: any) =>
    product.ativo !== false
    && product.status === 'published'
    && Boolean(product.categoria)
  );
  if (publicProducts.length !== normalized.length) {
    console.warn(`[Catalog] ${normalized.length - publicProducts.length} registro(s) omitido(s): não publicados/ativos ou PUBLIC_CATEGORY_REVIEW_REQUIRED.`);
  }
  return publicProducts;
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
  try {
    const res = await fetch(getApiUrl('/api/meta-capi'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('[Meta CAPI] Falha ao enviar evento CAPI:', err);
    return false;
  }
}

export async function trackProductClickApi(data: any): Promise<boolean> {
  try {
    const res = await fetch(getApiUrl('/api/track-click'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('[Analytics] Falha ao enviar clique para o backend:', err);
    return false;
  }
}

export async function subscribeNewsletter(email: string, marketingConsent: boolean): Promise<{ success: boolean; error?: string; result?: string; replayed?: boolean }> {
  try {
    const res = await fetch(getApiUrl('/api/newsletter'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, marketingConsent })
    });
    const payload = await res.json().catch(() => ({}));

    if ((res.status === 201 || res.status === 200) && payload.success === true) {
      const successResponse: { success: true; result?: string; replayed?: boolean } = { success: true };
      if (typeof payload.result === 'string') successResponse.result = payload.result;
      if (typeof payload.replayed === 'boolean') successResponse.replayed = payload.replayed;
      return successResponse;
    }

    if (res.status === 400 && payload.code === 'INVALID_EMAIL') {
      return { success: false, error: 'E-mail inválido. Verifique e tente novamente.' };
    }

    if (res.status === 400 && payload.code === 'CONSENT_REQUIRED') {
      return { success: false, error: 'Confirme que deseja receber novas seleções, recomendações e ofertas.' };
    }

    if (res.status === 409 && payload.code === 'RECONSENT_REQUIRED') {
      return { success: false, error: 'Este contato está fora da lista de marketing. Uma reativação exigirá um fluxo explícito futuro.' };
    }

    if (res.status === 409 && payload.code === 'IDEMPOTENCY_COLLISION') {
      return { success: false, error: 'A intenção de inscrição não coincide com a intenção já registrada.' };
    }

    if (res.status === 503 && payload.code === 'NEWSLETTER_UNAVAILABLE') {
      return { success: false, error: 'Serviço temporariamente indisponível. Tente novamente em instantes.' };
    }

    return { success: false, error: payload.error || 'Cadastro indisponível.' };
  } catch {
    return { success: false, error: 'Não foi possível conectar. Se o site acabou de carregar, aguarde alguns segundos e tente novamente.' };
  }
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

export const publicCatalogApiInternals = {
  PRODUCTION_API_BASE,
  PUBLIC_CATALOG_EDGE_BASE,
  getPublicCatalogApiUrl,
};
