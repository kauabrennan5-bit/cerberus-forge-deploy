import { SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";
import { toPublicProductDTOs } from "../../supabase/functions/_shared/publicProductDTO";

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
const PUBLIC_CATALOG_EDGE_BASE = String(import.meta.env.VITE_PUBLIC_CATALOG_EDGE_BASE || '').replace(/\/+$/, '');

function getApiUrl(path: string): string {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
      // No storefront estático de produção, operações não-catálogo usam o backend canônico.
      if (hostname === 'cerberusfinds.com' || hostname.includes('cerberus-design-static')) {
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

function getPublicCatalogApiUrl(): string | null {
  return PUBLIC_CATALOG_EDGE_BASE ? `${PUBLIC_CATALOG_EDGE_BASE}/products?t=${Date.now()}` : null;
}

function getLastKnownGoodCatalogUrl(): string {
  return `/data/products.json?t=${Date.now()}`;
}

function catalogListFromPayload(payload: any): any[] | null {
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.products)
      ? payload.products
      : Array.isArray(payload?.data)
        ? payload.data
        : null;
}

async function loadPublicCatalog(url: string, source: string): Promise<any[]> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${source} retornou HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const list = catalogListFromPayload(payload);
  if (!list) {
    throw new Error(`${source} não contém uma lista válida.`);
  }

  const publicProducts = toPublicProductDTOs(list);
  if (publicProducts.length !== list.length) {
    console.warn(`[Catalog] ${list.length - publicProducts.length} registro(s) omitido(s) pela projeção pública canônica em ${source}.`);
  }
  console.log(`[Catalog] ${publicProducts.length} registros públicos carregados via ${source}.`);
  return publicProducts;
}

/**
 * Durante a migração serverless, o snapshot versionado publicado junto do
 * storefront é a projeção pública canônica e fail-closed. Ele só muda por PR/CI
 * e nunca participa de mutações. Uma Supabase Edge nova pode ser habilitada
 * explicitamente por VITE_PUBLIC_CATALOG_EDGE_BASE quando a proveniência do
 * banco estiver reconciliada; até lá não fazemos chamadas ao projeto antigo nem
 * ao backend Render suspenso.
 */
export async function getProducts(): Promise<any[]> {
  try {
    return await loadPublicCatalog(getLastKnownGoodCatalogUrl(), 'snapshot público versionado');
  } catch (snapshotError) {
    console.error('[Catalog] Snapshot público indisponível.', snapshotError);
  }

  const edgeUrl = getPublicCatalogApiUrl();
  if (edgeUrl) {
    try {
      return await loadPublicCatalog(edgeUrl, 'Supabase Edge configurada');
    } catch (edgeError) {
      console.error('[Catalog] Snapshot e Supabase Edge configurada indisponíveis.', edgeError);
    }
  }

  throw new Error('Catálogo temporariamente indisponível. Não foi possível carregar a projeção pública versionada.');
}

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
  getLastKnownGoodCatalogUrl,
  catalogListFromPayload,
};
