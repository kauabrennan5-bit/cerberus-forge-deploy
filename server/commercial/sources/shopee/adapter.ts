import { createHash } from "node:crypto";
import type {
  FieldState,
} from "../../../repositories/candidateEvidenceRepository";
import type {
  ShopeeClientError,
  ShopeeProductLookupResult,
} from "../../affiliate/shopeeClientContracts";
import {
  OFFICIAL_SHOPEE_COLLECTION_METHOD,
  OFFICIAL_SHOPEE_ENDPOINT,
  OFFICIAL_SHOPEE_MARKETPLACE,
  OFFICIAL_SHOPEE_OPERATION,
  OFFICIAL_SHOPEE_SOURCE_TYPE,
  SHOPEE_EVIDENCE_FIELD_NAMES,
  type OfficialShopeeEvidenceField,
  type OfficialShopeeEvidenceFieldName,
  type OfficialShopeeEvidenceFailure,
  type OfficialShopeeEvidencePayload,
  type OfficialShopeeEvidenceProvenance,
  type OfficialShopeeEvidenceRequest,
  type OfficialShopeeEvidenceResult,
  type OfficialShopeeEvidenceSuccess,
  type ShopeeProductLookupClient,
} from "./contracts";

const KNOWN_QUALITY = "HIGH" as const;
const UNKNOWN_QUALITY = "UNKNOWN" as const;
/**
 * D-SHOPEE-1 (PHASE14_SCHEMA_PROBE_20260820): a API oficial retorna
 * `price` como string decimal pura (shape real observado). A forma é
 * aceitada no parsing, mas a SEMÂNTICA (moeda/unidade/escala) NÃO é
 * especificada oficialmente (BLOCKED — CONTRACT UNSPECIFIED, Fase 19).
 * Quando o valor vem do string real, a dimensão é promovida a KNOWN
 * apenas na FORMA: quality=UNKNOWN e unit=string_price_unscaled sinalizam
 * ao N14 que a ESCALA permanece UNVERIFIED — jamais é tratada como
 * "minor units" comprovados.
 */
const STRING_PRICE_UNSCALED_UNIT = "string_price_unscaled" as const;
const SCALE_UNVERIFIED_NOTE =
  "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED" as const;
const HTTPS_SHOPEE_HOSTS = ["shopee.com.br", "shopee.com", "shope.ee"] as const;

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDigits(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function isOfficialShopeeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && HTTPS_SHOPEE_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function nowIso(value?: string): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function safeErrorKind(error: ShopeeClientError | null): string | null {
  return error?.kind ?? null;
}

function baseProvenance(
  request: OfficialShopeeEvidenceRequest,
  fieldState: FieldState,
  httpStatus: number | null,
  responseDigest: string | null,
  observedAt: string,
): OfficialShopeeEvidenceProvenance {
  return {
    source_type: OFFICIAL_SHOPEE_SOURCE_TYPE,
    collection_method: OFFICIAL_SHOPEE_COLLECTION_METHOD,
    marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
    external_listing_id: request.item_id,
    shop_id: request.shop_id ?? null,
    observed_at: observedAt,
    http_status: httpStatus,
    response_digest: responseDigest,
    field_state: fieldState,
    endpoint: OFFICIAL_SHOPEE_ENDPOINT,
    operation: OFFICIAL_SHOPEE_OPERATION,
  };
}

function failure(
  request: OfficialShopeeEvidenceRequest,
  state: "COLLECTION_FAILED" | "BLOCKED",
  reason: string,
  error: ShopeeClientError | null,
  httpStatus: number | null,
  observedAt: string,
): OfficialShopeeEvidenceResult {
  const provenance = baseProvenance(request, "COLLECTION_FAILED", httpStatus, null, observedAt);
  const result: OfficialShopeeEvidenceFailure = {
    state,
    reason,
    error_kind: safeErrorKind(error),
    evidence: null,
    provenance,
    response_digest: null,
  };
  return result;
}

function fieldValueFor(
  fieldName: OfficialShopeeEvidenceFieldName,
  result: { name: string | null; priceMinorUnits: number | null; productLink: string | null },
): { value: unknown; state: FieldState; quality: "HIGH" | "UNKNOWN"; unit: string | null } {
  if (fieldName === "title" && isNonEmpty(result.name)) {
    return { value: result.name, state: "KNOWN", quality: KNOWN_QUALITY, unit: null };
  }
  // price: o número só é promovido se vier de forma decimal pura
  // (parseShopeePriceString já rejeitou ambíguos — fail-closed).
  if (fieldName === "price" && typeof result.priceMinorUnits === "number" && Number.isFinite(result.priceMinorUnits)) {
    // A unidade "minor_units" pressupõe escala contratada (não comprovada);
    // a dimensão entra no N14 como KNOWN (forma observada) porém com
    // quality UNKNOWN e unit string_price_unscaled (escala UNVERIFIED).
    return {
      value: result.priceMinorUnits,
      state: "KNOWN",
      quality: UNKNOWN_QUALITY,
      unit: STRING_PRICE_UNSCALED_UNIT,
    };
  }
  return { value: null, state: "UNKNOWN", quality: UNKNOWN_QUALITY, unit: null };
}

function buildFields(
  request: OfficialShopeeEvidenceRequest,
  itemId: string,
  shopId: string,
  result: { name: string | null; priceMinorUnits: number | null; productLink: string | null },
  observedAt: string,
  responseDigest: string,
): ReadonlyArray<OfficialShopeeEvidenceField> {
  return SHOPEE_EVIDENCE_FIELD_NAMES.map((fieldName) => {
    const field = fieldValueFor(fieldName, result);
    const fieldEvidenceHash = digest({
      marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
      item_id: itemId,
      shop_id: shopId,
      field_name: fieldName,
      field_value: field.value,
      source_url: request.source_url,
      response_digest: responseDigest,
    });
    return {
      candidate_id: request.candidate_id,
      research_id: request.research_id,
      marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
      external_listing_id: itemId,
      field_name: fieldName,
      field_value: field.value,
      field_state: field.state,
      source_url: request.source_url,
      source_type: OFFICIAL_SHOPEE_SOURCE_TYPE,
      collection_method: OFFICIAL_SHOPEE_COLLECTION_METHOD,
      observed_at: observedAt,
      evidence_hash: fieldEvidenceHash,
      quality: field.quality,
      unit: field.unit,
      evidence_note:
        fieldName === "price" && field.state === "KNOWN"
          ? SCALE_UNVERIFIED_NOTE
          : field.state === "KNOWN"
            ? "OBSERVED_FROM_OFFICIAL_SHOPEE_API"
            : "UNKNOWN_NOT_RETURNED_BY_OFFICIAL_SHOPEE_OPERATION",
      metadata: {
        marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
        operation: OFFICIAL_SHOPEE_OPERATION,
        response_digest: responseDigest,
        response_item_id: itemId,
        response_shop_id: shopId,
        product_link_observed: result.productLink,
      },
    };
  });
}

function success(
  request: OfficialShopeeEvidenceRequest,
  lookup: ShopeeProductLookupResult & { status: "found" },
  observedAt: string,
): OfficialShopeeEvidenceResult {
  if (!isDigits(lookup.itemId) || !isDigits(lookup.shopId)) {
    return failure(request, "BLOCKED", "identity_mismatch_or_invalid_returned_identifiers", null, lookup.httpStatus, observedAt);
  }
  if (lookup.itemId !== request.item_id || (request.shop_id != null && lookup.shopId !== request.shop_id)) {
    return failure(request, "BLOCKED", "identity_mismatch", null, lookup.httpStatus, observedAt);
  }
  const responseDigest = digest({
    marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
    operation: OFFICIAL_SHOPEE_OPERATION,
    requested_item_id: request.item_id,
    requested_shop_id: request.shop_id ?? null,
    response_item_id: lookup.itemId,
    response_shop_id: lookup.shopId,
    name: lookup.name,
    price_minor_units: lookup.priceMinorUnits,
    product_link: lookup.productLink,
    http_status: lookup.httpStatus,
  });
  const fields = buildFields(request, lookup.itemId, lookup.shopId, lookup, observedAt, responseDigest);
  const evidence: OfficialShopeeEvidencePayload = {
    candidate_id: request.candidate_id,
    research_id: request.research_id,
    marketplace: OFFICIAL_SHOPEE_MARKETPLACE,
    external_listing_id: lookup.itemId,
    shop_id: lookup.shopId,
    item_id: lookup.itemId,
    product_url: lookup.productLink,
    field_state: "KNOWN",
    observed_fields: {
      title: fields.find((field) => field.field_name === "title")?.field_value ?? null,
      price: fields.find((field) => field.field_name === "price")?.field_value ?? null,
      images: null,
      seller: null,
      rating: null,
      review_count: null,
      availability: null,
      category: null,
    },
    fields,
  };
  const provenance = baseProvenance(request, "KNOWN", lookup.httpStatus, responseDigest, observedAt);
  const result: OfficialShopeeEvidenceSuccess = {
    state: "SUCCESS",
    evidence,
    provenance,
    response_digest: responseDigest,
  };
  return result;
}

function validateRequest(request: OfficialShopeeEvidenceRequest): string | null {
  if (!isNonEmpty(request.candidate_id) || !isNonEmpty(request.research_id)) return "invalid_research_context";
  if (!isDigits(request.item_id)) return "invalid_item_id";
  if (request.shop_id != null && !isDigits(request.shop_id)) return "invalid_shop_id";
  if (!isOfficialShopeeUrl(request.source_url)) return "invalid_official_source_url";
  return null;
}

export function createOfficialShopeeEvidenceAdapter(client: ShopeeProductLookupClient) {
  return {
    async collect(request: OfficialShopeeEvidenceRequest): Promise<OfficialShopeeEvidenceResult> {
      const observedAt = nowIso(request.observed_at);
      const invalid = validateRequest(request);
      if (invalid) return failure(request, "BLOCKED", invalid, null, null, observedAt);
      let lookup;
      try {
        lookup = await client.lookupProduct({ shopId: request.shop_id ?? null, itemId: request.item_id });
      } catch {
        return failure(request, "COLLECTION_FAILED", "client_exception", null, null, observedAt);
      }
      if (lookup.status === "found") return success(request, lookup, observedAt);
      if (lookup.status === "not_found") {
        return failure(request, "BLOCKED", "identity_unresolved_or_not_found", lookup.error, lookup.httpStatus, observedAt);
      }
      if (lookup.status === "not_eligible") {
        return failure(request, "BLOCKED", "official_offer_not_eligible", lookup.error, lookup.httpStatus, observedAt);
      }
      return failure(request, "COLLECTION_FAILED", "official_api_error", lookup.error, lookup.httpStatus, observedAt);
    },
  };
}
