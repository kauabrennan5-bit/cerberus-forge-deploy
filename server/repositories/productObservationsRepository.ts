import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./productsRepository";
import { sanitizeOperationalPayload } from "../services/operationalEvents";
import { sanitizeOperationalText } from "../services/operationalDiagnostics";

export type ObservationConfidence = "HIGH" | "MEDIUM" | "LOW" | "INCONCLUSIVE";
export type ObservedAvailability = "IN_STOCK" | "OUT_OF_STOCK" | "UNAVAILABLE" | "UNKNOWN";

interface ObservationContext {
  productId: string;
  sourceName: string;
  sourceUrl: string;
  marketplace?: string;
  merchant?: string;
  externalListingId?: string;
  observedAt: string;
  collectionMethod: string;
  confidence: ObservationConfidence;
  correlationId: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface ProductPriceObservation extends ObservationContext {
  observationId: string;
  observedPrice: number;
  currency: string;
  schemaVersion: string;
  createdAt: string;
}

export interface ProductAvailabilityObservation extends ObservationContext {
  observationId: string;
  observedAvailability: ObservedAvailability;
  schemaVersion: string;
  createdAt: string;
}

export interface ProductSourceObservation extends ObservationContext {
  observationId: string;
  sourceKind: string;
  schemaVersion: string;
  createdAt: string;
}

export interface ProductImageObservation extends ObservationContext {
  observationId: string;
  imageUrl: string;
  imageHash?: string;
  schemaVersion: string;
  createdAt: string;
}

export interface ProductObservations {
  prices: ProductPriceObservation[];
  availabilities: ProductAvailabilityObservation[];
  sources: ProductSourceObservation[];
  images: ProductImageObservation[];
}

export interface ObservationWriteResult<T> {
  ok: boolean;
  deduplicated?: boolean;
  value?: T;
  reason?: string;
}

export interface ObservationReadResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

interface ObservationRow {
  observation_id: string;
  product_id: string;
  source_name: string;
  marketplace: string | null;
  merchant: string | null;
  source_url: string;
  external_listing_id: string | null;
  observed_at: string;
  collection_method: string;
  confidence: ObservationConfidence;
  correlation_id: string;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  schema_version: string;
  created_at: string;
  observed_price?: number;
  currency?: string;
  observed_availability?: ObservedAvailability;
  source_kind?: string;
  image_url?: string;
  image_hash?: string | null;
}

const OBSERVATION_SCHEMA_VERSION = "1.0";
const MAX_LIMIT = 100;
const SAFE_TEXT_MAX = 500;
const UNTRUSTED_TEXT = /(ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|jailbreak|do\s+not\s+follow|\[(?:url final|titulo identificado|preco identificado|conteudo da pagina)\])/i;
const SENSITIVE_QUERY = /^(?:token|secret|password|credential|authorization|access_token|api_key|service_role)$/i;

let testClient: SupabaseClient | null | undefined;

export function setProductObservationsClientForTests(client: SupabaseClient | null | undefined): void {
  testClient = client;
}

function getClient(): SupabaseClient | null {
  return testClient === undefined ? supabase : testClient;
}

function unavailable(reason: string): never {
  throw new Error(sanitizeOperationalText(reason));
}

function readUnavailable<T>(reason: string): ObservationReadResult<T> {
  return { ok: false, reason: sanitizeOperationalText(reason) };
}

function requiredText(name: string, value: unknown, maxLength = SAFE_TEXT_MAX): string {
  const raw = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!raw) throw new Error(`INVALID_PRODUCT_OBSERVATION_${name.toUpperCase()}`);
  if (UNTRUSTED_TEXT.test(raw)) throw new Error(`UNTRUSTED_PRODUCT_OBSERVATION_${name.toUpperCase()}`);
  return sanitizeOperationalText(raw).replace(/[\r\n]+/g, " ").slice(0, maxLength);
}

function optionalText(value: unknown, maxLength = SAFE_TEXT_MAX): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  return requiredText("optional_field", value, maxLength);
}

function normalizeHttpUrl(name: string, value: unknown): string {
  const raw = requiredText(name, value, 2000);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`INVALID_PRODUCT_OBSERVATION_${name.toUpperCase()}_URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`INVALID_PRODUCT_OBSERVATION_${name.toUpperCase()}_PROTOCOL`);
  }
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  return parsed.toString().slice(0, 2000);
}

function normalizeObservedAt(value: unknown): string {
  const text = requiredText("observed_at", value, 80);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error("INVALID_PRODUCT_OBSERVATION_OBSERVED_AT");
  return new Date(timestamp).toISOString();
}

function normalizeConfidence(value: unknown): ObservationConfidence {
  const confidence = String(value || "").trim().toUpperCase();
  if (!["HIGH", "MEDIUM", "LOW", "INCONCLUSIVE"].includes(confidence)) {
    throw new Error("INVALID_PRODUCT_OBSERVATION_CONFIDENCE");
  }
  return confidence as ObservationConfidence;
}

function normalizeContext(input: ObservationContext): ObservationContext {
  return {
    productId: requiredText("product_id", input.productId, 160),
    sourceName: requiredText("source_name", input.sourceName),
    sourceUrl: normalizeHttpUrl("source_url", input.sourceUrl),
    marketplace: optionalText(input.marketplace, 120),
    merchant: optionalText(input.merchant, 180),
    externalListingId: optionalText(input.externalListingId, 180),
    observedAt: normalizeObservedAt(input.observedAt),
    collectionMethod: requiredText("collection_method", input.collectionMethod, 120),
    confidence: normalizeConfidence(input.confidence),
    correlationId: requiredText("correlation_id", input.correlationId, 180),
    idempotencyKey: optionalText(input.idempotencyKey, 250),
    metadata: sanitizeOperationalPayload(input.metadata),
  };
}

function mapCommon(row: Record<string, unknown>): ObservationContext & { observationId: string; schemaVersion: string; createdAt: string } {
  return {
    observationId: String(row.observation_id || ""),
    productId: String(row.product_id || ""),
    sourceName: String(row.source_name || ""),
    sourceUrl: String(row.source_url || ""),
    marketplace: row.marketplace ? String(row.marketplace) : undefined,
    merchant: row.merchant ? String(row.merchant) : undefined,
    externalListingId: row.external_listing_id ? String(row.external_listing_id) : undefined,
    observedAt: String(row.observed_at || ""),
    collectionMethod: String(row.collection_method || ""),
    confidence: String(row.confidence || "INCONCLUSIVE") as ObservationConfidence,
    correlationId: String(row.correlation_id || ""),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    metadata: sanitizeOperationalPayload((row.metadata || {}) as Record<string, unknown>),
    schemaVersion: String(row.schema_version || OBSERVATION_SCHEMA_VERSION),
    createdAt: String(row.created_at || ""),
  };
}

function mapPrice(row: Record<string, unknown>): ProductPriceObservation {
  return { ...mapCommon(row), observedPrice: Number(row.observed_price ?? 0), currency: String(row.currency || "BRL") };
}

function mapAvailability(row: Record<string, unknown>): ProductAvailabilityObservation {
  return { ...mapCommon(row), observedAvailability: String(row.observed_availability || "UNKNOWN") as ObservedAvailability };
}

function mapSource(row: Record<string, unknown>): ProductSourceObservation {
  return { ...mapCommon(row), sourceKind: String(row.source_kind || "") };
}

function mapImage(row: Record<string, unknown>): ProductImageObservation {
  return {
    ...mapCommon(row),
    imageUrl: String(row.image_url || ""),
    imageHash: row.image_hash ? String(row.image_hash) : undefined,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function comparable(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy.observation_id;
  delete copy.created_at;
  return copy;
}

async function ensureProductExists(productId: string): Promise<void> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para observações.");
  const { data, error } = await client.from("products").select("id").eq("id", productId).limit(1).maybeSingle();
  if (error) return unavailable(error.message || "Falha ao validar associação ao produto.");
  if (!data) return unavailable(`Produto canônico ${productId} não encontrado; observação rejeitada.`);
}

async function findByColumn(table: string, column: string, value: string): Promise<Record<string, unknown> | null> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para observações.");
  const { data, error } = await client.from(table).select("*").eq(column, value).limit(1).maybeSingle();
  if (error) return unavailable(error.message || `Falha ao consultar ${table}.`);
  return data as Record<string, unknown> | null;
}

async function persistObservation<T>(table: string, row: Record<string, unknown>, map: (value: Record<string, unknown>) => T): Promise<ObservationWriteResult<T>> {
  const client = getClient();
  if (!client) return { ok: false, reason: "Cliente Supabase não configurado para observações." };
  await ensureProductExists(String(row.product_id));
  const canonical = comparable(row);
  const existingById = await findByColumn(table, "observation_id", String(row.observation_id));
  const existingByKey = row.idempotency_key ? await findByColumn(table, "idempotency_key", String(row.idempotency_key)) : null;
  const existing = existingById || existingByKey;
  if (existing) {
    if (stableJson(comparable(existing)) === stableJson(canonical)) {
      return { ok: true, deduplicated: true, value: map(existing) };
    }
    return { ok: false, reason: "Colisão de observação: identificador ou chave de idempotência já existe com conteúdo diferente." };
  }

  const { data, error } = await client.from(table).insert(row).select("*").maybeSingle();
  if (!error && data) return { ok: true, value: map(data as Record<string, unknown>) };
  if (error?.code === "23505") {
    const raced = await findByColumn(table, "observation_id", String(row.observation_id)) ||
      (row.idempotency_key ? await findByColumn(table, "idempotency_key", String(row.idempotency_key)) : null);
    if (raced && stableJson(comparable(raced)) === stableJson(canonical)) {
      return { ok: true, deduplicated: true, value: map(raced) };
    }
  }
  return { ok: false, reason: sanitizeOperationalText(error?.message || `Falha ao persistir observação em ${table}.`) };
}

function commonRow(context: ObservationContext, observationId?: string): Record<string, unknown> {
  const normalized = normalizeContext(context);
  return {
    observation_id: observationId ? requiredText("observation_id", observationId, 180) : `obs-${Date.now().toString(36)}-${randomUUID()}`,
    product_id: normalized.productId,
    source_name: normalized.sourceName,
    marketplace: normalized.marketplace || null,
    merchant: normalized.merchant || null,
    source_url: normalized.sourceUrl,
    external_listing_id: normalized.externalListingId || null,
    observed_at: normalized.observedAt,
    collection_method: normalized.collectionMethod,
    confidence: normalized.confidence,
    correlation_id: normalized.correlationId,
    idempotency_key: normalized.idempotencyKey || null,
    metadata: normalized.metadata || {},
    schema_version: OBSERVATION_SCHEMA_VERSION,
  };
}

export async function recordPriceObservation(input: ObservationContext & { observationId?: string; observedPrice: number; currency?: string }): Promise<ObservationWriteResult<ProductPriceObservation>> {
  if (!Number.isFinite(Number(input.observedPrice)) || Number(input.observedPrice) < 0) return { ok: false, reason: "Preço observado inválido." };
  const currency = String(input.currency || "BRL").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: "Moeda da observação inválida." };
  const row = { ...commonRow(input, input.observationId), observed_price: Number(input.observedPrice), currency };
  return persistObservation("product_price_observed", row, mapPrice);
}

export async function recordAvailabilityObservation(input: ObservationContext & { observationId?: string; observedAvailability: ObservedAvailability }): Promise<ObservationWriteResult<ProductAvailabilityObservation>> {
  const availability = String(input.observedAvailability || "").trim().toUpperCase() as ObservedAvailability;
  if (!["IN_STOCK", "OUT_OF_STOCK", "UNAVAILABLE", "UNKNOWN"].includes(availability)) return { ok: false, reason: "Disponibilidade observada inválida." };
  const row = { ...commonRow(input, input.observationId), observed_availability: availability };
  return persistObservation("product_availability_observed", row, mapAvailability);
}

export async function recordSourceObservation(input: ObservationContext & { observationId?: string; sourceKind: string }): Promise<ObservationWriteResult<ProductSourceObservation>> {
  const row = { ...commonRow(input, input.observationId), source_kind: requiredText("source_kind", input.sourceKind, 120) };
  return persistObservation("product_source_observed", row, mapSource);
}

export async function recordImageObservation(input: ObservationContext & { observationId?: string; imageUrl: string; imageHash?: string }): Promise<ObservationWriteResult<ProductImageObservation>> {
  const row = {
    ...commonRow(input, input.observationId),
    image_url: normalizeHttpUrl("image_url", input.imageUrl),
    image_hash: optionalText(input.imageHash, 180) || null,
  };
  return persistObservation("product_image_observed", row, mapImage);
}

async function readTable<T>(table: string, productId: string, map: (row: Record<string, unknown>) => T, limit: number): Promise<T[]> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para leitura de observações.");
  const { data, error } = await client.from(table).select("*").eq("product_id", productId).order("observed_at", { ascending: false }).limit(limit);
  if (error) return unavailable(error.message || `Falha ao ler ${table}.`);
  return ((data || []) as Record<string, unknown>[]).map(map);
}

export async function getProductObservations(productId: string, limit = 100): Promise<ObservationReadResult<ProductObservations>> {
  const normalizedProductId = requiredText("product_id", productId, 160);
  const boundedLimit = Math.min(Math.max(Number(limit) || 1, 1), MAX_LIMIT);
  const client = getClient();
  if (!client) return readUnavailable<ProductObservations>("Cliente Supabase não configurado para leitura de observações.");
  try {
    const [prices, availabilities, sources, images] = await Promise.all([
      readTable("product_price_observed", normalizedProductId, mapPrice, boundedLimit),
      readTable("product_availability_observed", normalizedProductId, mapAvailability, boundedLimit),
      readTable("product_source_observed", normalizedProductId, mapSource, boundedLimit),
      readTable("product_image_observed", normalizedProductId, mapImage, boundedLimit),
    ]);
    return { ok: true, value: { prices, availabilities, sources, images } };
  } catch (error) {
    return readUnavailable<ProductObservations>(error instanceof Error ? error.message : "Falha ao ler observações.");
  }
}
