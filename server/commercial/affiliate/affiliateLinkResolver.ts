// ============================================================================
// Bloco N7 — Affiliate Resolver v1 (integração operacional N6 → N5)
//
// Contrato versionado: affiliate_resolver_v1
//
// Responsabilidade ÚNICA: fornecer DADOS de resolução de link afiliado para
// o Publication Executor (N5). O resolver NUNCA autoriza publicação, NUNCA
// publica, NUNCA promove candidato e NUNCA executa qualquer ação externa.
//
//   AFFILIATE LINK != AUTHORIZATION
//   VALID != AUTHORITY
//   RESOLUTION != DECISION
//
// Fronteiras:
//   - Entrada: candidate_id + affiliateUrl manual explícita (opcional)
//     + snapshot de registry quando injetado (testes).
//   - Saída: estado explícito + dados (DATA, não decisão).
//   - affiliateUrl manual continua válida somente quando fornecida
//     explicitamente e validada conforme N6 (rota N5 já valida formato;
//     proveniência admin:manual registrada no AffiliateLinkSource).
//   - Sem affiliateUrl manual: seleciona SOMENTE link elegível
//     (VALID ∧ validation_state=VALID ∧ provider ACTIVE ∧ não expirado,
//     não revogado) com seleção determinística (observed_at DESC,
//     digest ASC como desempate) — nunca "primeiro que aparecer".
//   - Não inventa link; não transforma URL comum em afiliada; não deriva
//     parâmetros de afiliado; não consulta APIs externas; não faz scraping.
//   - Falha: estado explícito (RESOLUTION_ERROR), nunca escrita parcial,
//     o executor decide segundo a política existente (fail-closed do gate).
// ============================================================================
import {
  getProvider,
  listLinksByCandidate,
} from "./affiliateRepository";
import type {
  AffiliateLinkRecord,
  AffiliateProviderRecord,
} from "./contract";

export const AFFILIATE_RESOLVER_CONTRACT_VERSION = "affiliate_resolver_v1";

export type AffiliateResolutionStatus =
  | "RESOLVED"
  | "MANUAL_PROVIDED"
  | "MISSING"
  | "NO_ELEGIBLE_LINK"
  | "RESOLUTION_ERROR";

export interface AffiliateResolution {
  /** Estado explícito da resolução — dados, nunca decisão. */
  status: AffiliateResolutionStatus;
  /** URL utilizável quando disponível (manual validada ou link governado). */
  affiliateUrl: string | null;
  /** provider_id do registry quando resolvido; null caso contrário. */
  providerId: string | null;
  /** link_id governado quando resolvido; null caso contrário. */
  affiliateLinkId: string | null;
  /** Proveniência registrada (sempre admin:manual via registry na v1). */
  provenance: string | null;
  /** Digest determinístico do link governado; null para manual/ausência. */
  digest: string | null;
  /** Base determinística da seleção: most_recent_validity + digest ASC. */
  selectionBasis: string | null;
  /** Versão do contrato do resolver. */
  resolverVersion: string;
  /** Motivo explícito quando status ≠ RESOLVED/MANUAL_PROVIDED. */
  reason: string | null;
  /** Registro completo do link governado (auditoria); null se ausente. */
  linkRecord: AffiliateLinkRecord | null;
  /** Registro do provider (auditoria); null se ausente. */
  providerRecord: AffiliateProviderRecord | null;
}

/**
 * Snapshot injetável do registry (testes e isolamento). Quando ausente,
 * o resolver usa o repositório real do N6 (fail-closed sob erro).
 */
export interface AffiliateRegistrySnapshot {
  listLinksByCandidate(
    candidateId: string
  ): Promise<ReadonlyArray<AffiliateLinkRecord>>;
  getProvider(providerId: string): Promise<AffiliateProviderRecord | null>;
}

/**
 * Seleção determinística: links elegíveis ordenados por observed_at DESC e
 * desempate por digest ASC (ordem lexicográfica estável).
 * Elegível: status=VALID ∧ validation_state=VALID ∧ provider ACTIVE ∧
 *            (expires_at nulo ou no futuro).
 */
export function selectEligibleLink(
  links: ReadonlyArray<AffiliateLinkRecord>,
  providers: ReadonlyMap<string, AffiliateProviderRecord>
): AffiliateLinkRecord | null {
  const now = Date.now();
  const eligible = links.filter((link) => {
    if (link.status !== "VALID" || link.validation_state !== "VALID") return false;
    const provider = providers.get(link.provider_id);
    if (!provider || provider.status !== "ACTIVE") return false;
    if (link.expires_at && new Date(link.expires_at).getTime() <= now) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const atA = new Date(a.observed_at).getTime();
    const atB = new Date(b.observed_at).getTime();
    if (atB !== atA) return atB - atA; // observed_at DESC
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0; // digest ASC
  });
  return eligible[0];
}

async function registrySnapshot(): Promise<AffiliateRegistrySnapshot> {
  // Repositório real do N6 — importado aqui para preservar o fail-closed
  // do resolver (qualquer erro do repositório → RESOLUTION_ERROR).
  return {
    listLinksByCandidate: (candidateId: string) => listLinksByCandidate(candidateId),
    getProvider: (providerId: string) => getProvider(providerId),
  };
}

/**
 * Resolve o link afiliado para um candidate.
 *
 *   - affiliateUrl manual fornecida explicitamente → MANUAL_PROVIDED
 *     (a rota N5 já validou o formato e a whitelist; proveniência
 *     admin:manual registrada no AffiliateLinkSource do contrato).
 *   - sem manual → consulta o registry; link elegível → RESOLVED;
 *     sem elegível → MISSING.
 *   - erro em qualquer consulta → RESOLUTION_ERROR (fail-closed).
 */
export async function resolveAffiliateLink(
  params: {
    candidateId: string;
    /** affiliateUrl manual explicitamente fornecida (já validada pela rota). */
    affiliateUrlManual: string | null;
  },
  snapshot?: AffiliateRegistrySnapshot
): Promise<AffiliateResolution> {
  if (
    params.affiliateUrlManual !== null &&
    params.affiliateUrlManual !== undefined &&
    params.affiliateUrlManual.trim() !== ""
  ) {
    return Object.freeze({
      status: "MANUAL_PROVIDED",
      affiliateUrl: params.affiliateUrlManual.trim(),
      providerId: null,
      affiliateLinkId: null,
      provenance: "admin:manual",
      digest: null,
      selectionBasis: "manual_explicit",
      resolverVersion: AFFILIATE_RESOLVER_CONTRACT_VERSION,
      reason: null,
      linkRecord: null,
      providerRecord: null,
    });
  }
  const registry = snapshot ?? (await registrySnapshot());
  let links: ReadonlyArray<AffiliateLinkRecord>;
  try {
    links = await registry.listLinksByCandidate(params.candidateId);
  } catch {
    return Object.freeze({
      status: "RESOLUTION_ERROR",
      affiliateUrl: null,
      providerId: null,
      affiliateLinkId: null,
      provenance: null,
      digest: null,
      selectionBasis: null,
      resolverVersion: AFFILIATE_RESOLVER_CONTRACT_VERSION,
      reason: "list_links_failed",
      linkRecord: null,
      providerRecord: null,
    });
  }
  if (links.length === 0) {
    return Object.freeze({
      status: "MISSING",
      affiliateUrl: null,
      providerId: null,
      affiliateLinkId: null,
      provenance: null,
      digest: null,
      selectionBasis: null,
      resolverVersion: AFFILIATE_RESOLVER_CONTRACT_VERSION,
      reason: "no_links_registered",
      linkRecord: null,
      providerRecord: null,
    });
  }
  const providers = new Map<string, AffiliateProviderRecord>();
  for (const link of links) {
    try {
      const provider = await registry.getProvider(link.provider_id);
      if (provider) providers.set(link.provider_id, provider);
    } catch {
      // Provider inacessível ≠ elegível: o link segue sem provider válido.
      // (falha fechada por link individual — nunca inventa provider)
    }
  }
  const selected = selectEligibleLink(links, providers);
  if (!selected) {
    return Object.freeze({
      status: "NO_ELEGIBLE_LINK",
      affiliateUrl: null,
      providerId: null,
      affiliateLinkId: null,
      provenance: null,
      digest: null,
      selectionBasis: "selection_none",
      resolverVersion: AFFILIATE_RESOLVER_CONTRACT_VERSION,
      reason: "no_eligible_link",
      linkRecord: null,
      providerRecord: null,
    });
  }
  return Object.freeze({
    status: "RESOLVED",
    affiliateUrl: selected.affiliate_url,
    providerId: selected.provider_id,
    affiliateLinkId: selected.link_id,
    provenance: selected.provenance,
    digest: selected.digest,
    selectionBasis: "most_recent_validity;digest_asc",
    resolverVersion: AFFILIATE_RESOLVER_CONTRACT_VERSION,
    reason: null,
    linkRecord: selected,
    providerRecord: providers.get(selected.provider_id) ?? null,
  });
}
