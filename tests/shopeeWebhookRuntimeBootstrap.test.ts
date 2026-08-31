import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  inspectShopeeProviderEnv,
  resolveShopeeProviderCredentials,
} from "../server/services/shopeeProviderRuntime";
import {
  handleTelegramWebhookUpdate,
  inspectTelegramAllowedUserIds,
} from "../server/services/telegramBot";

const originalAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("TELEGRAM_ALLOWED_USER_IDS", originalAllowed);
});

describe("Shopee provider bootstrap aliases", () => {
  it("prefere SHOPEE_APP_ID/SHOPEE_APP_SECRET via nullish e aplica trim", () => {
    const resolved = resolveShopeeProviderCredentials({
      SHOPEE_APP_ID: "  canonical-id  ",
      SHOPEE_APP_SECRET: "  canonical-secret  ",
      SHOPEE_AFFILIATE_APP_ID: "legacy-id",
      SHOPEE_AFFILIATE_APP_SECRET: "legacy-secret",
    });

    assert.deepEqual(resolved, {
      appId: "canonical-id",
      appSecret: "canonical-secret",
    });
  });

  it("usa aliases Affiliate somente quando os nomes canônicos são undefined", () => {
    const resolved = resolveShopeeProviderCredentials({
      SHOPEE_AFFILIATE_APP_ID: " legacy-id ",
      SHOPEE_AFFILIATE_APP_SECRET: " legacy-secret ",
    });

    assert.deepEqual(resolved, {
      appId: "legacy-id",
      appSecret: "legacy-secret",
    });
  });

  it("não mascara variável canônica vazia usando alias legado", () => {
    const env = {
      SHOPEE_APP_ID: "   ",
      SHOPEE_APP_SECRET: "canonical-secret",
      SHOPEE_AFFILIATE_APP_ID: "legacy-id",
      SHOPEE_AFFILIATE_APP_SECRET: "legacy-secret",
    };

    const resolved = resolveShopeeProviderCredentials(env);
    const status = inspectShopeeProviderEnv(env);

    assert.equal(resolved.appId, "");
    assert.equal(status.appIdConfigured, false);
    assert.equal(status.credentialsConfigured, false);
  });
});

describe("Telegram webhook runtime allowlist", () => {
  it("faz trim, parsing numérico e deduplicação sem expor IDs no status", () => {
    const status = inspectTelegramAllowedUserIds({
      TELEGRAM_ALLOWED_USER_IDS: " 123456 , 789012 , 123456 ",
    });

    assert.deepEqual(status, {
      configured: true,
      valid: true,
      parsedCount: 2,
      invalidCount: 0,
    });
    assert.equal(JSON.stringify(status).includes("123456"), false);
    assert.equal(JSON.stringify(status).includes("789012"), false);
  });

  it("falha fechado quando TELEGRAM_ALLOWED_USER_IDS está ausente", async () => {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    assert.deepEqual(inspectTelegramAllowedUserIds(process.env), {
      configured: false,
      valid: false,
      parsedCount: 0,
      invalidCount: 0,
    });

    await handleTelegramWebhookUpdate({ message: { from: { id: 123456 }, text: "/shopee luminária 2" } });
  });

  it("rejeita allowlist parcialmente malformada", () => {
    const status = inspectTelegramAllowedUserIds({
      TELEGRAM_ALLOWED_USER_IDS: "123456, abc, -7, 0",
    });

    assert.equal(status.configured, true);
    assert.equal(status.valid, false);
    assert.equal(status.parsedCount, 1);
    assert.equal(status.invalidCount, 3);
  });

  it("server.ts encaminha o webhook pela wrapper que valida o mesmo process.env", () => {
    const source = fs.readFileSync("server.ts", "utf8");
    assert.match(source, /handleTelegramWebhookUpdate\s*,\s*startTelegramPolling\s*}\s*from\s*["']\.\/server\/services\/telegramBot["']/);
    assert.match(source, /handleTelegramWebhookUpdate\s*\(\s*req\.body\s*\)/);
  });
});
