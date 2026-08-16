// ============================================================================
// Bloco N5 — Governed Publication — Rotas administrativas
//
// - POST   /api/commercial/candidates/:id/publish/preview  → dry-run (SEPARADO da execução real)
// - POST   /api/commercial/candidates/:id/publish          → publicação governada
// - GET    /api/commercial/candidates/:id/publish/status   → render-only (cockpit)
// - GET    /api/commercial/publications                    → render-only (cockpit)
//
// Todas exigem x-admin-password (requireAdminAuth) — admin-only e fail-closed.
// GOVERNANÇA:
// - Nenhuma rota contorna Policy Engine, ApprovalStore ou Agent Runtime.
// - A execução real exige DECISION + Policy Engine + approval válida.
// - Preview/dry-run nunca cria produto, vínculo ou evento de execução.
// - CANDIDATE != FACT CANÔNICO: a publicação só cria produto canônico
//   quando todos os gates forem satisfeitos, com aprovação explícita.
// ============================================================================
import type { Express, Request, Response } from "express";
import {
  executePublication,
  preflightPublication,
  buildPublicationDecision,
  type PublicationRepositoryAdapter,
  type ApprovalLookup,
} from "../commercial/publication/publicationExecutor";
import { evaluatePolicy } from "../policyEngine/policyEngine";
import { supabasePublicationAdapter } from "../commercial/publication/supabasePublicationAdapter";
import {
  InMemoryApprovalStore,
  type ApprovalStore,
} from "../agentRuntime/approvalPersisted";
import type { RuntimeApproval } from "../agentRuntime/approvalPersisted";

function adminError(res: Response, status: number, message: string, detail?: string): void {
  res.status(status).json({ ok: false, error: message, ...(detail ? { detail } : {}) });
}

function validateCandidateId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 255;
}

// Estado global oficial do executor (admin-only; TEST-ONLY via
// setPublicationApprovalStoreForTests) — mesmo padrão de agentRuntimeRoutes.
let publicationApprovalStore: ApprovalStore = new InMemoryApprovalStore();
export function setPublicationApprovalStoreForTests(store: ApprovalStore | null): void {
  publicationApprovalStore = store ?? new InMemoryApprovalStore();
}

function mapApprovalState(state: string): import("../agentRuntime/types").ApprovalDecisionState {
  const normalized = String(state ?? "").toUpperCase();
  if (normalized === "APPROVED") return "APPROVED";
  if (normalized === "REJECTED") return "REJECTED";
  if (normalized === "EXPIRED") return "EXPIRED";
  if (normalized === "REVOKED") return "REJECTED";
  if (normalized === "NOT_REQUIRED") return "NOT_REQUIRED";
  return "PENDING";
}

function buildApprovalLookup(): ApprovalLookup {
  return {
    async findApproval(executionId: string) {
      try {
        const approvals = await publicationApprovalStore.list();
        const match =
          approvals && approvals.length > 0
            ? (approvals as ReadonlyArray<RuntimeApproval>).find((a) => a.executionId === executionId)
            : undefined;
        if (!match) return { approvalId: null, state: "NOT_REQUIRED", expiresAt: null };
        return {
          approvalId: match.approvalId ?? null,
          state: mapApprovalState(match.state ?? ""),
          expiresAt: match.expiresAt ?? null,
        };
      } catch {
        // Fail-closed: falha de leitura NÃO aprova nem bloqueia; a aprovação
        // é decidida pela política + executor (PENDING ⇒ aguarda approval).
        return null;
      }
    },
  };
}

function buildExecutionId(candidateId: string, idempotencyKey: string): string {
  return `exec-pub-${candidateId}-${idempotencyKey.slice(0, 16)}`;
}

function buildIdempotencyKeyFromDecision(params: {
  candidateId: string;
  assessmentId: string;
  affiliateUrl: string | null;
}): string {
  const parts = [
    params.candidateId,
    params.assessmentId,
    params.affiliateUrl ?? "",
  ];
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `pub-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function registerPublicationRoutes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: () => void) => void,
  repo: PublicationRepositoryAdapter = supabasePublicationAdapter,
  approvalLookup: ApprovalLookup = buildApprovalLookup()
): void {
  // ------------------------------------------------------------------
  // POST /api/commercial/candidates/:id/publish/preview  (DRY-RUN)
  // ------------------------------------------------------------------
  app.post("/api/commercial/candidates/:id/publish/preview", requireAdminAuth, async (req, res) => {
    try {
      const candidateId = req.params.id;
      if (!validateCandidateId(candidateId)) {
        return adminError(res, 400, "invalid_candidate_id");
      }
      const preflight = await preflightPublication(
        { candidateId, affiliateUrl: req.body?.affiliateUrl ?? null },
        repo
      );
      return res.status(200).json({
        ok: true,
        preview: true,
        execution: false,
        preflight,
        note: "DRY-RUN: nenhuma avaliação de política, aprovação ou criação de produto foi executada.",
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "preview_failed", detail: error instanceof Error ? error.message : "unknown" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/commercial/candidates/:id/publish  (EXECUÇÃO GOVERNADA)
  // ------------------------------------------------------------------
  app.post("/api/commercial/candidates/:id/publish", requireAdminAuth, async (req, res) => {
    try {
      const candidateId = req.params.id;
      if (!validateCandidateId(candidateId)) {
        return adminError(res, 400, "invalid_candidate_id");
      }
      const body = req.body ?? {};

      // Decision explícita exigida (RECOMMENDATION != DECISION).
      const assessmentId = typeof body.assessmentId === "string" ? body.assessmentId : "";
      const rationale = typeof body.rationale === "string" ? body.rationale : "";
      if (!assessmentId || !rationale) {
        return adminError(res, 400, "missing_decision", "decision (assessmentId + rationale) é obrigatória");
      }

      // Affiliate URL — aceitar somente quando fornecido explicitamente;
      // JAMAIS derivar de URL comum de marketplace.
      const affiliateUrl = typeof body.affiliateUrl === "string" && body.affiliateUrl.trim() ? body.affiliateUrl.trim() : null;
      const affiliateSource = affiliateUrl
        ? Object.freeze({
            provider: "admin:manual",
            providerRef: null,
            affiliateUrl,
            providedAt: new Date().toISOString(),
          })
        : null;

      const correlationId =
        typeof body.correlationId === "string" && body.correlationId
          ? body.correlationId
          : `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const idempotencyKey = buildIdempotencyKeyFromDecision({ candidateId, assessmentId, affiliateUrl });
      const executionId = buildExecutionId(candidateId, idempotencyKey);

      // A decisão usa a avaliação do Policy Engine sobre a intenção
      // (policyDecision registrado na PublicationDecision; o executor
      // aplica fail-closed sobre ela).
      const policyDecision = await Promise.resolve(
        evaluatePolicy({
          agentId: "publication-executor",
          agentVersion: "1.0",
          policyVersion: "1.0",
          tool: "publication.execute",
          action: "CREATE_PRODUCT",
          targetTable: "products",
          risk: "HIGH",
          memoryScope: "PRODUCT",
          context: `publicação governada do candidate ${candidateId}`,
          approvalState: "PENDING",
        })
      );

      const decision = buildPublicationDecision({
        candidateId,
        assessmentId,
        policyDecision: policyDecision.decision,
        approvalState: policyDecision.decision === "ALLOW" ? "NOT_REQUIRED" : "PENDING",
        rationale,
        decidedBy: "operator-admin",
        correlationId,
      });

      const result = await executePublication({
        request: {
          candidateId,
          decision,
          affiliateSource,
          correlationId,
          executionId,
          idempotencyKey,
          decidedBy: "operator-admin",
        },
        affiliateUrl: affiliateUrl,
        affiliateSource,
        repo,
        approveLookup: approvalLookup,
      });

      const status = result.ok ? 200 :
        result.outcome === "WAITING_APPROVAL" || result.outcome === "ALREADY_PUBLISHED" ? 202 :
        result.outcome === "NOT_FOUND" ? 404 :
        result.outcome === "POLICY_DENIED" ? 403 :
        result.outcome === "POLICY_ERROR" ? 500 : 409;
      return res.status(status).json({ ok: result.ok, ...result });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "publish_failed", detail: error instanceof Error ? error.message : "unknown" });
    }
  });

  // ------------------------------------------------------------------
  // GET  /api/commercial/candidates/:id/publish/status  (RENDER-ONLY)
  // ------------------------------------------------------------------
  app.get("/api/commercial/candidates/:id/publish/status", requireAdminAuth, async (req, res) => {
    try {
      const candidateId = req.params.id;
      if (!validateCandidateId(candidateId)) {
        return adminError(res, 400, "invalid_candidate_id");
      }
      const preflight = await preflightPublication({ candidateId, affiliateUrl: null }, repo);
      return res.status(200).json({
        ok: true,
        renderOnly: true,
        candidateId,
        status: preflight.ok ? "ELIGIBLE" : "NOT_ELIGIBLE",
        preflight: {
          ok: preflight.ok,
          failureCode: preflight.failureCode ?? null,
          reason: preflight.reason ?? null,
        },
        candidate: preflight.candidate
          ? {
              status: preflight.candidate.status,
              promotedProductId: preflight.candidate.promotedProductId,
              sourceUrl: preflight.candidate.sourceUrl,
            }
          : null,
        note: "RENDER-ONLY: consulta de estado; nenhuma execução ou decisão é realizada.",
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "status_failed", detail: error instanceof Error ? error.message : "unknown" });
    }
  });

  // ------------------------------------------------------------------
  // GET   /api/commercial/publications  (RENDER-ONLY, cockpit)
  // ------------------------------------------------------------------
  app.get("/api/commercial/publications", requireAdminAuth, async (req, res) => {
    try {
      // Cockpit render-only: lista candidatos já promovidos com seus
      // produtos (proveniência candidate → product). Sem execução.
      const { listCandidates } = await import("../repositories/candidatesRepository");
      const promoted = await listCandidates({ status: "APPROVED", limit: 100 });
      const rows = (promoted.candidates ?? []).filter(c => Boolean(c.promoted_product_id));
      return res.status(200).json({
        ok: true,
        renderOnly: true,
        publications: rows.map(c => ({
          candidateId: c.candidate_id,
          productId: c.promoted_product_id,
          promotedAt: c.promoted_at,
          sourceUrl: c.source_url,
          marketplace: c.marketplace,
          title: c.title,
          category: c.category,
          observedPrice: c.observed_price,
        })),
        note: "RENDER-ONLY: leitura de estado; sem criação de produto, vínculo ou evento.",
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "publications_list_failed", detail: error instanceof Error ? error.message : "unknown" });
    }
  });
}
