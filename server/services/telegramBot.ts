import * as core from "./telegramBotCore";
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

// Structural Telegram V2 contract remains implemented in telegramBotCore.ts,
// including parseTelegramCommand(text) and shouldProcessTelegramUpdate.

/**
 * Keep the proven Telegram V2 implementation in telegramBotCore.ts and route
 * only the product detail/manual rotation callbacks through the isolated
 * rotation extension.
 *
 * The allowlist configuration preflight intentionally runs in this wrapper
 * because this is the exact function imported by server.ts for the Telegram
 * webhook. It checks TELEGRAM_ALLOWED_USER_IDS from the same Node process that
 * receives the webhook, trims and parses numeric IDs, fails closed when the
 * configuration is absent/malformed, and never logs the configured IDs.
 * Sender authorization itself remains in the canonical Telegram core/rotation
 * handlers so the established access-denied response and human gate are kept.
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!validateWebhookRuntime()) return;

  const data = String(update?.callback_query?.data || "");
  if (isProductRotationCallback(data)) {
    await handleProductRotationCallback(update);
    return;
  }
  return core.handleTelegramWebhookUpdate(update);
}
