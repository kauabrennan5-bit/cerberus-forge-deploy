import type { Product } from "../../src/types";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import { AUTONOMOUS_CURATOR_PROFILES } from "./autonomousCuratorProfiles";
import { sendTelegramMessage } from "./telegramBot";
import {
  runAutonomousCuratorContinuousV2 as runStrictAutonomousCuratorContinuousV2,
  autonomousCuratorContinuousV2Internals,
  type ContinuousCuratorResultV2,
} from "./autonomousCuratorContinuousV2Strict";
import {
  fillAutonomousCatalogFloor,
  type CatalogFloorFallbackResult,
} from "./autonomousCuratorCatalogFloorFallback";
import { AUTONOMOUS_CURATOR_FLOOR_FALLBACK_VERSION } from "./autonomousCuratorCatalogFloorPolicy";

const GUARANTEED_FLOOR_COORDINATOR_VERSION = "1";
type ContinuousOptions = Parameters<typeof runStrictAutonomousCuratorContinuousV2>[0];

function activePublishedCount(products: readonly Product[], category: string): number {
  return products.filter(product => product.categoria === category && product.status === "published" && product.ativo !== false).length;
}

function countsByCategory(products: readonly Product[]): Record<string, number> {
  return Object.fromEntries(AUTONOMOUS_CURATOR_PROFILES.map(profile => [profile.category, activePublishedCount(products, profile.category)]));
}

function totalDeficit(counts: Record<string, number>, target: number): number {
  return AUTONOMOUS_CURATOR_PROFILES.reduce((sum, profile) => sum + Math.max(0, target - (counts[profile.category] || 0)), 0);
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

async function persistFallbackAudit(input: {
  result: ContinuousCuratorResultV2;
  fallback: CatalogFloorFallbackResult;
  target: number;
  counts: Record<string, number>;
}): Promise<void> {
  if (!input.result.runId) return;
  const client = requireSupabase();
  const { data, error: readError } = await client.from("autonomous_curator_runs")
    .select("metadata")
    .eq("id", input.result.runId)
    .single();
  if (readError) throw readError;
  const metadata = data?.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
  const { error } = await client.from("autonomous_curator_runs").update({
    status: input.result.status === "completed" ? "completed" : input.result.status === "failed" ? "failed" : "partial",
    metadata: {
      ...metadata,
      guaranteed_floor_coordinator_version: GUARANTEED_FLOOR_COORDINATOR_VERSION,
      catalog_floor_fallback_version: AUTONOMOUS_CURATOR_FLOOR_FALLBACK_VERSION,
      catalog_floor_target_per_category: input.target,
      catalog_floor_counts_after: input.counts,
      catalog_floor_deficit_after: totalDeficit(input.counts, input.target),
      catalog_floor_fallback_published_ids: input.fallback.publishedIds,
      catalog_floor_fallback_sync_success: input.fallback.syncSuccess,
      catalog_floor_fallback_sync_error: input.fallback.syncError,
      catalog_floor_fallback_categories: input.fallback.categories.map(category => ({
        category: category.category,
        requested: category.requested,
        published: category.published,
        received: category.received,
        technicallyExamined: category.technicallyExamined,
        reasons: category.reasons,
        productIds: category.productIds,
      })),
      catalog_floor_fallback_warnings: input.fallback.warnings,
    },
  }).eq("id", input.result.runId);
  if (error) throw error;
}

async function notifyGuaranteedFloor(input: {
  result: ContinuousCuratorResultV2;
  fallback: CatalogFloorFallbackResult;
  target: number;
  counts: Record<string, number>;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const chatId = adminChatId(input.env);
  if (!chatId) return;
  const covered = AUTONOMOUS_CURATOR_PROFILES.filter(profile => (input.counts[profile.category] || 0) >= input.target).length;
  const lines = AUTONOMOUS_CURATOR_PROFILES.map(profile => {
    const count = input.counts[profile.category] || 0;
    const fallbackCategory = input.fallback.categories.find(item => item.category === profile.category);
    const extra = fallbackCategory?.published ? ` · fallback +${fallbackCategory.published}` : "";
    return `${count >= input.target ? "✅" : "🔎"} <b>${escapeHtml(profile.category)}</b>: ${count}/${input.target}${extra}`;
  });
  const warningProducts = input.fallback.warnings.filter(item => item.warnings.length > 0).length;
  const text = [
    "🛡️ <b>CERBERUS — PISO GARANTIDO DO CATÁLOGO</b>",
    "",
    `Meta atual: <b>${input.target} produtos por categoria</b>`,
    `Categorias na meta: <b>${covered}/${AUTONOMOUS_CURATOR_PROFILES.length}</b>`,
    `Publicados pelo curador estrito + fallback neste ciclo: <b>${input.result.publishedThisCycle}</b>`,
    `Fallback best-of-lot: <b>${input.fallback.publishedIds.length}</b> produto(s)`,
    `Produtos publicados com ressalva editorial: <b>${warningProducts}</b>`,
    "",
    ...lines,
    "",
    covered === AUTONOMOUS_CURATOR_PROFILES.length
      ? "✅ Piso cumprido. Filtros editoriais/visuais continuam registrados e ordenam a escolha, mas não podem zerar uma categoria quando há ofertas Shopee tecnicamente publicáveis."
      : "⚠️ Ainda existe déficit factual: o fallback não encontrou ofertas suficientes com identidade oficial, link afiliado, preço positivo e imagem tecnicamente acessível. O próximo ciclo tentará novamente.",
  ].join("\n");
  await sendTelegramMessage(chatId, text).catch(() => undefined);
}

/**
 * Production entrypoint used by the scheduled continuous route.
 *
 * 1. Run the existing strict curator first, preserving its full editorial,
 *    image, pipeline and score gates as the preferred path.
 * 2. If any category is still below today's progressive floor, run a bounded
 *    best-of-lot fallback. The fallback keeps source identity, affiliate link,
 *    price and image accessibility as hard technical gates, but treats image,
 *    category-fit and aesthetic/editorial failures as ranking/audit warnings.
 * 3. Recalculate the real public floor and report the final state.
 */
export async function runAutonomousCuratorContinuousV2(options: ContinuousOptions = {}): Promise<ContinuousCuratorResultV2> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const result = await runStrictAutonomousCuratorContinuousV2({ ...options, notify: false });
  if (result.status === "disabled" || !result.runId) return result;

  let products = await productsRepository.getProducts();
  const target = autonomousCuratorContinuousV2Internals.dailyTargetPerCategory(products, now, env);
  let counts = countsByCategory(products);
  const deficitBeforeFallback = totalDeficit(counts, target);
  const client = autonomousCuratorContinuousV2Internals.resolveShopeeClient(env, options.shopeeClient);

  let fallback: CatalogFloorFallbackResult = {
    attempted: false,
    targetPerCategory: target,
    publishedIds: [],
    warnings: [],
    categories: [],
    syncSuccess: true,
    syncError: null,
  };

  if (deficitBeforeFallback > 0 && client) {
    fallback = await fillAutonomousCatalogFloor({ targetPerCategory: target, client, now, env });
    products = await productsRepository.getProducts();
    counts = countsByCategory(products);
  }

  const deficitAfterFallback = totalDeficit(counts, target);
  const coveredCategories = AUTONOMOUS_CURATOR_PROFILES.filter(profile => (counts[profile.category] || 0) >= target).length;
  result.publishedThisCycle += fallback.publishedIds.length;
  result.fulfilledCategories = coveredCategories;

  for (const category of fallback.categories) {
    if (category.published <= 0) continue;
    const resultCategory = result.categories.find(item => item.category === category.category);
    if (!resultCategory) continue;
    resultCategory.published = true;
    resultCategory.productId = category.productIds.at(-1) || resultCategory.productId;
    const product = products.find(item => item.id === resultCategory.productId);
    resultCategory.title = product?.produto || resultCategory.title;
    resultCategory.reason = `PUBLISHED_BY_BEST_OF_LOT_FLOOR_FALLBACK:${category.published}`;
  }

  result.status = deficitAfterFallback === 0 && result.failedThisCycle === 0
    ? "completed"
    : result.failedThisCycle > 0 && coveredCategories === 0
      ? "failed"
      : "partial";

  await persistFallbackAudit({ result, fallback, target, counts }).catch(error => {
    console.warn("[Catalog Floor Fallback] metadata update failed", error);
  });
  if (options.notify !== false) await notifyGuaranteedFloor({ result, fallback, target, counts, env });
  return result;
}

export const autonomousCuratorContinuousGuaranteedInternals = {
  GUARANTEED_FLOOR_COORDINATOR_VERSION,
  activePublishedCount,
  countsByCategory,
  totalDeficit,
};
