import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";
import type { OperatorHealthComponentName, OperatorHealthObservation } from "./operatorHealthChecksV2";

export const ACTIVE_OPERATOR_INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "INVESTIGATING",
  "AUTO_FIXING",
  "REQUIRES_APPROVAL",
  "ESCALATED",
  "RECOVERING",
  "BLOCKED",
] as const;

export type PersistedOperatorIncident = {
  incident_id: string;
  incident_type: string;
  fingerprint: string;
  severity: string;
  status: string;
  created_at: string;
  updated_at: string;
  source: string;
  correlation_id: string;
  operation_id: string;
  summary: string;
  error_code?: string | null;
  impact: string;
  recoverability: string;
  metadata?: Record<string, unknown> | null;
};

export type IncidentSyncResult = {
  opened: string[];
  updated: string[];
  resolved: string[];
  active: number;
};

function normalizedText(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function componentForIncident(incident: Pick<PersistedOperatorIncident, "incident_type" | "summary" | "error_code" | "metadata">): OperatorHealthComponentName | null {
  const metadataComponent = String(incident.metadata?.component || "").trim();
  const metadataDependency = String(incident.metadata?.dependency || "").trim();
  const known: OperatorHealthComponentName[] = ["Site", "Backend", "Produtos/API", "Catálogo/Projection", "Supabase", "Telegram", "Shopee", "Gemini", "OpenAI", "Newsletter"];
  if (known.includes(metadataComponent as OperatorHealthComponentName)) return metadataComponent as OperatorHealthComponentName;

  // Legacy Operator incidents used broad component names that no longer match
  // V2 observations. Translate them to the independently measured dependency
  // so healthy checks can resolve old incidents instead of leaving false OPENs.
  if (metadataComponent === "Lifecycle" && metadataDependency === "Backend") return "Backend";
  if (metadataComponent === "Produtos") return "Produtos/API";

  const text = normalizedText(`${incident.incident_type} ${incident.summary} ${incident.error_code || ""}`);
  if (text.includes("lifecycle_degraded")) return "Backend";
  if (text.includes("produtos_degraded") || text.includes("produtos/api") || text.includes("products_api") || text.includes("api_products")) return "Produtos/API";
  if (text.includes("telegram") || text.includes("unauthorized")) return "Telegram";
  if (text.includes("catalog") || text.includes("catalogo") || text.includes("projection")) return "Catálogo/Projection";
  if (text.includes("backend")) return "Backend";
  if (text.includes("supabase")) return "Supabase";
  if (text.includes("shopee")) return "Shopee";
  if (text.includes("gemini")) return "Gemini";
  if (text.includes("openai") || text.includes("open_ai")) return "OpenAI";
  if (text.includes("newsletter") || text.includes("brevo")) return "Newsletter";
  if (text.includes("site") || text.includes("frontend")) return "Site";
  return null;
}

function incidentFingerprint(observation: OperatorHealthObservation): string {
  return createHash("sha256")
    .update(`${observation.name}|${observation.status}|${observation.error || "none"}|${observation.httpStatus ?? "none"}`)
    .digest("hex");
}

function safeCode(value: unknown): string | null {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 100);
  return normalized || null;
}

function incidentType(observation: OperatorHealthObservation): string {
  const component = observation.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${component}_${observation.status}`;
}

function sanitizedHealthEvidence(observation: OperatorHealthObservation): Record<string, unknown> {
  return {
    component: observation.name,
    status: observation.status,
    timestamp: observation.timestamp,
    latencyMs: observation.latencyMs,
    httpStatus: observation.httpStatus ?? null,
    error: observation.error || null,
    diagnostic: observation.diagnostic,
  };
}

function recoveryDurationMs(createdAt: string, recoveredAt: string): number {
  const created = Date.parse(createdAt);
  const recovered = Date.parse(recoveredAt);
  if (!Number.isFinite(created) || !Number.isFinite(recovered)) return 0;
  return Math.max(0, recovered - created);
}

async function resolveIncident(client: SupabaseClient, incident: PersistedOperatorIncident, observation: OperatorHealthObservation): Promise<boolean> {
  const recoveredAt = observation.timestamp || new Date().toISOString();
  const healthEvidence = sanitizedHealthEvidence(observation);
  const metadata = incident.metadata && typeof incident.metadata === "object" ? incident.metadata : {};
  const { data, error } = await client
    .from("operational_incidents")
    .update({
      status: "RESOLVED",
      recovered_at: recoveredAt,
      duration_ms: recoveryDurationMs(incident.created_at, recoveredAt),
      recovery_reason: "COMPONENT_HEALTHY_ON_INDEPENDENT_OPERATOR_CHECK",
      health_evidence: healthEvidence,
      updated_at: recoveredAt,
      metadata: {
        ...metadata,
        component: observation.name,
        recoveredAt,
        recoveryReason: "COMPONENT_HEALTHY_ON_INDEPENDENT_OPERATOR_CHECK",
        recoveryHealthEvidence: healthEvidence,
      },
    })
    .eq("incident_id", incident.incident_id)
    .in("status", [...ACTIVE_OPERATOR_INCIDENT_STATUSES])
    .select("incident_id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.incident_id);
}

async function updateOrOpenIncident(client: SupabaseClient, observation: OperatorHealthObservation, active: PersistedOperatorIncident[]): Promise<{ opened?: string; updated?: string }> {
  const fingerprint = incidentFingerprint(observation);
  const current = active.find(incident => componentForIncident(incident) === observation.name && incident.fingerprint === fingerprint);
  const now = observation.timestamp || new Date().toISOString();
  const evidence = sanitizedHealthEvidence(observation);
  if (current) {
    const metadata = current.metadata && typeof current.metadata === "object" ? current.metadata : {};
    const { error } = await client.from("operational_incidents").update({
      updated_at: now,
      error_code: safeCode(observation.error),
      summary: `${observation.name} ${observation.status}: ${observation.error || "health check degraded"}`.slice(0, 300),
      health_evidence: evidence,
      metadata: { ...metadata, component: observation.name, lastSeenAt: now, currentHealthEvidence: evidence },
    }).eq("incident_id", current.incident_id);
    if (error) throw error;
    return { updated: current.incident_id };
  }

  const short = fingerprint.slice(0, 16);
  const incidentId = `OPV2-${short}`;
  const correlationId = `health-${Date.parse(now) || Date.now()}-${short.slice(0, 8)}`;
  const row = {
    incident_id: incidentId,
    incident_type: incidentType(observation),
    fingerprint,
    severity: observation.status === "DOWN" ? "ERROR" : "WARNING",
    status: "OPEN",
    created_at: now,
    updated_at: now,
    source: "cerberus_operator_v2",
    correlation_id: correlationId,
    operation_id: `operator-health-${short}`,
    summary: `${observation.name} ${observation.status}: ${observation.error || "health check degraded"}`.slice(0, 300),
    error_code: safeCode(observation.error),
    impact: `${observation.name} health is ${observation.status}`,
    recoverability: "AUTO",
    health_evidence: evidence,
    metadata: { component: observation.name, openedBy: "operator_health_v2", currentHealthEvidence: evidence },
  };
  const { error } = await client.from("operational_incidents").insert(row);
  if (error && error.code !== "23505") throw error;
  if (error?.code === "23505") {
    const { error: updateError } = await client.from("operational_incidents").update({ updated_at: now, health_evidence: evidence, metadata: row.metadata }).eq("incident_id", incidentId);
    if (updateError) throw updateError;
    return { updated: incidentId };
  }
  return { opened: incidentId };
}

export async function synchronizeOperatorIncidents(
  observations: readonly OperatorHealthObservation[],
  options: { client?: SupabaseClient } = {},
): Promise<IncidentSyncResult> {
  const client = options.client || requireSupabase();
  const { data, error } = await client
    .from("operational_incidents")
    .select("incident_id,incident_type,fingerprint,severity,status,created_at,updated_at,source,correlation_id,operation_id,summary,error_code,impact,recoverability,metadata")
    .in("status", [...ACTIVE_OPERATOR_INCIDENT_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const active = (Array.isArray(data) ? data : []) as PersistedOperatorIncident[];
  const opened: string[] = [];
  const updated: string[] = [];
  const resolved: string[] = [];

  for (const observation of observations) {
    const componentActive = active.filter(incident => componentForIncident(incident) === observation.name);
    if (observation.status === "HEALTHY") {
      for (const incident of componentActive) {
        if (await resolveIncident(client, incident, observation)) resolved.push(incident.incident_id);
      }
      continue;
    }
    // When one fingerprint is still failing, do not resolve another incident for
    // the same dependency simply because its exact error string changed.
    const result = await updateOrOpenIncident(client, observation, active);
    if (result.opened) opened.push(result.opened);
    if (result.updated) updated.push(result.updated);
  }

  return { opened, updated, resolved, active: Math.max(0, active.length + opened.length - resolved.length) };
}

export const operatorIncidentRecoveryInternals = {
  normalizedText,
  incidentFingerprint,
  incidentType,
  safeCode,
  sanitizedHealthEvidence,
  recoveryDurationMs,
};
