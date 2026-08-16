// ============================================================================
// Bloco N2 — Evidência e validação de URL.
// Todo candidato deve carregar proveniência suficiente para responder:
// onde, o quê, quando e como.
// ============================================================================

import { createHash } from "crypto";
import { MARKETPLACE_HOSTS, MarketplaceSource, DISCOVERY_LIMITS } from "./types";

// SHA-256 do conteúdo observado (base para evidence_hash do N1).
export function evidenceDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// Trunca o conteúdo para o snapshot auditável (não armazenamos HTML completo).
export function contentSnapshot(content: string): string {
  const max = DISCOVERY_LIMITS.MAX_CONTENT_SNAPSHOT_BYTES;
  const prefix = content.slice(0, max);
  const suffix = content.length > max ? `\n[truncated: ${content.length - max} bytes omitidos do snapshot]` : "";
  return prefix + suffix;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  url: string; // URL validada e normalizada
  finalHost?: string;
}

// Valida URL e aplica a whitelist do marketplace.
// FAIL-CLOSED: qualquer URL fora da whitelist, malformada ou com protocolo
// inseguro é recusada. O redirecionamento para domínio não autorizado é
// detectado na camada de fetch (comparação de host final vs. whitelist).
export function validateDiscoveryUrl(urlStr: string, marketplace: MarketplaceSource): ValidationResult {
  if (!urlStr || typeof urlStr !== "string") {
    return { ok: false, reason: "invalid_url", url: "" };
  }
  let candidate = urlStr.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = "https://" + candidate;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid_url", url: "" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "invalid_protocol", url: "" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const allowed = MARKETPLACE_HOSTS[marketplace];
  const isAllowed = allowed.some(domain => host === domain || host.endsWith("." + domain));
  if (!isAllowed) {
    return { ok: false, reason: "domain_not_allowed", url: candidate };
  }
  // Proteções genéricas contra localhost e redes internas (defesa em profundidade)
  if (/^(localhost|127\.\d+\.\d+\.\d+|10\.\d+|192\.168\.\d+|169\.254\.\d+|0\.0\.0\.0|\[::1\])$/.test(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: "unsafe_host", url: candidate };
  }
  return { ok: true, url: candidate, finalHost: host };
}

// Redirecionamento para host não autorizado na whitelist → recusa.
export function isRedirectHostAllowed(finalUrl: string, marketplace: MarketplaceSource): boolean {
  try {
    const finalHost = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
    return MARKETPLACE_HOSTS[marketplace].some(domain => finalHost === domain || finalHost.endsWith("." + domain));
  } catch {
    return false;
  }
}
