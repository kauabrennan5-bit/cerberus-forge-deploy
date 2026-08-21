import test from "node:test";
import express from "express";
import supertest from "supertest";
import { PendingReview } from "../server/services/telegramBot";
import { setTestSavePendingReview, setTestGetPendingReview } from "../server/repositories/telegramRepository";

const origFetch = globalThis.fetch;
let log: string[] = [];
globalThis.fetch = (async (input: any) => {
  log.push(String(input));
  if (String(input).includes("api.telegram.org")) {
    return { status: 200, ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }), text: async () => "{}" };
  }
  if (String(input).includes("open-api.affiliate")) {
    return { status: 200, ok: true, json: async () => ({ data: { productOfferV2: { nodes: [{ itemId: "23794344926", shopId: "1530442944", productName: "X", price: 99, productLink: "https://shopee.com.br/x-i.1530442944.23794344926", offerLink: "https://shope.ee/abc" }] } } }), text: async () => "{}" };
  }
  return origFetch(input);
}) as any;

test.beforeEach(() => {
  process.env.SHOPEE_APP_ID = "id"; process.env.SHOPEE_APP_SECRET = "sec";
  process.env.ADMIN_PASSWORD = "p"; process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "tok";
});
test.afterEach(() => { globalThis.fetch = origFetch; });

import { setupPreviewTelegramRoutes } from "../server/routes/previewTelegramRoutes";
test("probe", async () => {
  setTestSavePendingReview(async () => {});
  const app = express(); app.use(express.json());
  setupPreviewTelegramRoutes({ app, requireAdminAuth: (req, res, next) => next() });
  const res = await supertest(app).post("/api/commercial/preview-telegram").set("Content-Type","application/json").set("x-admin-password","p").send({ url: "https://shopee.com.br/x-i.1530442944.23794344926" });
  console.log("STATUS:", res.status, "BODY:", JSON.stringify(res.body));
  console.log("FETCHLOG:", log);
});
