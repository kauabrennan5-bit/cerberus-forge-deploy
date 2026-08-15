import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./productsRepository";
import {
  sanitizeOperationalPayload,
  type OperationalEvent,
  type OperationalActor,
  type OperationalEnvironment,
  type OperationalOutcome,
  type OperationalSeverity,
} from "../services/operationalEvents";
import { sanitizeOperationalText } from "../services/operationalDiagnostics";

export type OperationalOperationStatus = "REQUESTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type OperationalMemoryOutcome = "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED" | "BLOCKED";
export type OperationalIncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RECOVERING" | "RESOLVED" | "BLOCKED";
export type OperationalRecoverability = "AUTO" | "ADMIN_APPROVAL" | "MANUAL" | "NOT_APPLICABLE";

export interface OperationalOperation {
  operationId: string;
  operationType: string;
  status: OperationalOperationStatus;
  actor: OperationalActor;
  correlationId: string;
  causationId?: string;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  resultCode?: string;
  errorCode?: string;
  metadata: Record<string, unknown>;
  schemaVersion: string;
}

export interface OperationalIncident {
  incidentId: string;
  incidentType: string;
  fingerprint: string;
  severity: Exclude<OperationalSeverity, "DEBUG" | "NOTICE" | "SECURITY">;
  status: OperationalIncidentStatus;
  createdAt: string;
  updatedAt: string;
  source: string;
  correlationId: string;
  operationId: string;
  summary: string;
  errorCode?: string;
  impact: string;
  recoverability: OperationalRecoverability;
  metadata: Record<string, unknown>;
}

export interface OperationalRecoveryAttempt {
  attemptId: string;
  incidentId: string;
  operationId: string;
  attemptNumber: number;
  strategy: string;
  startedAt: string;
  completedAt?: string;
  outcome: OperationalMemoryOutcome;
  errorCode?: string;
  metadata: Record<string, unknown>;
}

export interface MemoryWriteResult<T = undefined> {
  ok: boolean;
  deduplicated?: boolean;
  value?: T;
  reason?: string;
}

export interface OperationalMemoryReadResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

const MEMORY_SCHEMA_VERSION = "1.0";
let testClient: SupabaseClient | null | undefined;

/** Uso exclusivo de testes locais; produção sempre usa o cliente canônico do repository. */
export function setOperationalMemoryClientForTests(client: SupabaseClient | null | undefined): void {
  testClient = client;
}

function memoryUnavailable(reason: string): MemoryWriteResult {
  const safeReason = sanitizeOperationalText(reason);
  console.warn(`[MEMORY] memory.persistence.failed code=DATABASE_UNAVAILABLE reason=${safeReason}`);
  return { ok: false, reason: safeReason };
}

function readUnavailable<T>(reason: string): OperationalMemoryReadResult<T> {
  const safeReason = sanitizeOperationalText(reason);
  console.warn(`[MEMORY] memory.read code=DATABASE_UNAVAILABLE reason=${safeReason}`);
  return { ok: false, reason: safeReason };
}

function getClient(): SupabaseClient | null {
  return testClient === undefined ? supabase : testClient;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function eventComparable(event: OperationalEvent): Record<string, unknown> {
  return {
    event_type: event.eventType,
    event_timestamp: event.timestamp,
    source: event.source,
    actor: event.actor,
    correlation_id: event.correlationId,
    causation_id: event.causationId || null,
    severity: event.severity,
    payload: sanitizeOperationalPayload(event.payload),
    outcome: event.outcome,
    environment: event.environment,
    schema_version: event.schemaVersion,
  };
}

function mapEventRow(row: Record<string, unknown>): OperationalEvent {
  return {
    eventId: String(row.event_id || ""),
    eventType: String(row.event_type || ""),
    timestamp: String(row.event_timestamp || row.created_at || ""),
    source: String(row.source || ""),
    actor: String(row.actor || "system") as OperationalActor,
    correlationId: String(row.correlation_id || ""),
    causationId: row.causation_id ? String(row.causation_id) : undefined,
    severity: String(row.severity || "INFO") as OperationalSeverity,
    payload: sanitizeOperationalPayload(row.payload as Record<string, unknown>),
    outcome: String(row.outcome || "PENDING") as OperationalOutcome,
    environment: String(row.environment || "unknown") as OperationalEnvironment,
    schemaVersion: String(row.schema_version || MEMORY_SCHEMA_VERSION) as OperationalEvent["schemaVersion"],
  };
}

function mapOperationRow(row: Record<string, unknown>): OperationalOperation {
  return {
    operationId: String(row.operation_id || ""),
    operationType: String(row.operation_type || ""),
    status: String(row.status || "BLOCKED") as OperationalOperationStatus,
    actor: String(row.actor || "system") as OperationalActor,
    correlationId: String(row.correlation_id || ""),
    causationId: row.causation_id ? String(row.causation_id) : undefined,
    attempt: Number(row.attempt || 1),
    createdAt: String(row.created_at || ""),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    resultCode: row.result_code ? String(row.result_code) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    metadata: sanitizeOperationalPayload(row.metadata as Record<string, unknown>),
    schemaVersion: String(row.schema_version || MEMORY_SCHEMA_VERSION),
  };
}

function mapIncidentRow(row: Record<string, unknown>): OperationalIncident {
  return {
    incidentId: String(row.incident_id || ""),
    incidentType: String(row.incident_type || ""),
    fingerprint: String(row.fingerprint || ""),
    severity: String(row.severity || "WARNING") as OperationalIncident["severity"],
    status: String(row.status || "OPEN") as OperationalIncidentStatus,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || row.created_at || ""),
    source: String(row.source || ""),
    correlationId: String(row.correlation_id || ""),
    operationId: String(row.operation_id || ""),
    summary: sanitizeOperationalText(row.summary),
    errorCode: row.error_code ? sanitizeOperationalText(row.error_code) : undefined,
    impact: sanitizeOperationalText(row.impact),
    recoverability: String(row.recoverability || "MANUAL") as OperationalRecoverability,
    metadata: sanitizeOperationalPayload(row.metadata as Record<string, unknown>),
  };
}

function mapRecoveryRow(row: Record<string, unknown>): OperationalRecoveryAttempt {
  return {
    attemptId: String(row.attempt_id || ""),
    incidentId: String(row.incident_id || ""),
    operationId: String(row.operation_id || ""),
    attemptNumber: Number(row.attempt_number || 1),
    strategy: sanitizeOperationalText(row.strategy),
    startedAt: String(row.started_at || ""),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    outcome: String(row.outcome || "PENDING") as OperationalMemoryOutcome,
    errorCode: row.error_code ? sanitizeOperationalText(row.error_code) : undefined,
    metadata: sanitizeOperationalPayload(row.metadata as Record<string, unknown>),
  };
}

async function findEvent(eventId: string): Promise<OperationalEvent | null> {
  const client = getClient();
  if (!client) return null;
  const { data, error } = await client.from("operational_events").select("*").eq("event_id", eventId).maybeSingle();
  if (error || !data) return null;
  return mapEventRow(data as Record<string, unknown>);
}

export async function persistOperationalEvent(event: OperationalEvent): Promise<MemoryWriteResult<OperationalEvent>> {
  const client = getClient();
  if (!client) return memoryUnavailable("Cliente Supabase não configurado para memória operacional.");
  const canonical = eventComparable(event);
  const existing = await findEvent(event.eventId);
  if (existing) {
    if (stableJson(eventComparable(existing)) === stableJson(canonical)) {
      console.info(`[MEMORY] memory.deduplicated eventId=${event.eventId} correlationId=${event.correlationId}`);
      return { ok: true, deduplicated: true, value: existing };
    }
    return memoryUnavailable(`Colisão de eventId ${event.eventId} com payload diferente.`);
  }

  const { data, error } = await client.from("operational_events").insert({ event_id: event.eventId, ...canonical }).select("*").maybeSingle();
  if (!error && data) return { ok: true, value: mapEventRow(data as Record<string, unknown>) };
  if (error?.code === "23505") {
    const raced = await findEvent(event.eventId);
    if (raced && stableJson(eventComparable(raced)) === stableJson(canonical)) {
      console.info(`[MEMORY] memory.deduplicated eventId=${event.eventId} correlationId=${event.correlationId}`);
      return { ok: true, deduplicated: true, value: raced };
    }
  }
  return memoryUnavailable(error?.message || "Falha ao persistir evento operacional.");
}

export async function persistOperationalOperation(operation: OperationalOperation): Promise<MemoryWriteResult<OperationalOperation>> {
  const client = getClient();
  if (!client) return memoryUnavailable("Cliente Supabase não configurado para operações.");
  const row = {
    operation_id: operation.operationId,
    operation_type: sanitizeOperationalText(operation.operationType),
    status: operation.status,
    actor: operation.actor,
    correlation_id: operation.correlationId,
    causation_id: operation.causationId || null,
    attempt: operation.attempt,
    created_at: operation.createdAt,
    started_at: operation.startedAt || null,
    completed_at: operation.completedAt || null,
    result_code: operation.resultCode ? sanitizeOperationalText(operation.resultCode) : null,
    error_code: operation.errorCode ? sanitizeOperationalText(operation.errorCode) : null,
    metadata: sanitizeOperationalPayload(operation.metadata),
    schema_version: operation.schemaVersion || MEMORY_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client.from("operational_operations").upsert(row, { onConflict: "operation_id" }).select("*").maybeSingle();
  if (error || !data) return memoryUnavailable(error?.message || "Falha ao persistir operação operacional.");
  return { ok: true, value: mapOperationRow(data as Record<string, unknown>) };
}

export async function persistOperationalIncident(incident: OperationalIncident): Promise<MemoryWriteResult<OperationalIncident>> {
  const client = getClient();
  if (!client) return memoryUnavailable("Cliente Supabase não configurado para incidentes.");
  const row = {
    incident_id: incident.incidentId,
    incident_type: sanitizeOperationalText(incident.incidentType),
    fingerprint: sanitizeOperationalText(incident.fingerprint),
    severity: incident.severity,
    status: incident.status,
    created_at: incident.createdAt,
    updated_at: incident.updatedAt,
    source: sanitizeOperationalText(incident.source),
    correlation_id: incident.correlationId,
    operation_id: incident.operationId,
    summary: sanitizeOperationalText(incident.summary),
    error_code: incident.errorCode ? sanitizeOperationalText(incident.errorCode) : null,
    impact: sanitizeOperationalText(incident.impact),
    recoverability: incident.recoverability,
    metadata: sanitizeOperationalPayload(incident.metadata),
  };
  const { data, error } = await client.from("operational_incidents").upsert(row, { onConflict: "incident_id" }).select("*").maybeSingle();
  if (error || !data) return memoryUnavailable(error?.message || "Falha ao persistir incidente operacional.");
  return { ok: true, value: mapIncidentRow(data as Record<string, unknown>) };
}

export async function persistOperationalRecoveryAttempt(attempt: OperationalRecoveryAttempt): Promise<MemoryWriteResult<OperationalRecoveryAttempt>> {
  const client = getClient();
  if (!client) return memoryUnavailable("Cliente Supabase não configurado para recovery.");
  const row = {
    attempt_id: attempt.attemptId,
    incident_id: attempt.incidentId,
    operation_id: attempt.operationId,
    attempt_number: attempt.attemptNumber,
    strategy: sanitizeOperationalText(attempt.strategy),
    started_at: attempt.startedAt,
    completed_at: attempt.completedAt || null,
    outcome: attempt.outcome,
    error_code: attempt.errorCode ? sanitizeOperationalText(attempt.errorCode) : null,
    metadata: sanitizeOperationalPayload(attempt.metadata),
  };
  const { data, error } = await client.from("operational_recovery_attempts").upsert(row, { onConflict: "attempt_id" }).select("*").maybeSingle();
  if (error || !data) return memoryUnavailable(error?.message || "Falha ao persistir tentativa de recovery.");
  return { ok: true, value: mapRecoveryRow(data as Record<string, unknown>) };
}

export async function getOperationalOperation(operationId: string): Promise<OperationalMemoryReadResult<OperationalOperation>> {
  const client = getClient();
  if (!client) return readUnavailable<OperationalOperation>("Cliente Supabase não configurado para memória operacional.");
  const { data, error } = await client.from("operational_operations").select("*").eq("operation_id", operationId).maybeSingle();
  if (error) return readUnavailable<OperationalOperation>(error.message);
  return { ok: true, value: data ? mapOperationRow(data as Record<string, unknown>) : undefined };
}

export async function getOperationalEventsByCorrelationId(correlationId: string, limit = 100): Promise<OperationalMemoryReadResult<OperationalEvent[]>> {
  const client = getClient();
  if (!client) return readUnavailable<OperationalEvent[]>("Cliente Supabase não configurado para memória operacional.");
  const { data, error } = await client.from("operational_events").select("*").eq("correlation_id", correlationId).order("event_timestamp", { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  if (error) return readUnavailable<OperationalEvent[]>(error.message);
  return { ok: true, value: (data || []).map(row => mapEventRow(row as Record<string, unknown>)) };
}

export async function getOperationalIncident(incidentId: string): Promise<OperationalMemoryReadResult<OperationalIncident>> {
  const client = getClient();
  if (!client) return readUnavailable<OperationalIncident>("Cliente Supabase não configurado para memória operacional.");
  const { data, error } = await client.from("operational_incidents").select("*").eq("incident_id", incidentId).maybeSingle();
  if (error) return readUnavailable<OperationalIncident>(error.message);
  return { ok: true, value: data ? mapIncidentRow(data as Record<string, unknown>) : undefined };
}

export async function getLastOperationalOperation(): Promise<OperationalMemoryReadResult<OperationalOperation>> {
  const client = getClient();
  if (!client) return readUnavailable<OperationalOperation>("Cliente Supabase não configurado para memória operacional.");
  const { data, error } = await client.from("operational_operations").select("*").order("updated_at", { ascending: false }).limit(1);
  if (error) return readUnavailable<OperationalOperation>(error.message);
  const rows = (data || []) as Array<Record<string, unknown>>;
  return { ok: true, value: rows.length ? mapOperationRow(rows[0]) : undefined };
}

export const getLastOperation = getLastOperationalOperation;

export async function getRecentOperationalEvents(limit = 50): Promise<OperationalMemoryReadResult<OperationalEvent[]>> {
  const client = getClient();
  if (!client) return readUnavailable<OperationalEvent[]>("Cliente Supabase não configurado para memória operacional.");
  const { data, error } = await client.from("operational_events").select("*").order("event_timestamp", { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  if (error) return readUnavailable<OperationalEvent[]>(error.message);
  return { ok: true, value: (data || []).map(row => mapEventRow(row as Record<string, unknown>)) };
}

export async function recoverOperationalContext(operationId: string): Promise<OperationalMemoryReadResult<{ operation?: OperationalOperation; events: OperationalEvent[]; incident?: OperationalIncident; replayAllowed: false; uncertain: boolean }>> {
  const operation = await getOperationalOperation(operationId);
  if (!operation.ok) return { ok: false, reason: operation.reason };
  const events = await getOperationalEventsByCorrelationId(operation.value?.correlationId || operationId);
  if (!events.ok) return { ok: false, reason: events.reason };
  let incident: OperationalIncident | undefined;
  const incidentEvent = (events.value || []).find(event => typeof event.payload.incidentId === "string");
  if (incidentEvent?.payload.incidentId) {
    const loadedIncident = await getOperationalIncident(String(incidentEvent.payload.incidentId));
    if (!loadedIncident.ok) return { ok: false, reason: loadedIncident.reason };
    incident = loadedIncident.value;
  }
  const uncertain = operation.value?.status === "RUNNING";
  console.info(`[MEMORY] memory.recovery operationId=${operationId} uncertain=${uncertain} replayAllowed=false`);
  return { ok: true, value: { operation: operation.value, events: events.value || [], incident, replayAllowed: false, uncertain } };
}
