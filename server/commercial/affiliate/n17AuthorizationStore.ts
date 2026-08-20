import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listCandidateAssessments,
  setCandidateAssessmentClient,
} from "../../repositories/candidateAssessmentRepository";
import { GOVERNANCE_FILTER_VERSION } from "../governance/service";
import {
  N17_ACTION,
  type N17AuthorizationSnapshot,
} from "./n17Contract";

const N15_AUTHORIZATION_TTL_HOURS = 168;

export interface N17AuthorizationStore {
  getByRef(
    authorizationRef: string,
    candidateId?: string,
  ): Promise<N17AuthorizationSnapshot | null>;
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const iso = value.trim();
  return Number.isFinite(new Date(iso).getTime()) ? iso : null;
}

function decisionFromRow(
  row: Row,
  authorizationRef: string,
  candidateId: string | undefined,
  now: Date,
): N17AuthorizationSnapshot | null {
  if (row.filter_version !== GOVERNANCE_FILTER_VERSION) return null;

  const rowCandidateId = text(row.candidate_id);
  const assessmentId = text(row.assessment_id);
  if (!rowCandidateId || !assessmentId) return null;
  if (candidateId && rowCandidateId !== candidateId) return null;

  const dimensions = object(row.dimensions);
  if (!dimensions) return null;
  if (dimensions.action !== N17_ACTION || dimensions.status !== "APPROVED") {
    return null;
  }

  const inputSnapshot = object(row.input_snapshot);
  const governance = inputSnapshot ? object(inputSnapshot.governance) : null;
  if (!governance) return null;
  if (governance.action !== N17_ACTION || governance.status !== "APPROVED") {
    return null;
  }

  const persistedDecisionId = text(governance.decision_id) || assessmentId;
  if (persistedDecisionId !== authorizationRef) return null;

  if (!Object.prototype.hasOwnProperty.call(governance, "expires_at")) {
    return null;
  }
  const rawExpiresAt = governance.expires_at;
  const expiresAt = rawExpiresAt === null ? null : validIso(rawExpiresAt);
  if (rawExpiresAt !== null && !expiresAt) return null;

  const createdAt = validIso(row.created_at);
  if (!createdAt) return null;
  const createdMs = new Date(createdAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || createdMs > nowMs) return null;

  const ageHours = (nowMs - createdMs) / 3_600_000;
  if (ageHours > N15_AUTHORIZATION_TTL_HOURS) return null;
  if (expiresAt && new Date(expiresAt).getTime() <= nowMs) return null;

  return {
    authorization_ref: persistedDecisionId,
    candidate_id: rowCandidateId,
    action: N17_ACTION,
    status: "APPROVED",
    assessment_id: assessmentId,
    expires_at: expiresAt,
  };
}

/**
 * Cria o lookup N17 sobre assessments N15 já persistidos.
 *
 * A função não avalia, cria ou transforma decisões. Ela apenas lê a projeção
 * persistida de N15, filtra a versão de governança vigente e devolve uma
 * autorização somente quando a decisão APPROVED continua dentro do TTL.
 * Quando candidateId é fornecido, a leitura fica vinculada ao candidato do
 * request N17; sem ele, a busca usa apenas a janela global suportada pelo
 * repositório canônico de assessments.
 */
export function createN17AuthorizationStore(
  client: SupabaseClient,
  now: () => Date = () => new Date(),
): N17AuthorizationStore {
  // O repositório N15 usa o mesmo cliente injetado pelo bootstrap. Reafirmar
  // a injeção aqui torna a factory autocontida e não executa qualquer leitura.
  setCandidateAssessmentClient(client);

  return {
    async getByRef(
      authorizationRef: string,
      candidateId?: string,
    ): Promise<N17AuthorizationSnapshot | null> {
      const ref = text(authorizationRef);
      if (!ref || (candidateId !== undefined && !text(candidateId))) return null;

      const result = await listCandidateAssessments({
        candidateId: candidateId ? text(candidateId) : undefined,
        limit: 100,
      });
      if (!result.ok) return null;

      const rows = [...(result.assessments ?? [])]
        .map((row) => row as Row)
        .sort(
          (left, right) =>
            new Date(text(right.created_at)).getTime() -
            new Date(text(left.created_at)).getTime(),
        );
      const currentTime = now();

      for (const row of rows) {
        const authorization = decisionFromRow(row, ref, candidateId, currentTime);
        if (authorization) return authorization;
      }
      return null;
    },
  };
}

export { N15_AUTHORIZATION_TTL_HOURS };
