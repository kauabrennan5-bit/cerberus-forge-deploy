import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepository from "../repositories/autonomousCuratorRepository";
import { syncCatalogAndDeploy } from "./catalogSync";
import { sendTelegramMessage } from "./telegramBot";
import { AUTONOMOUS_CURATOR_PROFILES } from "./autonomousCuratorProfiles";
import {
  auditPublishedProductHealth,
  type PublishedProductHealthResult,
} from "./publishedProductHealth";
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
 * - every public category owns exactly two visible pieces;
 * - categories below two bypass the 24h cooldown until the floor is restored;
 * - once all categories are covered, the base curator returns to its normal
 *   >=24h-per-category cadence;
 * - a successful daily addition replaces the oldest visible piece in the same
 *   category so the storefront remains intentionally small and balanced.
 *
 * The proven V2 discovery/scoring/image/pipeline implementation lives in the
 * adjacent Base module unchanged. This coordinator changes inventory policy,
 * never the quality gates.
 *
 * Editorial persistence invariants remain owned by the preserved base:
 * image_review_fingerprint: imageCurationFingerprint(candidate.imageCuration)
 * display_title_reviewed_at: now.toISOString()
 * display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION
 * image_review_version: IMAGE_REVIEW_VERSION
 */
const LIVE_TARGET_PER_CATEGORY = 2;
const CATEGORY_BALANCE_VERSION = "1";
const PUBLISHED_HEALTH_COORDINATOR_VERSION = "1";

type ContinuousOptions = Parameters<typeof runAutonomousCuratorContinuousV2Base>[0];

type CategoryCounts = Record<PublicProductCategory, number>;

type BeforeProduct = {
  id: string;
  title: string;
  ref: string;
  category: string;
};

function isActivePublished(product: Product): boolean {
  return product.status === "published" && product.ativo !== false;
}

function activePublishedForCategory(products: readonly Product[], category: PublicProductCategory): Product[] {
  return products.filter(product => product.categoria === category && isActivePublished(product));
}

function categoryCounts(products: readonly Product[]): CategoryCounts {
  return Object.fromEntries(
    AUTONOMOUS_CURATOR_PROFILES.map(profile => [
      profile.category,
      activePublishedForCategory(products, profile.category).length,
    ]),
  ) as CategoryCounts;
}

function categoryDeficits(counts: CategoryCounts): CategoryCounts {
  return Object.fromEntries(
    AUTONOMOUS_CURATOR_PROFILES.map(profile => [
      profile.category,
      Math.max(0, LIVE_TARGET_PER_CATEGORY - (counts[profile.category] || 0)),
    ]),
  ) as CategoryCounts;
}

function totalDeficit(counts: CategoryCounts): number {
  return Object.values(categoryDeficits(counts)).reduce((sum, value) => sum + value, 0);
}

function publicationTimestamp(product: Product): number {
  const meta = baseInternals.parseQueueNote(product.curatorNote);
  const value = meta?.publishedAt || product.createdAt || "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function retirementCandidates(
  products: readonly Product[],
  category: PublicProductCategory,
  protectedIds: ReadonlySet<string>,
): Product[] {
  const active = activePublishedForCategory(products, category);
  const excess = Math.max(0, active.length - LIVE_TARGET_PER_CATEGORY);
  if (excess === 0) return [];

  return active
    .filter(product => !protectedIds.has(product.id))
    .sort((a, b) => {
      // Prefer retiring an older curator-managed item before a manual/system
      // seed. If necessary, the oldest remaining public item is still eligible
      // so the exact-two storefront invariant cannot drift.
      const aManaged = a.createdBy === baseInternals.QUEUE_CREATED_BY ? 0 : 1;
      const bManaged = b.createdBy === baseInternals.QUEUE_CREATED_BY ? 0 : 1;
      return aManaged - bManaged
        || publicationTimestamp(a) - publicationTimestamp(b)
        || a.id.localeCompare(b.id);
    })
    .slice(0, excess);
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

  for (const id of uniqueIds) await setProductVisibility(id, true).catch(() => undefined);
  await syncCatalogAndDeploy("published product health rollback").catch(() => undefined);
  throw new Error(`PUBLISHED_PRODUCT_HEALTH_CATALOG_SYNC_FAILED:${sync.error || "unknown"}`);
}

async function persistBalanceMetadata(input: {
  result: ContinuousCuratorResultV2;
  bootstrapMode: boolean;
  countsBefore: CategoryCounts;
  countsAfter: CategoryCounts;
  retiredIds: string[];
  bootstrapExtraIds: string[];
  health: PublishedProductHealthResult;
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
  const { error } = await client.from("autonomous_curator_runs").update({
    status: input.result.status === "completed" ? "completed" : input.result.status === "failed" ? "failed" : "partial",
    metadata: {
      ...metadata,
      category_balance_version: CATEGORY_BALANCE_VERSION,
      live_target_per_category: LIVE_TARGET_PER_CATEGORY,
      live_catalog_target: LIVE_TARGET_PER_CATEGORY * AUTONOMOUS_CURATOR_PROFILES.length,
      category_balance_bootstrap: input.bootstrapMode,
      category_counts_before: input.countsBefore,
      category_counts_after: input.countsAfter,
      category_deficits_after: categoryDeficits(input.countsAfter),
      category_balance_retired_ids: input.retiredIds,
      category_balance_bootstrap_extra_ids: input.bootstrapExtraIds,
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

async function notifyBalance(
  result: ContinuousCuratorResultV2,
  counts: CategoryCounts,
  env: NodeJS.ProcessEnv,
  health: PublishedProductHealthResult,
): Promise<void> {
  const chatId = adminChatId(env);
  if (!chatId) return;
  const covered = AUTONOMOUS_CURATOR_PROFILES.filter(profile => counts[profile.category] >= LIVE_TARGET_PER_CATEGORY).length;
  const lines = AUTONOMOUS_CURATOR_PROFILES.map(profile => {
    const count = counts[profile.category] || 0;
    return `${count >= LIVE_TARGET_PER_CATEGORY ? "✅" : "🔎"} <b>${profile.category}</b>: ${count}/${LIVE_TARGET_PER_CATEGORY}`;
  });
  const text = [
    "⚖️ <b>CERBERUS — EQUILÍBRIO DO ACERVO</b>",
    "",
    `Categorias com 2 peças: <b>${covered}/${AUTONOMOUS_CURATOR_PROFILES.length}</b>`,
    `Novos publicados neste ciclo: <b>${result.publishedThisCycle}</b>`,
    `Links Shopee indisponíveis removidos: <b>${health.unavailableIds.length}</b>`,
    "",
    ...lines,
    "",
    covered === AUTONOMOUS_CURATOR_PROFILES.length
      ? "Acervo equilibrado. Cada categoria recebe no máximo 1 novo achado após 24h; o item mais antigo sai para manter 2 peças visíveis."
      : "Categorias abaixo de 2 continuam em recuperação automática nos próximos ciclos, sem reduzir os gates de qualidade.",
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

  // Published products are periodically revalidated against the exact official
  // Shopee shopId/itemId. Only a definitive `not_found` archives a product;
  // auth, network and provider failures are recorded as UNKNOWN and never hide
  // a valid listing. Archiving happens before deficit calculation so the same
  // curator cycle can refill the affected category.
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

  const countsBefore = categoryCounts(productsBefore);
  const bootstrapMode = totalDeficit(countsBefore) > 0;
  const activeBefore = productsBefore.filter(isActivePublished).length;

  // The unchanged base V2 uses a global emergency floor. During bootstrap we
  // deliberately create a deficit of ten, which makes all ten profiles get one
  // bounded attempt in this cycle. After coverage reaches 2/category, the
  // global emergency is disabled and the original >=24h cadence takes over.
  const baseEnv: NodeJS.ProcessEnv = {
    ...env,
    AUTONOMOUS_CURATOR_LIVE_CATALOG_TARGET: String(
      bootstrapMode
        ? Math.min(100, activeBefore + AUTONOMOUS_CURATOR_PROFILES.length)
        : LIVE_TARGET_PER_CATEGORY * AUTONOMOUS_CURATOR_PROFILES.length,
    ),
  };

  const result = await runAutonomousCuratorContinuousV2Base({
    ...options,
    ...(shopeeClient ? { shopeeClient } : {}),
    env: baseEnv,
    notify: false,
  });
  if (result.status === "disabled" || !result.runId) return result;

  let products = await productsRepository.getProducts();
  const publishedIds = new Set(
    result.categories
      .filter(category => category.published && category.productId)
      .map(category => String(category.productId)),
  );
  const bootstrapExtraIds: string[] = [];
  const retiredIds: string[] = [];

  // While repairing sparse categories, publications produced for categories
  // that were already full are not allowed to churn the visible collection.
  // They are archived immediately and the catalog is resynced below.
  if (bootstrapMode) {
    for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
      if ((countsBefore[profile.category] || 0) < LIVE_TARGET_PER_CATEGORY) continue;
      for (const product of activePublishedForCategory(products, profile.category)) {
        if (!publishedIds.has(product.id)) continue;
        await setProductVisibility(product.id, false);
        product.status = "archived";
        product.ativo = false;
        bootstrapExtraIds.push(product.id);
      }
    }
  }

  // Normal daily rotation protects the just-published item and retires the
  // oldest prior item. During bootstrap, newly published items only remain in
  // categories that were actually below the two-piece floor.
  products = await productsRepository.getProducts();
  const protectedIds = new Set(
    [...publishedIds].filter(id => !bootstrapExtraIds.includes(id)),
  );
  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    for (const product of retirementCandidates(products, profile.category, protectedIds)) {
      await setProductVisibility(product.id, false);
      product.status = "archived";
      product.ativo = false;
      retiredIds.push(product.id);
    }
  }

  if (bootstrapExtraIds.length > 0 || retiredIds.length > 0) {
    const sync = await syncCatalogAndDeploy("autonomous curator category balance");
    if (!sync.success) {
      // Restore the base publication state rather than leaving the database and
      // public catalog disagreeing. The next scheduled cycle retries balance.
      for (const id of [...bootstrapExtraIds, ...retiredIds]) {
        await setProductVisibility(id, true).catch(() => undefined);
      }
      await syncCatalogAndDeploy("autonomous curator category balance rollback").catch(() => undefined);
      throw new Error(`CATEGORY_BALANCE_CATALOG_SYNC_FAILED:${sync.error || "unknown"}`);
    }
  }

  const productsAfter = await productsRepository.getProducts();
  const countsAfter = categoryCounts(productsAfter);
  const deficitAfter = totalDeficit(countsAfter);
  const coveredCategories = AUTONOMOUS_CURATOR_PROFILES.filter(
    profile => countsAfter[profile.category] >= LIVE_TARGET_PER_CATEGORY,
  ).length;

  result.fulfilledCategories = coveredCategories;
  result.status = deficitAfter === 0 && result.failedThisCycle === 0
    ? "completed"
    : result.failedThisCycle > 0 && coveredCategories === 0
      ? "failed"
      : "partial";

  await persistBalanceMetadata({
    result,
    bootstrapMode,
    countsBefore,
    countsAfter,
    retiredIds,
    bootstrapExtraIds,
    health,
  }).catch(error => console.warn("[Autonomous Curator Balance] metadata update failed", error));

  if (options.notify !== false) await notifyBalance(result, countsAfter, env, health);
  return result;
}

export const autonomousCuratorContinuousV2Internals = {
  ...baseInternals,
  LIVE_TARGET_PER_CATEGORY,
  CATEGORY_BALANCE_VERSION,
  PUBLISHED_HEALTH_COORDINATOR_VERSION,
  activePublishedForCategory,
  categoryCounts,
  categoryDeficits,
  totalDeficit,
  publicationTimestamp,
  retirementCandidates,
  resolveShopeeClient,
};