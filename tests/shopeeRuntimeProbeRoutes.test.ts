import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  registerShopeeRuntimeProbeRoutes,
  SHOPEE_RUNTIME_PROBE_ITEM_ID,
  SHOPEE_RUNTIME_PROBE_PATH,
  SHOPEE_RUNTIME_PROBE_SHOP_ID,
} from "../server/routes/shopeeRuntimeProbeRoutes";
import type { ShopeeProductLookupResult } from "../server/commercial/affiliate/shopeeClientContracts";

function buildApp(
  result: ShopeeProductLookupResult,
  tracker: { calls: number },
): express.Express {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.headers["x-admin-password"] === "testpass") return next();
    return res.status(401).json({ error: "unauthorized" });
  };
  registerShopeeRuntimeProbeRoutes({
    app,
    requireAdminAuth,
    createClient: (() => ({
      lookupProduct: async () => {
        tracker.calls += 1;
        return result;
      },
      acquireAffiliateLink: async () => {
        throw new Error("must not be called");
      },
      generateShortLink: async () => {
        throw new Error("must not be called");
      },
    })) as never,
  });
  return app;
}

function foundResult(priceMinorUnits: number | null): ShopeeProductLookupResult {
  return {
    status: "found",
    shopId: SHOPEE_RUNTIME_PROBE_SHOP_ID,
    itemId: SHOPEE_RUNTIME_PROBE_ITEM_ID,
    name: "Produto real de teste",
    priceMinorUnits,
    productLink: "https://shopee.com.br/product/1530442944/23794344926",
    httpStatus: 200,
    raw: { data: { secret_like_field: "never returned" } },
    error: null,
  };
}

test("probe sem autenticação retorna 401 e não chama o cliente", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(1990), tracker))
    .post(SHOPEE_RUNTIME_PROBE_PATH)
    .send({ item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID, shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID });
  assert.equal(response.status, 401);
  assert.equal(tracker.calls, 0);
});

test("probe rejeita qualquer item ou shop fora da prova autorizada", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(1990), tracker))
    .post(SHOPEE_RUNTIME_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send({ item_id: "1", shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID });
  assert.equal(response.status, 400);
  assert.equal(response.body.client_status, "not_executed");
  assert.equal(tracker.calls, 0);
});

test("probe faz uma única lookup, preserva price observado e não expõe raw", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(1990), tracker))
    .post(SHOPEE_RUNTIME_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send({ item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID, shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID });
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.client_status, "found");
  assert.equal(response.body.http_status, 200);
  assert.equal(response.body.returned_item_id, SHOPEE_RUNTIME_PROBE_ITEM_ID);
  assert.equal(response.body.returned_shop_id, SHOPEE_RUNTIME_PROBE_SHOP_ID);
  assert.equal(response.body.identity_confirmed, true);
  assert.equal(response.body.title, "Produto real de teste");
  assert.equal(response.body.price, 1990);
  assert.match(response.body.response_digest, /^[0-9a-f]{64}$/);
  assert.match(response.body.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal("raw" in response.body, false);
  assert.equal("secret_like_field" in response.body, false);
});

test("probe mantém price UNKNOWN quando o cliente não observou valor", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(null), tracker))
    .post(SHOPEE_RUNTIME_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send({ item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID, shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID });
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.price, "UNKNOWN");
  assert.equal(response.body.identity_confirmed, true);
});

test("probe retorna erro catalogado sem chamar aquisição ou gerar link", async () => {
  const tracker = { calls: 0 };
  const result: ShopeeProductLookupResult = {
    status: "error",
    shopId: null,
    itemId: null,
    name: null,
    priceMinorUnits: null,
    productLink: null,
    httpStatus: 401,
    raw: null,
    error: {
      name: "ShopeeClientError",
      message: "shopee_client_error:SHOPEE_AUTH_ERROR",
      kind: "SHOPEE_AUTH_ERROR",
      detail: "http_401",
      httpStatus: 401,
    } as never,
  };
  const response = await request(buildApp(result, tracker))
    .post(SHOPEE_RUNTIME_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send({ item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID, shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID });
  assert.equal(response.status, 502);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.client_status, "error");
  assert.equal(response.body.error_kind, "SHOPEE_AUTH_ERROR");
  assert.equal(response.body.price, "UNKNOWN");
  assert.equal("message" in response.body, false);
});
