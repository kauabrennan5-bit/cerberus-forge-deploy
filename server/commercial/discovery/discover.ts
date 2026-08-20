// ============================================================================
// Bloco N2 — Orquestrador de descoberta controlada.
// Registra candidatos no Registry N1 (registerCandidate). É READ-ONLY em
// relação ao catálogo: NUNCA publica, promove, altera products ou catálogo.
// Todas as chamadas são sob demanda (admin/Telegram), nunca programadas.
// ============================================================================

import {
  MarketplaceSource,
  MarketplaceConnector,
  DiscoverResult,
  DiscoverResultItem,
  DISCOVERY_LIMITS,
} from "./types";
import { mercadoLivreConnector } from "./connectors/mercadoLivre";
import { shopeeConnector } from "./connectors/shopee";
import { candidateNormalizer } from "./normalizer";
import { registerCandidate, listCandidates, deleteCandidateForProof } from "../../repositories/candidatesRepository";
import { evidenceDigest, contentSnapshot } from "./evidence";

// Registra uma tentativa de coleta FALHADA como evidência identificável no
// Registry N1: title null (nunca confirmado), todos os campos UNKNOWN,
// metadata com collection_failed=true e o motivo operacional. Sem isso, uma
// tentativa de descoberta que falha ficaria invisível (sem audit trail).
async function registerCollectionFailure(
  marketplace: MarketplaceSource,
  url: string,
  reason: string,
): Promise<DiscoverResultItem> {
  const observed_at = new Date().toISOString();
  const evidence = evidenceDigest(contentSnapshot(`COLLECTION_FAILED:${reason}:${url}`));
  const registration = await registerCandidate({
    marketplace: n1Marketplace(marketplace),
    source_url: url,
    external_listing_id: "UNKNOWN",
    merchant: null,
    title: null,
    description: null,
    category: null,
    observed_price: null,
    observed_rating: null,
    observed_rating_count: null,
    observed_availability: "UNKNOWN",
    observed_at,
    evidence_hash: evidence,
    collection_method: "SCRAPE",
    idempotency_key: evidence.slice(0, 32),
    metadata: {
      source: "unknown",
      unknown_fields: ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"],
      evidence_note: `COLLECTION_FAILED (${reason}); tentativa de coleta sem dados observados — nada confirmado`,
      collection_failed: true,
      http_status: null,
      final_url: url,
      discovery_block: "N2",
    },
  });
  return {
    outcome: registration.outcome === "rejected" ? "conflict_rejected" : registration.outcome,
    candidate_id: registration.candidate_id ?? registration.existing_id ?? null,
    marketplace,
    source_url: url,
    title: null,
    unknown_fields: ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"],
  };
}

export function getConnector(marketplace: MarketplaceSource): MarketplaceConnector {
  if (marketplace === "MERCADOLIVRE") return mercadoLivreConnector;
  if (marketplace === "SHOPEE") return shopeeConnector;
  throw new Error(`marketplace_desconhecido: ${String(marketplace)}`);
}

// Mapeia a identidade do N2 para o catálogo fechado do N1.
function n1Marketplace(m: MarketplaceSource): string {
  return m === "MERCADOLIVRE" ? "Mercado Livre" : "Shopee";
}

export interface DiscoverInput {
  marketplace: MarketplaceSource;
  mode: "url" | "search";
  url?: string;
  query?: string;
  limit?: number;
}

function validateDiscoverInput(input: DiscoverInput): { ok: boolean; reason?: string } {
  if (!input.mode || (input.mode !== "url" && input.mode !== "search")) {
    return { ok: false, reason: "invalid_mode" };
  }
  if (input.mode === "url" && (!input.url || typeof input.url !== "string" || input.url.trim().length === 0)) {
    return { ok: false, reason: "missing_url" };
  }
  if (input.mode === "search" && (!input.query || typeof input.query !== "string" || input.query.trim().length === 0)) {
    return { ok: false, reason: "missing_query" };
  }
  if (typeof input.limit === "number" && (input.limit < 1 || input.limit > DISCOVERY_LIMITS.MAX_RESULTS)) {
    return { ok: false, reason: "limit_fora_da_faixa" };
  }
  return { ok: true };
}

// Executa uma operação de descoberta controlada.
// Prova de escopo (teste H): esta função NÃO chama nada de products, pipeline,
// job queue, scheduler ou agentes — apenas conector, normalizer e N1.
export async function executeDiscover(input: DiscoverInput): Promise<DiscoverResult> {
  const validation = validateDiscoverInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      marketplace: input.marketplace,
      mode: input.mode,
      found: 0,
      created: 0,
      duplicates: 0,
      conflicts: 0,
      items: [],
      error: validation.reason,
    };
  }

  const connector = getConnector(input.marketplace);
  const cap = Math.min(Math.max(1, Math.floor(input.limit ?? 5)), DISCOVERY_LIMITS.MAX_RESULTS);

  let listings = [];
  if (input.mode === "url") {
    const result = await connector.fetchListing(input.url!);
    if (!result.ok || !result.listing) {
      // Falha operacional controlada (rate_limited/circuit_open/invalid_url):
      // sem evidência de tentativa — retorna erro sem registro.
      if (result.reason === "rate_limited" || result.reason === "circuit_open" || result.reason === "invalid_url" || result.reason === "empty_query") {
        return {
          ok: false,
          marketplace: input.marketplace,
          mode: "url",
          found: 0,
          created: 0,
          duplicates: 0,
          conflicts: 0,
          items: [],
          error: result.reason ?? "fetch_failed",
        };
      }
      // Falha de COLETA (http_error/no_content_read/fetch_failed): a tentativa
      // é registrada no N1 como evidência identificável (COLLECTION_FAILED),
      // com todos os campos UNKNOWN e title null — nunca confirmado. Isso
      // preserva auditabilidade da descoberta sem inventar dados.
      const failedItem = await registerCollectionFailure(input.marketplace, input.url!, result.reason ?? "fetch_failed");
      return {
        ok: true, // operação concluída com evidência registrada
        marketplace: input.marketplace,
        mode: "url",
        found: 1,
        created: failedItem.outcome === "created" ? 1 : 0,
        duplicates: failedItem.outcome === "identical_duplicate" ? 1 : 0,
        conflicts: failedItem.outcome === "conflict_rejected" ? 1 : 0,
        items: [failedItem],
        error: `collection_failed: ${result.reason}`,
      };
    }
    listings = [result.listing];
  } else {
    const result = await connector.search({ query: input.query!, limit: cap });
    if (!result.ok && result.listings.length === 0) {
      return {
        ok: false,
        marketplace: input.marketplace,
        mode: "search",
        found: 0,
        created: 0,
        duplicates: 0,
        conflicts: 0,
        items: [],
        error: result.reason ?? "search_failed",
      };
    }
    listings = result.listings.slice(0, cap);
  }

  const items: DiscoverResultItem[] = [];
  let created = 0;
  let duplicates = 0;
  let conflicts = 0;

  for (const listing of listings) {
    const payload = candidateNormalizer.normalize(listing);
    const unknownFields = candidateNormalizer.unknownFields(payload);

    // Registro no Registry N1 respeitando o funil (sem bypass).
    const registration = await registerCandidate({
      marketplace: n1Marketplace(payload.marketplace),
      source_url: payload.source_url,
      external_listing_id: payload.external_listing_id,
      merchant: payload.merchant,
      // CONTRATO DE PROVENIÊNCIA (patch): título derivado do slug da URL
      // (source: "url_slug") NÃO é enviado ao N1 como título confirmado —
      // entra como null (UNKNOWN). Somente título observado da página vai.
      title: payload.title.unknown || payload.title.source === "url_slug" ? null : payload.title.value,
      description: null,
      category: payload.category.unknown ? null : payload.category.value,
      observed_price: payload.price.unknown ? null : payload.price.value,
      observed_rating: payload.rating.unknown ? null : payload.rating.value,
      observed_rating_count: payload.review_count.unknown ? null : payload.review_count.value,
      observed_availability: payload.availability.unknown ? "UNKNOWN" : (payload.availability.value ?? "UNKNOWN"),
      observed_at: payload.observed_at,
      evidence_hash: payload.evidence_hash,
      collection_method: "SCRAPE",
      idempotency_key: payload.evidence_hash.slice(0, 32),
      metadata: {
        source: payload.title.source,
        // Proveniência canônica da operação N2; valor fechado e já reconhecido pelo N13.
        provenance: "n10:discovery",
        unknown_fields: unknownFields,
        evidence_note: payload.evidence_note,
        // PROVENIÊNCIA DE FALHA: coleta identificável — COLLECTION_FAILED
        // quando a página não pôde ser lida (mantém diagnóstico para revisão).
        ...(payload.evidence_note.includes("COLLECTION_FAILED")
          ? { collection_failed: true }
          : {}),
        http_status: payload.raw_evidence.http_status,
        final_url: payload.raw_evidence.final_url,
        discovery_block: "N2",
      },
    });

    const outcome: DiscoverResultItem["outcome"] =
      registration.outcome === "rejected" ? "conflict_rejected" : registration.outcome;
    const item: DiscoverResultItem = {
      outcome,
      candidate_id: registration.candidate_id ?? registration.existing_id ?? null,
      marketplace: payload.marketplace,
      source_url: payload.source_url,
      title: payload.title.unknown ? null : payload.title.value,
      unknown_fields: unknownFields,
    };
    items.push(item);

    if (registration.outcome === "created") created += 1;
    else if (registration.outcome === "identical_duplicate") duplicates += 1;
    else if (registration.outcome === "conflict_rejected") conflicts += 1;
  }

  return {
    ok: true,
    marketplace: input.marketplace,
    mode: input.mode,
    found: listings.length,
    created,
    duplicates,
    conflicts,
    items,
  };
}

// Cleanup administrativo seguro para provas vivas (mesmo contrato N1).
export { deleteCandidateForProof, listCandidates };
