import { requireSupabase } from "./productsRepository";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";

export type AutonomousCuratorConfig = {
  enabled: boolean;
  autoPublishEnabled: boolean;
  autoPublishThreshold: number;
  reviewThreshold: number;
  maxDailyPerCategory: number;
  maxSearchCandidates: number;
  maxEnrichPerCategory: number;
};

export type AutonomousCuratorRun = {
  id: string;
  runDate: string;
  status: "running" | "completed" | "partial" | "failed" | "dry_run";
  dryRun: boolean;
};

export type AutonomousCuratorDecision =
  | "auto_selected"
  | "auto_published"
  | "review_required"
  | "rejected"
  | "failed"
  | "duplicate"
  | "no_candidate"
  | "dry_run_auto"
  | "dry_run_review";

export type AutonomousCuratorCategoryResult = {
  runId: string;
  category: string;
  searchQuery: string;
  shopId?: string | null;
  itemId?: string | null;
  sourceProductUrl?: string | null;
  rawTitle?: string | null;
  displayTitle?: string | null;
  score?: number | null;
  scoreBreakdown?: Record<string, unknown>;
  decision: AutonomousCuratorDecision;
  reason?: string | null;
  productId?: string | null;
  reviewId?: string | null;
};

export type ProductSourceIdentity = {
  marketplace: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  productId: string | null;
  reviewId: string | null;
  reservedRunId: string | null;
  reservedUntil: string | null;
};

function mapConfig(row: any): AutonomousCuratorConfig {
  return {
    enabled: row?.enabled === true,
    autoPublishEnabled: row?.auto_publish_enabled === true,
    autoPublishThreshold: Number(row?.auto_publish_threshold ?? 88),
    reviewThreshold: Number(row?.review_threshold ?? 72),
    maxDailyPerCategory: Number(row?.max_daily_per_category ?? 1),
    maxSearchCandidates: Number(row?.max_search_candidates ?? 10),
    maxEnrichPerCategory: Number(row?.max_enrich_per_category ?? 1),
  };
}

export async function getAutonomousCuratorConfig(): Promise<AutonomousCuratorConfig> {
  const client = requireSupabase();
  const { data, error } = await client.from("autonomous_curator_config").select("*").eq("id", "default").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("AUTONOMOUS_CURATOR_CONFIG_MISSING");
  return mapConfig(data);
}

export async function setAutonomousCuratorEnabled(enabled: boolean): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("autonomous_curator_config").update({ enabled, updated_at: new Date().toISOString() }).eq("id", "default");
  if (error) throw error;
}

export async function openAutonomousCuratorRun(input: {
  runDate: string;
  dryRun: boolean;
  profileVersion: string;
  categoriesTotal: number;
}): Promise<{ run: AutonomousCuratorRun; resumed: boolean }> {
  const client = requireSupabase();
  if (!input.dryRun) {
    const { data: existing, error: existingError } = await client
      .from("autonomous_curator_runs")
      .select("id,run_date,status,dry_run")
      .eq("run_date", input.runDate)
      .eq("dry_run", false)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      const { data: reopened, error: reopenError } = await client
        .from("autonomous_curator_runs")
        .update({
          status: "running",
          completed_at: null,
          categories_processed: 0,
          auto_published: 0,
          review_required: 0,
          rejected: 0,
          failed: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select("id,run_date,status,dry_run")
        .single();
      if (reopenError) throw reopenError;
      return {
        run: { id: String(reopened.id), runDate: String(reopened.run_date), status: reopened.status, dryRun: false },
        resumed: true,
      };
    }
  }

  const { data, error } = await client.from("autonomous_curator_runs").insert({
    run_date: input.runDate,
    status: input.dryRun ? "running" : "running",
    dry_run: input.dryRun,
    profile_version: input.profileVersion,
    categories_total: input.categoriesTotal,
  }).select("id,run_date,status,dry_run").single();
  if (error) throw error;
  return {
    run: { id: String(data.id), runDate: String(data.run_date), status: data.status, dryRun: data.dry_run === true },
    resumed: false,
  };
}

export async function getAutonomousCuratorCategoryResult(runId: string, category: string): Promise<AutonomousCuratorCategoryResult | null> {
  const client = requireSupabase();
  const { data, error } = await client.from("autonomous_curator_candidates").select("*").eq("run_id", runId).eq("category", category).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    runId: String(data.run_id),
    category: String(data.category),
    searchQuery: String(data.search_query),
    shopId: data.shop_id ? String(data.shop_id) : null,
    itemId: data.item_id ? String(data.item_id) : null,
    sourceProductUrl: data.source_product_url ? String(data.source_product_url) : null,
    rawTitle: data.raw_title ? String(data.raw_title) : null,
    displayTitle: data.display_title ? String(data.display_title) : null,
    score: data.score === null ? null : Number(data.score),
    scoreBreakdown: data.score_breakdown || {},
    decision: data.decision,
    reason: data.reason ? String(data.reason) : null,
    productId: data.product_id ? String(data.product_id) : null,
    reviewId: data.review_id ? String(data.review_id) : null,
  };
}

export async function saveAutonomousCuratorCategoryResult(result: AutonomousCuratorCategoryResult): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("autonomous_curator_candidates").upsert({
    run_id: result.runId,
    category: result.category,
    search_query: result.searchQuery,
    shop_id: result.shopId ?? null,
    item_id: result.itemId ?? null,
    source_product_url: result.sourceProductUrl ?? null,
    raw_title: result.rawTitle ?? null,
    display_title: result.displayTitle ?? null,
    score: result.score ?? null,
    score_breakdown: result.scoreBreakdown ?? {},
    decision: result.decision,
    reason: result.reason ?? null,
    product_id: result.productId ?? null,
    review_id: result.reviewId ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "run_id,category" });
  if (error) throw error;
}

export async function finishAutonomousCuratorRun(input: {
  runId: string;
  status: AutonomousCuratorRun["status"];
  categoriesProcessed: number;
  autoPublished: number;
  reviewRequired: number;
  rejected: number;
  failed: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("autonomous_curator_runs").update({
    status: input.status,
    completed_at: new Date().toISOString(),
    categories_processed: input.categoriesProcessed,
    auto_published: input.autoPublished,
    review_required: input.reviewRequired,
    rejected: input.rejected,
    failed: input.failed,
    metadata: input.metadata || {},
    updated_at: new Date().toISOString(),
  }).eq("id", input.runId);
  if (error) throw error;
}

export async function findProductSourceIdentity(marketplace: string, shopId: string, itemId: string): Promise<ProductSourceIdentity | null> {
  const client = requireSupabase();
  const { data, error } = await client.from("product_source_identities").select("*")
    .eq("marketplace", marketplace).eq("shop_id", shopId).eq("item_id", itemId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    marketplace: String(data.marketplace),
    shopId: String(data.shop_id),
    itemId: String(data.item_id),
    sourceProductUrl: String(data.source_product_url),
    productId: data.product_id ? String(data.product_id) : null,
    reviewId: data.review_id ? String(data.review_id) : null,
    reservedRunId: data.reserved_run_id ? String(data.reserved_run_id) : null,
    reservedUntil: data.reserved_until ? String(data.reserved_until) : null,
  };
}

/**
 * Reserva a identidade antes de persistir o produto. Um conflito significa que
 * outro run/publicação já possui autoridade sobre o mesmo item Shopee.
 */
export async function reserveProductSourceIdentity(input: {
  marketplace: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  runId: string;
  reviewId?: string | null;
  ttlMinutes?: number;
}): Promise<{ reserved: boolean; identity: ProductSourceIdentity | null }> {
  const client = requireSupabase();
  const now = Date.now();
  const maxTtlMinutes = input.reviewId ? 24 * 60 : 120;
  const defaultTtlMinutes = input.reviewId ? 24 * 60 : 30;
  const reservedUntil = new Date(now + Math.max(5, Math.min(maxTtlMinutes, input.ttlMinutes ?? defaultTtlMinutes)) * 60_000).toISOString();
  const { error } = await client.from("product_source_identities").insert({
    marketplace: input.marketplace,
    shop_id: input.shopId,
    item_id: input.itemId,
    source_product_url: input.sourceProductUrl,
    source: "autonomous_curator",
    review_id: input.reviewId ?? null,
    reserved_run_id: input.runId,
    reserved_until: reservedUntil,
  });
  if (!error) {
    return {
      reserved: true,
      identity: {
        marketplace: input.marketplace,
        shopId: input.shopId,
        itemId: input.itemId,
        sourceProductUrl: input.sourceProductUrl,
        productId: null,
        reviewId: input.reviewId ?? null,
        reservedRunId: input.runId,
        reservedUntil,
      },
    };
  }

  // 23505 = unique violation. Qualquer outro erro continua fail-closed.
  if ((error as any).code !== "23505") throw error;
  const existing = await findProductSourceIdentity(input.marketplace, input.shopId, input.itemId);
  if (!existing) return { reserved: false, identity: null };
  if (existing.productId) return { reserved: false, identity: existing };
  const expiry = existing.reservedUntil ? Date.parse(existing.reservedUntil) : 0;
  const expired = Number.isFinite(expiry) && expiry <= now;
  const sameReview = Boolean(input.reviewId && existing.reviewId === input.reviewId);
  const sameRunWithoutReview = !input.reviewId && !existing.reviewId && existing.reservedRunId === input.runId;
  if (sameReview || sameRunWithoutReview || expired) {
    const { data, error: updateError } = await client.from("product_source_identities").update({
      source_product_url: input.sourceProductUrl,
      review_id: input.reviewId ?? null,
      reserved_run_id: input.runId,
      reserved_until: reservedUntil,
      updated_at: new Date().toISOString(),
    }).eq("marketplace", input.marketplace).eq("shop_id", input.shopId).eq("item_id", input.itemId)
      .is("product_id", null).select("*").maybeSingle();
    if (updateError) throw updateError;
    if (data) return { reserved: true, identity: { ...existing, sourceProductUrl: input.sourceProductUrl, reviewId: input.reviewId ?? null, reservedRunId: input.runId, reservedUntil } };
  }
  return { reserved: false, identity: existing };
}

export async function bindProductSourceIdentity(input: {
  marketplace: string;
  shopId: string;
  itemId: string;
  runId: string;
  productId: string;
}): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("product_source_identities").update({
    product_id: input.productId,
    review_id: null,
    reserved_run_id: input.runId,
    reserved_until: null,
    updated_at: new Date().toISOString(),
  }).eq("marketplace", input.marketplace).eq("shop_id", input.shopId).eq("item_id", input.itemId).eq("reserved_run_id", input.runId);
  if (error) throw error;
}

export async function releaseProductSourceIdentity(input: {
  marketplace: string;
  shopId: string;
  itemId: string;
  runId: string;
}): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("product_source_identities").delete()
    .eq("marketplace", input.marketplace).eq("shop_id", input.shopId).eq("item_id", input.itemId)
    .eq("reserved_run_id", input.runId).is("product_id", null);
  if (error) throw error;
}

export async function bindProductSourceIdentityByReview(input: {
  reviewId: string;
  productId: string;
}): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client.from("product_source_identities").update({
    product_id: input.productId,
    review_id: null,
    reserved_run_id: null,
    reserved_until: null,
    updated_at: new Date().toISOString(),
  }).eq("review_id", input.reviewId).is("product_id", null).select("id").maybeSingle();
  if (error) throw error;
  if (data) return;

  // A publicação manual governada pode vincular a identidade de forma
  // transacional no banco antes de o Telegram persistir status=published.
  // Como product_id é UNIQUE quando não nulo, encontrar a identidade já
  // vinculada ao mesmo produto prova que a operação foi consumida com sucesso
  // e torna esta finalização idempotente. Vinculação a outro produto continua
  // fail-closed porque não satisfaz esta consulta.
  const { data: alreadyBound, error: alreadyBoundError } = await client
    .from("product_source_identities")
    .select("id")
    .eq("product_id", input.productId)
    .maybeSingle();
  if (alreadyBoundError) throw alreadyBoundError;
  if (alreadyBound) return;

  throw new Error("AUTONOMOUS_CURATOR_REVIEW_IDENTITY_MISSING");
}

export async function releaseProductSourceIdentityByReview(reviewId: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("product_source_identities").delete()
    .eq("review_id", reviewId).is("product_id", null);
  if (error) throw error;
}

export async function saveProductImageEditorialReview(input: {
  productId: string;
  curation: ProductImageCuration;
  model?: string | null;
  reviewVersion?: string;
}): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("product_image_editorial_reviews").insert({
    product_id: input.productId,
    source: "autonomous_curator",
    status: input.curation.status === "ready" ? "clean" : "review_required",
    primary_image_url: input.curation.primaryImageUrl ?? null,
    raw_image_urls: input.curation.rawImageUrls,
    gallery_image_urls: input.curation.galleryImageUrls,
    assessments: input.curation.assessments,
    model: input.model ?? null,
    review_version: input.reviewVersion || "1.0",
  });
  if (error) throw error;
}
