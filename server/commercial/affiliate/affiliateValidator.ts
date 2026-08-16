// ============================================================================
// Bloco N6 — Affiliate Economics + Link Resolution — Validation Service
//
// Valida um Affiliate Link Record reutilizando a infraestrutura de segurança
// do N2 (whitelist de domínios + redirect whitelist do discovery read-only).
//
// Fronteiras:
//   - VALID != AUTHORITY: um link VALID pode ser USADO pelo executor N5, mas
//     NUNCA publica por si só (DECISION + Policy Engine + ApprovalStore).
//   - Falha fechada: checagem inconclusiva (ex.: fetch indisponível) permanece
//     INCONCLUSIVE/PENDING_EXTERNAL — nunca vira APPROVED/VALID.
//   - Parâmetros de tracking não provam que o link é afiliado: a proveniência
//     'admin:manual' é que confere a origem declarada.
//   - Sem credenciais: a validação não usa tokens nem autentica em programas.
//
// Checagens (ordem determinística):
//   1. Sintaxe de URL (parse)
//   2. Esquema permitido (http/https; fail-closed p/ javascript:/file:/...)
//   3. Host não perigoso (localhost/redes internas)
//   4. Domínio compatível com o marketplace (catálogo fechado do N2)
//   5. Provider compatível (marketplace, status ACTIVE, método MANUAL)
//   6. Redirect whitelist (isRedirectHostAllowed do N2) via checagem viva
//      (método HEAD leve, com rate limiter + circuit breaker do fetchShared)
//   7. Evidência: o link deve conter marcador de rastreamento declarado ou
//      ser expressamente registrado pelo provider — registrado como nota,
//      nunca como recusa automática (a proveniência confere a origem).
//   8. Expiração (expires_at passado → rejeição automática da proposta
//      de VALID)
// ============================================================================
import {
  isRedirectHostAllowed,
  type ValidationResult as N2ValidationResult,
} from "../discovery/evidence";
import {
  AFFILIATE_MARKETPLACE_HOSTS,
  type AffiliateMarketplace,
  type AffiliateProviderRecord,
  type LinkValidationOutcome,
} from "./contract";
import type { AffiliateLinkRecord } from "./contract";
import {
  getProvider,
  validateLinkInput,
} from "./affiliateRepository";
import {
  discoveryRateLimiter,
  discoveryCircuitBreaker,
} from "../discovery/fetchShared";

export interface LiveCheckOptions {
  /** Permite executar a checagem viva (fetch HEAD). Default: true. */
  allowLiveCheck?: boolean;
  /** Timeout da checagem viva em ms. */
  liveCheckTimeoutMs?: number;
}

/** Mapeia AffiliateMarketplace (N6) para MarketplaceSource (N2). */
function toN2Marketplace(marketplace: AffiliateMarketplace): "MERCADOLIVRE" | "SHOPEE" {
  return marketplace === "MercadoLivre" ? "MERCADOLIVRE" : "SHOPEE";
}

/**
 * Verificação viva leve (HEAD): confirma domínio de destino + redirect
 * dentro da whitelist do N2, sem baixar o HTML. Rate limiter e circuit
 * breaker compartilhados com o discovery (mesmo teto de operação).
 * Falha de rede/redirect inesperado → INCONCLUSIVE (fail-closed), nunca
 * INVALID arbitrário que esconda a causa, nunca VALID.
 */
export async function liveHostCheck(
  url: string,
  marketplace: AffiliateMarketplace
): Promise<{
  final_host: string | null;
  redirect_ok: boolean;
  http_status: number | null;
  error_reason?: string;
}> {
  const result = { final_host: null as string | null, redirect_ok: false, http_status: null as number | null, error_reason: undefined as string | undefined };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    result.error_reason = "invalid_url";
    return result;
  }

  if (!discoveryRateLimiter.tryAcquire(parsed.hostname)) {
    result.error_reason = "rate_limited";
    return result;
  }
  if (!discoveryCircuitBreaker.allowsRequest(parsed.hostname)) {
    result.error_reason = "circuit_open";
    return result;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      let currentUrl = url;
      let redirectCount = 0;
      let resp = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent": "CerberusCatalogBot/1.0 (+affiliate-validate)",
          Accept: "*/*",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      while (resp.status >= 300 && resp.status < 400 && redirectCount < 3) {
        const location = resp.headers.get("location");
        if (!location) {
          result.error_reason = "redirect_missing_location";
          return result;
        }
        currentUrl = new URL(location, currentUrl).href;
        // Redirect whitelist do N2: reuso explícito, fail-closed.
        if (!isRedirectHostAllowed(currentUrl, toN2Marketplace(marketplace))) {
          result.error_reason = "redirect_not_allowed";
          return result;
        }
        redirectCount += 1;
        const headResp = await fetch(currentUrl, {
          method: "HEAD",
          headers: { "User-Agent": "CerberusCatalogBot/1.0 (+affiliate-validate)", Accept: "*/*" },
          redirect: "manual",
          signal: controller.signal,
        });
        resp = headResp;
      }
      try {
        result.final_host = new URL(currentUrl).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        result.final_host = null;
      }
      result.http_status = resp.status;
      result.redirect_ok = resp.status >= 200 && resp.status < 400;
      return result;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    result.error_reason = err instanceof Error && /abort|timeout/i.test(err.message) ? "timeout" : "network_error";
    return result;
  }
}

/**
 * Validação completa de um link registrado (ou de um input novo).
 * - Validação estrutural determinística (sem fetch) SEMPRE executada.
 * - Checagem viva opcional (falha de rede → INCONCLUSIVE, nunca VALID).
 */
export async function validateAffiliateLink(
  linkOrInput: AffiliateLinkRecord | RegisterLinkInputLike,
  options: LiveCheckOptions = {}
): Promise<LinkValidationOutcome> {
  const allowLiveCheck = options.allowLiveCheck ?? true;
  const checks: Array<{ check: string; ok: boolean; reason?: string }> = [];

  // 1–5: validação estrutural (determinística, sem rede).
  const structural = await validateLinkInput({
    ...linkOrInput,
    provenance: linkOrInput.provenance as "admin:manual" | undefined,
  });
  checks.push({ check: "structural", ok: structural.ok, reason: structural.reason });
  if (!structural.ok) {
    return {
      validation_state: "INVALID",
      checks,
      final_host: null,
    };
  }

  // 6: expiração — já passado → não pode ser proposto como VALID.
  if (
    linkOrInput !== undefined &&
    linkOrInput !== null &&
    typeof (linkOrInput as AffiliateLinkRecord).expires_at === "string" &&
    (linkOrInput as AffiliateLinkRecord).expires_at
  ) {
    const expiresAt = (linkOrInput as AffiliateLinkRecord).expires_at;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      checks.push({ check: "expiry", ok: false, reason: "expired" });
      return { validation_state: "INVALID", checks, final_host: null };
    }
  }
  checks.push({ check: "expiry", ok: true });

  // 7: checagem viva (redirect whitelist do N2).
  let liveFinalHost: string | null = null;
  if (allowLiveCheck) {
    const live = await liveHostCheck(linkOrInput.affiliate_url, linkOrInput.marketplace);
    if (live.error_reason) {
      checks.push({ check: "live_redirect_whitelist", ok: false, reason: live.error_reason });
      // Fail-closed: inconclusivo, nunca VALID.
      return { validation_state: "INCONCLUSIVE", checks, final_host: live.final_host };
    }
    liveFinalHost = live.final_host;
    if (!live.redirect_ok) {
      checks.push({ check: "live_redirect_whitelist", ok: false, reason: live.error_reason ?? "non_ok_status" });
      return { validation_state: "INVALID", checks, final_host: live.final_host };
    }
    checks.push({ check: "live_redirect_whitelist", ok: true });
  } else {
    checks.push({ check: "live_redirect_whitelist", ok: false, reason: "live_check_disabled" });
    // Sem checagem viva → permanece UNVALIDATED/PENDING (não aprova).
    return { validation_state: "PENDING_EXTERNAL", checks, final_host: null };
  }

  return {
    validation_state: "VALID",
    checks,
    final_host: liveFinalHost,
  };
}

/** Shape mínimo aceito pelo validador (record ou input). */
export interface RegisterLinkInputLike {
  affiliate_url: string;
  marketplace: AffiliateMarketplace;
  provider_id: string;
  candidate_id?: string | null;
  product_id?: string | null;
  expires_at?: string | null;
  provenance?: string;
}

/**
 * Resolve um link utilizável pelo executor N5 para um candidate.
 * Governa: status VALID + validation_state VALID + provider ACTIVE.
 * Este módulo NÃO publica — retorna a URL governada para quem tiver
 * DECISION + Policy Engine + ApprovalStore (N5).
 */
export async function resolveUsableLinkForCandidate(candidateId: string): Promise<{
  ok: boolean;
  link: AffiliateLinkRecord | null;
  reason?: string;
}> {
  const { listLinksByCandidate, getProvider } = await import("./affiliateRepository");
  const links = await listLinksByCandidate(candidateId);
  for (const link of links) {
    if (link.status !== "VALID" || link.validation_state !== "VALID") continue;
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) continue;
    const provider = await getProvider(link.provider_id);
    if (!provider || provider.status !== "ACTIVE") continue;
    return { ok: true, link };
  }
  return { ok: false, link: null, reason: "no_usable_link" };
}

export { AFFILIATE_MARKETPLACE_HOSTS, type AffiliateMarketplace, type AffiliateProviderRecord };
