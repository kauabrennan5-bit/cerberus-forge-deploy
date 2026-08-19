import { createHash } from "crypto";

export const PUBLICATION_N16_VERSION = "n16:publication_v1" as const;
export const PublicationAction = "PUBLISH" as const;
export type PublicationAction = typeof PublicationAction;

export const PublicationStatus = {
  PENDING: "PENDING",
  VALIDATING: "VALIDATING",
  AUTHORIZED: "AUTHORIZED",
  EXECUTING: "EXECUTING",
  PUBLISHED: "PUBLISHED",
  FAILED: "FAILED",
  AMBIGUOUS: "AMBIGUOUS",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
} as const;
export type PublicationStatus = (typeof PublicationStatus)[keyof typeof PublicationStatus];

export const PUBLICATION_N16_REASON_CODES = {
  n15_authorization_missing: "n15_authorization_missing",
  n15_authorization_not_approved: "n15_authorization_not_approved",
  n15_authorization_expired: "n15_authorization_expired",
  n15_authorization_invalid: "n15_authorization_invalid",
  n15_action_mismatch: "n15_action_mismatch",
  n15_digest_mismatch: "n15_digest_mismatch",
  candidate_not_found: "candidate_not_found",
  publication_payload_invalid: "publication_payload_invalid",
  publication_destination_invalid: "publication_destination_invalid",
  publication_duplicate: "publication_duplicate",
  publication_execution_failed: "publication_execution_failed",
  publication_result_ambiguous: "publication_result_ambiguous",
  publication_confirmation_missing: "publication_confirmation_missing",
  publication_already_published: "publication_already_published",
  internal_error: "internal_error",
} as const;
export type PublicationReasonCode = (typeof PUBLICATION_N16_REASON_CODES)[keyof typeof PUBLICATION_N16_REASON_CODES];

export interface PublicationPayload {
  candidate_id: string;
  title: string;
  source_url: string;
  category: string;
  price: number;
  currency?: string;
  description?: string;
  external_listing_id?: string;
  metadata?: Record<string, unknown>;
}

export interface PublicationExecutionInput {
  candidate_id: string;
  destination: string;
  action?: PublicationAction;
  payload: PublicationPayload;
  request_id?: string;
  correlation_id?: string | null;
  proof_run_id?: string | null;
  now_iso?: string;
}

export interface N13AuthorizationSource {
  assessment_id: string;
  digest: string;
  verdict: string;
}

export interface N14AuthorizationSource {
  assessment_id: string;
  digest: string;
  band: string;
  score: number | null;
}

export interface N15AuthorizationRecord {
  assessment_id: string;
  candidate_id: string;
  status: string;
  action: string;
  authorization_digest: string;
  evaluated_at: string;
  expires_at: string;
  n13: N13AuthorizationSource;
  n14: N14AuthorizationSource;
  metadata?: Record<string, unknown>;
}

export interface PublicationAuthorizationEvaluationInput {
  candidate_id: string;
  candidate_status: string;
  destination: string;
  payload: PublicationPayload;
  action?: string;
  n13?: N13AuthorizationSource | null;
  n14?: N14AuthorizationSource | null;
  n15?: N15AuthorizationRecord | null;
  now_iso?: string;
}

export interface PublicationAuthorizationEvaluation {
  status: PublicationStatus;
  allowed: boolean;
  reasons: PublicationReasonCode[];
  authorizationDigest: string | null;
  payloadDigest: string | null;
  executionKey: string | null;
}

export interface PublicationExecutionResult {
  ok: boolean;
  status: PublicationStatus;
  execution_id?: string;
  execution_key?: string | null;
  reasons: PublicationReasonCode[];
  provider_reference?: string | null;
  result?: Record<string, unknown> | null;
  error?: string;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function publicationPayloadDigest(payload: PublicationPayload): string {
  return `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}

export function publicationExecutionKey(params: {
  candidateId: string;
  authorizationDigest: string;
  payloadDigest: string;
  destination: string;
  action: string;
}): string {
  return createHash("sha256")
    .update(params.candidateId + params.authorizationDigest + params.payloadDigest + params.destination + params.action)
    .digest("hex");
}
