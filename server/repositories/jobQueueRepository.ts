import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { supabase } from "./productsRepository";
import { sanitizeOperationalText } from "../services/operationalDiagnostics";
import { sanitizeOperationalPayload } from "../services/operationalEvents";

export type JobQueueStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "RETRYING" | "DEAD_LETTER" | "CANCELLED";

export type JobQueueType =
  | "catalog_sync"
  | "telegram_send"
  | "product_ingest_review"
  | "operational_recovery"
  | "maintenance";

export type JobCreatedBy = "system" | "operator" | "human" | "automation" | "external" | "agent";

export interface JobQueuePayload {
  [key: string]: unknown;
}

export interface JobQueueJob {
  jobId: string;
  type: JobQueueType;
  status: JobQueueStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  lease: string | null;
  timeoutMs: number;
  idempotencyKey: string | null;
  createdBy: JobCreatedBy;
  costEstimate: Record<string, unknown>;
  lastError: string | null;
  correlationId: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  type: JobQueueType;
  idempotencyKey?: string;
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  createdBy: JobCreatedBy;
  correlationId?: string;
  costEstimate?: Record<string, unknown>;
  payload?: JobQueuePayload;
}

export interface QueueReadModel {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  retrying: number;
  dead_letter: number;
  cancelled: number;
}

const JOB_SCHEMA_VERSION = "1.0";
const QUEUED_RETRY_STATUSES: readonly JobQueueStatus[] = ["QUEUED", "RETRYING"];
const NON_TERMINAL_STATUSES: readonly JobQueueStatus[] = [
  "QUEUED",
  "RUNNING",
  "RETRYING",
];
const CLAIMABLE_STATUSES: readonly JobQueueStatus[] = ["QUEUED", "RETRYING"];

let testClient: SupabaseClient | null | undefined;

export function setJobQueueClientForTests(client: SupabaseClient | null | undefined): void {
  testClient = client;
}

function getClient(): SupabaseClient | null {
  return testClient === undefined ? supabase : testClient;
}

function unavailable(message: string): never {
  throw new Error(message);
}

function mapRow(row: Record<string, unknown>): JobQueueJob {
  return {
    jobId: String(row.job_id || ""),
    type: String(row.type || "") as JobQueueType,
    status: String(row.status || "") as JobQueueStatus,
    priority: Number(row.priority ?? 0),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    nextRunAt: String(row.next_run_at || new Date().toISOString()),
    lease: row.lease ? String(row.lease) : null,
    timeoutMs: Number(row.timeout_ms ?? 60000),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    createdBy: String(row.created_by || "") as JobCreatedBy,
    costEstimate: (row.cost_estimate || {}) as Record<string, unknown>,
    lastError: row.last_error ? String(row.last_error) : null,
    correlationId: String(row.correlation_id || ""),
    payload: (row.payload || {}) as Record<string, unknown>,
    result: (row.result as Record<string, unknown> | null) || null,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

export async function enqueueJob(input: EnqueueInput): Promise<JobQueueJob> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).trim() : null;
  if (idempotencyKey) {
    const { data: existing } = await client
      .from("job_queue")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle();
    if (existing) {
      const existingStatus = String(existing.status || "") as JobQueueStatus;
      const terminal = existingStatus === "SUCCEEDED" || existingStatus === "FAILED" || existingStatus === "DEAD_LETTER" || existingStatus === "CANCELLED";
      if (terminal) {
        unavailable(`Chave de idempotência ${idempotencyKey} já registrada em estado terminal (${existingStatus}).`);
      }
      const payloadEqual = JSON.stringify(sanitizeOperationalPayload((existing.payload || {}) as Record<string, unknown>)) ===
        JSON.stringify(sanitizeOperationalPayload((input.payload || {}) as Record<string, unknown>));
      if (payloadEqual) {
        console.info(`[JOB-QUEUE] queue.deduplicated idempotency_key=${idempotencyKey}`);
        return mapRow(existing as Record<string, unknown>);
      }
      unavailable(`Chave de idempotência ${idempotencyKey} colidiu com payload diferente.`);
    }
  }

  const priority = Math.min(100, Math.max(-100, Number(input.priority ?? 0)));
  const maxAttempts = Math.min(10, Math.max(1, Number(input.maxAttempts ?? 3)));
  const timeoutMs = Math.min(600000, Math.max(1000, Number(input.timeoutMs ?? 60000)));
  const now = Date.now();
  const nextRunAt = new Date(now + (Number(input.delayMs) > 0 ? Number(input.delayMs) : 0)).toISOString();

  const row = {
    job_id: `job-${now.toString(36)}-${randomUUID()}`,
    type: input.type,
    status: "QUEUED",
    priority,
    attempts: 0,
    max_attempts: maxAttempts,
    next_run_at: nextRunAt,
    lease: null,
    timeout_ms: timeoutMs,
    idempotency_key: idempotencyKey,
    created_by: input.createdBy,
    cost_estimate: sanitizeOperationalPayload(input.costEstimate),
    last_error: null,
    correlation_id: input.correlationId ? String(input.correlationId).trim() : input.type,
    payload: sanitizeOperationalPayload(input.payload),
    result: null,
  };

  const { data, error } = await client.from("job_queue").insert(row).select("*").maybeSingle();
  if (!error && data) return mapRow(data as Record<string, unknown>);
  if (error?.code === "23505") {
    const { data: raced } = await client
      .from("job_queue")
      .select("*")
      .eq("idempotency_key", idempotencyKey as string)
      .limit(1)
      .maybeSingle();
    if (raced) return mapRow(raced as Record<string, unknown>);
  }
  return unavailable(error?.message || "Falha ao enfileirar job.");
}

export async function getJob(jobId: string): Promise<JobQueueJob | null> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");
  const { data, error } = await client
    .from("job_queue")
    .select("*")
    .eq("job_id", jobId)
    .limit(1)
    .maybeSingle();
  if (error) return unavailable(error.message || "Falha ao ler job.");
  if (!data) return null;
  return mapRow(data as Record<string, unknown>);
}

export async function claimNextJob(): Promise<JobQueueJob | null> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const nowIso = new Date().toISOString();
  const { data, error } = await client
    .from("job_queue")
    .update({
      status: "RUNNING",
      lease: new Date(Date.now() + 60000).toISOString(),
    })
    .in("status", CLAIMABLE_STATUSES)
    .lte("next_run_at", nowIso)
    .or(`lease.is.null,lease.lte.${nowIso}`)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .select("*")
    .maybeSingle();

  if (error) return unavailable(error.message || "Falha ao reclamar job.");
  if (!data) return null;
  return mapRow(data as Record<string, unknown>);
}

export async function releaseJob(
  jobId: string,
  nextStatus: Extract<JobQueueStatus, "QUEUED" | "RETRYING" | "FAILED" | "DEAD_LETTER" | "SUCCEEDED">,
  options: { error?: string; result?: Record<string, unknown> } = {},
): Promise<JobQueueJob> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const job = await getJob(jobId);
  if (!job) return unavailable(`Job ${jobId} não encontrado para liberação.`);
  if (job.status !== "RUNNING") return unavailable(`Job ${jobId} não está em RUNNING (status atual: ${job.status}).`);

  if (nextStatus === "FAILED" || nextStatus === "DEAD_LETTER" || nextStatus === "SUCCEEDED") {
    const patch: Record<string, unknown> = {
      status: nextStatus,
      lease: null,
      last_error: options.error ? sanitizeOperationalText(options.error) : null,
      result: options.result ? sanitizeOperationalPayload(options.result) : null,
    };
    const { data, error } = await client
      .from("job_queue")
      .update(patch)
      .eq("job_id", jobId)
      .select("*")
      .maybeSingle();
    if (error || !data) return unavailable(error?.message || `Falha ao finalizar job ${jobId}.`);
    return mapRow(data as Record<string, unknown>);
  }

  const retryAttempt = job.attempts >= job.maxAttempts;
  const terminal = retryAttempt ? "DEAD_LETTER" : nextStatus;
  const backoffMs = Math.min(60000 * Math.pow(2, job.attempts), 300000);
  const patch: Record<string, unknown> = {
    status: terminal,
    lease: null,
    last_error: options.error ? sanitizeOperationalText(options.error) : null,
    next_run_at: new Date(Date.now() + backoffMs).toISOString(),
  };
  const { data, error } = await client
    .from("job_queue")
    .update(patch)
    .eq("job_id", jobId)
    .select("*")
    .maybeSingle();
  if (error || !data) return unavailable(error?.message || `Falha ao liberar job ${jobId}.`);
  return mapRow(data as Record<string, unknown>);
}

export async function heartbeat(jobId: string): Promise<JobQueueJob> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const job = await getJob(jobId);
  if (!job) return unavailable(`Job ${jobId} não encontrado para heartbeat.`);
  if (job.status !== "RUNNING") return unavailable(`Job ${jobId} não está em RUNNING (status atual: ${job.status}).`);

  const newLease = new Date(Date.now() + job.timeoutMs).toISOString();
  const { data, error } = await client
    .from("job_queue")
    .update({ lease: newLease })
    .eq("job_id", jobId)
    .select("*")
    .maybeSingle();
  if (error || !data) return unavailable(error?.message || `Falha no heartbeat do job ${jobId}.`);
  return mapRow(data as Record<string, unknown>);
}

export async function cancelJob(jobId: string): Promise<JobQueueJob> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const job = await getJob(jobId);
  if (!job) return unavailable(`Job ${jobId} não encontrado para cancelamento.`);
  if (!NON_TERMINAL_STATUSES.includes(job.status)) {
    return unavailable(`Job ${jobId} está em estado terminal (${job.status}) e não pode ser cancelado.`);
  }

  const { data, error } = await client
    .from("job_queue")
    .update({ status: "CANCELLED", lease: null })
    .eq("job_id", jobId)
    .select("*")
    .maybeSingle();
  if (error || !data) return unavailable(error?.message || `Falha ao cancelar job ${jobId}.`);
  return mapRow(data as Record<string, unknown>);
}

export async function queueReadModel(): Promise<QueueReadModel> {
  const client = getClient();
  if (!client) return unavailable("Cliente Supabase não configurado para a fila de jobs.");

  const { data, error } = await client
    .from("job_queue")
    .select("status")
    .order("status", { ascending: true });
  if (error) return unavailable(error.message || "Falha ao ler modelo de fila.");

  const model: QueueReadModel = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
    dead_letter: 0,
    cancelled: 0,
  };
  for (const row of (data as Record<string, unknown>[]) || []) {
    const status = String(row.status || "") as JobQueueStatus;
    if (status === "QUEUED") model.queued += 1;
    else if (status === "RUNNING") model.running += 1;
    else if (status === "SUCCEEDED") model.succeeded += 1;
    else if (status === "FAILED") model.failed += 1;
    else if (status === "RETRYING") model.retrying += 1;
    else if (status === "DEAD_LETTER") model.dead_letter += 1;
    else if (status === "CANCELLED") model.cancelled += 1;
  }
  return model;
}

export async function countByStatus(): Promise<QueueReadModel> {
  return queueReadModel();
}

export { JOB_SCHEMA_VERSION };
