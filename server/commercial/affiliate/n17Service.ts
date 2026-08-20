import { createHash } from "node:crypto";
import {
  AFFILIATE_MARKETPLACE_HOSTS,
  type AffiliateMarketplace,
} from "./contract";
import { type AcquireOptions } from "./acquisitionService";
import { type AcquireResult } from "./acquisitionContract";
import {
  N17_ACTION,
  N17_CONTRACT_VERSION,
  type N17AcquireRequest,
  type N17AcquireResult,
  type N17AcquisitionRecord,
  type N17AuthorizationSnapshot,
  type N17Dependencies,
  type N17IdentitySnapshot,
  type N17Provenance,
} from "./n17Contract";

const N17_SOURCE_OPERATION_SHOPEE = "productOfferV2";
const N17_IDEMPOTENCY_PREFIX = "n17-idem:";

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isoUtc(value: unknown): value is string {
  if (!text(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && value.endsWith("Z");
}

function officialUrl(value: unknown, marketplace: AffiliateMarketplace): value is string {
  if (!text(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return AFFILIATE_MARKETPLACE_HOSTS[marketplace].some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

function canonicalIdempotencyInput(request: N17AcquireRequest): string {
  return JSON.stringify({
    action: request.action,
    authorization_ref: request.authorization_ref,
    candidate_id: request.candidate_id,
    marketplace: request.marketplace,
    product_id: request.product_id ?? null,
    provider_id: request.provider_id,
    source_product_id: request.source_product_id ?? null,
    source_shop_id: request.source_shop_id ?? null,
  });
}

export function buildN17IdempotencyKey(request: N17AcquireRequest): string {
  return `${N17_IDEMPOTENCY_PREFIX}${createHash("sha256")
    .update(canonicalIdempotencyInput(request), "utf8")
    .digest("hex")}`;
}

function canonicalDigestInput(params: {
  providerId: string;
  marketplace: AffiliateMarketplace;
  affiliateUrl: string;
  listingId: string;
  sellerId: string;
  titleSnapshot: string;
  canonicalUrl: string;
  method: "API" | "MANUAL";
  acquisitionRef: string;
  identityConfirmed: true;
}): string {
  return JSON.stringify({
    acquisition_ref: params.acquisitionRef,
    affiliate_url: params.affiliateUrl,
    canonical_url: params.canonicalUrl,
    identity_confirmed: params.identityConfirmed,
    listing_id: params.listingId,
    marketplace: params.marketplace,
    method: params.method,
    provider_id: params.providerId,
    seller_id: params.sellerId,
    title_snapshot: params.titleSnapshot,
  });
}

/** Digest somente de metadados permitidos; nunca recebe rawResponse, headers ou credenciais. */
export function buildN17ResponseDigest(params: {
  providerId: string;
  marketplace: AffiliateMarketplace;
  affiliateUrl: string;
  identity: N17IdentitySnapshot;
  method: "API" | "MANUAL";
  acquisitionRef: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalDigestInput({
        providerId: params.providerId,
        marketplace: params.marketplace,
        affiliateUrl: params.affiliateUrl,
        listingId: params.identity.listing_id,
        sellerId: params.identity.seller_id,
        titleSnapshot: params.identity.title_snapshot,
        canonicalUrl: params.identity.canonical_url,
        method: params.method,
        acquisitionRef: params.acquisitionRef,
        identityConfirmed: true,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

function sanitizeReason(value: unknown): string {
  if (!text(value)) return "unspecified";
  return value
    .replace(/(authorization|token|secret|password|signature|cookie|api[_-]?key)\s*[:=]\s*[^;\s]+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function nowIso(deps: N17Dependencies): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function blankResult(request: N17AcquireRequest, observedAt: string): N17AcquireResult {
  return {
    status: "BLOCKED",
    affiliate_link_id: null,
    affiliate_url: null,
    short_url: null,
    provider_id: null,
    marketplace: null,
    listing_id: null,
    seller_id: null,
    title_snapshot: null,
    canonical_url: null,
    acquisition_ref: null,
    authorization_ref: request.authorization_ref || null,
    assessment_id: request.assessment_id ?? null,
    idempotency_key: request.idempotency_key || "",
    method: null,
    acquired_at: null,
    observed_at: observedAt,
    response_digest: null,
    provenance: null,
    error_kind: null,
    reason_sanitized: null,
  };
}

function blocked(
  request: N17AcquireRequest,
  deps: N17Dependencies,
  errorKind: string,
  reason: string,
): N17AcquireResult {
  return {
    ...blankResult(request, nowIso(deps)),
    error_kind: errorKind,
    reason_sanitized: sanitizeReason(reason),
  };
}

function resultFromRecord(
  request: N17AcquireRequest,
  record: N17AcquisitionRecord,
  status: "ACQUIRED" | "ALREADY_ACQUIRED",
): N17AcquireResult {
  return {
    status,
    affiliate_link_id: record.affiliate_link_id,
    affiliate_url: record.affiliate_url,
    short_url: record.short_url,
    provider_id: record.provider_id,
    marketplace: record.marketplace,
    listing_id: record.identity.listing_id,
    seller_id: record.identity.seller_id,
    title_snapshot: record.identity.title_snapshot,
    canonical_url: record.identity.canonical_url,
    acquisition_ref: record.acquisition_ref,
    authorization_ref: record.authorization_ref,
    assessment_id: record.assessment_id,
    idempotency_key: record.idempotency_key,
    method: record.method,
    acquired_at: record.acquired_at,
    observed_at: record.observed_at,
    response_digest: record.response_digest,
    provenance: record.provenance,
    error_kind: null,
    reason_sanitized: null,
  };
}

function sameExpectedIdentity(request: N17AcquireRequest, record: N17AcquisitionRecord): boolean {
  const productMatches =
    !request.source_product_id || record.identity.listing_id === request.source_product_id;
  const shopMatches =
    !request.source_shop_id || record.identity.seller_id === request.source_shop_id;
  return (
    record.candidate_id === request.candidate_id &&
    record.provider_id === request.provider_id &&
    record.marketplace === request.marketplace &&
    productMatches &&
    shopMatches
  );
}

function validateRequest(request: N17AcquireRequest): string | null {
  if (!request || typeof request !== "object") return "request_missing";
  if (!text(request.candidate_id)) return "candidate_id_missing";
  if (request.product_id !== undefined && request.product_id !== null && !text(request.product_id)) {
    return "product_id_invalid";
  }
  if (!text(request.provider_id)) return "provider_id_missing";
  if (!text(request.public_product_url)) return "public_product_url_missing";
  if (!text(request.authorization_ref)) return "authorization_ref_missing";
  if (!text(request.idempotency_key)) return "idempotency_key_missing";
  if (!text(request.action)) return "action_missing";
  if (request.action !== N17_ACTION) return "action_not_allowed";
  if (!isoUtc(request.requested_at)) return "requested_at_invalid";
  if (!request.provenance || !text(request.provenance.provider)) return "provenance_missing";
  if (request.provenance.provider !== request.provider_id) return "provenance_provider_mismatch";
  if (request.provenance.marketplace !== request.marketplace) return "provenance_marketplace_mismatch";
  if (!text(request.provenance.source_operation)) return "provenance_source_operation_missing";
  if (request.provenance.method !== "API" && request.provenance.method !== "MANUAL") {
    return "provenance_method_invalid";
  }
  if (
    request.provenance.method === "API" &&
    request.provenance.source_url_origin !== "official_provider"
  ) {
    return "provenance_origin_invalid";
  }
  if (request.marketplace === "Shopee") {
    if (!text(request.source_product_id)) return "source_product_id_missing";
    if (!text(request.source_shop_id)) return "source_shop_id_missing";
    if (request.provenance.method !== "API") return "shopee_manual_not_authorized";
    if (request.provenance.source_operation !== N17_SOURCE_OPERATION_SHOPEE) {
      return "shopee_source_operation_invalid";
    }
  }
  return null;
}

function validateAuthorization(
  request: N17AcquireRequest,
  authorization: N17AuthorizationSnapshot | null,
  now: string,
): string | null {
  if (!authorization) return "authorization_not_found";
  if (authorization.authorization_ref !== request.authorization_ref) return "authorization_ref_mismatch";
  if (authorization.candidate_id !== request.candidate_id) return "authorization_candidate_mismatch";
  if (authorization.action !== N17_ACTION) return "authorization_action_not_allowed";
  if (authorization.status !== "APPROVED") return "authorization_not_approved";
  if (authorization.expires_at && new Date(authorization.expires_at).getTime() <= new Date(now).getTime()) {
    return "authorization_expired";
  }
  if (authorization.assessment_id && authorization.assessment_id !== (request.assessment_id ?? null)) {
    return "assessment_id_mismatch";
  }
  return null;
}

function mapN8Failure(
  request: N17AcquireRequest,
  deps: N17Dependencies,
  result: Exclude<AcquireResult, { kind: "SUCCESS" }>,
): N17AcquireResult {
  switch (result.kind) {
    case "PRODUCT_NOT_ELIGIBLE":
      return {
        ...blankResult(request, nowIso(deps)),
        status: "NOT_ELIGIBLE",
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: sanitizeReason(result.reason),
      };
    case "RESOLUTION_FAILED":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        status: "FAILED",
        error_kind: result.kind,
        reason_sanitized: sanitizeReason(result.reason),
      };
    case "IDENTITY_UNCERTAIN":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: sanitizeReason(result.rationale),
      };
    case "AUTH_REQUIRED":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: sanitizeReason(result.reason),
      };
    case "NOT_SUPPORTED":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: `marketplace_not_supported:${result.marketplace}`,
      };
    case "MANUAL_REQUIRED":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: sanitizeReason(result.reason),
      };
    case "PROVIDER_NOT_ACTIVE":
      return {
        ...blankResult(request, nowIso(deps)),
        provider_id: request.provider_id,
        marketplace: request.marketplace,
        error_kind: result.kind,
        reason_sanitized: `provider_not_active:${result.providerId}`,
      };
  }
}

function recordFromN8(
  request: N17AcquireRequest,
  result: Extract<AcquireResult, { kind: "SUCCESS" }>,
  observedAt: string,
): N17AcquisitionRecord | null {
  if (
    result.identityConfidence !== "PRODUCT_IDENTITY_CONFIRMED" ||
    !text(result.affiliateUrl) ||
    !text(result.identity.listingId) ||
    !text(result.identity.sellerId) ||
    !text(result.identity.titleSnapshot) ||
    !officialUrl(result.affiliateUrl, request.marketplace) ||
    !officialUrl(result.identity.canonicalUrl, request.marketplace) ||
    result.method !== request.provenance.method ||
    !text(result.acquisitionRef)
  ) {
    return null;
  }
  const identity: N17IdentitySnapshot = {
    listing_id: result.identity.listingId,
    seller_id: result.identity.sellerId,
    title_snapshot: result.identity.titleSnapshot,
    canonical_url: result.identity.canonicalUrl,
  };
  const acquiredAt = new Date(result.acquiredAt).toISOString();
  const provenance: N17Provenance = {
    provider: request.provider_id,
    marketplace: request.marketplace,
    method: result.method,
    source_operation: request.provenance.source_operation,
    source_url_origin: request.provenance.source_url_origin,
  };
  return {
    affiliate_link_id: `n17-link:${request.idempotency_key}`,
    candidate_id: request.candidate_id,
    product_id: request.product_id ?? null,
    marketplace: request.marketplace,
    provider_id: request.provider_id,
    affiliate_url: result.affiliateUrl,
    short_url: null,
    identity,
    acquisition_ref: result.acquisitionRef,
    authorization_ref: request.authorization_ref,
    assessment_id: request.assessment_id ?? null,
    idempotency_key: request.idempotency_key,
    method: result.method,
    acquired_at: acquiredAt,
    observed_at: observedAt,
    response_digest: buildN17ResponseDigest({
      providerId: request.provider_id,
      marketplace: request.marketplace,
      affiliateUrl: result.affiliateUrl,
      identity,
      method: result.method,
      acquisitionRef: result.acquisitionRef,
    }),
    provenance,
  };
}

export async function acquireN17(
  request: N17AcquireRequest,
  deps: N17Dependencies,
): Promise<N17AcquireResult> {
  const observedAt = nowIso(deps);
  const invalidRequest = validateRequest(request);
  if (invalidRequest) return blocked(request, deps, "REQUEST_INVALID", invalidRequest);
  if (request.idempotency_key !== buildN17IdempotencyKey(request)) {
    return blocked(request, deps, "IDEMPOTENCY_INVALID", "idempotency_key_not_deterministic");
  }
  if (!officialUrl(request.public_product_url, request.marketplace)) {
    return blocked(request, deps, "REQUEST_INVALID", "public_product_url_not_official");
  }

  const existing = await deps.repository.findByIdempotencyKey(request.idempotency_key);
  if (existing) {
    if (!sameExpectedIdentity(request, existing)) {
      return blocked(request, deps, "IDEMPOTENCY_CONFLICT", "existing_identity_conflict");
    }
    return resultFromRecord(request, existing, "ALREADY_ACQUIRED");
  }

  const authorization = await deps.authorizationStore.getByRef(
    request.authorization_ref,
    request.candidate_id,
  );
  const authorizationError = validateAuthorization(request, authorization, observedAt);
  if (authorizationError) {
    return blocked(request, deps, "AUTHORIZATION_INVALID", authorizationError);
  }

  const provider = await deps.providerStore.getById(request.provider_id);
  if (!provider) return blocked(request, deps, "PROVIDER_NOT_FOUND", "provider_not_found");
  if (provider.status !== "ACTIVE") return blocked(request, deps, "PROVIDER_NOT_ACTIVE", provider.status);
  if (provider.marketplace !== request.marketplace) {
    return blocked(request, deps, "PROVIDER_MARKETPLACE_MISMATCH", "provider_marketplace_mismatch");
  }

  const reference = {
    marketplace: request.marketplace,
    productId: request.source_product_id ?? request.product_id ?? null,
    candidateId: request.candidate_id,
    publicUrl: request.public_product_url,
  } as const;
  const acquireOptions: AcquireOptions = { provider, reference };
  let n8Result: AcquireResult;
  try {
    n8Result = await deps.acquire(acquireOptions);
  } catch (error) {
    return {
      ...blankResult(request, observedAt),
      provider_id: request.provider_id,
      marketplace: request.marketplace,
      status: "FAILED",
      error_kind: "N8_EXCEPTION",
      reason_sanitized: sanitizeReason(error instanceof Error ? error.message : "n8_exception"),
    };
  }
  if (n8Result.kind !== "SUCCESS") return mapN8Failure(request, deps, n8Result);

  const record = recordFromN8(request, n8Result, observedAt);
  if (!record) {
    return blocked(request, deps, "N8_CONTRACT_INVALID", "success_without_confirmed_identity_or_official_url");
  }
  const persisted = await deps.repository.persist(record);
  if (persisted.outcome === "identical_duplicate" && persisted.record) {
    if (!sameExpectedIdentity(request, persisted.record)) {
      return blocked(request, deps, "PERSISTENCE_CONFLICT", "duplicate_identity_conflict");
    }
    return resultFromRecord(request, persisted.record, "ALREADY_ACQUIRED");
  }
  if (persisted.outcome === "conflict") {
    return blocked(request, deps, "PERSISTENCE_CONFLICT", sanitizeReason(persisted.reason));
  }
  if (persisted.outcome !== "created" || !persisted.record) {
    return {
      ...blankResult(request, observedAt),
      provider_id: request.provider_id,
      marketplace: request.marketplace,
      status: "FAILED",
      error_kind: "PERSISTENCE_FAILED",
      reason_sanitized: sanitizeReason(persisted.reason ?? "persistence_failed"),
    };
  }
  return resultFromRecord(request, persisted.record, "ACQUIRED");
}

export { N17_CONTRACT_VERSION };
