// ============================================================================
// Bloco N3 — Serviço de Research (Pipeline de Pesquisa + Evidência).
// Inicia uma sessão de pesquisa para um candidato existente, coleta dados
// usando os conectores READ-ONLY do N2 (com rate-limit/circuit breaker) e
// persiste evidências com proveniência completa na tabela candidate_evidence.
//
// Fronteiras obrigatórias:
//   EVIDENCE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO
//   CANDIDATE != FACT CANÔNICO · RESEARCH != PUBLICATION
//   RESEARCH != PROMOTION
// Este módulo NUNCA:
//   - altera candidates (o registro do candidato é imutável aqui);
//   - cria/altera products ou catálogo canônico;
//   - publica, promove ou executa qualquer ação externa;
//   - toca job queue, scheduler, agentes, Telegram ou lifecycle.
// ============================================================================

import { createHash } from "node:crypto";
import {
  CollectionMethod,
  FIELD_NAMES,
  EvidenceFieldName,
  FieldState,
  SourceType,
  generateEvidenceId,
  listCandidateEvidence,
  listFieldEvidence,
  persistEvidence,
} from "../../repositories/candidateEvidenceRepository";
import {
  MarketplaceSource,
  RawListing,
  UNKNOWN_TOKEN,
} from "./types";
import { fetchListingPage } from "./fetchShared";
import { validateDiscoveryUrl } from "./evidence";
import { getCandidate } from "../../repositories/candidatesRepository";
import { assessEvidenceQuality, detectContradictions } from "./researchQuality";
import { createOfficialShopeeEvidenceAdapter } from "../sources/shopee/adapter";
import type { ShopeeProductLookupClient } from "../sources/shopee/contracts";
import { createShopeeApiClient } from "../affiliate/shopeeApiClient";
import { extractShopeeIdentifiers } from "../affiliate/shopeeClientContracts";

export const RESEARCH_FIELDS: ReadonlyArray<EvidenceFieldName> = [...FIELD_NAMES];

// Mapeamento N2 → proveniência N3 (source_type)
function sourceTypeOf(field: keyof RawListing, listing: RawListing): SourceType {
  const raw = listing[field] as { unknown: boolean; derived?: boolean } | null;
  if (raw?.derived) return "url_slug";
  if (raw?.unknown) return "url_slug"; // desconhecido: não atribuir marketplace_page
  return "marketplace_page";
}

// Mapeamento N2 → state N3
function fieldStateOf(field: keyof RawListing, listing: RawListing): FieldState {
  const raw = listing[field] as { unknown: boolean; derived?: boolean } | null;
  if (raw?.unknown) return "UNKNOWN";
  if (raw?.derived) return "DERIVED";
  return "KNOWN";
}

function contentDigest(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function numericShopeeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d{1,20}$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function resolveShopeeIdentity(
  candidate: { external_listing_id: string; metadata: Record<string, unknown> },
  sourceUrl: string,
): { itemId: string | null; shopId: string | null } {
  const external = String(candidate.external_listing_id ?? "").trim();
  const externalPair = /^shopee-(\d{1,20})-(\d{1,20})$/i.exec(external);
  const urlIdentity = extractShopeeIdentifiers(sourceUrl);
  return {
    itemId: numericShopeeId(external) ?? externalPair?.[2] ?? urlIdentity.itemId,
    shopId:
      numericShopeeId(candidate.metadata?.shop_id) ??
      externalPair?.[1] ??
      urlIdentity.shopId,
  };
}

function createDefaultShopeeClient(): ShopeeProductLookupClient {
  return createShopeeApiClient({
    appId: process.env.SHOPEE_APP_ID ?? process.env.SHOPEE_AFFILIATE_APP_ID ?? "",
    secret: process.env.SHOPEE_APP_SECRET ?? process.env.SHOPEE_AFFILIATE_APP_SECRET ?? "",
    baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL,
  });
}

export interface ResearchInput {
  candidate_id: string;
  initiated_by?: string;
  requested_fields?: ReadonlyArray<string>;
  // Injeção de fetch para testes — em produção usa fetchListingPage real.
  fetchPage?: typeof fetchListingPage;
  // Injeção do cliente oficial Shopee para testes; produção usa as envs oficiais.
  shopeeClient?: ShopeeProductLookupClient;
}

export interface ResearchItemResult {
  field: string;
  state: FieldState | "SESSION" | "FAILED";
  source: SourceType | "none";
  quality: string;
  evidence_id: string | null;
  outcome: "created" | "identical_duplicate" | "rejected";
}

export interface ResearchResult {
  ok: boolean;
  research_id: string | null;
  candidate_id: string | null;
  error?: string;
  fetch_failed?: boolean;
  fetch_reason?: string;
  session_evidence_id: string | null;
  fields: ResearchItemResult[];
  contradictions: number;
  unknowns: number;
}

/**
 * Inicia uma sessão de pesquisa (coleta + evidências).
 * - O candidato DEVE existir no N1 (validação de existência, sem mutação);
 * - A sessão é registrada como RESEARCH_SESSION (estado inicial: UNKNOWN);
 * - Cada campo é coletado via conector N2 e persistido como FIELD;
 * - Contradições com evidências anteriores são marcadas CONTRADICTED
 *   (preservando ambas as evidências);
 * - Se a coleta da página falhar, registra a tentativa como COLLECTION_FAILED
 *   (idempotente, auditável) e o session como estado "FAILED" (unknown fields).
 */
export async function startResearch(input: ResearchInput): Promise<ResearchResult> {
  const candidateId = String(input.candidate_id ?? "");
  if (!candidateId) {
    return {
      ok: false,
      research_id: null,
      candidate_id: null,
      error: "candidate_id_ausente",
      session_evidence_id: null,
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  // Existência do candidato (READ-ONLY — nunca mutação)
  const candidate = await getCandidate(candidateId);
  if (!candidate.ok || !candidate.candidate) {
    return {
      ok: false,
      research_id: null,
      candidate_id: candidateId,
      error: "candidate_not_found",
      session_evidence_id: null,
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  const sourceUrl = candidate.candidate.source_url;
  // Identificar marketplace N2 pela URL (validação whitelist do N2)
  const mp: MarketplaceSource = sourceUrl.toLowerCase().includes("shopee")
    ? "SHOPEE"
    : "MERCADOLIVRE";
  const urlValidation = validateDiscoveryUrl(sourceUrl, mp);
  if (!urlValidation.ok) {
    return {
      ok: false,
      research_id: null,
      candidate_id: candidateId,
      error: `source_url_recusada (${urlValidation.reason})`,
      session_evidence_id: null,
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  const researchId = `rs-${contentDigest(
    `${candidateId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  ).slice(0, 24)}`;

  // Registrar a sessão de pesquisa
  const sessionResult = await persistEvidence({
    candidate_id: candidateId,
    research_id: researchId,
    kind: "RESEARCH_SESSION",
    source_url: sourceUrl,
    source_type: "scrape",
    collection_method: "SCRAPE",
    observed_at: new Date().toISOString(),
    evidence_hash: contentDigest(`RESEARCH_SESSION:${candidateId}:${researchId}`),
    quality: "UNKNOWN",
    evidence_note: `Sessão de pesquisa iniciada por ${input.initiated_by ?? "operator-admin"} via Bloco N3 (pipeline de pesquisa, sem promoção/publicação)`,
    metadata: {
      initiated_by: input.initiated_by ?? "operator-admin",
      candidate_marketplace: candidate.candidate.marketplace,
      discovery_block: "N3",
    },
  });
  if (!sessionResult.ok || !sessionResult.evidence_id) {
    return {
      ok: false,
      research_id: researchId,
      candidate_id: candidateId,
      error: "session_registration_failed",
      session_evidence_id: null,
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  // Coleta da página do anúncio (N2, READ-ONLY)
  const requested = (input.requested_fields ?? RESEARCH_FIELDS)
    .map(f => String(f))
    .filter(f => FIELD_NAMES.includes(f as EvidenceFieldName));

  if (mp === "SHOPEE") {
    const identity = resolveShopeeIdentity(candidate.candidate, sourceUrl);
    const failureFields = async (reason: string, httpStatus: number | null, apiState: string) => {
      const fields: ResearchItemResult[] = [];
      for (const field of requested) {
        const result = await persistEvidence({
          candidate_id: candidateId,
          research_id: researchId,
          kind: "FIELD",
          field_name: field,
          field_value: { value: null, unknown: true },
          field_state: "COLLECTION_FAILED",
          source_url: sourceUrl,
          source_type: "api",
          collection_method: "API",
          observed_at: new Date().toISOString(),
          evidence_hash: contentDigest(`SHOPEE_COLLECTION_FAILED:${apiState}:${reason}:${sourceUrl}:${field}`),
          quality: "UNKNOWN",
          evidence_note: `COLLECTION_FAILED (${reason}): a operação oficial productOfferV2 não confirmou o campo ${field}; permanece UNKNOWN — nada confirmado`,
          metadata: {
            http_status: httpStatus,
            api_state: apiState,
            fetch_failed: true,
            endpoint: "affiliate_graphql",
            operation: "productOfferV2",
            discovery_block: "N3",
          },
        });
        fields.push({
          field,
          state: "FAILED",
          source: "none",
          quality: "UNKNOWN",
          evidence_id: result.ok ? result.evidence_id ?? null : null,
          outcome: result.outcome,
        });
      }
      return {
        ok: true,
        research_id: researchId,
        candidate_id: candidateId,
        fetch_failed: true,
        fetch_reason: reason,
        session_evidence_id: sessionResult.evidence_id,
        fields,
        contradictions: 0,
        unknowns: requested.length,
      } satisfies ResearchResult;
    };

    if (!identity.itemId) {
      return failureFields("identity_missing_item_id", null, "BLOCKED");
    }

    let shopeeResult;
    try {
      const client = input.shopeeClient ?? createDefaultShopeeClient();
      shopeeResult = await createOfficialShopeeEvidenceAdapter(client).collect({
        candidate_id: candidateId,
        research_id: researchId,
        item_id: identity.itemId,
        shop_id: identity.shopId,
        source_url: urlValidation.url,
      });
    } catch {
      return failureFields("client_not_configured", null, "COLLECTION_FAILED");
    }

    if (shopeeResult.state !== "SUCCESS") {
      return failureFields(shopeeResult.reason, shopeeResult.provenance.http_status, shopeeResult.state);
    }

    const fields: ResearchItemResult[] = [];
    let contradictions = 0;
    let unknowns = 0;
    for (const field of shopeeResult.evidence.fields) {
      const value = field.field_value;
      const unknown = field.field_state === "UNKNOWN";
      const previous = await listFieldEvidence(candidateId, field.field_name);
      const contradictedIds = detectContradictions(
        field.field_name,
        value,
        (previous.evidence ?? []).map(e => ({
          evidence_id: e.evidence_id,
          field_state: e.field_state,
          field_value: e.field_value,
        })),
      );
      const finalState: FieldState = contradictedIds.length > 0 ? "CONTRADICTED" : field.field_state;
      const result = await persistEvidence({
        candidate_id: candidateId,
        research_id: researchId,
        kind: "FIELD",
        field_name: field.field_name,
        field_value: { value: unknown ? null : value, unknown },
        field_state: finalState,
        source_url: field.source_url || sourceUrl,
        source_type: "api",
        collection_method: "API",
        observed_at: field.observed_at,
        evidence_hash: field.evidence_hash,
        quality: field.quality,
        unit: field.unit,
        evidence_note:
          finalState === "CONTRADICTED"
            ? `${field.field_name} CONTRADITO: valor oficial Shopee diverge de evidência(s) anterior(es) — ambas preservadas`
            : field.evidence_note,
        metadata: {
          ...field.metadata,
          http_status: shopeeResult.provenance.http_status,
          response_digest: shopeeResult.response_digest,
          endpoint: shopeeResult.provenance.endpoint,
          operation: shopeeResult.provenance.operation,
          discovery_block: "N3",
        },
        contradicted_by_evidence_ids: contradictedIds,
      });
      if (unknown) unknowns += 1;
      if (contradictedIds.length > 0) contradictions += 1;
      fields.push({
        field: field.field_name,
        state: finalState,
        source: "api",
        quality: field.quality,
        evidence_id: result.ok ? result.evidence_id ?? null : null,
        outcome: result.outcome,
      });
    }
    return {
      ok: true,
      research_id: researchId,
      candidate_id: candidateId,
      session_evidence_id: sessionResult.evidence_id,
      fields,
      contradictions,
      unknowns,
    };
  }

  const fetchResult = await (input.fetchPage ?? fetchListingPage)({
    marketplace: mp,
    source_url: urlValidation.url,
  });

  const listing: RawListing | null = fetchResult.ok ? fetchResult.listing ?? null : null;

  // Se a coleta falhou: evidência de campo por campo como COLLECTION_FAILED
  if (!listing || !fetchResult.ok) {
    const fields: ResearchItemResult[] = [];
    for (const field of requested) {
      const digest = contentDigest(
        `COLLECTION_FAILED:${fetchResult.reason ?? "fetch_failed"}:${sourceUrl}:${field}`,
      );
      const result = await persistEvidence({
        candidate_id: candidateId,
        research_id: researchId,
        kind: "FIELD",
        field_name: field,
        field_value: { value: null, unknown: true },
        field_state: "COLLECTION_FAILED",
        source_url: sourceUrl,
        source_type: "scrape",
        collection_method: "SCRAPE",
        observed_at: new Date().toISOString(),
        evidence_hash: digest,
        quality: "UNKNOWN",
        evidence_note: `COLLECTION_FAILED (${fetchResult.reason ?? "fetch_failed"}): a página do anúncio não pôde ser lida; campo ${field} permanece UNKNOWN — nada confirmado`,
        metadata: {
          http_status: fetchResult.httpStatus,
          fetch_failed: true,
          discovery_block: "N3",
        },
      });
      fields.push({
        field,
        state: "FAILED",
        source: "none",
        quality: "UNKNOWN",
        evidence_id: result.ok ? result.evidence_id ?? null : null,
        outcome: result.outcome,
      });
    }
    return {
      ok: true,
      research_id: researchId,
      candidate_id: candidateId,
      fetch_failed: true,
      fetch_reason: fetchResult.reason ?? "fetch_failed",
      session_evidence_id: sessionResult.evidence_id,
      fields,
      contradictions: 0,
      unknowns: requested.length,
    };
  }

  // Coleta bem-sucedida: evidências de campo com proveniência
  const fields: ResearchItemResult[] = [];
  let contradictions = 0;
  let unknowns = 0;

  for (const field of requested) {
    const raw = listing[field as keyof RawListing] as {
      value: unknown;
      unknown: boolean;
      derived?: boolean;
    } | null;
    const value = raw ? raw.value : null;
    const unknown = raw?.unknown ?? true;
    const derived = raw?.derived ?? false;

    const state = unknown ? "UNKNOWN" : derived ? "DERIVED" : "KNOWN";
    const source = sourceTypeOf(field as keyof RawListing, listing);
    const qualityDecision = assessEvidenceQuality({
      fieldState: state,
      sourceType: source,
      httpStatus: listing.http_status,
    });

    // Detectar contradição com evidências anteriores do mesmo campo
    const previous = await listFieldEvidence(candidateId, field);
    const contradictedIds = detectContradictions(
      field,
      value,
      (previous.evidence ?? []).map(e => ({
        evidence_id: e.evidence_id,
        field_state: e.field_state,
        field_value: e.field_value,
      })),
    );

    const finalState: FieldState =
      contradictedIds.length > 0 ? "CONTRADICTED" : state;

    // Digest de idempotência por CONTEÚDO: o replay com mesmo conteúdo
    // (mesmo candidato + campo + valor + página) deve ser
    // identical_duplicate, independente da sessão que o gravou.
    const digest = contentDigest(
      JSON.stringify({
        candidate_id: candidateId,
        field,
        value,
        unknown,
        http_status: listing.http_status,
        final_url: listing.final_url,
      }),
    );

    const result = await persistEvidence({
      candidate_id: candidateId,
      research_id: researchId,
      kind: "FIELD",
      field_name: field,
      field_value: {
        value: unknown ? null : value,
        unknown,
        ...(derived ? { derived: true } : {}),
      },
      field_state: finalState,
      source_url: listing.final_url || sourceUrl,
      source_type: source,
      collection_method: "SCRAPE",
      observed_at: listing.observed_at,
      evidence_hash: digest,
      quality: qualityDecision.quality,
      evidence_note:
        finalState === "CONTRADICTED"
          ? `${field} CONTRADITO: valor ${unknown ? "UNKNOWN" : String(value)} difere de evidência(s) anterior(es) — ambas preservadas`
          : unknown
            ? `${field} não observado na página (${listing.evidence_note})`
            : `${field} observado na página do anúncio (${listing.evidence_note})`,
      metadata: {
        http_status: listing.http_status,
        final_url: listing.final_url,
        evidence_note: listing.evidence_note,
        quality_rationale: qualityDecision.rationale,
        discovery_block: "N3",
      },
      contradicted_by_evidence_ids: contradictedIds,
    });

    if (unknown) unknowns += 1;
    if (contradictedIds.length > 0) contradictions += 1;

    fields.push({
      field,
      state: finalState,
      source,
      quality: qualityDecision.quality,
      evidence_id: result.ok ? result.evidence_id ?? null : null,
      outcome: result.outcome,
    });
  }

  return {
    ok: true,
    research_id: researchId,
    candidate_id: candidateId,
    session_evidence_id: sessionResult.evidence_id,
    fields,
    contradictions,
    unknowns,
  };
}

export { listCandidateEvidence, listFieldEvidence };
