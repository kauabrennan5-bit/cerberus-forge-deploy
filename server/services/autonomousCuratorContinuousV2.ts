import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepository from "../repositories/autonomousCuratorRepository";
import { syncCatalogAndDeploy, type SyncLogResult } from "./catalogSync";
import { sendTelegramMessage } from "./telegramBot";
import { AUTONOMOUS_CURATOR_PROFILES } from "./autonomousCuratorProfiles";
import {
  calculateCategoryPolicy,
  categoryCounts,
  categoryDeficits,
  deficitCategories,
  fulfilledCategoryCount,
  totalCategoryDeficit,
  type CategoryCounts,
} from "./autonomousCuratorCategoryPolicy";
import {
  auditPublishedProductHealth,
  type PublishedProductHealthResult,
} from "./publishedProductHealth";
import {
  blockerForCategory,
  summarizeCuratorBlockers,
} from "./autonomousCuratorObservability";
import { getOpenAIRuntimeHealth } from "./openAIProviderRuntime";
import {
  runAutonomousCuratorContinuousV2 as runAutonomousCuratorContinuousV2Base,
  autonomousCuratorContinuousV2Internals as baseInternals,
  type ContinuousCuratorResultV2,
} from "./autonomousCuratorContinuousV2Base";

export type {
  ContinuousCuratorCategoryResultV2,
  ContinuousCuratorResultV2,
} from "./autonomousCuratorContinuousV2Base";

/**
 * Public catalog contract:
 * - the autonomous catalog grows cumulatively by one visible piece per category
 *   for every local calendar day since autonomous publication began;
 * - day 1 targets 1/category, day 2 targets 2/category, day 3 targets 3/category,
 *   and so on; already-published pieces are never retired merely to keep a cap;
 * - while any category is below today's target, normal growth publication is
 *   restricted to the explicit deficit category list before enrichment starts;
 * - availability failures still archive only listings definitively unavailable
 *   on the exact Shopee identity and therefore create a refill deficit;
 * - a day/cycle is never recorded as complete while any category is below its
 *   cumulative floor or the public runtime projection is not validated.
 */
const CATEGORY_GROWTH_VERSION = "4";
const PUBLISHED_HEALTH_COORDINATOR_VERSION = "2";
const GROWTH_TIME_ZONE = "America/Fortaleza";
const DAY_MS = 24 * 60 * 60 * 1000;

type ContinuousOptions = Parameters<typeof runAutonomousCuratorContinuousV2Base>[0];

type BeforeProduct = {
  id: string;
  title: string;
  ref: string;
  category: string;
};

type RunCycleMetrics = {
  candidatesExamined: number;
  candidatesEnriched: number;
  candidatesRejected: number;
  queriesExecuted: number;
  technicalFailures: number;
};

function isActivePublished(product: Product): boolean {
  return product.status === "published" && product.ativo !== false;
}

function activePublishedForCategory(products: readonly Product[], category: PublicProductCategory): Product[] {
  return products.filter(product => product.categoria === category && isActivePublished(product));
}

function localDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: GROWTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (name: string) => parts.find(item => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateKeyOrdinal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / DAY_MS) : null;
}

function autonomousGrowthStartDate(products: readonly Product[], now: Date, env: NodeJS.ProcessEnv): string {
  const configured = String(env.AUTONOMOUS_CURATOR_GROWTH_START_DATE || "").trim();
  if (dateKeyOrdinal(configured) !== null) return configured;

  let earliest = Number.POSITIVE_INFINITY;
  for (const product of products) {
    if (product.createdBy !== baseInternals.QUEUE_CREATED_BY || !product.createdAt) continue;
    const timestamp = Date.parse(product.createdAt);
    if (Number.isFinite(timestamp) && timestamp < earliest) earliest = timestamp;
  }
  return Number.isFinite(earliest) ? localDateKey(new Date(earliest)) : localDateKey(now);
}

function dailyTargetPerCategory(products: readonly Product[], now: Date, env: NodeJS.ProcessEnv): number {
  const start = dateKeyOrdinal(autonomousGrowthStartDate(products, now, env));
  const today = dateKeyOrdinal(localDateKey(now));
  if (start === null || today === null) return 1;
  return Math.max(1, today - start + 1);
}

function totalDeficit(counts: CategoryCounts, target: number): number {
  return totalCategoryDeficit(categoryDeficits(counts, target));
}

async function setProductVisibility(productId: string, published: boolean): Promise<void> {
  const { error } = await requireSupabase()
    .from("products")
    .update({ ativo: published, status: published ? "published" : "archived" })
    .eq("id", productId);
  if (error) throw error;
}

function resolveShopeeClient(env: NodeJS.ProcessEnv, provided?: ShopeeApiClient): ShopeeApiClient | null {
  if (provided) return provided;
  const appId = String(env.SHOPEE_APP_ID || env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = String(env.SHOPEE_APP_SECRET || env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  if (!appId || !secret) return null;
  return createShopeeApiClient({ appId, secret, baseUrl: env.SHOPEE_AFFILIATE_API_BASE_URL });
}

function emptyHealthResult(): PublishedProductHealthResult {
  return {
    checkedIds: [],
    unavailableIds: [],
    skippedRecentIds: [],
    unknownIds: [],
    failures: [],
  };
}

async function archiveUnavailableProducts(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const uniqueIds = [...new Set(ids)];
  for (const id of uniqueIds) await setProductVisibility(id, false);
  const sync = await syncCatalogAndDeploy("published product health archive");
  if (sync.success) return;

  // Rollback restores the exact products that were visible before this health
  // transaction; it is not growth publication and never creates a new identity.
  for (const id of uniqueIds) await setProductVisibility(id, true).catch(() => undefined);
  await syncCatalogAndDeploy("published product health rollback").catch(() => undefined);
  throw new Error(`PUBLISHED_PRODUCT_HEALTH_CATALOG_SYNC_FAILED:${sync.error || "unknown"}`);
}

async function readRunCycleMetrics(runId: string): Promise<RunCycleMetrics> {
  const fallback: RunCycleMetrics = { candidatesExamined: 0, candidatesEnriched: 0, candidatesRejected: 0, queriesExecuted: 0, technicalFailures: 0 };
  if (!runId) return fallback;
  const { data, error } = await requireSupabase()
    .from("autonomous_curator_runs")
    .select("metadata")
    .eq("id", runId)
    .single();
  if (error) return fallback;
  const metadata = data?.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  const safeCount = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    candidatesExamined: safeCount(metadata.candidates_examined),
    candidatesEnriched: safeCount(metadata.candidates_enriched),
    candidatesRejected: safeCount(metadata.candidates_rejected),
    queriesExecuted: safeCount(metadata.queries_executed),
    technicalFailures: safeCount(metadata.technical_failures),
  };
}

async function persistGrowthMetadata(input: {
  result: ContinuousCuratorResultV2;
  recoveryMode: boolean;
  dailyTarget: number;
  growthStartDate: string;
  countsBefore: CategoryCounts;
  countsAfter: CategoryCounts;
  deficitCategoriesBefore: PublicProductCategory[];
  health: PublishedProductHealthResult;
  publicValidation: SyncLogResult;
}): Promise<void> {
  if (!input.result.runId) return;
  const client = requireSupabase();
  const { data, error: readError } = await client
    .from("autonomous_curator_runs")
    .select("metadata")
    .eq("id", input.result.runId)
    .single();
  if (readError) throw readError;
  const metadata = data?.metadata && typeof data.metadata === "object"
    ? data.metadata as Record<string, unknown>
    : {};
  const deficitsAfter = categoryDeficits(input.countsAfter, input.dailyTarget);
  const deficitCategoriesAfter = deficitCategories(deficitsAfter);
  const blockerSummary = summarizeCuratorBlockers(input.result.categories);
  const openaiRuntime = getOpenAIRuntimeHealth();
  const dailyTargetSatisfied = deficitCategoriesAfter.length === 0 && input.publicValidation.success;
  const categoryValidation = Object.fromEntries(AUTONOMOUS_CURATOR_PROFILES.map(profile => {
    const count = input.countsAfter[profile.category] || 0;
    return [profile.category, {
      count,
      dailyTarget: input.dailyTarget,
      deficit: Math.max(0, input.dailyTarget - count),
      floorMet: count >= input.dailyTarget,
      publicRuntimeValidated: input.publicValidation.success,
    }];
  }));
  const aiFailureTypes = Object.fromEntries(Object.entries(blockerSummary).filter(([key]) => key.startsWith("ai_")));
  const { error } = await client.from("autonomous_curator_runs").update({
    status: dailyTargetSatisfied && input.result.failedThisCycle === 0
      ? "completed"
      : input.result.status === "failed" ? "failed" : "partial",
    metadata: {
      ...metadata,
      category_growth_version: CATEGORY_GROWTH_VERSION,
      category_growth_recovery: input.recoveryMode,
      category_growth_saturation_gate: "hard_pre_enrichment",
      growth_start_date: input.growthStartDate,
      growth_day: input.dailyTarget,
      daily_target_per_category: input.dailyTarget,
      daily_catalog_target: input.dailyTarget * AUTONOMOUS_CURATOR_PROFILES.length,
      live_catalog_target: input.dailyTarget * AUTONOMOUS_CURATOR_PROFILES.length,
      daily_target_invariant: "count(category) >= dailyTarget for all 10 categories AND public runtime projection validated",
      daily_target_satisfied: dailyTargetSatisfied,
      category_counts_before: input.countsBefore,
      category_counts_after: input.countsAfter,
      category_deficits_before: categoryDeficits(input.countsBefore, input.dailyTarget),
      category_deficits_after: deficitsAfter,
      deficit_categories_before: input.deficitCategoriesBefore,
      deficit_categories_after: deficitCategoriesAfter,
      total_deficit_before: totalDeficit(input.countsBefore, input.dailyTarget),
      total_deficit_after: totalCategoryDeficit(deficitsAfter),
      fulfilled_categories: fulfilledCategoryCount(input.countsAfter, input.dailyTarget),
      post_publication_category_validation: categoryValidation,
      public_runtime_validation: {
        success: input.publicValidation.success,
        storefrontUrl: input.publicValidation.staticSiteUrl,
        publicCatalogApiUrl: input.publicValidation.publicCatalogApiUrl || null,
        storefrontHealthy: input.publicValidation.storefrontHealthy === true,
        publicCount: input.publicValidation.publicJsonCount ?? null,
        productFoundPublic: input.publicValidation.productFoundPublic ?? null,
        missingPublicIds: input.publicValidation.missingPublicIds || [],
        unexpectedPublicIds: input.publicValidation.unexpectedPublicIds || [],
        categoryMismatchIds: input.publicValidation.categoryMismatchIds || [],
      },
      curator_blocker_summary: blockerSummary,
      ai_failure_types: aiFailureTypes,
      openai_runtime_health: openaiRuntime ? {
        status: openaiRuntime.status,
        model: openaiRuntime.model,
        httpStatus: openaiRuntime.httpStatus,
        errorCode: openaiRuntime.errorCode,
        updatedAt: openaiRuntime.updatedAt,
      } : null,
      category_growth_over_target_publication_ids: [],
      published_product_health_version: PUBLISHED_HEALTH_COORDINATOR_VERSION,
      published_product_health_checked_ids: input.health.checkedIds,
      published_product_health_unavailable_ids: input.health.unavailableIds,
      published_product_health_skipped_recent_ids: input.health.skippedRecentIds,
      published_product_health_unknown_ids: input.health.unknownIds,
      published_product_health_failures: input.health.failures,
    },
  }).eq("id", input.result.runId);
  if (error) throw error;
}

function adminChatId(env: NodeJS.ProcessEnv): number | null {
  const raw = String(env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publishedSnapshot(products: readonly Product[]): Map<string, BeforeProduct> {
  const snapshot = new Map<string, BeforeProduct>();
  for (const product of products.filter(isActivePublished)) {
    snapshot.set(product.id, {
      id: product.id,
      title: product.displayTitle || product.produto,
      ref: product.ref || product.id,
      category: product.categoria,
    });
  }
  return snapshot;
}

async function notifyConfirmedUnavailableTransitions(
  before: ReadonlyMap<string, BeforeProduct>,
  unavailableIds: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (before.size === 0 || unavailableIds.length === 0) return;
  const chatId = adminChatId(env);
  if (!chatId) return;

  const after = await productsRepository.getProducts();
  const afterById = new Map(after.map(product => [product.id, product] as const));

  for (const productId of new Set(unavailableIds)) {
    const previous = before.get(productId);
    if (!previous) continue;
    const current = afterById.get(productId);
    if (!current || isActivePublished(current)) continue;

    const { data: observation, error } = await requireSupabase()
      .from("product_availability_observed")
      .select("observed_availability,observed_at,metadata,external_listing_id")
      .eq("product_id", productId)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || String(observation?.observed_availability || "").toUpperCase() !== "UNAVAILABLE") continue;

    const reason = observation?.metadata && typeof observation.metadata === "object"
      ? String((observation.metadata as Record<string, unknown>).reason || "EXACT_SHOPEE_IDENTITY_NOT_FOUND")
      : "EXACT_SHOPEE_IDENTITY_NOT_FOUND";
    const text = [
      "🚨 <b>PRODUTO REMOVIDO DO ACERVO</b>",
      "",
      `<b>${escapeHtml(previous.title)}</b>`,
      `REF: <code>${escapeHtml(previous.ref)}</code>`,
      `Categoria: ${escapeHtml(previous.category)}`,
      "",
      "Shopee: <b>UNAVAILABLE</b>",
      `Motivo: <code>${escapeHtml(reason)}</code>`,
      `Identidade: <code>${escapeHtml(observation?.external_listing_id || "não informada")}</code>`,
      `Confirmado em: ${escapeHtml(observation?.observed_at || "agora")}`,
      "",
      "✅ Produto arquivado automaticamente",
      "✅ Catálogo público sincronizado",
      "🔎 A categoria ficou elegível para reposição automática no mesmo ciclo do Curator.",
    ].join("\n");
    await sendTelegramMessage(chatId, text).catch(() => undefined);
  }
}

async function notifyGrowth(
  result: ContinuousCuratorResultV2,
  counts: CategoryCounts,
  dailyTarget: number,
  growthStartDate: string,
  env: NodeJS.ProcessEnv,
  health: PublishedProductHealthResult,
  metrics: RunCycleMetrics,
  publicValidation: SyncLogResult,
): Promise<void> {
  const chatId = adminChatId(env);
  if (!chatId) return;
  const covered = fulfilledCategoryCount(counts, dailyTarget);
  const blockerSummary = summarizeCuratorBlockers(result.categories);
  const summaryText = Object.entries(blockerSummary).map(([key, value]) => `${key}=${value}`).join(" · ") || "nenhum";
  const lines = AUTONOMOUS_CURATOR_PROFILES.map(profile => {
    const count = counts[profile.category] || 0;
    const deficit = Math.max(0, dailyTarget - count);
    if (deficit === 0) return `✅ <b>${profile.category}</b>: ${count}/${dailyTarget}`;
    const blocker = blockerForCategory(result.categories, profile.category);
    return `⚠️ <b>${profile.category}</b>: ${count}/${dailyTarget} · déficit <b>${deficit}</b> · bloqueio <code>${escapeHtml(blocker.type)}</code> · ${escapeHtml(blocker.reason)}`;
  });
  const text = [
    "📈 <b>CERBERUS — CRESCIMENTO DIÁRIO DO ACERVO</b>",
    "",
    `Dia de crescimento: <b>${dailyTarget}</b> · início: <code>${growthStartDate}</code>`,
    `Meta mínima hoje: <b>${dailyTarget} peças por categoria</b>`,
    `Categorias na meta: <b>${covered}/${AUTONOMOUS_CURATOR_PROFILES.length}</b>`,
    `Novos publicados neste ciclo: <b>${result.publishedThisCycle}</b>`,
    `Candidatos pesquisados: <b>${metrics.candidatesExamined}</b> · enriquecidos com etapas caras: <b>${metrics.candidatesEnriched}</b>`,
    `Queries: <b>${metrics.queriesExecuted}</b> · rejeitados: <b>${metrics.candidatesRejected}</b> · falhas técnicas: <b>${metrics.technicalFailures}</b>`,
    `Catálogo público/frontend: <b>${publicValidation.success && publicValidation.storefrontHealthy ? "VALIDADO" : "NÃO VALIDADO"}</b>`,
    `Links Shopee indisponíveis removidos: <b>${health.unavailableIds.length}</b>`,
    `Bloqueios principais: <code>${escapeHtml(summaryText)}</code>`,
    "",
    ...lines,
    "",
    covered === AUTONOMOUS_CURATOR_PROFILES.length && publicValidation.success
      ? `✅ Meta do dia cumprida. Amanhã o piso sobe automaticamente para ${dailyTarget + 1} peças por categoria; nenhuma peça saudável é removida só para manter limite.`
      : "🚨 META DO DIA NÃO CUMPRIDA. O run permanece partial/failed até count(category) >= dailyTarget nas 10 categorias e a projeção pública estar validada. Nenhum gate editorial é afrouxado.",
  ].join("\n");
  await sendTelegramMessage(chatId, text).catch(() => undefined);
}

export async function runAutonomousCuratorContinuousV2(options: ContinuousOptions = {}): Promise<ContinuousCuratorResultV2> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const config = await curatorRepository.getAutonomousCuratorConfig();
  let productsBefore = await productsRepository.getProducts();
  const beforeHealth = publishedSnapshot(productsBefore);
  let health = emptyHealthResult();
  const shopeeClient = config.enabled ? resolveShopeeClient(env, options.shopeeClient) : options.shopeeClient || null;

  if (config.enabled && shopeeClient) {
    health = await auditPublishedProductHealth({
      products: productsBefore,
      client: shopeeClient,
      now,
      env,
      correlationId: options.cycleId ? `published-health:${options.cycleId}` : `published-health:${now.toISOString()}`,
    });
    if (health.unavailableIds.length > 0) {
      await archiveUnavailableProducts(health.unavailableIds);
      productsBefore = await productsRepository.getProducts();
      await notifyConfirmedUnavailableTransitions(beforeHealth, health.unavailableIds, env).catch(error => {
        console.warn("[Published Product Health Telegram] notification failed", error);
      });
    }
  }

  const growthStartDate = autonomousGrowthStartDate(productsBefore, now, env);
  const dailyTarget = dailyTargetPerCategory(productsBefore, now, env);
  const beforePolicy = calculateCategoryPolicy(productsBefore, dailyTarget);
  const countsBefore = beforePolicy.categoryCounts;
  const recoveryMode = totalDeficit(countsBefore, dailyTarget) > 0;
  const activeBefore = productsBefore.filter(isActivePublished).length;

  // Deficit categories are a hard pre-enrichment scope. Complete categories
  // cannot consume semantic ranking, visual review, affiliate acquisition or
  // catalog publication while any lane remains below the daily cumulative floor.
  const baseEnv: NodeJS.ProcessEnv = {
    ...env,
    AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY: String(dailyTarget),
    AUTONOMOUS_CURATOR_RECOVERY_MODE: recoveryMode ? "true" : "false",
    AUTONOMOUS_CURATOR_DEFICIT_CATEGORIES: beforePolicy.deficitCategories.join(","),
    AUTONOMOUS_CURATOR_LIVE_CATALOG_TARGET: String(
      recoveryMode
        ? Math.min(100, activeBefore + beforePolicy.totalDeficit)
        : Math.min(100, dailyTarget * AUTONOMOUS_CURATOR_PROFILES.length),
    ),
  };

  // Growth is cumulative: never archived merely because a category crossed a fixed cap.
  const result = await runAutonomousCuratorContinuousV2Base({
    ...options,
    ...(shopeeClient ? { shopeeClient } : {}),
    env: baseEnv,
    notify: false,
  });
  if (result.status === "disabled" || !result.runId) return result;

  const productsAfter = await productsRepository.getProducts();
  const afterPolicy = calculateCategoryPolicy(productsAfter, dailyTarget);
  const countsAfter = afterPolicy.categoryCounts;
  const coveredCategories = afterPolicy.fulfilledCategories;
  const publicValidation = await syncCatalogAndDeploy("autonomous curator post-cycle category validation");
  if (!publicValidation.success) result.failedThisCycle += 1;

  result.fulfilledCategories = coveredCategories;
  result.status = afterPolicy.totalDeficit === 0 && result.failedThisCycle === 0 && publicValidation.success
    ? "completed"
    : result.failedThisCycle > 0 && coveredCategories === 0
      ? "failed"
      : "partial";

  const runMetrics = await readRunCycleMetrics(result.runId);
  await persistGrowthMetadata({
    result,
    recoveryMode,
    dailyTarget,
    growthStartDate,
    countsBefore,
    countsAfter,
    deficitCategoriesBefore: beforePolicy.deficitCategories,
    health,
    publicValidation,
  }).catch(error => console.warn("[Autonomous Curator Growth] metadata update failed", error));

  if (options.notify !== false) await notifyGrowth(result, countsAfter, dailyTarget, growthStartDate, env, health, runMetrics, publicValidation);
  return result;
}

export const autonomousCuratorContinuousV2Internals = {
  ...baseInternals,
  CATEGORY_GROWTH_VERSION,
  PUBLISHED_HEALTH_COORDINATOR_VERSION,
  GROWTH_TIME_ZONE,
  activePublishedForCategory,
  categoryCounts,
  localDateKey,
  dateKeyOrdinal,
  autonomousGrowthStartDate,
  dailyTargetPerCategory,
  categoryDeficits,
  deficitCategories,
  totalDeficit,
  calculateCategoryPolicy,
  resolveShopeeClient,
  readRunCycleMetrics,
};
