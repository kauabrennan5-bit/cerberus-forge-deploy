import * as productsRepository from "../repositories/productsRepository";
import * as core from "./telegramBotCore";
import { canonicalTelegramCommand, parseTelegramCommand } from "./telegramCommands";
import { getProductRotationRequest } from "./productRotation";
import {
  detachDisposableRotationCandidateForCancellation,
  hardDeleteRejectedRotationCandidate,
} from "./rotationCandidateCleanup";
import {
  handleProductRotationCallback,
  isProductRotationCallback,
} from "./telegramProductRotation";

export * from "./telegramBotCore";

export type TelegramAllowedUserIdsStatus = {
  configured: boolean;
  valid: boolean;
  parsedCount: number;
  invalidCount: number;
};

function parseTelegramAllowedUserIds(raw: string | undefined): { ids: string[]; status: TelegramAllowedUserIdsStatus } {
  const normalized = String(raw ?? "").trim();
  if (!normalized) {
    return {
      ids: [],
      status: { configured: false, valid: false, parsedCount: 0, invalidCount: 0 },
    };
  }

  const tokens = normalized.split(",").map(value => value.trim()).filter(Boolean);
  const ids: string[] = [];
  let invalidCount = 0;
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      invalidCount += 1;
      continue;
    }
    const numeric = Number(token);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      invalidCount += 1;
      continue;
    }
    ids.push(String(numeric));
  }

  return {
    ids: [...new Set(ids)],
    status: {
      configured: true,
      valid: ids.length > 0 && invalidCount === 0,
      parsedCount: new Set(ids).size,
      invalidCount,
    },
  };
}

export function inspectTelegramAllowedUserIds(env: NodeJS.ProcessEnv = process.env): TelegramAllowedUserIdsStatus {
  return parseTelegramAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS).status;
}

function validateWebhookRuntime(): boolean {
  const parsed = parseTelegramAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (!parsed.status.valid) {
    console.warn(
      `[Telegram] webhook_env_invalid allowed_ids_present=${parsed.status.configured} parsed_id_count=${parsed.status.parsedCount} invalid_id_count=${parsed.status.invalidCount}`,
    );
    return false;
  }
  return true;
}

type TelegramCatalogProduct = {
  id: string;
  ref?: string;
  produto: string;
  preco: number;
  ativo?: boolean;
  status?: string;
};

/**
 * The Telegram "Produtos" page is a view of the public catalog, not an
 * inventory/debug table. Only products that are actually active + published
 * belong here. Paused/archived candidates remain invisible even if retained
 * internally for another workflow.
 */
export function buildActiveProductListView(products: TelegramCatalogProduct[], pageInput: number) {
  const activeCatalog = products.filter(product => product.ativo === true && product.status === "published");
  const view = core.buildProductListView(activeCatalog, pageInput);
  return {
    ...view,
    text: view.text.replace(
      `📦 <b>PRODUTOS — ${view.total} cadastrados</b>`,
      `📦 <b>PRODUTOS ATIVOS — ${view.total} no catálogo</b>`,
    ),
  };
}

async function renderActiveProductList(pageInput: number) {
  const products = await productsRepository.getProducts();
  return buildActiveProductListView(products, pageInput);
}

function rotationRequestId(data: string): string | null {
  const [action, requestId] = data.split(":");
  return requestId && ["rotation_approve", "rotation_retry", "rotation_cancel"].includes(action)
    ? requestId
    : null;
}

async function cleanupRejectedCandidate(requestId: string, candidateId: string | null): Promise<void> {
  if (!candidateId) return;
  const current = await getProductRotationRequest(requestId).catch(() => null);
  if (!current || current.replacementProductId === candidateId || !current.rejectedCandidateIds.includes(candidateId)) return;
  try {
    const deleted = await hardDeleteRejectedRotationCandidate(candidateId);
    if (deleted) console.info(`[ROTATION] rejected_candidate_deleted request=${requestId} candidate=${candidateId}`);
  } catch (error) {
    console.error(`[ROTATION] rejected_candidate_cleanup_failed request=${requestId} candidate=${candidateId} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleActiveProductCommand(update: any): Promise<boolean> {
  const parsed = parseTelegramCommand(String(update?.message?.text || ""));
  if (!parsed || canonicalTelegramCommand(parsed.name) !== "produtos") return false;
  if (!core.shouldProcessTelegramUpdate(update?.update_id)) return true;

  const senderId = update?.message?.from?.id;
  const chatId = update?.message?.chat?.id;
  if (!core.isUserAllowed(senderId)) {
    if (chatId) await core.sendTelegramMessage(chatId, "🔒 Acesso não autorizado.");
    return true;
  }
  if (!chatId) return true;

  const listView = await renderActiveProductList(0);
  await core.sendTelegramMessage(chatId, listView.text, listView.keyboard);
  return true;
}

async function refreshActiveProductCallback(update: any, data: string): Promise<void> {
  if (!data.startsWith("products_list:") && !data.startsWith("product_toggle:")) return;
  const senderId = update?.callback_query?.from?.id;
  const chatId = update?.callback_query?.message?.chat?.id;
  const messageId = update?.callback_query?.message?.message_id;
  if (!core.isUserAllowed(senderId) || !chatId || !messageId) return;

  const page = data.startsWith("products_list:")
    ? Number.parseInt(data.slice("products_list:".length), 10) || 0
    : 0;
  const listView = await renderActiveProductList(page);
  await core.editTelegramMessageText(chatId, messageId, listView.text, listView.keyboard);
}

// Structural Telegram V2 contract remains implemented in telegramBotCore.ts,
// including parseTelegramCommand(text) and shouldProcessTelegramUpdate.

/**
 * Keep the proven Telegram V2 implementation in telegramBotCore.ts and route
 * product-list visibility/manual rotation cleanup through this wrapper.
 *
 * The allowlist configuration preflight intentionally runs in this wrapper
 * because this is the exact function imported by server.ts for the Telegram
 * webhook. It checks TELEGRAM_ALLOWED_USER_IDS from the same Node process that
 * receives the webhook, trims and parses numeric IDs, fails closed when the
 * configuration is absent/malformed, and never logs the configured IDs.
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!validateWebhookRuntime()) return;
  if (await handleActiveProductCommand(update)) return;

  const data = String(update?.callback_query?.data || "");
  if (isProductRotationCallback(data)) {
    const requestId = rotationRequestId(data);
    const before = requestId ? await getProductRotationRequest(requestId).catch(() => null) : null;
    let detachedOnCancel: string | null = null;
    if (requestId && data.startsWith("rotation_cancel:")) {
      try {
        detachedOnCancel = await detachDisposableRotationCandidateForCancellation(requestId);
      } catch (error) {
        console.error(`[ROTATION] cancel_candidate_detach_failed request=${requestId} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await handleProductRotationCallback(update);
    if (requestId) await cleanupRejectedCandidate(requestId, detachedOnCancel || before?.candidateProductId || null);
    return;
  }

  await core.handleTelegramWebhookUpdate(update);
  await refreshActiveProductCallback(update, data);
}
