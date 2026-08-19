import type { Express, NextFunction, Request, Response } from "express";
import { executePublicationN16 } from "../commercial/publication/n16Service";
import { PublicationAction, type PublicationExecutionInput, type PublicationPayload } from "../commercial/publication/n16Contract";
import { type PublicationProvider } from "../commercial/publication/n16Provider";

let provider: PublicationProvider | null = null;
export function setN16PublicationProvider(next: PublicationProvider | null): void { provider = next; }

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validInput(body: unknown): body is PublicationExecutionInput {
  if (!plain(body)) return false;
  if (typeof body.candidate_id !== "string" || !body.candidate_id.trim()) return false;
  if (typeof body.destination !== "string" || !body.destination.trim()) return false;
  if (body.action !== undefined && body.action !== PublicationAction) return false;
  if (!plain(body.payload)) return false;
  const p = body.payload as Record<string, unknown>;
  return p.candidate_id === body.candidate_id && typeof p.title === "string" && typeof p.category === "string" && typeof p.source_url === "string" && typeof p.price === "number";
}

const unavailableProvider: PublicationProvider = {
  async validatePayload(): Promise<{ ok: false; reason: string }> { return { ok: false, reason: "publication_provider_not_connected" }; },
  async publish(): Promise<{ ok: false; status: "FAILED"; error: string }> { return { ok: false, status: "FAILED", error: "publication_provider_not_connected" }; },
  async getStatus(): Promise<{ status: "FAILED"; error: string }> { return { status: "FAILED", error: "publication_provider_not_connected" }; },
};

export function registerPublicationN16Routes(
  app: Express,
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void,
): void {
  app.post("/api/commercial/publication/execute", requireAdminAuth, async (req: Request, res: Response) => {
    if (!validInput(req.body)) {
      res.status(400).json({ ok: false, error: "publication_payload_invalid", contract_version: "n16:publication_v1" });
      return;
    }
    try {
      const configuredProofRunId = (process.env.N16_PHASE4_PROOF_RUN_ID || process.env.N16_PHASE2_PROOF_RUN_ID)?.trim();
      const isProduction = process.env.NODE_ENV === "production";
      const proofProvider = provider && (!isProduction || (configuredProofRunId && req.body.proof_run_id === configuredProofRunId))
        ? provider
        : unavailableProvider;
      const result = await executePublicationN16(req.body, { provider: proofProvider });
      const status = result.status === "FAILED" && result.reasons.includes("internal_error") ? 500 : 200;
      res.status(status).json({ ok: result.ok, contract_version: "n16:publication_v1", ...result });
    } catch {
      res.status(500).json({ ok: false, status: "FAILED", reasons: ["internal_error"], error: "internal_error", contract_version: "n16:publication_v1" });
    }
  });
}
