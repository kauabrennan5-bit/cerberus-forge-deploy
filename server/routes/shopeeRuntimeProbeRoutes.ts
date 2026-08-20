/**
 * INFRA-03 — Fase 15 — probe administrativa temporária Shopee.
 *
 * Esta superfície existe somente para uma validação operacional controlada.
 * Fronteiras absolutas:
 * - usa exclusivamente lookupProduct/productOfferV2;
 * - não usa aquisição, generateShortLink ou N3;
 * - não persiste candidate, evidence, assessment, link, job ou publicação;
 * - não retorna secrets, Authorization, Signature ou payload GraphQL bruto.
 *
 * A rota deve ser removida após a prova real autorizada.
 */
import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import type { ShopeeProductLookupResult } from "../commercial/affiliate/shopeeClientContracts";

export const SHOPEE_RUNTIME_PROBE_PATH = "/api/admin/shopee/readonly-product-offer";
export const SHOPEE_RUNTIME_PROBE_ITEM_ID = "23794344926";
export const SHOPEE_RUNTIME_PROBE_SHOP_ID = "1530442944";

export interface ShopeeRuntimeProbeRouteParams {
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

function safeErrorKind(result: ShopeeProductLookupResult): string | null {
  return result.error?.kind ?? null;
}

function buildSanitizedResult(
  result: ShopeeProductLookupResult,
): Record<string, unknown> {
  const returnedItemId = result.itemId;
  const returnedShopId = result.shopId;
  const identityConfirmed =
    result.status === "found" &&
    returnedItemId === SHOPEE_RUNTIME_PROBE_ITEM_ID &&
    returnedShopId === SHOPEE_RUNTIME_PROBE_SHOP_ID;
  const price = result.priceMinorUnits === null ? "UNKNOWN" : result.priceMinorUnits;
  const errorKind = safeErrorKind(result);

  const digestInput = {
    client_status: result.status,
    http_status: result.httpStatus,
    requested_item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID,
    returned_item_id: returnedItemId,
    requested_shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID,
    returned_shop_id: returnedShopId,
    identity_confirmed: identityConfirmed,
    title: result.name,
    price,
    error_kind: errorKind,
  };

  return {
    client_status: result.status,
    http_status: result.httpStatus,
    requested_item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID,
    returned_item_id: returnedItemId,
    requested_shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID,
    returned_shop_id: returnedShopId,
    identity_confirmed: identityConfirmed,
    title: result.name,
    price,
    observed_at: new Date().toISOString(),
    response_digest: safeDigest(digestInput),
    error_kind: errorKind,
  };
}

function validateProbePayload(body: unknown): { valid: true } | { valid: false; error: string } {
  if (!isPlainObject(body)) {
    return { valid: false, error: "payload deve ser um objeto JSON" };
  }
  if (body.item_id !== SHOPEE_RUNTIME_PROBE_ITEM_ID) {
    return { valid: false, error: "item_id não autorizado para esta prova controlada" };
  }
  if (body.shop_id !== SHOPEE_RUNTIME_PROBE_SHOP_ID) {
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

export function registerShopeeRuntimeProbeRoutes(params: ShopeeRuntimeProbeRouteParams): void {
  const { app, requireAdminAuth } = params;
  const createClient = params.createClient ?? createShopeeApiClient;

  app.post(SHOPEE_RUNTIME_PROBE_PATH, requireAdminAuth, async (req: Request, res: Response) => {
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
        requested_item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID,
        returned_item_id: null,
        requested_shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID,
        returned_shop_id: null,
        identity_confirmed: false,
        title: null,
        price: "UNKNOWN",
        observed_at: new Date().toISOString(),
        response_digest: safeDigest({
          client_status: "error",
          http_status: null,
          requested_item_id: SHOPEE_RUNTIME_PROBE_ITEM_ID,
          returned_item_id: null,
          requested_shop_id: SHOPEE_RUNTIME_PROBE_SHOP_ID,
          returned_shop_id: null,
          identity_confirmed: false,
          title: null,
          price: "UNKNOWN",
          error_kind: errorKind,
        }),
        error_kind: errorKind,
      });
    }

    // Exactly one client lookup. lookupProduct itself performs no retry and
    // no other operation is reachable from this route.
    const result = await client.lookupProduct({
      itemId: SHOPEE_RUNTIME_PROBE_ITEM_ID,
      shopId: SHOPEE_RUNTIME_PROBE_SHOP_ID,
    });
    const sanitized = buildSanitizedResult(result);
    return res.status(result.status === "error" ? 502 : 200).json(sanitized);
  });
}
