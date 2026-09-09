import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";
import type { PendingReview } from "./telegramTypes";

const DEFAULT_PUBLISHING_TTL_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LIMIT = 100;

export type TelegramPublicationReconcileOutcome = {
  reviewId: string;
  action: "published" | "recoverable_error" | "skipped_recent" | "skipped_active_execution" | "already_reconciled";
  productId: string | null;
};

export type TelegramPublicationReconcileResult = {
  checked: number;
  published: number;
  recoverableErrors: number;
  skipped: number;
  outcomes: TelegramPublicationReconcileOutcome[];
};

type PublishingRow = {
  id: string;
  status: string;
  data: Record<string, any> | null;
  updated_at: string;
};

type PublishedProductMatch = {
  id: string;
  authorizationId: string | null;
  shopId: string | null;
  itemId: string | null;
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reviewIdentity(review: Record<string, any>) {
  const existing = record(review.existingProduct);
  return {
    shopId: clean(existing.shopId),
    itemId: clean(existing.itemId),
    sourceUrl: clean(review.normalizedUrl || existing.sourceProductUrl),
  };
}

function lifecycleProductIds(review: Record<string, any>): string[] {
  const lifecycle = record(review.lifecycle);
  const published = record(lifecycle.publishedProduct);
  return [...new Set([
    clean(lifecycle.publishedProductId),
    clean(published.id),
  ].filter(Boolean))];
}

function approvedAtFromLifecycle(review: Record<string, any>): string | null {
  const lifecycle = record(review.lifecycle);
  const audit = Array.isArray(lifecycle.audit) ? lifecycle.audit : [];
  const approved = audit
    .filter(item => record(item).type === "PRODUCT_APPROVED")
    .map(item => clean(record(item).timestamp))
    .filter(Boolean)
    .sort()
    .at(-1);
  return approved || null;
}

async function loadPublishedProduct(client: SupabaseClient, reviewId: string, review: Record<string, any>): Promise<PublishedProductMatch | null> {
  const directIds = lifecycleProductIds(review);
  if (directIds.length > 0) {
    const { data } = await client.from("products")
      .select("id,status,ativo")
      .in("id", directIds)
      .eq("status", "published")
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      const authorization = await loadHumanAuthorization(client, String(data.id), reviewId);
      if (authorization) return { id: String(data.id), authorizationId: authorization.authorizationId, shopId: authorization.shopId, itemId: authorization.itemId };
    }
  }

  const identity = reviewIdentity(review);
  if (!identity.shopId || !identity.itemId) return null;

  const { data: sourceIdentity } = await client.from("product_source_identities")
    .select("product_id,shop_id,item_id")
    .eq("marketplace", "Shopee")
    .eq("shop_id", identity.shopId)
    .eq("item_id", identity.itemId)
    .not("product_id", "is", null)
    .limit(1)
    .maybeSingle();
  const productId = clean(sourceIdentity?.product_id);
  if (!productId) return null;

  const { data: product } = await client.from("products")
    .select("id,status,ativo")
    .eq("id", productId)
    .eq("status", "published")
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();
  if (!product?.id) return null;

  const authorization = await loadHumanAuthorization(client, productId, reviewId);
  if (!authorization) return null;
  return {
    id: productId,
    authorizationId: authorization.authorizationId,
    shopId: authorization.shopId || identity.shopId,
    itemId: authorization.itemId || identity.itemId,
  };
}

async function loadHumanAuthorization(client: SupabaseClient, productId: string, reviewId: string): Promise<{ authorizationId: string; shopId: string | null; itemId: string | null } | null> {
  const { data } = await client.from("product_publication_authorizations")
    .select("authorization_id,review_id,shop_id,item_id,evidence,source,consumed_at")
    .eq("product_id", productId)
    .eq("source", "admin")
    .not("consumed_at", "is", null)
    .order("consumed_at", { ascending: false })
    .limit(5);
  const rows = Array.isArray(data) ? data : [];
  const match = rows.find(row => {
    const evidence = record(row.evidence);
    const human = evidence.humanManualApproval === true || String(evidence.humanManualApproval).toLowerCase() === "true";
    const persistedReview = clean(row.review_id || evidence.reviewId);
    return human && (!persistedReview || persistedReview === reviewId);
  });
  if (!match) return null;
  return {
    authorizationId: String(match.authorization_id),
    shopId: clean(match.shop_id) || null,
    itemId: clean(match.item_id) || null,
  };
}

async function hasActivePublicationExecution(client: SupabaseClient, reviewId: string): Promise<boolean> {
  const activeStatuses = ["pending", "running", "executing", "started", "in_progress", "processing"];
  const { data, error } = await client.from("publication_executions")
    .select("execution_id")
    .in("status", activeStatuses)
    .or(`correlation_id.eq.${reviewId},request_id.eq.${reviewId},metadata->>reviewId.eq.${reviewId}`)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

function publishedReviewData(row: PublishingRow, match: PublishedProductMatch): Record<string, any> {
  const original = record(row.data);
  const lifecycle = record(original.lifecycle);
  const publishedProduct = record(lifecycle.publishedProduct);
  return {
    ...original,
    status: "published",
    lifecycle: {
      ...lifecycle,
      state: "PUBLISHED",
      publishedProductId: match.id,
      publishedProduct: Object.keys(publishedProduct).length > 0 ? publishedProduct : { id: match.id },
    },
    reconciliation: {
      ...(record(original.reconciliation)),
      status: "published",
      reason: "STALE_PUBLISHING_PRODUCT_ALREADY_EXISTS",
      reconciledAt: new Date().toISOString(),
      productId: match.id,
    },
  };
}

function recoverableReviewData(row: PublishingRow): Record<string, any> {
  const original = record(row.data);
  return {
    ...original,
    status: "error",
    reconciliation: {
      ...(record(original.reconciliation)),
      status: "error",
      reason: "STALE_PUBLISHING_NO_PRODUCT_FOUND",
      reconciledAt: new Date().toISOString(),
    },
  };
}

async function persistLineage(client: SupabaseClient, row: PublishingRow, match: PublishedProductMatch): Promise<void> {
  const review = record(row.data);
  const identity = reviewIdentity(review);
  const approvedAt = approvedAtFromLifecycle(review);
  const lifecycle = record(review.lifecycle);
  const operationId = clean(lifecycle.operationId) || null;

  if (match.authorizationId) {
    const patch: Record<string, unknown> = {
      review_id: row.id,
      approval_origin: "telegram",
      human_approval_evidence: {
        reviewId: row.id,
        humanApproved: true,
        approvedAt,
        operationId,
        source: "telegram",
        reconciled: true,
      },
    };
    if (approvedAt) patch.approved_at = approvedAt;
    if (operationId) patch.operation_id = operationId;
    if (identity.shopId) patch.shop_id = identity.shopId;
    if (identity.itemId) patch.item_id = identity.itemId;
    if (identity.sourceUrl) patch.source_product_url = identity.sourceUrl;
    await client.from("product_publication_authorizations")
      .update(patch)
      .eq("authorization_id", match.authorizationId)
      .or(`review_id.is.null,review_id.eq.${row.id}`);
  }

  if (identity.shopId && identity.itemId) {
    await client.from("product_source_identities")
      .update({ review_id: row.id, product_id: match.id, updated_at: new Date().toISOString() })
      .eq("marketplace", "Shopee")
      .eq("shop_id", identity.shopId)
      .eq("item_id", identity.itemId)
      .eq("product_id", match.id)
      .or(`review_id.is.null,review_id.eq.${row.id}`);
  }
}

export async function reconcileStalePublishingReviews(options: {
  client?: SupabaseClient;
  now?: Date;
  ttlMs?: number;
  limit?: number;
} = {}): Promise<TelegramPublicationReconcileResult> {
  const client = options.client || requireSupabase();
  const now = options.now || new Date();
  const ttlMs = Math.max(5 * 60_000, options.ttlMs ?? DEFAULT_PUBLISHING_TTL_MS);
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();

  const { data, error } = await client.from("telegram_pending_reviews")
    .select("id,status,data,updated_at")
    .eq("status", "publishing")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`TELEGRAM_PUBLISHING_RECONCILE_READ_FAILED:${error.code || "unknown"}`);

  const rows = (Array.isArray(data) ? data : []) as PublishingRow[];
  const outcomes: TelegramPublicationReconcileOutcome[] = [];
  for (const row of rows) {
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt) || updatedAt > now.getTime() - ttlMs) {
      outcomes.push({ reviewId: row.id, action: "skipped_recent", productId: null });
      continue;
    }

    const match = await loadPublishedProduct(client, row.id, record(row.data));
    if (match) {
      const nextData = publishedReviewData(row, match);
      const { data: claimed, error: updateError } = await client.from("telegram_pending_reviews")
        .update({ status: "published", data: nextData, updated_at: now.toISOString() })
        .eq("id", row.id)
        .eq("status", "publishing")
        .lt("updated_at", cutoff)
        .select("id")
        .maybeSingle();
      if (updateError) throw new Error(`TELEGRAM_PUBLISHING_RECONCILE_FINALIZE_FAILED:${updateError.code || "unknown"}`);
      if (!claimed) {
        outcomes.push({ reviewId: row.id, action: "already_reconciled", productId: match.id });
        continue;
      }
      await persistLineage(client, row, match);
      outcomes.push({ reviewId: row.id, action: "published", productId: match.id });
      continue;
    }

    if (await hasActivePublicationExecution(client, row.id)) {
      outcomes.push({ reviewId: row.id, action: "skipped_active_execution", productId: null });
      continue;
    }

    const { data: released, error: releaseError } = await client.from("telegram_pending_reviews")
      .update({ status: "error", data: recoverableReviewData(row), updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "publishing")
      .lt("updated_at", cutoff)
      .select("id")
      .maybeSingle();
    if (releaseError) throw new Error(`TELEGRAM_PUBLISHING_RECONCILE_RELEASE_FAILED:${releaseError.code || "unknown"}`);
    outcomes.push({ reviewId: row.id, action: released ? "recoverable_error" : "already_reconciled", productId: null });
  }

  return {
    checked: rows.length,
    published: outcomes.filter(item => item.action === "published").length,
    recoverableErrors: outcomes.filter(item => item.action === "recoverable_error").length,
    skipped: outcomes.filter(item => !["published", "recoverable_error"].includes(item.action)).length,
    outcomes,
  };
}

let started = false;
export function startTelegramPublicationReconciler(options: { intervalMs?: number; ttlMs?: number } = {}): void {
  if (started || process.env.NODE_ENV === "test") return;
  started = true;
  const intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const run = () => reconcileStalePublishingReviews({ ttlMs: options.ttlMs })
    .then(result => {
      if (result.checked > 0) console.info(`[Telegram Publication Reconciler] checked=${result.checked} published=${result.published} recoverable=${result.recoverableErrors} skipped=${result.skipped}`);
    })
    .catch(error => console.warn("[Telegram Publication Reconciler]", error instanceof Error ? error.message : "reconcile_failed"));
  const initial = setTimeout(run, 30_000);
  initial.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
}

export const telegramPublicationReconcilerInternals = {
  DEFAULT_PUBLISHING_TTL_MS,
  reviewIdentity,
  lifecycleProductIds,
  approvedAtFromLifecycle,
};
