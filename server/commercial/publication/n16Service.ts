import { createHash } from "crypto";
import { getCandidate } from "../../repositories/candidatesRepository";
import { listCandidateAssessments } from "../../repositories/candidateAssessmentRepository";
import { evaluatePublicationAuthorization } from "./n16Engine";
import {
  PUBLICATION_N16_REASON_CODES,
  PublicationAction,
  PublicationStatus,
  stableJson,
  type N13AuthorizationSource,
  type N14AuthorizationSource,
  type N15AuthorizationRecord,
  type PublicationExecutionInput,
  type PublicationExecutionResult,
  type PublicationPayload,
} from "./n16Contract";
import type { PublicationProvider } from "./n16Provider";
import {
  getExecution,
  insertExecution,
  updateExecutionStatus,
  type PublicationExecutionRecord,
  type PublicationExecutionWriteResult,
} from "../../repositories/publicationExecutionsRepository";

const REASONS = PUBLICATION_N16_REASON_CODES;

type Row = Record<string, unknown>;
export interface N16ServiceDeps {
  provider: PublicationProvider;
  getCandidate?: typeof getCandidate;
  listAssessments?: typeof listCandidateAssessments;
  getExecution?: typeof getExecution;
  insertExecution?: typeof insertExecution;
  updateExecutionStatus?: typeof updateExecutionStatus;
  now?: () => string;
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function digestOf(row: Row): string {
  const metadata = object(row.metadata);
  const dimensions = object(row.dimensions);
  const snapshot = object(row.input_snapshot);
  return text(metadata.digest) || text(metadata.decision_digest) || text(dimensions.digest) || text(dimensions.decision_digest) || text(snapshot.digest) || text(row.idempotency_key);
}
function latest(rows: Row[], version: string): Row | null {
  return rows.filter((row) => row.filter_version === version)[0] ?? null;
}
function sourceFromSnapshot(snapshot: Row, key: string): Row {
  const governance = object(snapshot.governance);
  const sources = governance.source_assessments;
  if (Array.isArray(sources)) return object(sources.find((item) => object(item).block === key || object(item).filter_version === key));
  return object(object(sources)[key]);
}
function normalizeN13(row: Row | null): N13AuthorizationSource | null {
  if (!row) return null;
  const dimensions = object(row.dimensions);
  return { assessment_id: text(row.assessment_id), digest: digestOf(row), verdict: text(dimensions.verdict) || text(object(row.metadata).verdict) };
}
function normalizeN14(row: Row | null): N14AuthorizationSource | null {
  if (!row) return null;
  const dimensions = object(row.dimensions);
  const metadata = object(row.metadata);
  return { assessment_id: text(row.assessment_id), digest: digestOf(row), band: text(dimensions.band) || text(metadata.band), score: numberOrNull(dimensions.score ?? metadata.score) };
}
function normalizeN15(row: Row | null, candidateId: string, n13: N13AuthorizationSource | null, n14: N14AuthorizationSource | null): N15AuthorizationRecord | null {
  if (!row) return null;
  const dimensions = object(row.dimensions);
  const metadata = object(row.metadata);
  const snapshot = object(row.input_snapshot);
  const governance = object(snapshot.governance);
  const sourceN13 = sourceFromSnapshot(snapshot, "n13");
  const sourceN14 = sourceFromSnapshot(snapshot, "n14");
  const authDigest = text(metadata.authorization_digest) || text(metadata.decision_digest) || text(dimensions.decision_digest) || text(governance.decision_digest) || digestOf(row);
  const n13Source = { assessment_id: text(sourceN13.assessment_id) || n13?.assessment_id || "", digest: text(sourceN13.digest) || n13?.digest || "", verdict: text(sourceN13.verdict) || n13?.verdict || "" };
  const n14Source = { assessment_id: text(sourceN14.assessment_id) || n14?.assessment_id || "", digest: text(sourceN14.digest) || n14?.digest || "", band: text(sourceN14.band) || n14?.band || "", score: numberOrNull(sourceN14.score) ?? n14?.score ?? null };
  return {
    assessment_id: text(row.assessment_id),
    candidate_id: text(row.candidate_id) || candidateId,
    status: text(dimensions.status) || text(metadata.status),
    action: text(dimensions.action) || text(metadata.action),
    authorization_digest: authDigest,
    evaluated_at: text(metadata.evaluated_at) || text(row.created_at),
    expires_at: text(dimensions.expires_at) || text(metadata.expires_at) || text(governance.expires_at),
    n13: n13Source,
    n14: n14Source,
    metadata,
  };
}
function executionId(input: PublicationExecutionInput, executionKey: string | null, reasons: string[]): string {
  const base = executionKey ?? createHash("sha256").update(stableJson({ input, reasons })).digest("hex");
  return `n16-${base}`;
}
function toErrorResult(status: PublicationStatus, reasons: string[], error?: string): PublicationExecutionResult {
  return { ok: false, status, reasons: reasons as PublicationExecutionResult["reasons"], execution_key: null, error };
}

export async function executePublicationN16(input: PublicationExecutionInput, deps: N16ServiceDeps): Promise<PublicationExecutionResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const getCandidateFn = deps.getCandidate ?? getCandidate;
  const listAssessmentsFn = deps.listAssessments ?? listCandidateAssessments;
  const getExecutionFn = deps.getExecution ?? getExecution;
  const insertFn = deps.insertExecution ?? insertExecution;
  const updateFn = deps.updateExecutionStatus ?? updateExecutionStatus;
  const action = input.action ?? PublicationAction;
  let candidateStatus = "UNKNOWN";
  let n13: N13AuthorizationSource | null = null;
  let n14: N14AuthorizationSource | null = null;
  let n15: N15AuthorizationRecord | null = null;

  const candidateResult = await getCandidateFn(input.candidate_id);
  if (candidateResult.ok && candidateResult.candidate) candidateStatus = candidateResult.candidate.status;
  const assessments = await listAssessmentsFn({ candidateId: input.candidate_id, limit: 100 });
  if (!candidateResult.ok) return toErrorResult(PublicationStatus.BLOCKED, [REASONS.candidate_not_found], "candidate_not_found");
  if (!assessments.ok) return toErrorResult(PublicationStatus.FAILED, [REASONS.internal_error], assessments.error ?? "assessment_load_failed");

  const rows = assessments.assessments;
  const n13Row = latest(rows, "n13:curator_v1");
  const n14Row = latest(rows, "n14:commercial_brain_v1");
  const n15Row = latest(rows, "n15:governance_v1");
  n13 = normalizeN13(n13Row);
  n14 = normalizeN14(n14Row);
  n15 = normalizeN15(n15Row, input.candidate_id, n13, n14);

  const evaluation = evaluatePublicationAuthorization({
    candidate_id: input.candidate_id,
    candidate_status: candidateStatus,
    destination: input.destination,
    payload: input.payload,
    action,
    n13,
    n14,
    n15,
    now_iso: input.now_iso ?? now(),
  });
  const requestId = input.request_id || `n16-req-${createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 24)}`;
  const id = executionId(input, evaluation.executionKey, evaluation.reasons);

  if (evaluation.executionKey) {
    const existing = await getExecutionFn({ executionKey: evaluation.executionKey });
    if (!existing.ok) return toErrorResult(PublicationStatus.FAILED, [REASONS.internal_error], existing.error ?? "execution_lookup_failed");
    if (existing.record) {
      const record = existing.record;
      if (record.status === PublicationStatus.PUBLISHED) return { ok: true, status: PublicationStatus.PUBLISHED, execution_id: record.execution_id, execution_key: record.execution_key, reasons: [REASONS.publication_duplicate, REASONS.publication_already_published], provider_reference: record.provider_reference, result: record.result };
      if (record.status === PublicationStatus.AMBIGUOUS) return { ok: false, status: PublicationStatus.AMBIGUOUS, execution_id: record.execution_id, execution_key: record.execution_key, reasons: [REASONS.publication_result_ambiguous, REASONS.publication_confirmation_missing], provider_reference: record.provider_reference, result: record.result };
      if (record.status === PublicationStatus.FAILED || record.status === PublicationStatus.BLOCKED || record.status === PublicationStatus.CANCELLED) return { ok: false, status: record.status, execution_id: record.execution_id, execution_key: record.execution_key, reasons: (record.reason_codes as PublicationExecutionResult["reasons"]) ?? [], error: record.error_message ?? undefined };
      return { ok: false, status: record.status, execution_id: record.execution_id, execution_key: record.execution_key, reasons: [REASONS.publication_duplicate] };
    }
  }

  const initialStatus = evaluation.allowed ? PublicationStatus.AUTHORIZED : PublicationStatus.BLOCKED;
  const inserted = await insertFn({
    execution_id: id,
    execution_key: evaluation.executionKey,
    candidate_id: input.candidate_id,
    n15_authorization_digest: evaluation.authorizationDigest,
    publication_payload_digest: evaluation.payloadDigest,
    destination: input.destination,
    action: PublicationAction,
    status: initialStatus,
    reason_codes: evaluation.reasons,
    request_id: requestId,
    correlation_id: input.correlation_id ?? null,
    proof_run_id: input.proof_run_id ?? null,
    metadata: {
      contract_version: "n16:publication_v1",
      n15_assessment_id: n15?.assessment_id ?? null,
      proof_run_id: input.proof_run_id ?? null,
    },
  });
  if (!inserted.ok) return toErrorResult(PublicationStatus.FAILED, [REASONS.internal_error], inserted.error ?? "execution_persist_failed");
  const record = inserted.record;
  if (inserted.outcome === "identical_duplicate" && record) {
    if (record.status === PublicationStatus.PUBLISHED) return { ok: true, status: PublicationStatus.PUBLISHED, execution_id: record.execution_id, execution_key: record.execution_key, reasons: [REASONS.publication_duplicate], provider_reference: record.provider_reference, result: record.result };
    if (record.status === PublicationStatus.AMBIGUOUS) return { ok: false, status: PublicationStatus.AMBIGUOUS, execution_id: record.execution_id, execution_key: record.execution_key, reasons: [REASONS.publication_result_ambiguous], provider_reference: record.provider_reference };
    if (record.status !== PublicationStatus.AUTHORIZED) return { ok: false, status: record.status, execution_id: record.execution_id, execution_key: record.execution_key, reasons: (record.reason_codes as PublicationExecutionResult["reasons"]) ?? [] };
  }
  if (!evaluation.allowed || !record) return { ok: false, status: PublicationStatus.BLOCKED, execution_id: id, execution_key: evaluation.executionKey, reasons: evaluation.reasons };

  let providerValidation;
  try { providerValidation = await deps.provider.validatePayload(input.payload, input.destination); }
  catch (error) { await updateFn(id, PublicationStatus.FAILED, { reason_codes: [REASONS.publication_execution_failed], error_code: REASONS.internal_error, error_message: "provider_validation_failed" }); return { ok: false, status: PublicationStatus.FAILED, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_execution_failed], error: error instanceof Error ? error.message : "provider_validation_failed" }; }
  if (!providerValidation.ok) {
    await updateFn(id, PublicationStatus.FAILED, { reason_codes: [REASONS.publication_payload_invalid], error_code: REASONS.publication_payload_invalid, error_message: providerValidation.reason ?? "provider_payload_rejected" });
    return { ok: false, status: PublicationStatus.FAILED, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_payload_invalid], error: providerValidation.reason };
  }
  await updateFn(id, PublicationStatus.EXECUTING, { started_at: now() });
  let published;
  try { published = await deps.provider.publish(input.payload, input.destination, evaluation.executionKey as string); }
  catch (error) { await updateFn(id, PublicationStatus.FAILED, { reason_codes: [REASONS.publication_execution_failed], error_code: REASONS.publication_execution_failed, error_message: "provider_publish_failed", finished_at: now() }); return { ok: false, status: PublicationStatus.FAILED, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_execution_failed], error: error instanceof Error ? error.message : "provider_publish_failed" }; }
  if (published.status === "AMBIGUOUS") {
    await updateFn(id, PublicationStatus.AMBIGUOUS, { reason_codes: [REASONS.publication_result_ambiguous, REASONS.publication_confirmation_missing], provider_reference: published.provider_reference ?? null, error_code: REASONS.publication_result_ambiguous, error_message: published.error ?? "ambiguous", finished_at: now() });
    return { ok: false, status: PublicationStatus.AMBIGUOUS, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_result_ambiguous, REASONS.publication_confirmation_missing], provider_reference: published.provider_reference ?? null };
  }
  if (!published.ok || published.status === "FAILED") {
    await updateFn(id, PublicationStatus.FAILED, { reason_codes: [REASONS.publication_execution_failed], provider_reference: published.provider_reference ?? null, error_code: REASONS.publication_execution_failed, error_message: published.error ?? "provider_failed", finished_at: now() });
    return { ok: false, status: PublicationStatus.FAILED, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_execution_failed], error: published.error };
  }
  let confirmation;
  try { confirmation = await deps.provider.getStatus(published.provider_reference ?? null, evaluation.executionKey as string); }
  catch (error) { await updateFn(id, PublicationStatus.AMBIGUOUS, { reason_codes: [REASONS.publication_confirmation_missing, REASONS.publication_result_ambiguous], provider_reference: published.provider_reference ?? null, error_code: REASONS.publication_confirmation_missing, error_message: "confirmation_failed", finished_at: now() }); return { ok: false, status: PublicationStatus.AMBIGUOUS, execution_id: id, execution_key: evaluation.executionKey, reasons: [REASONS.publication_confirmation_missing, REASONS.publication_result_ambiguous], provider_reference: published.provider_reference ?? null }; }
  if (confirmation.status !== "PUBLISHED") {
    const status = confirmation.status === "AMBIGUOUS" ? PublicationStatus.AMBIGUOUS : PublicationStatus.FAILED;
    const reasons = status === PublicationStatus.AMBIGUOUS ? [REASONS.publication_result_ambiguous, REASONS.publication_confirmation_missing] : [REASONS.publication_execution_failed];
    await updateFn(id, status, { reason_codes: reasons, provider_reference: confirmation.provider_reference ?? published.provider_reference ?? null, error_code: reasons[0], error_message: confirmation.error ?? "confirmation_not_published", finished_at: now() });
    return { ok: false, status, execution_id: id, execution_key: evaluation.executionKey, reasons, provider_reference: confirmation.provider_reference ?? published.provider_reference ?? null };
  }
  await updateFn(id, PublicationStatus.PUBLISHED, { reason_codes: [], provider_reference: confirmation.provider_reference ?? published.provider_reference ?? null, result: { confirmed: true, provider_status: confirmation.status }, finished_at: now() });
  return { ok: true, status: PublicationStatus.PUBLISHED, execution_id: id, execution_key: evaluation.executionKey, reasons: [], provider_reference: confirmation.provider_reference ?? published.provider_reference ?? null, result: { confirmed: true, provider_status: confirmation.status } };
}
