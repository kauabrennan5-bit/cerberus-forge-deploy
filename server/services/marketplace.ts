/**
 * Módulo Canônico de Identificação de Marketplace e Resolução Segura de URLs (com SSRF guard)
 */

const ALLOWED_MARKETPLACE_DOMAINS = [
  "shopee.com.br",
  "shopee.com",
  "shope.ee",
  "mercadolivre.com.br",
  "mercadolibre.com",
  "meli.la"
];

function isSafeUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

export function detectMarketplace(urlStr: string): string {
  if (!urlStr) return "Outros";
  let target = urlStr.trim();
  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    target = "https://" + target;
  }
  try {
    const parsed = new URL(target);
    if (!isSafeUrl(parsed)) return "Outros";
    const host = parsed.hostname.toLowerCase();

    const matchesAllowed = ALLOWED_MARKETPLACE_DOMAINS.some(domain => host === domain || host.endsWith("." + domain));
    if (!matchesAllowed) return "Outros";

    if (host.includes("shopee") || host.includes("shope.ee")) {
      return "Shopee";
    }
    if (host.includes("mercadolivre") || host.includes("mercadolibre") || host === "meli.la" || host.endsWith(".meli.la")) {
      return "Mercado Livre";
    }
  } catch {
    const lower = urlStr.toLowerCase();
    if (lower.includes("shopee") || lower.includes("shope.ee")) return "Shopee";
    if (lower.includes("mercadolivre") || lower.includes("mercadolibre") || lower.includes("meli.la")) return "Mercado Livre";
  }
  return "Outros";
}

export function isIntermediateMarketplaceUrl(urlStr: string): boolean {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    return /^\/(?:social(?:\/|$)|search(?:\/|$)|home(?:\/|$)|deals(?:\/|$)|offers(?:\/|$))/.test(pathname);
  } catch {
    return false;
  }
}

export async function resolveShortUrlIfNeeded(urlStr: string): Promise<{ resolvedUrl: string; marketplace: string }> {
  let target = urlStr.trim();
  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    target = "https://" + target;
  }

  let marketplace = detectMarketplace(target);
  let resolvedUrl = target;

  try {
    const parsed = new URL(target);
    if (!isSafeUrl(parsed)) {
      return { resolvedUrl: target, marketplace: "Outros" };
    }

    if (parsed.hostname.toLowerCase() === "meli.la" || parsed.hostname.toLowerCase().endsWith(".meli.la")) {
      marketplace = "Mercado Livre";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(target, {
          method: "HEAD",
          redirect: "follow",
          headers: { "User-Agent": "CerberusRedirectResolver/1.0" },
          signal: controller.signal
        });
        const finalUrl = response.url || target;
        const parsedFinal = new URL(finalUrl);
        if (isSafeUrl(parsedFinal) && !isIntermediateMarketplaceUrl(finalUrl)) {
          resolvedUrl = finalUrl;
          const finalMarketplace = detectMarketplace(resolvedUrl);
          if (finalMarketplace !== "Outros") {
            marketplace = finalMarketplace;
          }
        } else if (isIntermediateMarketplaceUrl(finalUrl)) {
          console.warn(`[Marketplace Resolver] Destino intermediário rejeitado para ${target}: ${parsedFinal.pathname}`);
        }
      } catch (err) {
        console.warn(`[Marketplace Resolver] Aviso ao resolver redirect de ${target}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (err) {
    console.warn(`[Marketplace Resolver] URL inválida: ${urlStr}`);
  }

  return { resolvedUrl, marketplace };
}
