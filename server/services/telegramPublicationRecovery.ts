import * as telegramRepo from "../repositories/telegramRepository";
import * as telegramCore from "./telegramBotCore";
import type { PendingReview } from "./telegramTypes";

const LEGACY_CATEGORY_BLOCK = "SHOPEE_PREFLIGHT_CATEGORY_CHANGED";

export type TelegramPublicationRecoveryResult = {
  status: "disabled" | "skipped" | "reopened";
  reviewId?: string;
  reason?: string;
  previousOperationId?: string;
};

type RecoveryDeps = {
  getReview: (reviewId: string) => Promise<PendingReview | null>;
  saveReview: (review: PendingReview) => Promise<void>;
  notifyReview: (review: PendingReview) => Promise<void>;
  now: () => number;
};

const productionDeps: RecoveryDeps = {
  getReview: telegramRepo.getPendingReview,
  saveReview: telegramRepo.savePendingReview,
  notifyReview: async review => {
    await telegramCore.sendTelegramMessage(
      review.chatId,
      "↩️ <b>REVIEW RECUPERADA</b>\n\nA falha antiga foi liberada para nova tentativa. Nada foi publicado automaticamente; revise o card e confirme novamente se ainda quiser publicar.",
      { inline_keyboard: [[{ text: "✅ Confirmar & Publicar", callback_data: `confirm_pub:${review.id}` }]] },
    );
  },
  now: Date.now,
};

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function runConfiguredShopeePublicationRecovery(
  env: NodeJS.ProcessEnv = process.env,
  deps: RecoveryDeps = productionDeps,
): Promise<TelegramPublicationRecoveryResult> {
  const reviewId = String(env.SHOPEE_PUBLICATION_RECOVERY_REVIEW_ID || "").trim();
  if (!reviewId) return { status: "disabled" };

  const review = await deps.getReview(reviewId);
  if (!review) return { status: "skipped", reviewId, reason: "REVIEW_NOT_FOUND" };

  const currentStatus = review.status || "pending";
  if (currentStatus === "published") {
    return {
      status: "skipped",
      reviewId,
      reason: "ALREADY_PUBLISHED",
    };
  }
  if (currentStatus !== "error") {
    return { status: "skipped", reviewId, reason: `REVIEW_STATUS_${currentStatus.toUpperCase()}` };
  }

  const previousLifecycle = review.lifecycle;
  const previousOperationId = String(previousLifecycle?.operationId || "").trim() || undefined;
  // Persisted reviews can contain diagnostic codes written by an older runtime.
  // The legacy category hard-block was intentionally removed from the current
  // OperationalFailureCode union, so consume this historical JSON as data.
  const previousDiagnosticCode = String(
    (previousLifecycle?.diagnostic as { code?: unknown } | undefined)?.code ?? "",
  ).trim();
  if (previousDiagnosticCode !== LEGACY_CATEGORY_BLOCK) {
    return { status: "skipped", reviewId, reason: "LEGACY_CATEGORY_BLOCK_NOT_PRESENT", previousOperationId };
  }
  if (previousLifecycle?.humanApproved !== true) {
    return { status: "skipped", reviewId, reason: "HUMAN_APPROVAL_NOT_PRESENT", previousOperationId };
  }

  const now = deps.now();
  const expiresAt = Number(review.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { status: "skipped", reviewId, reason: "REVIEW_EXPIRED", previousOperationId };
  }

  const senderId = positiveSafeInteger(review.senderId);
  const chatId = positiveSafeInteger(review.chatId);
  if (!senderId || !chatId) {
    return { status: "skipped", reviewId, reason: "TELEGRAM_IDENTITY_INVALID", previousOperationId };
  }

  const existingMeta = review.existingProduct && typeof review.existingProduct === "object"
    ? review.existingProduct as Record<string, any>
    : {};
  const existingHistory = Array.isArray(existingMeta.publicationRecoveryHistory)
    ? existingMeta.publicationRecoveryHistory
    : [];

  review.existingProduct = {
    ...existingMeta,
    publicationRecoveryHistory: [
      ...existingHistory,
      {
        recoveryType: "LEGACY_SHOPEE_CATEGORY_DRIFT",
        previousOperationId: previousOperationId || null,
        previousDiagnosticCode,
        approvedCategory: review.categoria,
        requestedAt: new Date(now).toISOString(),
      },
    ],
  };

  // Recovery only releases the review back to human decision. It never
  // synthesizes or replays a Telegram callback and therefore cannot publish.
  review.status = "pending";
  await deps.saveReview(review);
  await deps.notifyReview(review);
  return {
    status: "reopened",
    reviewId,
    reason: "PENDING_FRESH_HUMAN_APPROVAL",
    previousOperationId,
  };
}

export const telegramPublicationRecoveryInternals = {
  LEGACY_CATEGORY_BLOCK,
  positiveSafeInteger,
};
