/**
 * INFRA-03 — Fase 17 — probe administrativa temporária do shape de price.
 *
 * Fronteiras absolutas:
 * - usa exclusivamente ShopeeApiClient.lookupProduct/productOfferV2;
 * - faz exatamente uma chamada por requisição válida;
 * - não usa aquisição, generateShortLink ou N3;
 * - não persiste candidate, evidence, assessment, link, job ou publicação;
 * - nunca retorna valor de price, raw GraphQL, headers ou secrets;
 * - deve ser removida após a prova real autorizada.
 */
import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import type { ShopeeProductLookupResult } from "../commercial/affiliate/shopeeClientContracts";

export const SHOPEE_PRICE_SHAPE_PROBE_PATH = "/api/admin/shopee/readonly-price-shape";
export const SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID = "23794344926";
export const SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID = "1530442944";

export interface ShopeePriceShapeProbeRouteParams {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
  createClient?: typeof createShopeeApiClient;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function findMatchedRawNode(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const data = raw.data;
  if (!isPlainObject(data)) return null;
  const offer = data.productOfferV2;
  if (!isPlainObject(offer) || !Array.isArray(offer.nodes)) return null;
  for (const candidate of offer.nodes) {
    if (!isPlainObject(candidate)) continue;
    const itemId = normalizeIdentifier(candidate.itemId);
    const shopId = normalizeIdentifier(candidate.shopId);
    if (
      itemId === SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID &&
      shopId === SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID
    ) {
      return candidate;
    }
  }
  return null;
}

type PriceShape = "number" | "string" | "object" | "array" | "null" | "undefined";

type SanitizedPriceShape = {
  price_present: boolean;
  price_type: PriceShape;
  price_keys: string[];
  price_is_finite?: boolean;
  classification: "PRICE_SHAPE_CONFIRMED_NUMERIC" | "PRICE_SHAPE_CONFIRMED_NON_NUMERIC" | "PRICE_NOT_RETURNED" | "PRICE_SHAPE_UNRESOLVED";
};

function inspectPriceShape(raw: unknown): SanitizedPriceShape {
  const matchedNode = findMatchedRawNode(raw);
  if (!matchedNode) {
    return {
      price_present: false,
      price_type: "undefined",
      price_keys: [],
      classification: "PRICE_SHAPE_UNRESOLVED",
    };
  }

  const pricePresent = Object.prototype.hasOwnProperty.call(matchedNode, "price");
  if (!pricePresent) {
    return {
      price_present: false,
      price_type: "undefined",
      price_keys: [],
      classification: "PRICE_NOT_RETURNED",
    };
  }

  const price = matchedNode.price;
  if (price === null) {
    return {
      price_present: true,
      price_type: "null",
      price_keys: [],
      classification: "PRICE_NOT_RETURNED",
    };
  }
  if (typeof price === "number") {
    return {
      price_present: true,
      price_type: "number",
      price_keys: [],
      price_is_finite: Number.isFinite(price),
      classification: "PRICE_SHAPE_CONFIRMED_NUMERIC",
    };
  }
  if (typeof price === "string") {
    return {
      price_present: true,
      price_type: "string",
      price_keys: [],
      classification: "PRICE_SHAPE_CONFIRMED_NON_NUMERIC",
    };
  }
  if (Array.isArray(price)) {
    return {
      price_present: true,
      price_type: "array",
      price_keys: [],
      classification: "PRICE_SHAPE_CONFIRMED_NON_NUMERIC",
    };
  }
  return {
    price_present: true,
    price_type: "object",
    price_keys: Object.keys(price as Record<string, unknown>).sort(),
    classification: "PRICE_SHAPE_CONFIRMED_NON_NUMERIC",
  };
}

function validateProbePayload(body: unknown): { valid: true } | { valid: false; error: string } {
  if (!isPlainObject(body)) {
    return { valid: false, error: "payload deve ser um objeto JSON" };
  }
  if (body.item_id !== SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID) {
    return { valid: false, error: "item_id não autorizado para esta prova controlada" };
  }
  if (body.shop_id !== SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID) {
    return { valid: false, error: "shop_id não autorizado para esta prova controlada" };
  }
  return { valid: true };
}

function createClientFromRuntime(createClient: typeof createShopeeApiClient): ShopeeApiClient {
  return createClient({
    appId: (process.env.SHOPEE_APP_ID || process.env.SHOPEE_AFFILIATE_APP_ID || "").trim(),
    secret: (process.env.SHOPEE_APP_SECRET || process.env.SHOPEE_AFFILIATE_APP_SECRET || "").trim(),
    baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL?.trim() || undefined,
  });
}

function buildSanitizedResult(result: ShopeeProductLookupResult): Record<string, unknown> {
  const shape = inspectPriceShape(result.raw);
  const returnedItemId = result.itemId;
  const returnedShopId = result.shopId;
  const identityConfirmed =
    result.status === "found" &&
    returnedItemId === SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID &&
    returnedShopId === SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID;
  const errorKind = result.error?.kind ?? null;
  const digestInput = {
    client_status: result.status,
    http_status: result.httpStatus,
    requested_item_id: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
    returned_item_id: returnedItemId,
    requested_shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
    returned_shop_id: returnedShopId,
    identity_confirmed: identityConfirmed,
    price_present: shape.price_present,
    price_type: shape.price_type,
    price_keys: shape.price_keys,
    price_is_finite: shape.price_is_finite ?? null,
    classification: shape.classification,
    error_kind: errorKind,
  };
  return {
    client_status: result.status,
    http_status: result.httpStatus,
    requested_item_id: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
    returned_item_id: returnedItemId,
    requested_shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
    returned_shop_id: returnedShopId,
    identity_confirmed: identityConfirmed,
    ...shape,
    observed_at: new Date().toISOString(),
    response_digest: safeDigest(digestInput),
    error_kind: errorKind,
  };
}

export function registerShopeePriceShapeProbeRoutes(params: ShopeePriceShapeProbeRouteParams): void {
  const { app, requireAdminAuth } = params;
  const createClient = params.createClient ?? createShopeeApiClient;
  app.post(SHOPEE_PRICE_SHAPE_PROBE_PATH, requireAdminAuth, async (req: Request, res: Response) => {
    const payload = validateProbePayload(req.body);
    if (payload.valid === false) {
      return res.status(400).json({
        client_status: "not_executed",
        error_kind: "INVALID_PROBE_PAYLOAD",
        error: payload.error,
      });
    }

    let client: ShopeeApiClient;
    try {
      client = createClientFromRuntime(createClient);
    } catch (error) {
      const errorKind = error && typeof error === "object" && "kind" in error
        ? String((error as { kind?: unknown }).kind ?? "SHOPEE_UNKNOWN_ERROR")
        : "SHOPEE_UNKNOWN_ERROR";
      return res.status(503).json({
        client_status: "error",
        http_status: null,
        requested_item_id: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
        returned_item_id: null,
        requested_shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
        returned_shop_id: null,
        identity_confirmed: false,
        price_present: false,
        price_type: "undefined",
        price_keys: [],
        classification: "PRICE_SHAPE_UNRESOLVED",
        observed_at: new Date().toISOString(),
        response_digest: safeDigest({
          client_status: "error",
          http_status: null,
          requested_item_id: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
          returned_item_id: null,
          requested_shop_id: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
          returned_shop_id: null,
          identity_confirmed: false,
          price_present: false,
          price_type: "undefined",
          price_keys: [],
          classification: "PRICE_SHAPE_UNRESOLVED",
          error_kind: errorKind,
        }),
        error_kind: errorKind,
      });
    }

    // Exactly one lookupProduct call. No acquisition or short-link operation is reachable.
    const result = await client.lookupProduct({
      itemId: SHOPEE_PRICE_SHAPE_PROBE_ITEM_ID,
      shopId: SHOPEE_PRICE_SHAPE_PROBE_SHOP_ID,
    });
    const sanitized = buildSanitizedResult(result);
    return res.status(result.status === "error" ? 502 : 200).json(sanitized);
  });
}
