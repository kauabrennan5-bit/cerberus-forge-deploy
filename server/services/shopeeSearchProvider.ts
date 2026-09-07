import axios from "axios";
import * as cheerio from "cheerio";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";

export interface ShopeeSearchCandidate {
  url: string;
  shopId: string;
  itemId: string;
  rawTitle: string;
}

export type ShopeeSearchState =
  | "DDG_OK"
  | "DDG_BLOCKED"
  | "DDG_UNAVAILABLE"
  | "DDG_NO_RESULTS";

export interface ShopeeSearchResult {
  provider: "duckduckgo";
  state: ShopeeSearchState;
  candidates: ShopeeSearchCandidate[];
  httpStatus: number | null;
  reason: string | null;
}

export interface ShopeeSearchHttpClient {
  get: (
    url: string,
    config: Record<string, unknown>,
  ) => Promise<{ status: number; data: unknown }>;
}

const DDG_URL = "https://duckduckgo.com/lite/";
const DDG_BLOCKED_STATUSES = new Set([202, 403, 418, 429]);
const DDG_CHALLENGE_PATTERN = /anomaly-modal|captcha|bot challenge|unusual traffic|automated requests/i;

function result(
  state: ShopeeSearchState,
  candidates: ShopeeSearchCandidate[] = [],
  httpStatus: number | null = null,
  reason: string | null = null,
): ShopeeSearchResult {
  return { provider: "duckduckgo", state, candidates, httpStatus, reason };
}

function unwrapDdgResultUrl(rawHref: string): string | null {
  const href = String(rawHref || "").trim();
  if (!href) return null;
  try {
    const parsed = new URL(href, DDG_URL);
    const redirected = parsed.searchParams.get("uddg");
    // URLSearchParams already decodes the parameter exactly once.
    if (redirected) return redirected;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseCandidates(html: string): ShopeeSearchCandidate[] {
  const $ = cheerio.load(html);
  const candidates: ShopeeSearchCandidate[] = [];
  const selectors = [".result-link", "a.result-link", ".links_main a", ".result__a"];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const url = unwrapDdgResultUrl($(element).attr("href") || "");
      if (!url) return;
      const identity = extractShopeeIdentity(url);
      if (!identity.shopId || !identity.itemId) return;
      candidates.push({
        url,
        shopId: identity.shopId,
        itemId: identity.itemId,
        rawTitle: $(element).text().replace(/\s+/g, " ").trim(),
      });
    });
  }

  return Array.from(
    new Map(candidates.map(candidate => [`${candidate.shopId}:${candidate.itemId}`, candidate])).values(),
  );
}

/**
 * Descoberta pública de candidatos Shopee via DuckDuckGo Lite.
 *
 * Esta camada nunca envia mensagens ao Telegram e nunca promove os dados web a
 * evidência canônica. URL, título, shopId e itemId são apenas pistas que o
 * orquestrador deve confirmar pela Shopee Affiliate API antes de usar.
 */
export async function searchShopeeProductsDDG(
  keyword: string,
  limit: number = 20,
  http: ShopeeSearchHttpClient = axios,
): Promise<ShopeeSearchResult> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 1));
  const query = `site:shopee.com.br/product ${String(keyword || "").trim()}`;

  try {
    const response = await http.get(DDG_URL, {
      params: { q: query },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      timeout: 10_000,
    });

    const httpStatus = Number.isFinite(response.status) ? response.status : null;
    const html = typeof response.data === "string" ? response.data : "";
    if ((httpStatus !== null && DDG_BLOCKED_STATUSES.has(httpStatus)) || DDG_CHALLENGE_PATTERN.test(html)) {
      return result("DDG_BLOCKED", [], httpStatus, "ddg_challenge_or_block");
    }
    if (httpStatus !== 200 || !html) {
      return result("DDG_UNAVAILABLE", [], httpStatus, httpStatus === 200 ? "ddg_invalid_body" : "ddg_http_error");
    }

    const candidates = parseCandidates(html).slice(0, safeLimit);
    if (candidates.length === 0) {
      return result("DDG_NO_RESULTS", [], httpStatus, "ddg_zero_candidates");
    }
    return result("DDG_OK", candidates, httpStatus, null);
  } catch (error: unknown) {
    const responseStatus = Number((error as { response?: { status?: unknown } })?.response?.status);
    const httpStatus = Number.isFinite(responseStatus) ? responseStatus : null;
    if (httpStatus !== null && DDG_BLOCKED_STATUSES.has(httpStatus)) {
      return result("DDG_BLOCKED", [], httpStatus, "ddg_request_blocked");
    }
    return result("DDG_UNAVAILABLE", [], httpStatus, "ddg_request_failed");
  }
}
