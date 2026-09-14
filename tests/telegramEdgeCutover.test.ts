import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const edge = readFileSync(new URL("../supabase/functions/cerberus-telegram-cutover/index.ts", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/telegram-edge-cutover-v2.yml", import.meta.url), "utf8");
const target = "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-telegram-gateway/webhook";

test("cutover utility keeps Telegram webhook secret inside Supabase Edge", () => {
  assert.match(edge, /Deno\.env\.get\("TELEGRAM_WEBHOOK_SECRET"\)/);
  assert.match(edge, /Deno\.env\.get\("TELEGRAM_BOT_TOKEN"\)/);
  assert.match(edge, /Authorization|authorization/);
  assert.match(edge, /setWebhook/);
  assert.match(edge, /getWebhookInfo/);
  assert.match(edge, /drop_pending_updates:\s*false/);
  assert.match(edge, /allowed_updates:\s*\["message", "callback_query"\]/);
  assert.ok(edge.includes(target));
});

test("GitHub cutover uses only the bot credential and never exports the webhook secret", () => {
  assert.match(workflow, /secrets\.TELEGRAM_BOT_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.TELEGRAM_WEBHOOK_SECRET/);
  assert.match(workflow, /cerberus-telegram-cutover/);
  assert.match(workflow, /TELEGRAM_EDGE_SECRET_GATE=PASS/);
  assert.match(workflow, /TELEGRAM_EDGE_CUTOVER=PASS/);
  assert.ok(workflow.includes(target));
});
