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

const DEFAULT_SERVERLESS_RUNTIME_BASE = 'https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-runtime-api';
const DEFAULT_PUBLIC_CATALOG_EDGE_BASE = 'https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-public-api';
const SERVERLESS_RUNTIME_BASE = String(import.meta.env?.VITE_SERVERLESS_RUNTIME_BASE || DEFAULT_SERVERLESS_RUNTIME_BASE).replace(/\/+$/, '');
const PUBLIC_CATALOG_EDGE_BASE = String(import.meta.env?.VITE_PUBLIC_CATALOG_EDGE_BASE || DEFAULT_PUBLIC_CATALOG_EDGE_BASE).replace(/\/+$/, '');

function runtimePath(path: string): string {
  if (path === '/api/institutional/social-links') return '/social-links';
  if (path === '/api/admin/verify') return '/admin/verify';
  if (path === '/api/admin/extract') return '/admin/extract';
  if (path === '/api/meta-capi') return '/meta-capi';
  if (path === '/api/track-click') return '/track-click';
  if (path === '/api/newsletter') return '/newsletter';
  if (path === '/api/products') return '/admin/products';
  if (path.startsWith('/api/products/')) return `/admin/products/${path.slice('/api/products/'.length)}`;
  throw new Error(`SERVERLESS_ROUTE_NOT_MIGRATED:${path}`);
}

function getApiUrl(path: string): string {
  return `${SERVERLESS_RUNTIME_BASE}${runtimePath(path)}`;
}

function getPublicCatalogApiUrl(): string {
  return `${PUBLIC_CATALOG_EDGE_BASE}/products?t=${Date.now()}`;
}

function getCatalogOverlayUrl(): string {
  return `${PUBLIC_CATALOG_EDGE_BASE}/catalog-overlay?t=${Date.now()}`;
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
  if (!response.ok) throw new Error(`${source} retornou HTTP ${response.status}.`);
  const payload = await response.json();
  const list = catalogListFromPayload(payload);
  if (!list) throw new Error(`${source} não contém uma lista válida.`);
  const publicProducts = toPublicProductDTOs(list);
  if (publicProducts.length !== list.length) {
    console.warn(`[Catalog] ${list.length - publicProducts.length} registro(s) omitido(s) pela projeção pública canônica em ${source}.`);
  }
  return publicProducts;
}

async function loadCatalogOverlay(): Promise<{ upserts: any[]; hiddenIds: string[] }> {
  const response = await fetch(getCatalogOverlayUrl(), { cache: 'no-store' });
  if (!response.ok) throw new Error(`catalog overlay retornou HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload?.success !== true || payload?.contract !== 'catalog-overlay-v1' || !Array.isArray(payload.upserts) || !Array.isArray(payload.hiddenIds)) {
    throw new Error('catalog overlay inválido.');
  }
  return {
    upserts: toPublicProductDTOs(payload.upserts),
    hiddenIds: payload.hiddenIds.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0),
  };
}

function applyCatalogOverlay(base: any[], overlay: { upserts: any[]; hiddenIds: string[] }): any[] {
  const hidden = new Set(overlay.hiddenIds);
  const upserts = new Map(overlay.upserts.map(product => [String(product.id), product]));
  const merged = base
    .filter(product => !hidden.has(String(product.id)))
    .map(product => upserts.get(String(product.id)) || product);
  const baseIds = new Set(base.map(product => String(product.id)));
  const newRows = overlay.upserts.filter(product => !baseIds.has(String(product.id)) && !hidden.has(String(product.id)));
  return [...newRows, ...merged];
}

/**
 * O snapshot versionado continua sendo a baseline dos 30 itens legados, cuja
 * prova histórica não pode ser inventada. Toda mutação serverless passa pelo
 * Supabase e aparece na vitrine por um overlay governado: upserts somente de
 * produtos que passam no gate público e tombstones para itens arquivados/rotados.
 */
export async function getProducts(): Promise<any[]> {
  let snapshot: any[] | null = null;
  try {
    snapshot = await loadPublicCatalog(getLastKnownGoodCatalogUrl(), 'snapshot público versionado');
  } catch (snapshotError) {
    console.error('[Catalog] Snapshot público indisponível.', snapshotError);
  }

  if (snapshot) {
    try {
      return applyCatalogOverlay(snapshot, await loadCatalogOverlay());
    } catch (overlayError) {
      console.warn('[Catalog] Overlay serverless indisponível; preservando baseline versionada em modo degradado.', overlayError);
      return snapshot;
    }
  }

  try {
    return await loadPublicCatalog(getPublicCatalogApiUrl(), 'Supabase Edge');
  } catch (edgeError) {
    console.error('[Catalog] Snapshot e Supabase Edge indisponíveis.', edgeError);
    throw new Error('Catálogo temporariamente indisponível.');
  }
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
      body: JSON.stringify({ senha: password })
    });
    if (!res.ok) return { success: false, error: 'Senha incorreta.' };
    const data = await res.json();
    return { success: Boolean(data.success), error: data.error };
  } catch {
    return { success: false, error: 'Erro ao conectar ao runtime serverless.' };
  }
}

export async function createProduct(payload: any, password?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl('/api/products'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, senha: password || payload.senha })
    });
    return await res.json();
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
    return await res.json();
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
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao remover produto.' };
  }
}

export async function sendMetaCapiEvent(eventData: any): Promise<boolean> {
  try {
    const { metaPixelId: _legacyPixelId, metaAccessToken: _legacyAccessToken, ...safeEventData } = eventData || {};
    const res = await fetch(getApiUrl('/api/meta-capi'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safeEventData),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('[Meta CAPI] Falha ao enviar evento ao Edge:', err);
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
    console.warn('[Analytics] Falha ao enviar clique ao Edge:', err);
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
    if (res.status === 400 && payload.code === 'INVALID_EMAIL') return { success: false, error: 'E-mail inválido. Verifique e tente novamente.' };
    if (res.status === 400 && payload.code === 'CONSENT_REQUIRED') return { success: false, error: 'Confirme que deseja receber novas seleções, recomendações e ofertas.' };
    if (res.status === 409 && payload.code === 'RECONSENT_REQUIRED') return { success: false, error: 'Este contato está fora da lista de marketing. Uma reativação exigirá um fluxo explícito futuro.' };
    if (res.status === 409 && payload.code === 'IDEMPOTENCY_COLLISION') return { success: false, error: 'A intenção de inscrição não coincide com a intenção já registrada.' };
    if (res.status === 429) return { success: false, error: 'Muitas tentativas. Aguarde um instante e tente novamente.' };
    if (res.status === 503 && payload.code === 'NEWSLETTER_UNAVAILABLE') return { success: false, error: 'Serviço temporariamente indisponível. Tente novamente em instantes.' };
    return { success: false, error: payload.error || 'Cadastro indisponível.' };
  } catch {
    return { success: false, error: 'Não foi possível conectar ao runtime serverless.' };
  }
}

export async function extractProduct(url: string, rawText?: string, adminPass?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl('/api/admin/extract'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, rawText, senha: adminPass })
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao extrair produto.' };
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
  DEFAULT_SERVERLESS_RUNTIME_BASE,
  DEFAULT_PUBLIC_CATALOG_EDGE_BASE,
  SERVERLESS_RUNTIME_BASE,
  PUBLIC_CATALOG_EDGE_BASE,
  getApiUrl,
  getPublicCatalogApiUrl,
  getCatalogOverlayUrl,
  getLastKnownGoodCatalogUrl,
  catalogListFromPayload,
  applyCatalogOverlay,
};
