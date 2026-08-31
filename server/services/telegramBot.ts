import * as core from "./telegramBotCore";
import {
  handleProductRotationCallback,
  isProductRotationCallback,
} from "./telegramProductRotation";

export * from "./telegramBotCore";

/**
 * Keep the proven Telegram V2 implementation in telegramBotCore.ts and route
 * only the product detail/manual rotation callbacks through the isolated
 * rotation extension.
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  const data = String(update?.callback_query?.data || "");
  if (isProductRotationCallback(data)) {
    await handleProductRotationCallback(update);
    return;
  }
  return core.handleTelegramWebhookUpdate(update);
}
