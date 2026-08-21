import { createHash } from "node:crypto";
import {
  canonicalMercadoLivreItemId,
  isMercadoLivreItemId,
  MERCADO_LIVRE_API_DEFAULT_BASE_URL,
  MERCADO_LIVRE_COLLECTION_METHOD,
  MERCADO_LIVRE_DEFAULT_TIMEOUT_MS,
  MERCADO_LIVRE_DOCUMENTED_FIELDS,
  MERCADO_LIVRE_SOURCE_TYPE,
  MercadoLivreAdapterError,
  type MercadoLivreAdapterFailure,
  type MercadoLivreAdapterOptions,
  type MercadoLivreAdapterResult,
  type MercadoLivreAdapterSuccess,
  type MercadoLivreFieldState,
  type MercadoLivreLookupInput,
  type MercadoLivreNormalizedItem,
  type MercadoLivreProvenance,
  type MercadoLivreVerboseItemResponse,
} from "./contracts";

const ALLOWED_ATTRIBUTES = [
  "id",
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

const UNKNOWN_FIELDS = [
  "seller_name",
  "seller_reputation",
  "rating",
  "review_count",
  "category_name",
  "commission",
  "competition",
  "market_demand",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${normalizedJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Digest do conteúdo observado, nunca da requisição.
 * Exclui token, headers, timestamp de coleta e qualquer dado de transporte.
 */
export function mercadoLivreResponseDigest(payload: unknown): string {
  return `sha256:${createHash("sha256").update(normalizedJson(payload), "utf8").digest("hex")}`;
}

function utcNow(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function fieldStatesForItem(item: MercadoLivreNormalizedItem): Readonly<Record<string, MercadoLivreFieldState>> {
  const states: Record<string, MercadoLivreFieldState> = {};
  for (const field of MERCADO_LIVRE_DOCUMENTED_FIELDS) {
    const value = field === "available_quantity"
      ? item.available_quantity_observed
      : item[field as keyof MercadoLivreNormalizedItem];
    states[field] = value === null ? "UNKNOWN" : "KNOWN";
  }
  for (const field of UNKNOWN_FIELDS) states[field] = "UNKNOWN";
  return states;
}

function buildProvenance(params: {
  itemId: string;
  observedAt: string;
  httpStatus: number;
  responseDigest: string | null;
  fieldState: MercadoLivreFieldState;
  item?: MercadoLivreNormalizedItem;
}): MercadoLivreProvenance {
  return {
    source_type: MERCADO_LIVRE_SOURCE_TYPE,
    collection_method: MERCADO_LIVRE_COLLECTION_METHOD,
    external_listing_id: params.item?.item_id ?? null,
    observed_at: params.observedAt,
    http_status: params.httpStatus,
    response_digest: params.responseDigest,
    field_state: params.fieldState,
    field_states: params.item ? fieldStatesForItem(params.item) : Object.fromEntries([
      ...MERCADO_LIVRE_DOCUMENTED_FIELDS.map((field) => [field, "COLLECTION_FAILED"]),
      ...UNKNOWN_FIELDS.map((field) => [field, "COLLECTION_FAILED"]),
    ]) as Readonly<Record<string, MercadoLivreFieldState>>,
  };
}

function failure(
  error: MercadoLivreAdapterError,
  observedAt: string,
  httpStatus: number,
): MercadoLivreAdapterFailure {
  return {
    ok: false,
    observation: null,
    error,
    provenance: buildProvenance({
      itemId: "",
      observedAt,
      httpStatus,
      responseDigest: null,
      fieldState: "COLLECTION_FAILED",
    }),
  };
}

function normalizeItem(body: unknown, requestedItemId: string): MercadoLivreNormalizedItem {
  if (!isRecord(body)) {
    throw new MercadoLivreAdapterError("INVALID_SCHEMA", "item_body_not_object");
  }
  const returnedId = stringOrNull(body.id);
  if (!returnedId || canonicalMercadoLivreItemId(returnedId) !== requestedItemId) {
    throw new MercadoLivreAdapterError("IDENTITY_MISMATCH", "response_item_id_mismatch");
  }
  return {
    item_id: returnedId,
    site_id: stringOrNull(body.site_id),
    title: stringOrNull(body.title),
    seller_id: body.seller_id === null || body.seller_id === undefined
      ? null
      : String(body.seller_id),
    category_id: stringOrNull(body.category_id),
    price: numberOrNull(body.price),
    currency_id: stringOrNull(body.currency_id),
    initial_quantity: numberOrNull(body.initial_quantity),
    available_quantity_observed: numberOrNull(body.available_quantity),
    availability_semantics: isFiniteNumber(body.available_quantity) ? "REFERENCE_OR_RANGE" : null,
    date_created: stringOrNull(body.date_created),
    last_updated: stringOrNull(body.last_updated),
  };
}

function parseVerboseResponse(json: unknown, requestedItemId: string): { code: number; body: unknown } {
  if (!Array.isArray(json) || json.length !== 1 || !isRecord(json[0])) {
    throw new MercadoLivreAdapterError("INVALID_SCHEMA", "verbose_response_not_single_item_array");
  }
  const row = json[0] as unknown as MercadoLivreVerboseItemResponse;
  if (!isFiniteNumber(row.code)) {
    throw new MercadoLivreAdapterError("INVALID_SCHEMA", "verbose_response_code_missing");
  }
  if (row.code !== 200) {
    throw new MercadoLivreAdapterError("HTTP_ERROR", `verbose_code_${row.code}`, row.code);
  }
  if (!Object.prototype.hasOwnProperty.call(row, "body")) {
    throw new MercadoLivreAdapterError("INVALID_SCHEMA", "verbose_response_body_missing", 200);
  }
  return { code: row.code, body: row.body };
}

function errorForStatus(status: number): MercadoLivreAdapterError {
  if (status === 401) return new MercadoLivreAdapterError("AUTH_ERROR", "http_401", status);
  if (status === 403) return new MercadoLivreAdapterError("FORBIDDEN", "http_403", status);
  if (status === 404) return new MercadoLivreAdapterError("NOT_FOUND", "http_404", status);
  if (status === 429) return new MercadoLivreAdapterError("RATE_LIMITED", "http_429", status);
  return new MercadoLivreAdapterError("HTTP_ERROR", `http_${status}`, status);
}

function buildUrl(baseUrl: string, itemId: string): string {
  const url = new URL("/items", baseUrl);
  url.searchParams.set("ids", itemId);
  url.searchParams.set("attributes", ALLOWED_ATTRIBUTES.join(","));
  return url.toString();
}

export function createMercadoLivreOfficialAdapter(options: MercadoLivreAdapterOptions) {
  const baseUrl = (options.baseUrl ?? MERCADO_LIVRE_API_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? MERCADO_LIVRE_DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? fetch;
  const clock = options.clock ?? (() => Date.now());

  async function lookup(input: MercadoLivreLookupInput): Promise<MercadoLivreAdapterResult> {
    const requested = typeof input.itemId === "string" ? input.itemId.trim() : "";
    const observedAt = utcNow(clock);
    if (!isMercadoLivreItemId(requested)) {
      return failure(new MercadoLivreAdapterError("INVALID_ITEM_ID", "item_id_invalid"), observedAt, 0);
    }
    if (!options.accessToken || !options.accessToken.trim()) {
      return failure(new MercadoLivreAdapterError("AUTH_REQUIRED", "access_token_missing"), observedAt, 0);
    }
    const requestedItemId = canonicalMercadoLivreItemId(requested);
    const url = buildUrl(baseUrl, requestedItemId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await transport(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.accessToken}`,
        },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      const error = controller.signal.aborted
        ? new MercadoLivreAdapterError("TIMEOUT", "transport_timed_out")
        : new MercadoLivreAdapterError("NETWORK_ERROR", "transport_failed");
      return failure(error, observedAt, 0);
    }
    clearTimeout(timer);

    if (!response.ok) {
      return failure(errorForStatus(response.status), observedAt, response.status);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return failure(new MercadoLivreAdapterError("INVALID_JSON", "body_not_json", response.status), observedAt, response.status);
    }

    try {
      const verbose = parseVerboseResponse(json, requestedItemId);
      const item = normalizeItem(verbose.body, requestedItemId);
      const digest = mercadoLivreResponseDigest(verbose.body);
      const provenance = buildProvenance({
        itemId: requestedItemId,
        observedAt,
        httpStatus: response.status,
        responseDigest: digest,
        fieldState: "KNOWN",
        item,
      });
      const success: MercadoLivreAdapterSuccess = {
        ok: true,
        error: null,
        observation: {
          kind: "REAL_API_OBSERVATION",
          request_item_id: requestedItemId,
          source_url: input.sourceUrl ?? null,
          item,
          provenance,
        },
      };
      return success;
    } catch (error) {
      const adapterError = error instanceof MercadoLivreAdapterError
        ? error
        : new MercadoLivreAdapterError("UNKNOWN_ERROR", "unexpected");
      return failure(adapterError, observedAt, response.status);
    }
  }

  return { lookup };
}
