import type { Product } from "../../src/types";
import * as productsRepository from "../repositories/productsRepository";
import { requireSupabase } from "../repositories/productsRepository";
import { sendTelegramMessage } from "./telegramBot";
import * as core from "./autonomousCuratorContinuousV2Core";

export * from "./autonomousCuratorContinuousV2Core";

type ContinuousOptions = Parameters<typeof core.runAutonomousCuratorContinuousV2>[0];

type BeforeProduct = {
  id: string;
  title: string;
  ref: string;
  category: string;
};

function activePublished(product: Product): boolean {
  return product.status === "published" && product.ativo !== false;
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
    .replace(/\"/g, "&quot;");
}

async function notifyConfirmedUnavailableTransitions(before: Map<string, BeforeProduct>, env: NodeJS.ProcessEnv): Promise<void> {
  if (before.size === 0) return;
  const chatId = adminChatId(env);
  if (!chatId) return;
  const after = await productsRepository.getProducts();
  const afterById = new Map(after.map(product => [product.id, product] as const));

  for (const [productId, previous] of before) {
    const current = afterById.get(productId);
    if (!current || activePublished(current)) continue;
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

/**
 * Adds event-level Telegram notifications around the proven coordinator.
 * The core still owns exact-identity Shopee health checks, fail-safe UNKNOWN
 * handling, archive rollback and category refill. This layer only announces a
 * transition after the product actually left the public published set.
 */
export async function runAutonomousCuratorContinuousV2(options: ContinuousOptions = {}): Promise<core.ContinuousCuratorResultV2> {
  const env = options.env || process.env;
  const beforeProducts = await productsRepository.getProducts();
  const before = new Map<string, BeforeProduct>();
  for (const product of beforeProducts.filter(activePublished)) {
    before.set(product.id, {
      id: product.id,
      title: product.displayTitle || product.produto,
      ref: product.ref || product.id,
      category: product.categoria,
    });
  }

  try {
    const result = await core.runAutonomousCuratorContinuousV2(options);
    await notifyConfirmedUnavailableTransitions(before, env).catch(error => {
      console.warn("[Published Product Health Telegram] notification failed", error);
    });
    return result;
  } catch (error) {
    await notifyConfirmedUnavailableTransitions(before, env).catch(notificationError => {
      console.warn("[Published Product Health Telegram] notification after failure failed", notificationError);
    });
    throw error;
  }
}
