// ============================================================================
// Bloco N6 — Affiliate Link Resolver (integração futura com o N5)
//
// Contrato ADITIVO: prepara o executor N5 para CONSUMIR Affiliate Link
// Records governados, sem substituir o executor, sem criar um segundo
// executor e sem alterar qualquer comportamento de produção.
//
// Uso futuro (não ativado nesta fase):
//   - O adapter do N5 (supabasePublicationAdapter) poderá consultar
//     resolveAffiliateLink para obter affiliate_url governada quando o
//     request NÃO trouxer affiliate_url explícita (admin:manual continua
//     funcionando exatamente como hoje — retrocompatível).
//   - AffiliateLinkSource.provider passa a incluir proveniência
//     N6 (ex.: "provider:admin:manual"), mantendo affiliateState
//     AVAILABLE/UNKNOWN.
//
// Fronteiras:
//   - AFFILIATE LINK != AUTHORITY: a resolução retorna DADOS; a execução
//     continua exigindo DECISION + Policy Engine + ApprovalStore.
//   - Falha fechada: qualquer erro → null + reason; nunca link inventado.
//   - CANDIDATE != FACT CANÔNICO: a resolução nunca promove candidato.
// ============================================================================
import { resolveUsableLinkForCandidate } from "./affiliateValidator";
import type { AffiliateLinkRecord } from "./contract";

export interface ResolvedAffiliateLink {
  /** URL rastreável governada (proveniência admin:manual via registry). */
  affiliateUrl: string;
  /** Proveniência registrada — sempre 'provider:admin:manual' na v1. */
  provider: string;
  /** providerRef do registry (provider_id). */
  providerRef: string;
  /** Id do link governado. */
  linkId: string;
  /** Registro completo para auditoria. */
  record: AffiliateLinkRecord;
}

/**
 * Resolve um link utilizável para um candidate (status VALID + provider
 * ACTIVE + não expirado). Fail-closed: erro ou ausência → null.
 * NÃO publica, NÃO promove, NÃO executa.
 */
export async function resolveAffiliateLink(
  candidateId: string
): Promise<ResolvedAffiliateLink | null> {
  try {
    const resolution = await resolveUsableLinkForCandidate(candidateId);
    if (!resolution.ok || !resolution.link) return null;
    return {
      affiliateUrl: resolution.link.affiliate_url,
      provider: "provider:admin:manual",
      providerRef: resolution.link.provider_id,
      linkId: resolution.link.link_id,
      record: resolution.link,
    };
  } catch {
    // Fail-closed: nunca inventar link.
    return null;
  }
}
