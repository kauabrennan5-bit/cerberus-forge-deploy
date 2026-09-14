import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../supabase/functions/cerberus-telegram-gateway/index.ts"), "utf8");

test("Telegram Edge review card uses approve_only and cancel_rev", () => {
  assert.match(source, /callback_data:\s*`approve_only:\$\{reviewId\}`/);
  assert.match(source, /callback_data:\s*`cancel_rev:\$\{reviewId\}`/);
  assert.doesNotMatch(source, /callback_data:\s*`confirm_pub:\$\{reviewId\}`/);
});

test("Telegram Edge approve_only records a decision without invoking publication RPC", () => {
  const start = source.indexOf('if (ctx.data.startsWith("approve_only:"))');
  const end = source.indexOf('if (ctx.data.startsWith("confirm_pub:"))', start);
  assert.ok(start >= 0 && end > start, "approve_only block must exist before legacy confirm_pub block");
  const block = source.slice(start, end);

  assert.match(block, /from\("telegram_pending_reviews"\)/);
  assert.match(block, /status:\s*"published"/);
  assert.match(block, /mode:\s*"approve_only"/);
  assert.match(block, /Nenhum produto foi publicado ou ativado/);
  assert.doesNotMatch(block, /cerberus_telegram_publish_review/);
  assert.doesNotMatch(block, /pipeline\.publish/);
  assert.doesNotMatch(block, /createProduct|updateProduct|catalogSync/);
});

test("Telegram Edge rejects legacy confirm_pub instead of publishing", () => {
  const start = source.indexOf('if (ctx.data.startsWith("confirm_pub:"))');
  const end = source.indexOf('if (ctx.data.startsWith("cancel_rev:"))', start);
  assert.ok(start >= 0 && end > start, "legacy confirm_pub rejection block must exist");
  const block = source.slice(start, end);

  assert.match(block, /TELEGRAM_CALLBACK_UNSUPPORTED_CONFIRM_PUB/);
  assert.doesNotMatch(block, /cerberus_telegram_publish_review/);
  assert.doesNotMatch(block, /\.rpc\(/);
});
