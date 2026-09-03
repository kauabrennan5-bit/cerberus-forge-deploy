import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  setTestTelegramSenders,
} from "../server/services/telegramBot";

function telegramResponse(status: number, payload: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe("Telegram truthful delivery", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN_FOR_UNIT_TESTS";
    setTestTelegramSenders(null, null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
    setTestTelegramSenders(null, null);
  });

  it("sendMessage HTTP 200 com ok:false retorna falha lógica", async () => {
    globalThis.fetch = async () => telegramResponse(200, { ok: false, description: "Bad Request: message rejected" });
    const result = await sendTelegramMessage(1, "teste");
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, "Bad Request: message rejected");
  });

  it("sendPhoto HTTP 200 com ok:false retorna falha lógica", async () => {
    globalThis.fetch = async () => telegramResponse(200, { ok: false, description: "Bad Request: photo rejected" });
    const result = await sendTelegramPhoto(1, "https://img.test/photo.webp", "teste");
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, "Bad Request: photo rejected");
  });

  it("erro HTTP retorna falha explícita mesmo sem payload JSON legível", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error("invalid json"); } }) as unknown as Response;
    const result = await sendTelegramMessage(1, "teste");
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, "telegram_http_502");
  });

  it("timeout ou erro de transporte retorna falha explícita", async () => {
    globalThis.fetch = async () => { throw new DOMException("request timeout", "AbortError"); };
    const result = await sendTelegramPhoto(1, "https://img.test/photo.webp", "teste");
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, "TELEGRAM_TIMEOUT");
  });

  it("não registra chat_id não numérico no log", async () => {
    const logLines: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
    const tokenLikeChatId = "123456:TEST_TOKEN_SHOULD_NOT_APPEAR";
    try {
      globalThis.fetch = async () => telegramResponse(200, { ok: false, description: "Forbidden" });
      const result = await sendTelegramMessage(tokenLikeChatId, "teste");
      assert.equal(result.ok, false);
      assert.equal(logLines.some(line => line.includes("chat_id=[REDACTED_NON_NUMERIC_CHAT_ID]")), true);
      assert.equal(logLines.some(line => line.includes(tokenLikeChatId)), false);
    } finally {
      console.info = originalInfo;
    }
  });
});
