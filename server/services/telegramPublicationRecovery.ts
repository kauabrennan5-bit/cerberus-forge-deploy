import * as telegramRepo from "../repositories/telegramRepository";
import * as telegramCore from "./telegramBotCore";
import type { PendingReview } from "./telegramTypes";

const LEGACY_CATEGORY_BLOCK = "SHOPEE_PREFLIGHT_CATEGORY_CHANGED";

export type TelegramPublicationRecoveryResult = {
  status: "disabled" | "skipped" | "attempted" | "published";
  reviewId?: string;
  reason?: string;
  previousOperationId?: string;
  operationId?: string;
  publishedProductId?: string;
};

type RecoveryDeps = {
  getReview: (reviewId: string) => Promise<PendingReview | null>;
  saveReview: (review: PendingReview) => Promise<void>;
  handleUpdate: (update: any) => Promise<void>;
  now: () => number;
};

const productionDeps: RecoveryDeps = {
  getReview: telegramRepo.getPendingReview,
  saveReview: telegramRepo.savePendingReview,
  handleUpdate: telegramCore.handleTelegramWebhookUpdate,
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
      operationId: review.lifecycle?.operationId,
      publishedProductId: review.lifecycle?.publishedProductId,
    };
  }
  if (currentStatus !== "error") {
    return { status: "skipped", reviewId, reason: `REVIEW_STATUS_${currentStatus.toUpperCase()}` };
  }

  const previousLifecycle = review.lifecycle;
  const previousOperationId = String(previousLifecycle?.operationId || "").trim() || undefined;
  if (previousLifecycle?.diagnostic?.code !== LEGACY_CATEGORY_BLOCK) {
    return { status: "skipped", reviewId, reason: "LEGACY_CATEGORY_BLOCK_NOT_PRESENT", previousOperationId };
  }
  if (previousLifecycle.humanApproved !== true) {
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
        previousDiagnosticCode: LEGACY_CATEGORY_BLOCK,
        approvedCategory: review.categoria,
        requestedAt: new Date(now).toISOString(),
      },
    ],
  };

  // Reabre explicitamente a review antes de reaplicar o mesmo callback canônico.
  // A publicação ainda precisa adquirir o CAS pending/error -> publishing e passar
  // novamente por identidade, disponibilidade, afiliado, preço e imagem.
  review.status = "pending";
  await deps.saveReview(review);

  await deps.handleUpdate({
    update_id: now,
    callback_query: {
      id: `recovery-${review.id}-${now}`,
      from: { id: senderId },
      message: {
        message_id: review.cardMessageId || 1,
        chat: { id: chatId },
      },
      data: `confirm_pub:${review.id}`,
    },
  });

  const after = await deps.getReview(review.id);
  const operationId = String(after?.lifecycle?.operationId || "").trim() || undefined;
  const newOperationId = operationId && operationId !== previousOperationId ? operationId : undefined;

  if (after?.status === "published" && after.lifecycle?.publishedProductId && newOperationId) {
    return {
      status: "published",
      reviewId,
      previousOperationId,
      operationId: newOperationId,
      publishedProductId: after.lifecycle.publishedProductId,
    };
  }

  return {
    status: "attempted",
    reviewId,
    reason: after?.lifecycle?.diagnostic?.code || after?.lifecycle?.error || after?.status || "RECOVERY_RESULT_UNKNOWN",
    previousOperationId,
    operationId: newOperationId,
    publishedProductId: after?.lifecycle?.publishedProductId,
  };
}

export const telegramPublicationRecoveryInternals = {
  LEGACY_CATEGORY_BLOCK,
  positiveSafeInteger,
};
