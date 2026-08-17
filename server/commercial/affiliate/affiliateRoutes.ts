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
  validateProviderId,
} from "./affiliateRepository";
import { validateAffiliateLink } from "./affiliateValidator";
import {
  acquireAffiliateLink,
  getAffiliateApiSource,
  validateManualUrl,
  AFFILIATE_ACQUIRER_CONTRACT_VERSION,
} from "./acquisitionService";

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

  // ------------------------------------------------------------------
  // Bloco N8 — Aquisição de link de afiliado (ACQUISITION != REGISTRATION).
  //   POST /api/commercial/affiliate/acquire
  //
  // Caminhos:
  //   (a) SEM affiliate_url → aquisição via mecanismo oficial (API): exige
  //       provider ACTIVE + credenciais oficiais configuradas (fonte API
  //       injetada no bootstrap). Sem isso → AUTH_REQUIRED (fail-closed,
  //       nunca tenta endpoint inventado).
  //   (b) COM affiliate_url → manual assistido: o operador submetre o link
  //       obtido pelo mecanismo oficial (UI do portal/Gerador de Links);
  //       validado contra o whitelist de hosts oficiais, registrado
  //       idempotentemente via N6 (persistLink) com metadata de aquisição.
  //
  // Governança:
  //   - ACQUISITION != REGISTRATION != RESOLUTION != PUBLICATION.
  //   - O link é gravado como DRAFT/UNVALIDATED com provenance "admin:manual"
  //     (única gravável sem migration); o metadata registra acquisition_ref
  //     para auditoria. Provenance "admin:acquired" exigirá migration.
  //   - A URL EXATA é preservada; nunca é normalizada/derivada.
  //   - Registro NÃO autoriza publicação (N5 continua a autoridade).
  // ------------------------------------------------------------------
  app.post("/api/commercial/affiliate/acquire", admin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const providerId = typeof body.provider_id === "string" ? body.provider_id : "";
      if (!providerId) return adminError(res, 400, "provider_id_required");
      if (!validateProviderId(providerId)) return adminError(res, 400, "provider_id_invalid");

      const marketplace = normalizeMarketplace(body.marketplace);
      if (!marketplace) return adminError(res, 400, "marketplace_invalid", body.marketplace);

      const publicUrl = typeof body.public_url === "string" ? body.public_url : "";
      if (!publicUrl) return adminError(res, 400, "public_url_required");
      const reference = {
        marketplace,
        publicUrl,
        productId: typeof body.product_id === "string" ? body.product_id : null,
        candidateId: typeof body.candidate_id === "string" ? body.candidate_id : null,
      };

      const provider = await getProvider(providerId);
      if (!provider) return adminError(res, 404, "provider_not_found");
      if (provider.marketplace !== marketplace) {
        return adminError(res, 400, "provider_marketplace_mismatch");
      }

      const operatorProvidedUrl = typeof body.affiliate_url === "string" && body.affiliate_url.length > 0
        ? body.affiliate_url
        : null;

      // (a) Aquisição via mecanismo oficial (3B).
      if (!operatorProvidedUrl) {
        const result = await acquireAffiliateLink({
          provider,
          reference,
          apiSource: getAffiliateApiSource(),
        });
        if (result.kind === "AUTH_REQUIRED") return adminError(res, 401, "acquisition_auth_required", result.reason);
        if (result.kind === "NOT_SUPPORTED") return adminError(res, 405, "acquisition_not_supported", result.marketplace);
        if (result.kind === "PROVIDER_NOT_ACTIVE") return adminError(res, 409, "provider_not_active");
        // PATCH DE CONTRATO: identidade incerta é estado explícito —
        // nunca declarado como sucesso confirmado; o preview preserva a
        // evidência e o rationale (rastreado) e a rota registra a decisão.
        if (result.kind === "IDENTITY_UNCERTAIN") {
          return adminSuccess(res, {
            acquisition: {
              state: "IDENTITY_UNCERTAIN",
              acquisitionRef: result.acquisitionRef,
              affiliateUrl: result.affiliateUrl,
              method: result.method,
              identityConfidence: result.identityConfidence,
              identity: result.identity,
              rationale: result.rationale,
              rawResponse: result.rawResponse,
              acquiredAt: new Date(result.acquiredAt).toISOString(),
            },
            note: "Aquisição com identidade NÃO confirmada — o link foi obtido, mas NUNCA é tratado como aquisição confirmada e não é elegível para publicação baseada apenas nessa identidade (fail-closed).",
          });
        }
        if (result.kind !== "SUCCESS") return adminError(res, 424, "acquisition_failed", result.reason);
        return adminSuccess(res, {
          acquisition: {
            state: "SUCCESS",
            acquisitionRef: result.acquisitionRef,
            affiliateUrl: result.affiliateUrl,
            method: result.method,
            identityConfidence: result.identityConfidence,
            identity: result.identity,
            rawResponse: result.rawResponse,
            acquiredAt: new Date(result.acquiredAt).toISOString(),
          },
          note: "Aquisição obtida do mecanismo oficial com identidade CONFIRMADA. Para GRAVAR no registry, reenvie esta URL como affiliate_url (caminho manual assistido) — o registro segue o contrato N6 (DRAFT/UNVALIDATED) e NÃO autoriza publicação.",
        });
      }

      // (b) Manual assistido (3D): valida o link EXATO contra o whitelist oficial.
      // PATCH DE CONTRATO: o caminho manual SEMPRE resulta em
      // IDENTITY_UNCERTAIN (não existe mecanismo oficial de confirmação)
      // — o link é registrado normalmente pelo contrato N6 (DRAFT/UNVALIDATED)
      // com o estado explícito, preservando evidência e rationale.
      const result = validateManualUrl({ provider, reference, url: operatorProvidedUrl });
      // PATCH DE CONTRATO: o caminho manual assistido SEMPRE resulta em
      // IDENTITY_UNCERTAIN (sem mecanismo oficial de confirmação). O link
      // é registrado pelo contrato N6 (DRAFT/UNVALIDATED) com estado
      // explícito IDENTITY_UNCERTAIN + rationale — evidência preservada,
      // mas JAMAIS elegível para publicação como identidade confirmada.
      if (result.kind !== "SUCCESS" && result.kind !== "IDENTITY_UNCERTAIN") {
        return adminError(res, 424, "acquisition_failed", result.kind === "RESOLUTION_FAILED" ? result.reason : JSON.stringify(result));
      }

      // Registro idempotente via N6 (contrato vigente). Metadata carrega
      // acquisition_ref, estado de identidade e rationale para auditoria;
      // provenance permanece a vigente (admin:manual).
      const targetCandidate = typeof body.candidate_id === "string" && body.candidate_id.length > 0 ? body.candidate_id : null;
      const targetProduct = typeof body.product_id === "string" && body.product_id.length > 0 ? body.product_id : null;
      const isUncertain = result.kind === "IDENTITY_UNCERTAIN";
      const persistResult = await persistLink({
        candidate_id: targetCandidate,
        product_id: targetProduct,
        marketplace,
        provider_id: providerId,
        affiliate_url: operatorProvidedUrl,
        notes: `Aquisição N8: ref=${result.acquisitionRef} method=${result.method} identity=${result.identityConfidence}${isUncertain ? ` rationale=${result.rationale}` : ""}`,
        idempotency_key: result.acquisitionRef,
        metadata: {
          acquisition_ref: result.acquisitionRef,
          acquisition_method: result.method,
          acquisition_identity_confidence: result.identityConfidence,
          ...(isUncertain ? { acquisition_state: "IDENTITY_UNCERTAIN", identity_rationale: result.rationale } : {}),
          contract_version: AFFILIATE_ACQUIRER_CONTRACT_VERSION,
        },
      });
      if (!persistResult.ok) return adminError(res, 400, "link_registration_failed", persistResult.reason);
      return adminSuccess(res, {
        result: persistResult.result,
        link: persistResult.record,
        acquisitionRef: result.acquisitionRef,
        acquisition: {
          state: isUncertain ? "IDENTITY_UNCERTAIN" : "SUCCESS",
          identityConfidence: result.identityConfidence,
          ...(isUncertain ? { rationale: result.rationale } : {}),
        },
        note: "Link adquirido e registrado como DRAFT/UNVALIDATED. Registro NÃO autoriza publicação — a publicação exige DECISION + Policy Engine + ApprovalStore (N5) + resolução (N7).",
      });
    } catch (error) {
      return adminError(res, 500, "acquisition_error", error instanceof Error ? error.message : "unknown");
    }
  });
}
