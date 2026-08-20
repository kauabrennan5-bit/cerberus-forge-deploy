import type {
  EvidenceFieldName,
  FieldState,
} from "../../../repositories/candidateEvidenceRepository";
import type {
  ShopeeProductLookupResult,
} from "../../affiliate/shopeeClientContracts";

export const OFFICIAL_SHOPEE_SOURCE_TYPE = "api" as const;
export const OFFICIAL_SHOPEE_COLLECTION_METHOD = "API" as const;
export const OFFICIAL_SHOPEE_MARKETPLACE = "SHOPEE" as const;
export const OFFICIAL_SHOPEE_OPERATION = "productOfferV2" as const;
export const OFFICIAL_SHOPEE_ENDPOINT = "affiliate_graphql" as const;

export const SHOPEE_EVIDENCE_FIELD_NAMES = [
  "title",
  "price",
  "images",
  "seller",
  "rating",
  "review_count",
  "availability",
  "category",
] as const satisfies ReadonlyArray<EvidenceFieldName>;

export type OfficialShopeeEvidenceFieldName =
  (typeof SHOPEE_EVIDENCE_FIELD_NAMES)[number];

export type OfficialShopeeEvidenceResultState =
  | "SUCCESS"
  | "COLLECTION_FAILED"
  | "BLOCKED";

export interface OfficialShopeeEvidenceRequest {
  readonly candidate_id: string;
  readonly research_id: string;
  readonly item_id: string;
  readonly shop_id?: string | null;
  readonly source_url: string;
  /** Somente metadados não sensíveis; não é persistido automaticamente. */
  readonly request_metadata?: Readonly<Record<string, unknown>>;
  readonly observed_at?: string;
}

export interface OfficialShopeeEvidenceProvenance {
  readonly source_type: typeof OFFICIAL_SHOPEE_SOURCE_TYPE;
  readonly collection_method: typeof OFFICIAL_SHOPEE_COLLECTION_METHOD;
  readonly marketplace: typeof OFFICIAL_SHOPEE_MARKETPLACE;
  readonly external_listing_id: string;
  readonly shop_id: string | null;
  readonly observed_at: string;
  readonly http_status: number | null;
  readonly response_digest: string | null;
  readonly field_state: FieldState;
  readonly endpoint: typeof OFFICIAL_SHOPEE_ENDPOINT;
  readonly operation: typeof OFFICIAL_SHOPEE_OPERATION;
}

export interface OfficialShopeeEvidenceField {
  readonly candidate_id: string;
  readonly research_id: string;
  readonly marketplace: typeof OFFICIAL_SHOPEE_MARKETPLACE;
  readonly external_listing_id: string;
  readonly field_name: OfficialShopeeEvidenceFieldName;
  readonly field_value: unknown;
  readonly field_state: FieldState;
  readonly source_url: string;
  readonly source_type: typeof OFFICIAL_SHOPEE_SOURCE_TYPE;
  readonly collection_method: typeof OFFICIAL_SHOPEE_COLLECTION_METHOD;
  readonly observed_at: string;
  readonly evidence_hash: string;
  readonly quality: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  readonly unit: string | null;
  readonly evidence_note: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OfficialShopeeEvidencePayload {
  readonly candidate_id: string;
  readonly research_id: string;
  readonly marketplace: typeof OFFICIAL_SHOPEE_MARKETPLACE;
  readonly external_listing_id: string;
  readonly shop_id: string | null;
  readonly item_id: string;
  readonly product_url: string | null;
  readonly field_state: FieldState;
  readonly observed_fields: Readonly<Record<string, unknown>>;
  readonly fields: ReadonlyArray<OfficialShopeeEvidenceField>;
}

export interface OfficialShopeeEvidenceSuccess {
  readonly state: "SUCCESS";
  readonly evidence: OfficialShopeeEvidencePayload;
  readonly provenance: OfficialShopeeEvidenceProvenance;
  readonly response_digest: string;
}

export interface OfficialShopeeEvidenceFailure {
  readonly state: Exclude<OfficialShopeeEvidenceResultState, "SUCCESS">;
  readonly reason: string;
  readonly error_kind: string | null;
  readonly evidence: null;
  readonly provenance: OfficialShopeeEvidenceProvenance;
  readonly response_digest: null;
}

export type OfficialShopeeEvidenceResult =
  | OfficialShopeeEvidenceSuccess
  | OfficialShopeeEvidenceFailure;

export interface ShopeeProductLookupClient {
  readonly lookupProduct: (params: {
    readonly shopId?: string | null;
    readonly itemId?: string | null;
  }) => Promise<ShopeeProductLookupResult>;
}
