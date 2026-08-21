import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import { setTestSavePendingReview, setTestGetPendingReview } from "../server/repositories/telegramRepository";
import { setupPreviewTelegramRoutes } from "../server/routes/previewTelegramRoutes";

const origFetch = globalThis.fetch;
let affiliateScenario: any = null;
let log: string[] = [];
function install(scenario: any) {
  affiliateScenario = scenario; log = [];
  globalThis.fetch = (async (input: any) => {
    log.push(String(input));
    if (String(input).includes("api.telegram.org")) return { status: 200, ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }), text: async () => "{}" };
    if (String(input).includes("open-api.affiliate")) return { status: scenario.httpStatus ?? 200, ok: true, json: async () => ({ data: { productOfferV2: { nodes: scenario.nodes } } }), text: async () => "{}" };
    return origFetch(input);
  }) as any;
}

const ADMIN = "p";
test.beforeEach(() => {
  process.env.SHOPEE_APP_ID = "id"; process.env.SHOPEE_APP_SECRET = "sec";
  process.env.ADMIN_PASSWORD = ADMIN; process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.TELEGRAM_BOT_TOKEN = "tok";
});
test.afterEach(() => { globalThis.fetch = origFetch; setTestSavePendingReview(null); setTestGetPendingReview(null); });

test("t1", async () => {
  install({ status: "link_acquired", nodes: [{ itemId: "23794344926", shopId: "1530442944", productName: "X", price: 99, productLink: "https://shopee.com.br/x-i.1530442944.23794344926", offerLink: "https://shope.ee/abc" }], httpStatus: 200 });
  setTestSavePendingReview(async () => {});
  const app = express(); app.use(express.json());
  setupPreviewTelegramRoutes({ app, requireAdminAuth: (req, res, next) => next() });
  const res = await supertest(app).post("/api/commercial/preview-telegram").set("Content-Type","application/json").set("x-admin-password",ADMIN).send({ url: "https://shopee.com.br/x-i.1530442944.23794344926" });
  console.log("t1 log:", log);
});
test("t2", async () => {
  install({ status: "link_acquired", nodes: [{ itemId: "23794344926", shopId: "1530442944", productName: "X", price: 99, productLink: "https://shopee.com.br/x-i.1530442944.23794344926", offerLink: "https://shope.ee/abc" }], httpStatus: 200 });
  setTestSavePendingReview(async () => {});
  const app = express(); app.use(express.json());
  setupPreviewTelegramRoutes({ app, requireAdminAuth: (req, res, next) => next() });
  const res = await supertest(app).post("/api/commercial/preview-telegram").set("Content-Type","application/json").set("x-admin-password",ADMIN).send({ url: "https://shopee.com.br/x-i.1530442944.23794344926" });
  console.log("t2 log:", log, "status:", res.status);
});
