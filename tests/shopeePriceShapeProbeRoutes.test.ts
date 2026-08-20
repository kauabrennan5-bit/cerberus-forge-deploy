import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  registerShopeePriceShapeProbeRoutes,
  SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
  SHOPEE_PRICE_SHAPE_PROBE_PATH,
  SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
} from "../server/routes/shopeePriceShapeProbeRoutes";
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
  registerShopeePriceShapeProbeRoutes({
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

function foundResult(raw: unknown, priceMinorUnits: number | null = null): ShopeeProductLookupResult {
  return {
    status: "found",
    shopId: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
    itemId: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
    name: "Produto real de teste",
    priceMinorUnits,
    productLink: "https://shopee.com.br/product/1530442944/23794344926",
    httpStatus: 200,
    raw,
    error: null,
  };
}

function payload() {
  return { item_id: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID, shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID };
}

test("probe sem autenticação retorna 401 e não chama o cliente", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(null), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .send(payload());
  assert.equal(response.status, 401);
  assert.equal(tracker.calls, 0);
});

test("probe rejeita identidade fora do item autorizado e não chama o cliente", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult(null), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send({ item_id: "1", shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID });
  assert.equal(response.status, 400);
  assert.equal(response.body.client_status, "not_executed");
  assert.equal(tracker.calls, 0);
});

test("classifica price numérico sem retornar o valor e executa uma única lookup", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult({
    data: {
      productOfferV2: {
        nodes: [{ itemId: 23794344926, shopId: 1530442944, productName: "Produto", price: 1990 }],
      },
    },
  }, 1990), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send(payload());
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.client_status, "found");
  assert.equal(response.body.identity_confirmed, true);
  assert.equal(response.body.price_present, true);
  assert.equal(response.body.price_type, "number");
  assert.equal(response.body.price_is_finite, true);
  assert.equal(response.body.classification, "PRICE_SHAPE_CONFIRMED_NUMERIC");
  assert.equal("price" in response.body, false);
  assert.equal("raw" in response.body, false);
  assert.match(response.body.response_digest, /^[0-9a-f]{64}$/);
});

test("classifica price string sem coerção e sem retornar o valor", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult({
    data: {
      productOfferV2: {
        nodes: [{ itemId: "23794344926", shopId: "1530442944", price: "19.90" }],
      },
    },
  }), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send(payload());
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.price_present, true);
  assert.equal(response.body.price_type, "string");
  assert.equal(response.body.classification, "PRICE_SHAPE_CONFIRMED_NON_NUMERIC");
  assert.equal("price" in response.body, false);
});

test("classifica price object somente pelas chaves", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult({
    data: {
      productOfferV2: {
        nodes: [{ itemId: 23794344926, shopId: 1530442944, price: { amount: 1990, currency: "BRL" } }],
      },
    },
  }), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send(payload());
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.price_present, true);
  assert.equal(response.body.price_type, "object");
  assert.deepEqual(response.body.price_keys, ["amount", "currency"]);
  assert.equal(response.body.classification, "PRICE_SHAPE_CONFIRMED_NON_NUMERIC");
  assert.equal("price" in response.body, false);
});

test("classifica ausência de price como PRICE_NOT_RETURNED", async () => {
  const tracker = { calls: 0 };
  const response = await request(buildApp(foundResult({
    data: {
      productOfferV2: {
        nodes: [{ itemId: 23794344926, shopId: 1530442944 }],
      },
    },
  }), tracker))
    .post(SHOPEE_PRICE_SHAPE_PROBE_PATH)
    .set("x-admin-password", "testpass")
    .send(payload());
  assert.equal(response.status, 200);
  assert.equal(tracker.calls, 1);
  assert.equal(response.body.price_present, false);
  assert.equal(response.body.price_type, "undefined");
  assert.equal(response.body.classification, "PRICE_NOT_RETURNED");
});
