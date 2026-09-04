import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const telegramBot = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
const telegramRepository = readFileSync(new URL("../server/repositories/telegramRepository.ts", import.meta.url), "utf8");

test("Telegram V2 required contract remains enforced by the global suite", () => {
  assert.ok(!telegramBot.includes("categoriesRepository"), "Telegram V2 must not depend on categoriesRepository");
  assert.ok(
    !telegramBot.includes("getLatestPendingReviewForUser(senderId, chatId)"),
    "Telegram V2 must not restore the legacy pending-review lookup",
  );
  assert.ok(!telegramBot.includes("addCategory("), "Telegram V2 must not expose addCategory from the bot surface");
  assert.ok(!telegramBot.includes("renameCategory("), "Telegram V2 must not expose renameCategory from the bot surface");
  assert.ok(telegramBot.includes("parseTelegramCommand(text)"), "Telegram V2 command parser contract is required");
  assert.ok(telegramBot.includes("shouldProcessTelegramUpdate"), "Telegram V2 update deduplication contract is required");
  assert.ok(telegramRepository.includes("listReviewsByStatus"), "Telegram review status query contract is required");
  assert.ok(telegramRepository.includes("setTestUserStateHandlers"), "Telegram testable user-state boundary is required");
});
