import type { Express, Request, Response } from "express";
import {
  N17_ACTION,
  type N17AcquireRequest,
  type N17Provenance,
} from "./n17Contract";
import { acquireN17Runtime } from "./n17Runtime";

type AdminAuth = (req: Request, res: Response, next: () => void) => void;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function asProvenance(value: unknown): N17Provenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    provider: asString(raw.provider) ?? "",
    marketplace: raw.marketplace as N17Provenance["marketplace"],
    method: raw.method as N17Provenance["method"],
    source_operation: asString(raw.source_operation) ?? "",
    source_url_origin: raw.source_url_origin as N17Provenance["source_url_origin"],
  };
}

function buildRequest(body: Record<string, unknown>): N17AcquireRequest {
  return {
    candidate_id: asString(body.candidate_id) ?? "",
    product_id: asNullableString(body.product_id),
    marketplace: body.marketplace as N17AcquireRequest["marketplace"],
    provider_id: asString(body.provider_id) ?? "",
    public_product_url: asString(body.public_product_url) ?? "",
    source_product_id: asNullableString(body.source_product_id),
    source_shop_id: asNullableString(body.source_shop_id),
    authorization_ref: asString(body.authorization_ref) ?? "",
    assessment_id: asNullableString(body.assessment_id),
    action: body.action as N17AcquireRequest["action"],
    idempotency_key: asString(body.idempotency_key) ?? "",
    provenance: asProvenance(body.provenance) ?? {
      provider: "",
      marketplace: body.marketplace as N17Provenance["marketplace"],
      method: "API",
      source_operation: "",
      source_url_origin: "official_provider",
    },
    tracking_context:
      body.tracking_context && typeof body.tracking_context === "object" && !Array.isArray(body.tracking_context)
        ? (body.tracking_context as Record<string, unknown>)
        : undefined,
    requested_at: asString(body.requested_at) ?? "",
  };
}

/**
 * N17 é um orquestrador governado: a rota apenas adapta HTTP ao contrato
 * fechado e delega toda a decisão ao runtime N15 → N17 → N8 → N6.
 */
export function registerN17Routes(app: Express, requireAdminAuth: AdminAuth): void {
  app.post("/api/commercial/affiliate/n17/acquire", requireAdminAuth, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
      const request = buildRequest(body);
      const result = await acquireN17Runtime(request);
      const successful = result.status === "ACQUIRED" || result.status === "ALREADY_ACQUIRED";
      return res.status(200).json({
        ok: successful,
        result,
        note: successful
          ? "N17 confirmou aquisição governada; publicação permanece fora do escopo."
          : "N17 bloqueou ou rejeitou a operação; nenhum bypass foi aplicado.",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "n17_route_error",
        detail: error instanceof Error ? error.message : "unknown",
      });
    }
  });
}

export const N17_ROUTE_ACTION = N17_ACTION;
