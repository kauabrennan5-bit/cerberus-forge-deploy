import { SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";
import { clearAdminSessionPassword, getAdminSessionPassword, setAdminSessionPassword } from "../lib/adminSession";

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
  status?: number;
  pending?: boolean;
}

const PRODUCTION_API_BASE = 'https://cerberus-forge-deploy-backend.onrender.com';

function getApiUrl(path: string): string {
  try {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
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

function adminHeaders(password?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const normalized = String(password || getAdminSessionPassword() || '').trim();
  if (normalized) headers['x-admin-password'] = normalized;
  return headers;
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

export async function getProducts(): Promise<any[]> {
  const catalogUrl = `/data/products.json?v=${Date.now()}`;
  const response = await fetch(catalogUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Catálogo indisponível: /data/products.json retornou HTTP ${response.status}.`);
  }

  const list = await response.json();
  if (!Array.isArray(list)) {
    throw new Error('Catálogo indisponível: /data/products.json não contém uma lista válida.');
  }

  console.log(`[Catalog] ${list.length} produtos carregados de /data/products.json.`);
  return list.map((p: any) => ({
    ...p,
    id: String(p.id || ''),
    produto: p.produto || '',
    displayTitle: typeof (p.displayTitle || p.display_title) === 'string' ? (p.displayTitle || p.display_title).trim() : undefined,
    curatorNote: typeof (p.curatorNote || p.curator_note) === 'string' ? (p.curatorNote || p.curator_note).trim() : undefined,
    preco: Number(p.preco) || 0,
    imagens: Array.isArray(p.imagens)
      ? p.imagens
      : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : (p.imagem ? [p.imagem] : [])),
    link: p.link || p.url || '',
    categoria: p.categoria || 'Geral',
    createdAt: typeof (p.createdAt || p.created_at) === 'string' ? (p.createdAt || p.created_at) : undefined,
    ativo: p.ativo !== false,
    status: p.status || 'published'
  }));
}

export async function verifyAdminPassword(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const normalizedPassword = String(password || '').trim();
    const res = await fetch(getApiUrl('/api/admin/verify'), {
      method: 'POST',
      headers: adminHeaders(normalizedPassword),
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success !== true) {
      clearAdminSessionPassword();
      return { success: false, error: data?.error || 'Senha incorreta.' };
    }
    setAdminSessionPassword(normalizedPassword);
    return { success: true };
  } catch {
    clearAdminSessionPassword();
    return { success: false, error: 'Erro ao conectar ao servidor.' };
  }
}

export async function createProduct(payload: any, password?: string): Promise<ApiResponse<any>> {
  try {
    const activePassword = password || payload?.senha || getAdminSessionPassword();
    const { senha: _ignoredSenha, ...safePayload } = payload || {};
    const res = await fetch(getApiUrl('/api/products'), {
      method: 'POST',
      headers: adminHeaders(activePassword),
      body: JSON.stringify(safePayload)
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 202 && data?.success === true) {
      return {
        ...data,
        success: false,
        pending: true,
        status: 202,
        error: data.message || 'Produto enviado para revisão e aguardando aprovação humana no Telegram.'
      };
    }

    return { ...data, status: res.status };
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao criar produto.' };
  }
}

export async function updateProduct(id: string, payload: any, password?: string): Promise<ApiResponse<any>> {
  try {
    const activePassword = password || payload?.senha || getAdminSessionPassword();
    const { senha: _ignoredSenha, ...safePayload } = payload || {};
    const res = await fetch(getApiUrl(`/api/products/${id}`), {
      method: 'PUT',
      headers: adminHeaders(activePassword),
      body: JSON.stringify(safePayload)
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, status: res.status };
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao atualizar produto.' };
  }
}

export async function deleteProduct(id: string, password?: string): Promise<ApiResponse<any>> {
  try {
    const res = await fetch(getApiUrl(`/api/products/${id}`), {
      method: 'DELETE',
      headers: adminHeaders(password)
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, status: res.status };
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
    const res = await fetch(getApiUrl('/api/extract'), {
      method: 'POST',
      headers: adminHeaders(adminPass),
      body: JSON.stringify({ url, rawText })
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, status: res.status };
  } catch (err: any) {
    return { success: false, error: err.message || 'Erro ao extrair produto com IA.' };
  }
}

export async function verifyPasswordApi(password: string): Promise<boolean> {
  const res = await verifyAdminPassword(password);
  return res.success;
}

export async function fetchProxyCsv(_url: string): Promise<string> {
  return '';
}
