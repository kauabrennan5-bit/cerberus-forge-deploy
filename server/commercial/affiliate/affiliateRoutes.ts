// ============================================================================
// Bloco N6 — Affiliate Economics + Link Resolution — Rotas administrativas
//
// ROTAS:
//   POST /api/commercial/affiliate/providers   — registrar provider
//   GET  /api/commercial/affiliate/providers   — listar providers (cockpit)
//   GET  /api/commercial/affiliate/providers/:id — obter provider
//   POST /api/commercial/affiliate/links       — registrar link
//   GET  /api/commercial/affiliate/links       — listar por candidate_id|product_id|provider_id
//   GET  /api/commercial/affiliate/links/:id   — obter link
//   POST /api/commercial/affiliate/links/:id/validate — validar link
//   POST /api/commercial/affiliate/links/:id/revoke   — revogar link (humano)
//
// GOVERNANÇA:
//   - Todas exigem x-admin-password (admin-only, fail-closed).
//   - REGISTER != VALIDATE != APPROVE != EXECUTE: nenhuma rota publica
//     produto, promove candidato, cria job, habilita agente ou executa
//     ação externa. A publicação continua exclusiva do N5
//     (DECISION + Policy Engine + ApprovalStore).
//   - validate NÃO é autorização de publicação: apenas muda
//     validation_state do link (com política exigida, ver abaixo).
//   - AFFILIATE LINK != AUTHORITY: um link VALID não executa nada sozinho.
// ============================================================================
import type { Express, Request, Response } from "express";
import {
  AFFILIATE_MARKETPLACES,
  LINK_PROVENANCES,
  PROVIDER_STATUSES,
  type AffiliateMarketplace,
  type LinkProvenance,
  type ProviderStatus,
  type RegisterLinkInput,
  type RegisterProviderInput,
} from "./contract";
import {
  persistLink,
  persistProvider,
  getLink,
  getProvider,
  listLinksByCandidate,
  listLinksByProduct,
  listLinksByProvider,
  listProviders,
  recordLinkValidation,
  revokeLink,
} from "./affiliateRepository";
import { validateAffiliateLink } from "./affiliateValidator";

type AdminAuth = (req: Request, res: Response, next: () => void) => void;

function adminError(res: Response, status: number, error: string, detail?: unknown): Response {
  return res.status(status).json({ ok: false, error, ...(detail !== undefined ? { detail } : {}) });
}

function adminSuccess(res: Response, payload: Record<string, unknown>): Response {
  return res.status(200).json({ ok: true, ...payload });
}

function normalizeMarketplace(raw: unknown): AffiliateMarketplace | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim() as AffiliateMarketplace;
  if ((AFFILIATE_MARKETPLACES as ReadonlyArray<string>).includes(value)) return value;
  // Normalização amigável (não autoriza nada novo): "Shopee" → "Shopee",
  // "MercadoLivre" | "Mercado Livre" → "MercadoLivre".
  if (raw === "Mercado Livre") return "MercadoLivre";
  return null;
}

export function registerAffiliateRoutes(
  app: Express,
  requireAdminAuth: AdminAuth,
): void {
  const admin: AdminAuth = requireAdminAuth;

  // ------------------------------------------------------------------
  // Providers — registro e leitura (cockpit admin-only)
  // ------------------------------------------------------------------
  app.post("/api/commercial/affiliate/providers", admin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<RegisterProviderInput>;
      const marketplace = normalizeMarketplace(body.marketplace);
      if (!marketplace) return adminError(res, 400, "marketplace_invalid", body.marketplace);
      const status = typeof body.status === "string"
        ? (PROVIDER_STATUSES as ReadonlyArray<string>).includes(body.status)
          ? (body.status as ProviderStatus)
          : undefined
        : undefined;
      const input: RegisterProviderInput = {
        provider_code: typeof body.provider_code === "string" ? body.provider_code : "",
        name: typeof body.name === "string" ? body.name : "",
        marketplace,
        program_name: typeof body.program_name === "string" ? body.program_name : undefined,
        status,
        resolution_method: body.resolution_method === "MANUAL" ? "MANUAL" : undefined,
        credential_ref: typeof body.credential_ref === "string" ? body.credential_ref : undefined,
        terms_url: typeof body.terms_url === "string" ? body.terms_url : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
        metadata: body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : undefined,
      };
      const result = await persistProvider(input);
      if (!result.ok) {
        return adminError(res, 400, "provider_registration_failed", result.reason);
      }
      return adminSuccess(res, {
        result: result.result,
        provider: result.record,
        note: "Provider registrado. O registro NÃO equivale a adesão efetiva ao programa de afiliados — a adesão é sempre humana e externa ao sistema.",
      });
    } catch (error) {
      return adminError(res, 500, "provider_registration_error", error instanceof Error ? error.message : "unknown");
    }
  });

  app.get("/api/commercial/affiliate/providers", admin, async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const providers = await listProviders(status ? { status } : undefined);
      return adminSuccess(res, { providers });
    } catch (error) {
      return adminError(res, 500, "providers_list_error", error instanceof Error ? error.message : "unknown");
    }
  });

  app.get("/api/commercial/affiliate/providers/:id", admin, async (req, res) => {
    try {
      const provider = await getProvider(req.params.id);
      if (!provider) return adminError(res, 404, "provider_not_found");
      return adminSuccess(res, { provider });
    } catch (error) {
      return adminError(res, 500, "provider_get_error", error instanceof Error ? error.message : "unknown");
    }
  });

  // ------------------------------------------------------------------
  // Links — registro, leitura, validação e revogação
  // ------------------------------------------------------------------
  app.post("/api/commercial/affiliate/links", admin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<RegisterLinkInput>;
      const marketplace = normalizeMarketplace(body.marketplace);
      if (!marketplace) return adminError(res, 400, "marketplace_invalid", body.marketplace);
      const provenance = typeof body.provenance === "string" ? body.provenance as LinkProvenance : undefined;
      // Proveniência fechada: qualquer valor diferente de admin:manual é
      // rejeitado aqui (fail-closed).
      if (provenance !== undefined && !(LINK_PROVENANCES as ReadonlyArray<string>).includes(provenance)) {
        return adminError(res, 400, "provenance_not_allowed", body.provenance);
      }
      const input: RegisterLinkInput = {
        candidate_id: typeof body.candidate_id === "string" ? body.candidate_id : null,
        product_id: typeof body.product_id === "string" ? body.product_id : null,
        marketplace,
        provider_id: typeof body.provider_id === "string" ? body.provider_id : "",
        affiliate_url: typeof body.affiliate_url === "string" ? body.affiliate_url : "",
        provenance,
        expires_at: typeof body.expires_at === "string" ? body.expires_at : null,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        idempotency_key: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
        metadata: body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : undefined,
      };
      const result = await persistLink(input);
      if (!result.ok) {
        return adminError(res, 400, "link_registration_failed", result.reason);
      }
      return adminSuccess(res, {
        result: result.result,
        link: result.record,
        note: "Link registrado como DRAFT/UNVALIDATED. Registro NÃO autoriza publicação — a publicação exige DECISION + Policy Engine + ApprovalStore (N5).",
      });
    } catch (error) {
      return adminError(res, 500, "link_registration_error", error instanceof Error ? error.message : "unknown");
    }
  });

  app.get("/api/commercial/affiliate/links", admin, async (req, res) => {
    try {
      const candidateId = typeof req.query.candidate_id === "string" ? req.query.candidate_id : null;
      const productId = typeof req.query.product_id === "string" ? req.query.product_id : null;
      const providerId = typeof req.query.provider_id === "string" ? req.query.provider_id : null;
      let links: Awaited<ReturnType<typeof listLinksByCandidate>> = [];
      if (candidateId) {
        links = await listLinksByCandidate(candidateId);
      } else if (productId) {
        links = await listLinksByProduct(productId);
      } else if (providerId) {
        links = await listLinksByProvider(providerId);
      } else {
        return adminError(res, 400, "missing_filter", "informe candidate_id, product_id ou provider_id");
      }
      return adminSuccess(res, { links });
    } catch (error) {
      return adminError(res, 500, "links_list_error", error instanceof Error ? error.message : "unknown");
    }
  });

  app.get("/api/commercial/affiliate/links/:id", admin, async (req, res) => {
    try {
      const link = await getLink(req.params.id);
      if (!link) return adminError(res, 404, "link_not_found");
      return adminSuccess(res, { link });
    } catch (error) {
      return adminError(res, 500, "link_get_error", error instanceof Error ? error.message : "unknown");
    }
  });

  // Validação: muda validation_state do link. NÃO é autorização de
  // publicação (REGISTER != VALIDATE != APPROVE != EXECUTE).
  app.post("/api/commercial/affiliate/links/:id/validate", admin, async (req, res) => {
    try {
      const link = await getLink(req.params.id);
      if (!link) return adminError(res, 404, "link_not_found");
      if (link.status === "REVOKED") {
        return adminError(res, 400, "link_revoked", "link revogado não pode ser validado");
      }
      const allowLiveCheck = req.body?.allow_live_check !== false;
      const outcome = await validateAffiliateLink(link, { allowLiveCheck });
      const persisted = await recordLinkValidation(link.link_id, outcome);
      if (!persisted.ok) {
        return adminError(res, 500, "validation_persist_failed", persisted.reason);
      }
      return adminSuccess(res, {
        link: persisted.record,
        validation: outcome,
        note: "VALID != AUTHORITY: a validação NÃO autoriza publicação. A publicação exige DECISION + Policy Engine + ApprovalStore (N5).",
      });
    } catch (error) {
      return adminError(res, 500, "validation_error", error instanceof Error ? error.message : "unknown");
    }
  });

  // Revogação: ato humano explícito; histórico preservado.
  app.post("/api/commercial/affiliate/links/:id/revoke", admin, async (req, res) => {
    try {
      const result = await revokeLink(req.params.id);
      if (!result.ok) return adminError(res, 500, "revoke_failed", result.reason);
      return adminSuccess(res, { link: result.record, note: "Link revogado. Histórico preservado." });
    } catch (error) {
      return adminError(res, 500, "revoke_error", error instanceof Error ? error.message : "unknown");
    }
  });
}
