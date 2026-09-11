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

type CatalogOverlay = {
  contract: 'catalog-overlay-v1';
  upserts: any[];
  hiddenIds: string[];
};

const SUPABASE_FUNCTIONS_BASE = String(
  import.meta.env?.VITE_SUPABASE_FUNCTIONS_BASE || 'https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1'
).replace(/\/+$/, '');
const PUBLIC_CATALOG_EDGE_BASE = String(
  import.meta.env?.VITE_PUBLIC_CATALOG_EDGE_BASE || `${SUPABASE_FUNCTIONS_BASE}/cerberus-public-api`
).replace(/\/+$/, '');
const RUNTIME_API_BASE = String(
  import.meta.env?.VITE_RUNTIME_API_BASE || `${SUPABASE_FUNCTIONS_BASE}/cerberus-runtime-api`
).replace(/\/+$/, '');

function getRuntimeApiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${RUNTIME_API_BASE}${normalized}`;
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

function parseCatalogOverlay(payload: any): CatalogOverlay | null {
  if (!payload || payload.success !== true || payload.contract !== 'catalog-overlay-v1') return null;
  if (!Array.isArray(payload.upserts) || !Array.isArray(payload.hiddenIds)) return null;
  const upserts = toPublicProductDTOs(payload.upserts);
  const hiddenIds = [...new Set(payload.hiddenIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0).map((id: string) => id.trim()))];
  return { contract: 'catalog-overlay-v1', upserts, hiddenIds };
}

async function loadCatalogOverlay(): Promise<CatalogOverlay> {
  const response = await fetch(getCatalogOverlayUrl(), { cache: 'no-store' });
  if (!response.ok) throw new Error(`catalog overlay retornou HTTP ${response.status}.`);
  const overlay = parseCatalogOverlay(await response.json());
  if (!overlay) throw new Error('catalog overlay inválido.');
  return overlay;
}

function applyCatalogOverlay(snapshot: any[], overlay: CatalogOverlay): any[] {
  const hidden = new Set(overlay.hiddenIds);
  const byId = new Map<string, any>();
  for (const product of snapshot) {
    if (product?.id && !hidden.has(String(product.id))) byId.set(String(product.id), product);
  }
  for (const product of overlay.upserts) {
    if (!product?.id) continue;
    if (hidden.has(String(product.id))) byId.delete(String(product.id));
    else byId.set(String(product.id), product);
  }
  return [...byId.values()];
}

/**
 * O catálogo versionado continua sendo a baseline auditável dos 30 itens legados.
 * Supabase Edge fornece somente um overlay governado de novas publicações/remoções.
 * Se o overlay estiver indisponível, a vitrine permanece no snapshot; nenhuma
 * publicação pode ser criada por esse fallback.
 */
export async function getProducts(): Promise<any[]> {
  const snapshot = await loadPublicCatalog(getLastKnownGoodCatalogUrl(), 'snapshot público versionado');
  try {
    const overlay = await loadCatalogOverlay();
    const merged = applyCatalogOverlay(snapshot, overlay);
    console.log(`[Catalog] ${merged.length} registros públicos após overlay governado.`);
    return merged;
  } catch (overlayError) {
    console.warn('[Catalog] Overlay serverless indisponível; mantendo snapshot público versionado.', overlayError);
    return snapshot;
  }
}

export async function getPublicSocialLinks(): Promise<PublicSocialLink[]> {
  try {
    const res = await fetch(getRuntimeApiUrl('/social-links'), { cache: 'no-store' });
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
    const res = await fetch(getRuntimeApiUrl('/admin/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: password })
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
    const res = await fetch(getRuntimeApiUrl('/admin/products'), {
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
    const res = await fetch(getRuntimeApiUrl(`/admin/products/${encodeURIComponent(id)}`), {
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
    const res = await fetch(getRuntimeApiUrl(`/admin/products/${encodeURIComponent(id)}`), {
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
    const res = await fetch(getRuntimeApiUrl('/meta-capi'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('[Meta CAPI] Falha ao enviar evento CAPI serverless:', err);
    return false;
  }
}

export async function trackProductClickApi(data: any): Promise<boolean> {
  try {
    const res = await fetch(getRuntimeApiUrl('/track-click'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true
    });
    return res.ok;
  } catch (err) {
    console.warn('[Analytics] Falha ao persistir clique no runtime serverless:', err);
    return false;
  }
}

export async function subscribeNewsletter(email: string, marketingConsent: boolean): Promise<{ success: boolean; error?: string; result?: string; replayed?: boolean }> {
  try {
    const res = await fetch(getRuntimeApiUrl('/newsletter'), {
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
    if (res.status === 503 && payload.code === 'NEWSLETTER_UNAVAILABLE') return { success: false, error: 'Serviço temporariamente indisponível. Tente novamente em instantes.' };
    return { success: false, error: payload.error || 'Cadastro indisponível.' };
  } catch {
    return { success: false, error: 'Não foi possível conectar. Se o site acabou de carregar, aguarde alguns segundos e tente novamente.' };
  }
}

export async function extractProduct(url: string, rawText?: string, adminPass?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getRuntimeApiUrl('/admin/extract'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, rawText, senha: adminPass })
    });
    return await res.json();
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
  SUPABASE_FUNCTIONS_BASE,
  PUBLIC_CATALOG_EDGE_BASE,
  RUNTIME_API_BASE,
  getCatalogOverlayUrl,
  getLastKnownGoodCatalogUrl,
  catalogListFromPayload,
  parseCatalogOverlay,
  applyCatalogOverlay,
};
