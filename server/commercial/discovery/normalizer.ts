// ============================================================================
// Bloco N2 — CandidateNormalizer.
// RawListing → CandidateDiscoveryPayload compatível com o Registry N1.
// Responsabilidade exclusiva: TRANSFORMAR dados. NÃO decide se o produto é
// bom; NÃO pontua; NÃO aprova; NÃO publica (blocos posteriores).
// Proveniência: cada campo normalizado rastreia origem e timestamp.
// Ausência = UNKNOWN (unknown: true). Nunca inventa valores derivados.
// ============================================================================

import {
  CandidateDiscoveryPayload,
  RawListing,
  UNKNOWN_TOKEN,
  COLLECTION_METHOD,
} from "./types";

function n<T>(listing: RawListing, field: keyof Pick<RawListing, "title" | "price" | "images" | "seller" | "rating" | "review_count" | "availability" | "category">): { value: T | null; unknown: boolean; source: string; observed_at: string } {
  const raw = listing[field] as { value: T | null; unknown: boolean; derived?: boolean };
  // PROVENIÊNCIA (patch de contrato):
  // - dado observado diretamente da página → "marketplace_page";
  // - dado derivado (título extraído do slug da URL, quando o fetch falhou)
  //   → "url_slug" — NUNCA é tratado como marketplace_title confirmado;
  // - dado não obtido → "unknown" (UNKNOWN).
  let source = "unknown";
  if (!raw.unknown) {
    source = raw.derived ? "url_slug" : "marketplace_page";
  }
  return {
    value: raw.unknown ? null : raw.value,
    unknown: raw.unknown,
    source,
    observed_at: listing.observed_at,
  };
}

// Determina a origem do título (útil para auditoria: título pode derivar da
// URL quando a página não fornece; derivado é explicitamente registrado como
// "url_slug", nunca como marketplace_title confirmado).
function titleSource(listing: RawListing): string {
  const raw = listing.title as { unknown: boolean; derived?: boolean };
  if (listing.title.unknown) return "unknown";
  if (raw.derived) return "url_slug";
  if (listing.source_url.includes(listing.title.value ?? "")) return "derived_from_url";
  return "marketplace_page";
}

export class CandidateNormalizer {
  // RawListing → payload de ingestão N1.
  normalize(listing: RawListing): CandidateDiscoveryPayload {
    return {
      marketplace: listing.marketplace,
      source_url: listing.source_url,
      external_listing_id: listing.external_listing_id ?? UNKNOWN_TOKEN,
      merchant: listing.seller.unknown ? null : listing.seller.value,
      title: { ...n<string>(listing, "title"), source: titleSource(listing) },
      price: n<number>(listing, "price"),
      images: n<string[]>(listing, "images"),
      seller: n<string>(listing, "seller"),
      rating: n<number>(listing, "rating"),
      review_count: n<number>(listing, "review_count"),
      availability: n<string>(listing, "availability"),
      category: n<string>(listing, "category"),
      observed_at: listing.observed_at,
      collection_method: COLLECTION_METHOD.PUBLIC_PAGE,
      evidence_hash: listing.evidence_digest,
      evidence_note: listing.evidence_note,
      raw_evidence: {
        digest: listing.evidence_digest,
        http_status: listing.http_status,
        final_url: listing.final_url,
      },
    };
  }

  // Campos observados como UNKNOWN no payload (para o render auditável).
  unknownFields(payload: CandidateDiscoveryPayload): string[] {
    const fields: string[] = [];
    if (payload.title.unknown) fields.push("title");
    if (payload.price.unknown) fields.push("price");
    if (payload.images.unknown) fields.push("images");
    if (payload.seller.unknown) fields.push("seller");
    if (payload.rating.unknown) fields.push("rating");
    if (payload.review_count.unknown) fields.push("review_count");
    if (payload.availability.unknown) fields.push("availability");
    if (payload.category.unknown) fields.push("category");
    return fields;
  }
}

export const candidateNormalizer = new CandidateNormalizer();
