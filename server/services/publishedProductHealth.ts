import type { Product } from "../../src/types";
import type { ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import {
  recordAvailabilityObservation,
  type ObservedAvailability,
  type ObservationConfidence,
} from "../repositories/productObservationsRepository";

const DEFAULT_INTERVAL_MINUTES = 180;
const MAX_INTERVAL_MINUTES = 24 * 60;
const HEALTH_VERSION = "1";

export type PublishedProductHealthFailure = {
  productId: string;
  reason: string;
};

export type PublishedProductHealthResult = {
  checkedIds: string[];
  unavailableIds: string[];
  skippedRecentIds: string[];
  unknownIds: string[];
  failures: PublishedProductHealthFailure[];
};

type SourceIdentity = {
  marketplace: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
};

type LatestAvailability = {
  observedAt: string;
  observedAvailability: ObservedAvailability;
};

function intervalMinutes(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(String(env.PUBLISHED_PRODUCT_HEALTH_INTERVAL_MINUTES || ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(parsed, MAX_INTERVAL_MINUTES);
}

function activePublished(product: Product): boolean {
  return product.status === "published" && product.ativo !== false;
}

function isFresh(observedAt: string | undefined, now: Date, intervalMs: number): boolean {
  const timestamp = Date.parse(String(observedAt || ""));
  return Number.isFinite(timestamp) && now.getTime() - timestamp < intervalMs;
}

async function findIdentity(productId: string): Promise<SourceIdentity | null> {
  const { data, error } = await requireSupabase()
    .from("product_source_identities")
    .select("marketplace,shop_id,item_id,source_product_url")
    .eq("product_id", productId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.marketplace || !data?.shop_id || !data?.item_id || !data?.source_product_url) return null;
  return {
    marketplace: String(data.marketplace),
    shopId: String(data.shop_id),
    itemId: String(data.item_id),
    sourceProductUrl: String(data.source_product_url),
  };
}

async function latestAvailability(productId: string): Promise<LatestAvailability | null> {
  const { data, error } = await requireSupabase()
    .from("product_availability_observed")
    .select("observed_at,observed_availability")
    .eq("product_id", productId)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.observed_at || !data?.observed_availability) return null;
  return {
    observedAt: String(data.observed_at),
    observedAvailability: String(data.observed_availability).toUpperCase() as ObservedAvailability,
  };
}

function safeReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value || "UNKNOWN");
  return raw.replace(/[\r\n]+/g, " ").slice(0, 160);
}

async function persistObservation(input: {
  productId: string;
  identity: SourceIdentity | null;
  availability: ObservedAvailability;
  confidence: ObservationConfidence;
  now: Date;
  intervalMs: number;
  correlationId: string;
  reason: string;
}): Promise<void> {
  const bucket = Math.floor(input.now.getTime() / input.intervalMs);
  const sourceUrl = input.identity?.sourceProductUrl || `https://shopee.com.br/product-health/${encodeURIComponent(input.productId)}`;
  const result = await recordAvailabilityObservation({
    productId: input.productId,
    sourceName: "shopee_affiliate_api",
    sourceUrl,
    marketplace: input.identity?.marketplace || "Shopee",
    externalListingId: input.identity ? `${input.identity.shopId}:${input.identity.itemId}` : undefined,
    observedAt: input.now.toISOString(),
    collectionMethod: "shopee_product_offer_v2_health",
    confidence: input.confidence,
    correlationId: input.correlationId,
    idempotencyKey: `published-health:${input.productId}:${bucket}`,
    metadata: {
      health_version: HEALTH_VERSION,
      reason: input.reason,
    },
    observedAvailability: input.availability,
  });
  if (!result.ok) throw new Error(`PRODUCT_HEALTH_OBSERVATION_FAILED:${result.reason || "unknown"}`);
}

export async function auditPublishedProductHealth(input: {
  products: readonly Product[];
  client: ShopeeApiClient;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  correlationId?: string;
}): Promise<PublishedProductHealthResult> {
  const now = input.now || new Date();
  const env = input.env || process.env;
  const intervalMs = intervalMinutes(env) * 60_000;
  const correlationId = input.correlationId || `published-health:${now.toISOString()}`;
  const result: PublishedProductHealthResult = {
    checkedIds: [],
    unavailableIds: [],
    skippedRecentIds: [],
    unknownIds: [],
    failures: [],
  };

  for (const product of input.products.filter(activePublished)) {
    try {
      const latest = await latestAvailability(product.id);
      if (latest && isFresh(latest.observedAt, now, intervalMs)) {
        result.skippedRecentIds.push(product.id);
        if (latest.observedAvailability === "UNAVAILABLE") result.unavailableIds.push(product.id);
        continue;
      }

      const identity = await findIdentity(product.id);
      if (!identity || identity.marketplace.toLowerCase() !== "shopee") {
        await persistObservation({
          productId: product.id,
          identity,
          availability: "UNKNOWN",
          confidence: "INCONCLUSIVE",
          now,
          intervalMs,
          correlationId,
          reason: "SOURCE_IDENTITY_MISSING",
        });
        result.checkedIds.push(product.id);
        result.unknownIds.push(product.id);
        continue;
      }

      const lookup = await input.client.lookupProduct({ shopId: identity.shopId, itemId: identity.itemId });
      result.checkedIds.push(product.id);

      if (lookup.status === "found" && lookup.shopId === identity.shopId && lookup.itemId === identity.itemId) {
        await persistObservation({
          productId: product.id,
          identity,
          availability: "IN_STOCK",
          confidence: "HIGH",
          now,
          intervalMs,
          correlationId,
          reason: "EXACT_SHOPEE_IDENTITY_FOUND",
        });
        continue;
      }

      if (lookup.status === "not_found") {
        await persistObservation({
          productId: product.id,
          identity,
          availability: "UNAVAILABLE",
          confidence: "HIGH",
          now,
          intervalMs,
          correlationId,
          reason: "EXACT_SHOPEE_IDENTITY_NOT_FOUND",
        });
        result.unavailableIds.push(product.id);
        continue;
      }

      const reason = lookup.error?.kind || `LOOKUP_${lookup.status}`;
      await persistObservation({
        productId: product.id,
        identity,
        availability: "UNKNOWN",
        confidence: "INCONCLUSIVE",
        now,
        intervalMs,
        correlationId,
        reason,
      });
      result.unknownIds.push(product.id);
    } catch (error) {
      result.failures.push({ productId: product.id, reason: safeReason(error) });
    }
  }

  return result;
}

export const publishedProductHealthInternals = {
  DEFAULT_INTERVAL_MINUTES,
  HEALTH_VERSION,
  intervalMinutes,
  activePublished,
  isFresh,
};
