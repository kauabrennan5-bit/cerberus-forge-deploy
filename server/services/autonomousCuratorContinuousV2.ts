import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import { syncCatalogAndDeploy } from "./catalogSync";
import { sendTelegramMessage } from "./telegramBot";
import { AUTONOMOUS_CURATOR_PROFILES } from "./autonomousCuratorProfiles";
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
 */
const LIVE_TARGET_PER_CATEGORY = 2;
const CATEGORY_BALANCE_VERSION = "1";

type ContinuousOptions = Parameters<typeof runAutonomousCuratorContinuousV2Base>[0];

type CategoryCounts = Record<PublicProductCategory, number>;

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

async function persistBalanceMetadata(input: {
  result: ContinuousCuratorResultV2;
  bootstrapMode: boolean;
  countsBefore: CategoryCounts;
  countsAfter: CategoryCounts;
  retiredIds: string[];
  bootstrapExtraIds: string[];
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
    },
  }).eq("id", input.result.runId);
  if (error) throw error;
}

function adminChatId(env: NodeJS.ProcessEnv): number | null {
  const raw = String(env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

async function notifyBalance(
  result: ContinuousCuratorResultV2,
  counts: CategoryCounts,
  env: NodeJS.ProcessEnv,
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
  const productsBefore = await productsRepository.getProducts();
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
  }).catch(error => console.warn("[Autonomous Curator Balance] metadata update failed", error));

  if (options.notify !== false) await notifyBalance(result, countsAfter, env);
  return result;
}

export const autonomousCuratorContinuousV2Internals = {
  ...baseInternals,
  LIVE_TARGET_PER_CATEGORY,
  CATEGORY_BALANCE_VERSION,
  activePublishedForCategory,
  categoryCounts,
  categoryDeficits,
  totalDeficit,
  publicationTimestamp,
  retirementCandidates,
};
