import type { Product } from "../../src/types";
import * as productsRepository from "../repositories/productsRepository";
import { loadLastSuccessfulWeeklySentAt, loadProductClickCounts } from "./newsletterWeeklyCampaign";
import { composeWeeklyEdition, evaluateWeeklyProductEligibility, rankWeeklyCandidates, weeklyFreshnessMs, type WeeklyCompositionMode } from "./newsletterWeeklyEditorial";
import { evaluateWeeklyRuntimePreflight, type WeeklyRuntimePreflight } from "./newsletterWeeklyRuntimePreflight";
import { getWeeklyCopyBudgetStatus, type WeeklyCopyBudgetStatus } from "./newsletterWeeklyCopy";

export type WeeklyProductionPreflight = {
  ready: boolean;
  readOnly: true;
  production: WeeklyRuntimePreflight;
  telegramConfigured: boolean;
  geminiConfigured: boolean;
  geminiBudgetConfigured: boolean;
  geminiBudgetAvailable: boolean;
  geminiBudgetUsed: number;
  geminiBudgetLimit: number;
  geminiBudgetResetAt: string;
  lastWeeklySentAt: string | null;
  cutoffAt: string;
  freshProducts: number;
  eligibleProducts: number;
  blockedReasons: Record<string, number>;
  categories: string[];
  probableComposition: WeeklyCompositionMode | null;
  selectableProducts: number;
  duplicateEditionExists: boolean;
};

export type WeeklyProductionPreflightDeps = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  productsLoader?: () => Promise<Product[]>;
  lastSentAtLoader?: () => Promise<string | null>;
  clickCountLoader?: (ids: string[]) => Promise<Map<string, number>>;
  runtimeLoader?: () => Promise<WeeklyRuntimePreflight>;
  geminiBudgetLoader?: () => WeeklyCopyBudgetStatus | Promise<WeeklyCopyBudgetStatus>;
  duplicateEditionLoader?: (date: string) => Promise<boolean>;
};

export async function runWeeklyProductionPreflight(deps: WeeklyProductionPreflightDeps = {}): Promise<WeeklyProductionPreflight> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const [products, lastWeeklySentAt, production, geminiBudget] = await Promise.all([
    (deps.productsLoader || productsRepository.getProducts)(),
    (deps.lastSentAtLoader || loadLastSuccessfulWeeklySentAt)(),
    (deps.runtimeLoader || (() => evaluateWeeklyRuntimePreflight()))(),
    Promise.resolve((deps.geminiBudgetLoader || getWeeklyCopyBudgetStatus)()),
  ]);
  const configuredLookback = Number.parseInt(env.NEWSLETTER_WEEKLY_INITIAL_LOOKBACK_DAYS || "7", 10);
  const lookbackDays = Number.isSafeInteger(configuredLookback) ? Math.max(1, Math.min(30, configuredLookback)) : 7;
  const cutoffMs = lastWeeklySentAt ? Date.parse(lastWeeklySentAt) : now.getTime() - lookbackDays * 86_400_000;
  const fresh = products.filter(product => product.ativo === true && product.status === "published" && weeklyFreshnessMs(product, now) > cutoffMs);
  const blockedReasons: Record<string, number> = {};
  const eligible = fresh.filter(product => {
    const result = evaluateWeeklyProductEligibility(product, now);
    for (const reason of result.reasons) blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
    return result.eligible;
  });
  const clicks = await (deps.clickCountLoader || loadProductClickCounts)(eligible.map(product => product.id));
  const composition = composeWeeklyEdition(rankWeeklyCandidates(eligible, clicks, now), 4);
  const date = now.toISOString().slice(0, 10);
  const duplicateEditionExists = await (deps.duplicateEditionLoader || hasOperationalWeeklyEditionOnDate)(date);
  const telegramConfigured = Boolean((env.TELEGRAM_BOT_TOKEN || "").trim() && (env.TELEGRAM_ADMIN_CHAT_ID || "").trim());
  const geminiConfigured = Boolean((env.GEMINI_API_KEY || "").trim());
  const geminiBudgetConfigured = (Number.parseInt(env.GEMINI_HOURLY_BUDGET || "20", 10) || 0) > 0;
  const ready = Boolean(
    production.weeklyProductionEnabled
    && production.productionListConfigured
    && production.productionAudienceReady
    && production.brevoMarketingProviderReady
    && telegramConfigured
    && geminiConfigured
    && geminiBudgetConfigured
    && geminiBudget.available
    && eligible.length >= 3
    && composition.products.length >= 3
    && !duplicateEditionExists,
  );
  return {
    ready,
    readOnly: true,
    production,
    telegramConfigured,
    geminiConfigured,
    geminiBudgetConfigured,
    geminiBudgetAvailable: geminiBudget.available,
    geminiBudgetUsed: geminiBudget.used,
    geminiBudgetLimit: geminiBudget.limit,
    geminiBudgetResetAt: new Date(geminiBudget.resetAt).toISOString(),
    lastWeeklySentAt,
    cutoffAt: new Date(cutoffMs).toISOString(),
    freshProducts: fresh.length,
    eligibleProducts: eligible.length,
    blockedReasons,
    categories: composition.categories,
    probableComposition: composition.products.length >= 3 ? composition.mode : null,
    selectableProducts: composition.products.length,
    duplicateEditionExists,
  };
}

export function renderWeeklyPreflightTelegram(result: WeeklyProductionPreflight): string {
  const ok = (value: boolean) => value ? "✅" : "❌";
  const blockers = Object.entries(result.blockedReasons).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "nenhum";
  return [
    result.ready ? "🩺 <b>PREFLIGHT WEEKLY</b>" : "⚠️ <b>WEEKLY NÃO ESTÁ PRONTA</b>",
    "",
    `Produção: ${ok(result.production.weeklyProductionEnabled)}`,
    `Brevo: ${ok(result.production.brevoMarketingProviderReady && result.production.productionListConfigured)}`,
    `Audiência: ${result.production.eligibleSubscribers ?? 0}/${result.production.productionBrevoMembers ?? 0} ${ok(result.production.productionAudienceReady)}`,
    `Telegram: ${ok(result.telegramConfigured)} · Gemini: ${ok(result.geminiConfigured && result.geminiBudgetConfigured && result.geminiBudgetAvailable)}`,
    `Orçamento copy Gemini: ${result.geminiBudgetUsed}/${result.geminiBudgetLimit} ${ok(result.geminiBudgetAvailable)}`,
    `Produtos novos: ${result.freshProducts}`,
    `Elegíveis: ${result.eligibleProducts} ${result.eligibleProducts >= 3 ? "✅" : "❌ (mínimo 3)"}`,
    `Selecionáveis após deduplicação: ${result.selectableProducts}`,
    `Categorias: ${result.categories.join(", ") || "nenhuma"}`,
    `Composição provável: ${result.probableComposition || "indisponível"}`,
    `Bloqueios editoriais: ${blockers}`,
    `Edição duplicada hoje: ${result.duplicateEditionExists ? "sim ❌" : "não ✅"}`,
    "Draft programado: 10:00 America/Fortaleza",
    "",
    "Preflight somente leitura: nenhuma campanha Brevo ou email foi criado/enviado.",
  ].join("\n");
}

async function hasOperationalWeeklyEditionOnDate(date: string): Promise<boolean> {
  const client = productsRepository.requireSupabase();
  const { count, error } = await client.from("email_campaigns")
    .select("id", { count: "exact", head: true })
    .eq("campaign_type", "collection")
    .like("edition_key", `weekly:${date}:%`)
    .in("status", ["draft", "pending_approval", "approved", "sending", "sent", "failed"]);
  if (error) throw error;
  return Number(count || 0) > 0;
}
