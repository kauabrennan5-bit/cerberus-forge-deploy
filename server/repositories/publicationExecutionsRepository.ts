import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicationStatus } from "../commercial/publication/n16Contract";

export interface PublicationExecutionRecord {
  execution_id: string;
  execution_key: string | null;
  candidate_id: string;
  n15_authorization_digest: string | null;
  publication_payload_digest: string | null;
  destination: string;
  action: "PUBLISH";
  status: PublicationStatus;
  reason_codes: string[];
  provider_reference: string | null;
  result: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  request_id: string;
  correlation_id: string | null;
  proof_run_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at?: string;
  updated_at?: string;
  metadata: Record<string, unknown>;
}

export interface PublicationExecutionInsert {
  execution_id: string;
  execution_key?: string | null;
  candidate_id: string;
  n15_authorization_digest?: string | null;
  publication_payload_digest?: string | null;
  destination: string;
  action: "PUBLISH";
  status: PublicationStatus;
  reason_codes?: string[];
  provider_reference?: string | null;
  result?: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
  request_id: string;
  correlation_id?: string | null;
  proof_run_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  metadata?: Record<string, unknown>;
}

export type PublicationExecutionWriteOutcome = "inserted" | "identical_duplicate" | "conflict_rejected" | "missing_supabase" | "database_error";
export interface PublicationExecutionWriteResult {
  ok: boolean;
  outcome: PublicationExecutionWriteOutcome;
  record?: PublicationExecutionRecord | null;
  error?: string;
}

let client: SupabaseClient | null = null;
export function setPublicationExecutionsClient(next: SupabaseClient | null): void { client = next; }
export function setPublicationExecutionsClientForTests(next: SupabaseClient | null): void { client = next; }
export function getPublicationExecutionsClient(): SupabaseClient | null { return client; }

function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === "23505" || /unique|duplicate/i.test(error.message ?? "")));
}

function sameIdentity(a: PublicationExecutionRecord, b: PublicationExecutionInsert): boolean {
  return a.execution_key === (b.execution_key ?? null) &&
    a.candidate_id === b.candidate_id &&
    a.n15_authorization_digest === (b.n15_authorization_digest ?? null) &&
    a.publication_payload_digest === (b.publication_payload_digest ?? null) &&
    a.destination === b.destination && a.action === b.action;
}

export async function insertExecution(input: PublicationExecutionInsert): Promise<PublicationExecutionWriteResult> {
  if (!client) return { ok: false, outcome: "missing_supabase", error: "missing_supabase" };
  const row = {
    execution_id: input.execution_id,
    execution_key: input.execution_key ?? null,
    candidate_id: input.candidate_id,
    n15_authorization_digest: input.n15_authorization_digest ?? null,
    publication_payload_digest: input.publication_payload_digest ?? null,
    destination: input.destination,
    action: input.action,
    status: input.status,
    reason_codes: input.reason_codes ?? [],
    provider_reference: input.provider_reference ?? null,
    result: input.result ?? {},
    error_code: input.error_code ?? null,
    error_message: input.error_message ?? null,
    request_id: input.request_id,
    correlation_id: input.correlation_id ?? null,
    proof_run_id: input.proof_run_id ?? null,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
    metadata: input.metadata ?? {},
  };
  try {
    const existing = await client.from("publication_executions").select("*").eq("execution_key", input.execution_key ?? "").limit(1).maybeSingle();
    if (existing.error) return { ok: false, outcome: "database_error", error: existing.error.message };
    if (existing.data) {
      const record = existing.data as PublicationExecutionRecord;
      return sameIdentity(record, input)
        ? { ok: true, outcome: "identical_duplicate", record }
        : { ok: false, outcome: "conflict_rejected", record, error: "execution_key_conflict" };
    }
    const inserted = await client.from("publication_executions").insert(row).select("*").single();
    if (inserted.error) {
      if (isDuplicate(inserted.error)) {
        const replay = await client.from("publication_executions").select("*").eq("execution_key", input.execution_key ?? "").limit(1).maybeSingle();
        if (replay.data) {
          const record = replay.data as PublicationExecutionRecord;
          return sameIdentity(record, input)
            ? { ok: true, outcome: "identical_duplicate", record }
            : { ok: false, outcome: "conflict_rejected", record, error: "execution_key_conflict" };
        }
      }
      return { ok: false, outcome: "database_error", error: inserted.error.message };
    }
    return { ok: true, outcome: "inserted", record: (inserted.data ?? row) as PublicationExecutionRecord };
  } catch (error) {
    return { ok: false, outcome: "database_error", error: error instanceof Error ? error.message : "database_error" };
  }
}

const transitions: Record<PublicationStatus, ReadonlySet<PublicationStatus>> = {
  PENDING: new Set(["VALIDATING", "BLOCKED", "CANCELLED"]),
  VALIDATING: new Set(["AUTHORIZED", "BLOCKED", "FAILED"]),
  AUTHORIZED: new Set(["EXECUTING", "BLOCKED", "CANCELLED"]),
  EXECUTING: new Set(["PUBLISHED", "FAILED", "AMBIGUOUS"]),
  PUBLISHED: new Set(), FAILED: new Set(), AMBIGUOUS: new Set(), BLOCKED: new Set(), CANCELLED: new Set(),
};

export async function updateExecutionStatus(executionId: string, nextStatus: PublicationStatus, patch: Partial<Pick<PublicationExecutionRecord, "reason_codes" | "provider_reference" | "result" | "error_code" | "error_message" | "started_at" | "finished_at" | "metadata">> = {}): Promise<PublicationExecutionWriteResult> {
  if (!client) return { ok: false, outcome: "missing_supabase", error: "missing_supabase" };
  try {
    const current = await client.from("publication_executions").select("*").eq("execution_id", executionId).limit(1).maybeSingle();
    if (current.error || !current.data) return { ok: false, outcome: "database_error", error: current.error?.message ?? "execution_not_found" };
    const currentRecord = current.data as PublicationExecutionRecord;
    if (currentRecord.status !== nextStatus && !transitions[currentRecord.status].has(nextStatus)) return { ok: false, outcome: "conflict_rejected", record: currentRecord, error: `invalid_transition:${currentRecord.status}->${nextStatus}` };
    const update = { ...patch, status: nextStatus, updated_at: new Date().toISOString() };
    const result = await client.from("publication_executions").update(update).eq("execution_id", executionId).select("*").single();
    if (result.error) return { ok: false, outcome: "database_error", error: result.error.message };
    return { ok: true, outcome: "inserted", record: (result.data ?? { ...currentRecord, ...update }) as PublicationExecutionRecord };
  } catch (error) {
    return { ok: false, outcome: "database_error", error: error instanceof Error ? error.message : "database_error" };
  }
}

export async function getExecution(params: { executionId?: string; executionKey?: string }): Promise<{ ok: boolean; record?: PublicationExecutionRecord | null; error?: string }> {
  if (!client) return { ok: false, error: "missing_supabase" };
  if (!params.executionId && !params.executionKey) return { ok: false, error: "execution_identifier_required" };
  try {
    let query = client.from("publication_executions").select("*");
    query = params.executionId ? query.eq("execution_id", params.executionId) : query.eq("execution_key", params.executionKey as string);
    const result = await query.limit(1).maybeSingle();
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, record: (result.data ?? null) as PublicationExecutionRecord | null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "database_error" };
  }
}
