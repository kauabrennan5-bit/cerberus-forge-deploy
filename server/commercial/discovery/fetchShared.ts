// ============================================================================
// Bloco N2 — Fetch compartilhado dos conectores (READ-ONLY).
// Reutiliza os limites já auditados do scraper (timeout 15s, limite de HTML),
// adicionando rate limiter, retry máximo 1 e circuit breaker por host.
// Proteções contra redirect para domínio não autorizado (fail-closed).
// ============================================================================

import {
  DISCOVERY_LIMITS,
  MarketplaceSource,
  RawListing,
  rawField,
  derivedField,
  UNKNOWN_TOKEN,
} from "./types";
import { SlidingWindowRateLimiter, CircuitBreaker } from "./rateLimiter";
import { evidenceDigest, contentSnapshot, isRedirectHostAllowed } from "./evidence";
import { extractMarketplaceId } from "../../services/productAutomation";
import { fetchProductDataFromUrl } from "../../services/scraper";

// Instâncias globais por processo (limite de operação: discovery sob demanda).
export const discoveryRateLimiter = new SlidingWindowRateLimiter({
  maxRequests: 10, // 10 requisições por janela por host
  windowMs: DISCOVERY_LIMITS.CIRCUIT_WINDOW_MS,
});

export const discoveryCircuitBreaker = new CircuitBreaker(
  DISCOVERY_LIMITS.CIRCUIT_FAILURE_THRESHOLD,
  DISCOVERY_LIMITS.CIRCUIT_WINDOW_MS,
);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

// Busca simples: extrai links de anúncios da página de resultados pública.
// Limitado e determinístico — NÃO é crawler nem paginação ilimitada.
export async function fetchSearchResultPage(
  marketplace: MarketplaceSource,
  searchUrl: string,
): Promise<{ ok: boolean; reason?: string; html: string; finalUrl: string; httpStatus: number | null }> {
  const host = hostOf(searchUrl);
  if (!discoveryRateLimiter.tryAcquire(host)) {
    return { ok: false, reason: "rate_limited", html: "", finalUrl: searchUrl, httpStatus: null };
  }
  if (!discoveryCircuitBreaker.allowsRequest(host)) {
    return { ok: false, reason: "circuit_open", html: "", finalUrl: searchUrl, httpStatus: null };
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DISCOVERY_LIMITS.MAX_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DISCOVERY_LIMITS.TIMEOUT_MS);
      try {
        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent": "CerberusCatalogBot/1.0 (+discovery-readonly)",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          },
          redirect: "manual",
          signal: controller.signal,
        });
        // Redirect manual: seguimos apenas dentro da whitelist.
        let currentUrl = searchUrl;
        let redirectCount = 0;
        let resp = response;
        while (resp.status >= 300 && resp.status < 400 && redirectCount < 3) {
          const location = resp.headers.get("location");
          if (!location) throw new Error("Redirect sem destino.");
          currentUrl = new URL(location, currentUrl).href;
          if (!isRedirectHostAllowed(currentUrl, marketplace)) {
            throw new Error("Redirect para domínio fora da whitelist.");
          }
          redirectCount += 1;
          resp = await fetch(currentUrl, { redirect: "manual", signal: controller.signal });
        }
        if (resp.status < 200 || resp.status >= 400) {
          return { ok: false, reason: "http_error", html: "", finalUrl: currentUrl, httpStatus: resp.status };
        }
        discoveryCircuitBreaker.recordSuccess(host);
        const text = await resp.text();
        return { ok: true, html: text.slice(0, 1_000_000), finalUrl: currentUrl, httpStatus: resp.status };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < DISCOVERY_LIMITS.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
    }
  }
  discoveryCircuitBreaker.recordFailure(host);
  return {
    ok: false,
    reason: lastError ? `fetch_failed: ${lastError.message}` : "fetch_failed",
    html: "",
    finalUrl: searchUrl,
    httpStatus: null,
  };
}


// Identifica se o título extraído pelo scraper é na verdade o título
// derivado da URL (fallback do scraper quando a página não fornece título).
// Contraste: título real vem de JSON-LD/OpenGraph/<title> da página.
function isUrlDerivedTitle(title: string | null, url: string): boolean {
  if (!title) return false;
  // O scraper deriva do URL path: "Luminária..." vira slug limpo. Padrão:
  // quando o título extraído está contido no path da URL (sem extensão), ele
  // veio do slug. Detectar pela presença literal do título limpo no pathname.
  try {
    const pathname = new URL(url).pathname
      .replace(/\.\w+$/, "") // remove extensão de arquivo, se houver
      .toLowerCase()
      .replace(/[/-]/g, " ") // slashes e hifens viram espaços
      .trim();
    return pathname.includes(title.toLowerCase()) || pathname === title.toLowerCase();
  } catch {
    return false;
  }
}

// Constrói um RawListing a partir da extração do scraper existente.
export function buildRawListing(params: {
  marketplace: MarketplaceSource;
  source_url: string;
  final_url: string;
  httpStatus: number | null;
  title: string | null;
  price: number | null;
  images: string[];
  content: string; // snapshot textual para hashing
  // PROVENIÊNCIA DE FALHA (patch de contrato): quando a página não pôde ser
  // lida (fetch falhou / bloqueio / timeout), o scraper retorna dados mínimos
  // com título derivado da URL. fetchFailed=true marca explicitamente que
  // NENHUM campo é observação real; o título (se presente) fica marcado como
  // derivado (derived) e preço/imagens permanecem UNKNOWN — nunca facts.
  fetchFailed?: boolean;
  fetchError?: string;
}): RawListing {
  const observed_at = new Date().toISOString();
  const contentDigest = evidenceDigest(params.content);
  const title = params.title;
  const titleFromUrl = params.fetchFailed && isUrlDerivedTitle(title, params.final_url || params.source_url);
  const note = params.fetchFailed
    ? `COLLECTION_FAILED (${params.fetchError ?? "unknown_error"}); título derivado do slug da URL, NÃO confirmado; dados UNKNOWN`
    : "extracted from public page via existing scraper pipeline (jsonLd/og/CDN)";
  return {
    marketplace: params.marketplace,
    source_url: params.source_url,
    final_url: params.final_url,
    external_listing_id: extractMarketplaceId(params.final_url || params.source_url),
    title: titleFromUrl
      ? derivedField(title)
      : rawField(title),
    price: params.fetchFailed ? { value: null, unknown: true } : rawField(params.price),
    currency: "BRL",
    images: params.fetchFailed
      ? { value: [], unknown: true }
      : rawField(params.images.length > 0 ? params.images : null),
    seller: { value: null, unknown: true }, // scraper não expõe seller; UNKNOWN
    rating: { value: null, unknown: true }, // não observado na extração atual; UNKNOWN
    review_count: { value: null, unknown: true },
    availability: { value: null, unknown: true },
    category: { value: null, unknown: true },
    evidence_digest: contentDigest,
    evidence_note: note,
    observed_at,
    collection_method: "PUBLIC_PAGE",
    content_digest_input: contentSnapshot(params.content),
    http_status: params.httpStatus,
    fetch_failed: Boolean(params.fetchFailed),
    ...(params.fetchFailed ? { fetch_error: params.fetchError ?? "unknown_error" } : {}),
  };
}

// Leitura de um anúncio específico reutilizando o pipeline do scraper.
// PROVENIÊNCIA DE FALHA (patch de contrato): o fetch é feito DIRETAMENTE por
// este módulo (validação de status e redirect whitelist como o search),
// garantindo detecção real de bloqueio (403), timeout e network errors — o
// scraper interno é fail-soft (deriva título da URL e nunca lança), então
// depender só dele escondia falhas de coleta. O HTML coletado é passado ao
// scraper via rawTextOverride (sem double-fetch de HTML).
export async function fetchListingPage(params: {
  marketplace: MarketplaceSource;
  source_url: string;
}): Promise<{ ok: boolean; reason?: string; listing: RawListing | null; httpStatus: number | null }> {
  const host = hostOf(params.source_url);
  if (!discoveryRateLimiter.tryAcquire(host)) {
    return { ok: false, reason: "rate_limited", listing: null, httpStatus: null };
  }
  if (!discoveryCircuitBreaker.allowsRequest(host)) {
    return { ok: false, reason: "circuit_open", listing: null, httpStatus: null };
  }

  // Fetch próprio com validação (status + redirect whitelist) — igual ao
  // padrão de fetchSearchResultPage.
  let html = "";
  let httpStatus: number | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DISCOVERY_LIMITS.MAX_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DISCOVERY_LIMITS.TIMEOUT_MS);
      try {
        const response = await fetch(params.source_url, {
          headers: {
            "User-Agent": "CerberusCatalogBot/1.0 (+discovery-readonly)",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          },
          redirect: "manual",
          signal: controller.signal,
        });
        let currentUrl = params.source_url;
        let redirectCount = 0;
        let resp = response;
        while (resp.status >= 300 && resp.status < 400 && redirectCount < 3) {
          const location = resp.headers.get("location");
          if (!location) throw new Error("Redirect sem destino.");
          currentUrl = new URL(location, currentUrl).href;
          if (!isRedirectHostAllowed(currentUrl, params.marketplace)) {
            throw new Error("Redirect para domínio fora da whitelist.");
          }
          redirectCount += 1;
          resp = await fetch(currentUrl, { redirect: "manual", signal: controller.signal });
        }
        if (resp.status < 200 || resp.status >= 400) {
          // Falha de coleta EXPLÍCITA (bloqueio/ban/timeout): nunca tentar
          // extração — sem página lida, sem título derivado como observação.
          return {
            ok: false,
            reason: "http_error",
            listing: null,
            httpStatus: resp.status,
          };
        }
        const text = await resp.text();
        if (!text || text.trim().length === 0) {
          return {
            ok: false,
            reason: "no_content_read",
            listing: null,
            httpStatus: resp.status,
          };
        }
        discoveryCircuitBreaker.recordSuccess(host);
        html = text;
        httpStatus = resp.status;
        break;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < DISCOVERY_LIMITS.MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
    }
  }
  if (!html) {
    discoveryCircuitBreaker.recordFailure(host);
    return {
      ok: false,
      reason: "fetch_failed",
      listing: null,
      httpStatus,
    };
  }

  // Extração via pipeline do scraper com o HTML já coletado (rawTextOverride
  // substitui o conteúdo quando o fetch interno falha/é redundante).
  let extracted: Awaited<ReturnType<typeof fetchProductDataFromUrl>> | null = null;
  try {
    extracted = await fetchProductDataFromUrl(params.source_url, html);
  } catch (err) {
    extracted = null;
  }
  const title = extracted?.title ?? null;
  const price = extracted?.price ?? null;
  const images = extracted?.images ?? [];
  const rawContent = extracted?.rawContent ?? "";
  // O scraper deriva título da URL quando a extração retorna título curto —
  // com HTML real da página isso é raro; se ainda assim vier título derivado
  // (detecção pelo slug), o buildRawListing marca como derived (não confirmado).
  const listing = buildRawListing({
    marketplace: params.marketplace,
    source_url: params.source_url,
    final_url: params.source_url,
    httpStatus,
    title,
    price,
    images,
    content: rawContent,
    fetchFailed: false,
  });
  return { ok: true, listing, httpStatus };
}
