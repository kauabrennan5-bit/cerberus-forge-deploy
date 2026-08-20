import type { AcquireOptions } from "./acquisitionService";
import type { AcquireResult } from "./acquisitionContract";

import type {
  AffiliateMarketplace,
  AffiliateProviderRecord,
} from "./contract";

export const N17_CONTRACT_VERSION = "n17-acquisition-v1" as const;
export const N17_ACTION = "ACQUIRE_AFFILIATE" as const;

export type N17Action = typeof N17_ACTION;
export type N17Status =
  | "ACQUIRED"
  | "ALREADY_ACQUIRED"
  | "BLOCKED"
  | "FAILED"
  | "NOT_ELIGIBLE";
export type N17Method = "API" | "MANUAL";

/** Proveniência explícita. Não é o campo v1 do affiliate_links; a persistência API exige migration. */
export interface N17Provenance {
  readonly provider: string;
  readonly marketplace: AffiliateMarketplace;
  readonly method: N17Method;
  readonly source_operation: string;
  readonly source_url_origin: "official_provider" | "operator_manual";
}

export interface N17AcquireRequest {
  readonly candidate_id: string;
  readonly product_id?: string | null;
  readonly marketplace: AffiliateMarketplace;
  readonly provider_id: string;
  readonly public_product_url: string;
  readonly source_product_id?: string | null;
  readonly source_shop_id?: string | null;
  readonly authorization_ref: string;
  readonly assessment_id?: string | null;
  readonly action: N17Action;
  readonly idempotency_key: string;
  readonly provenance: N17Provenance;
  readonly tracking_context?: Record<string, unknown>;
  readonly requested_at: string;
}

export interface N17AuthorizationSnapshot {
  readonly authorization_ref: string;
  readonly candidate_id: string;
  readonly action: N17Action;
  readonly status: "APPROVED";
  readonly assessment_id: string | null;
  readonly expires_at: string | null;
}

export interface N17IdentitySnapshot {
  readonly listing_id: string;
  readonly seller_id: string;
  readonly title_snapshot: string;
  readonly canonical_url: string;
}

export interface N17AcquisitionRecord {
  readonly affiliate_link_id: string;
  readonly candidate_id: string;
  readonly product_id: string | null;
  readonly marketplace: AffiliateMarketplace;
  readonly provider_id: string;
  readonly affiliate_url: string;
  readonly short_url: string | null;
  readonly identity: N17IdentitySnapshot;
  readonly acquisition_ref: string;
  readonly authorization_ref: string;
  readonly assessment_id: string | null;
  readonly idempotency_key: string;
  readonly method: N17Method;
  readonly acquired_at: string;
  readonly observed_at: string;
  readonly response_digest: string;
  readonly provenance: N17Provenance;
}

export interface N17AcquireResult {
  readonly status: N17Status;
  readonly affiliate_link_id: string | null;
  readonly affiliate_url: string | null;
  readonly short_url: string | null;
  readonly provider_id: string | null;
  readonly marketplace: AffiliateMarketplace | null;
  readonly listing_id: string | null;
  readonly seller_id: string | null;
  readonly title_snapshot: string | null;
  readonly canonical_url: string | null;
  readonly acquisition_ref: string | null;
  readonly authorization_ref: string | null;
  readonly assessment_id: string | null;
  readonly idempotency_key: string;
  readonly method: N17Method | null;
  readonly acquired_at: string | null;
  readonly observed_at: string;
  readonly response_digest: string | null;
  readonly provenance: N17Provenance | null;
  readonly error_kind: string | null;
  readonly reason_sanitized: string | null;
}

export type N17WriteOutcome =
  | "created"
  | "identical_duplicate"
  | "conflict"
  | "failed";

export interface N17Repository {
  findByIdempotencyKey(key: string): Promise<N17AcquisitionRecord | null>;
  persist(record: N17AcquisitionRecord): Promise<{
    outcome: N17WriteOutcome;
    record: N17AcquisitionRecord | null;
    reason?: string;
  }>;
}

export interface N17Dependencies {
  readonly providerStore: {
    getById(providerId: string): Promise<AffiliateProviderRecord | null>;
  };
  readonly authorizationStore: {
    getByRef(
    authorizationRef: string,
    candidateId?: string,
  ): Promise<N17AuthorizationSnapshot | null>;
  };
  readonly repository: N17Repository;
  /** Deve delegar ao N8; não deve implementar transporte ou GraphQL. */
  readonly acquire: (options: AcquireOptions) => Promise<AcquireResult>;
  readonly now?: () => Date;
}

/** Interface mínima futura: N18 só recebe aquisições confirmadas. */
export type N18AcquisitionInput = Pick<
  N17AcquireResult,
  | "status"
  | "affiliate_link_id"
  | "affiliate_url"
  | "provider_id"
  | "marketplace"
  | "listing_id"
  | "seller_id"
  | "title_snapshot"
  | "acquisition_ref"
  | "provenance"
  | "observed_at"
  | "acquired_at"
> & {
  readonly status: "ACQUIRED" | "ALREADY_ACQUIRED";
};

export function isN17TerminalSuccess(
  result: N17AcquireResult,
): result is N17AcquireResult & { status: "ACQUIRED" | "ALREADY_ACQUIRED" } {
  return result.status === "ACQUIRED" || result.status === "ALREADY_ACQUIRED";
}
