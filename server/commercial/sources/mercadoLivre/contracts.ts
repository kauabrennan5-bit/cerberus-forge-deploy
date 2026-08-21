import type { FieldState } from "../../../repositories/candidateEvidenceRepository";

export const MERCADO_LIVRE_API_DEFAULT_BASE_URL = "https://api.mercadolibre.com";
export const MERCADO_LIVRE_DEFAULT_TIMEOUT_MS = 10_000;
export const MERCADO_LIVRE_SOURCE_TYPE = "api" as const;
export const MERCADO_LIVRE_COLLECTION_METHOD = "API" as const;

export const MERCADO_LIVRE_DOCUMENTED_FIELDS = [
  "item_id",
  "site_id",
  "title",
  "seller_id",
  "category_id",
  "price",
  "currency_id",
  "initial_quantity",
  "available_quantity",
  "date_created",
  "last_updated",
] as const;
export type MercadoLivreDocumentedField = (typeof MERCADO_LIVRE_DOCUMENTED_FIELDS)[number];

export const MERCADO_LIVRE_UNSUPPORTED_FIELDS = [
  "seller_name",
  "seller_reputation",
  "rating",
  "review_count",
  "category_name",
  "commission",
  "competition",
  "market_demand",
] as const;
export type MercadoLivreUnsupportedField = (typeof MERCADO_LIVRE_UNSUPPORTED_FIELDS)[number];

export type MercadoLivreAdapterErrorKind =
  | "INVALID_ITEM_ID"
  | "AUTH_REQUIRED"
  | "AUTH_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_JSON"
  | "INVALID_SCHEMA"
  | "IDENTITY_MISMATCH"
  | "UNKNOWN_ERROR";

export class MercadoLivreAdapterError extends Error {
  readonly name = "MercadoLivreAdapterError";

  constructor(
    readonly kind: MercadoLivreAdapterErrorKind,
    readonly reason: string,
    readonly httpStatus: number | null = null,
  ) {
    super(reason);
  }
}

export interface MercadoLivreHttpTransportInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type MercadoLivreHttpTransport = (
  url: string,
  init: MercadoLivreHttpTransportInit,
) => Promise<Response>;

export interface MercadoLivreAdapterOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly transport?: MercadoLivreHttpTransport;
  readonly clock?: () => number;
}

export interface MercadoLivreNormalizedItem {
  readonly item_id: string;
  readonly site_id: string | null;
  readonly title: string | null;
  readonly seller_id: string | null;
  readonly category_id: string | null;
  readonly price: number | null;
  readonly currency_id: string | null;
  readonly initial_quantity: number | null;
  readonly available_quantity_observed: number | null;
  readonly availability_semantics: "REFERENCE_OR_RANGE" | null;
  readonly date_created: string | null;
  readonly last_updated: string | null;
}

export interface MercadoLivreProvenance {
  readonly source_type: typeof MERCADO_LIVRE_SOURCE_TYPE;
  readonly collection_method: typeof MERCADO_LIVRE_COLLECTION_METHOD;
  readonly external_listing_id: string | null;
  readonly observed_at: string;
  readonly http_status: number;
  readonly response_digest: string | null;
  readonly field_state: FieldState;
  readonly field_states: Readonly<Record<string, FieldState>>;
}

export interface MercadoLivreRealObservation {
  readonly kind: "REAL_API_OBSERVATION";
  readonly request_item_id: string;
  readonly source_url: string | null;
  readonly item: MercadoLivreNormalizedItem;
  readonly provenance: MercadoLivreProvenance;
}

export interface MercadoLivreAdapterSuccess {
  readonly ok: true;
  readonly observation: MercadoLivreRealObservation;
  readonly error: null;
}

export interface MercadoLivreAdapterFailure {
  readonly ok: false;
  readonly observation: null;
  readonly error: MercadoLivreAdapterError;
  readonly provenance: MercadoLivreProvenance;
}

export type MercadoLivreAdapterResult = MercadoLivreAdapterSuccess | MercadoLivreAdapterFailure;

export interface MercadoLivreLookupInput {
  readonly itemId: string;
  readonly sourceUrl?: string | null;
}

export interface MercadoLivreVerboseItemResponse {
  readonly code: number;
  readonly body?: unknown;
}

export type MercadoLivreFieldState = FieldState;

export function isMercadoLivreItemId(value: string): boolean {
  return /^ML[A-Z]-?\d+$/i.test(value.trim());
}

export function canonicalMercadoLivreItemId(value: string): string {
  const compact = value.trim().toUpperCase();
  return compact.replace(/^ML([A-Z])-/, "ML$1");
}

export function isMercadoLivreHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}
