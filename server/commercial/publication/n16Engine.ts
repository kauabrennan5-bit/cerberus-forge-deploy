import {
  PUBLICATION_N16_REASON_CODES,
  PublicationAction,
  PublicationStatus,
  type PublicationAuthorizationEvaluation,
  type PublicationAuthorizationEvaluationInput,
  publicationExecutionKey,
  publicationPayloadDigest,
} from "./n16Contract";

const REASONS = PUBLICATION_N16_REASON_CODES;

function nonEmpty(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validDestination(destination: string): boolean {
  if (!nonEmpty(destination, 256) || /[\s<>"']/.test(destination)) return false;
  if (/^https?:\/\//i.test(destination)) {
    try {
      const url = new URL(destination);
      return url.protocol === "https:" && Boolean(url.hostname);
    } catch {
      return false;
    }
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/.test(destination);
}

function validPayload(input: PublicationAuthorizationEvaluationInput): boolean {
  const payload = input.payload;
  return Boolean(
    payload &&
      payload.candidate_id === input.candidate_id &&
      nonEmpty(payload.title, 500) &&
      nonEmpty(payload.category, 200) &&
      nonEmpty(payload.source_url, 2048) &&
      /^https:\/\//i.test(payload.source_url) &&
      Number.isFinite(payload.price) &&
      payload.price > 0 &&
      (!payload.currency || /^[A-Z]{3}$/.test(payload.currency)),
  );
}

export function evaluatePublicationAuthorization(
  input: PublicationAuthorizationEvaluationInput,
): PublicationAuthorizationEvaluation {
  const reasons: PublicationAuthorizationEvaluationInput["n15"] extends never ? never : string[] = [];
  const nowMs = Date.parse(input.now_iso ?? new Date().toISOString());
  const action = input.action ?? PublicationAction;
  const n15 = input.n15 ?? null;
  let payloadDigest: string | null = null;

  if (!Number.isFinite(nowMs)) reasons.push(REASONS.internal_error);
  if (!nonEmpty(input.candidate_id, 256)) reasons.push(REASONS.candidate_not_found);
  if (input.candidate_status === "PUBLISHED") reasons.push(REASONS.publication_already_published);
  if (!validDestination(input.destination)) reasons.push(REASONS.publication_destination_invalid);
  if (!validPayload(input)) reasons.push(REASONS.publication_payload_invalid);
  else payloadDigest = publicationPayloadDigest(input.payload);

  if (!n15) {
    reasons.push(REASONS.n15_authorization_missing);
  } else {
    if (n15.status !== "APPROVED") reasons.push(REASONS.n15_authorization_not_approved);
    if (n15.action !== PublicationAction || action !== PublicationAction) reasons.push(REASONS.n15_action_mismatch);
    if (n15.candidate_id !== input.candidate_id) reasons.push(REASONS.n15_authorization_invalid);
    if (!nonEmpty(n15.authorization_digest, 256) || !nonEmpty(n15.assessment_id, 256)) reasons.push(REASONS.n15_authorization_invalid);
    const expiresMs = Date.parse(n15.expires_at);
    const evaluatedMs = Date.parse(n15.evaluated_at);
    if (!Number.isFinite(expiresMs) || !Number.isFinite(evaluatedMs)) reasons.push(REASONS.n15_authorization_invalid);
    else if (nowMs > expiresMs) reasons.push(REASONS.n15_authorization_expired);
    if (!input.n13 || input.n13.verdict !== "PASS" || !nonEmpty(input.n13.digest, 256)) reasons.push(REASONS.n15_digest_mismatch);
    if (!input.n14 || !nonEmpty(input.n14.digest, 256) || !Number.isFinite(input.n14.score)) reasons.push(REASONS.n15_digest_mismatch);
    if (!n15.n13 || !n15.n14 || n15.n13.digest !== input.n13?.digest || n15.n14.digest !== input.n14?.digest) reasons.push(REASONS.n15_digest_mismatch);
  }

  const uniqueReasons = [...new Set(reasons)] as PublicationAuthorizationEvaluation["reasons"];
  const authorizationDigest = n15?.authorization_digest ?? null;
  const executionKey = authorizationDigest && payloadDigest && validDestination(input.destination)
    ? publicationExecutionKey({ candidateId: input.candidate_id, authorizationDigest, payloadDigest, destination: input.destination, action })
    : null;
  return {
    status: uniqueReasons.length === 0 ? PublicationStatus.AUTHORIZED : PublicationStatus.BLOCKED,
    allowed: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    authorizationDigest,
    payloadDigest,
    executionKey,
  };
}
