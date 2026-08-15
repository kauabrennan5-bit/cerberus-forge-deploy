import { randomUUID } from "node:crypto";
import { sanitizeOperationalText } from "./operationalDiagnostics";

export const OPERATIONAL_EVENT_SCHEMA_VERSION = "1.0" as const;

export type OperationalSeverity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" | "SECURITY";
export type OperationalActor = "system" | "operator" | "human" | "automation" | "external" | "agent";
export type OperationalOutcome = "PENDING" | "SUCCESS" | "FAILED" | "BLOCKED" | "SKIPPED" | "APPROVAL_REQUIRED";
export type OperationalEnvironment = "development" | "test" | "production" | "unknown";

export interface OperationalEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: string;
  actor: OperationalActor;
  correlationId: string;
  causationId?: string;
  severity: OperationalSeverity;
  payload: Record<string, unknown>;
  outcome: OperationalOutcome;
  environment: OperationalEnvironment;
  schemaVersion: typeof OPERATIONAL_EVENT_SCHEMA_VERSION;
}

export interface OperationalEventInput {
  eventType: string;
  source: string;
  actor: OperationalActor;
  correlationId: string;
  causationId?: string;
  severity: OperationalSeverity;
  payload?: Record<string, unknown>;
  outcome: OperationalOutcome;
  timestamp?: string;
  environment?: OperationalEnvironment;
}

const SENSITIVE_KEY = /(token|secret|password|credential|authorization|service.?role|private.?key|api.?key)/i;
const UNTRUSTED_PAYLOAD_KEY = /(raw.?content|scraped.?content|page.?html|html.?body|external.?payload|prompt|instruction)/i;
const RAW_PAYLOAD_MARKER = /\[(?:url final|titulo identificado|preco identificado|total imagens oficiais|imagens extraidas|conteudo da pagina)\]/i;
const PROMPT_INJECTION_MARKER = /(ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|jailbreak|do\s+not\s+follow)/i;

function environmentFromRuntime(): OperationalEnvironment {
  const value = process.env.NODE_ENV;
  return value === "development" || value === "test" || value === "production" ? value : "unknown";
}

function sanitizePayloadValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (depth > 5) return "[REDACTED_MAX_DEPTH]";
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED_SENSITIVE_FIELD]";
  if (key && UNTRUSTED_PAYLOAD_KEY.test(key)) return "[REDACTED_UNTRUSTED_PAYLOAD]";

  if (typeof value === "string") {
    if (RAW_PAYLOAD_MARKER.test(value) || PROMPT_INJECTION_MARKER.test(value)) {
      return "[REDACTED_UNTRUSTED_PAYLOAD]";
    }
    return sanitizeOperationalText(value).replace(/[\r\n]+/g, " ");
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizePayloadValue(item, undefined, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      result[childKey] = sanitizePayloadValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeOperationalPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = sanitizePayloadValue(payload || {}, undefined, 0);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertNonEmpty(name: string, value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`INVALID_OPERATIONAL_EVENT_${name.toUpperCase()}`);
  return normalized;
}

export function createOperationalEvent(input: OperationalEventInput): OperationalEvent {
  return {
    eventId: `evt-${Date.now().toString(36)}-${randomUUID()}`,
    eventType: assertNonEmpty("event_type", input.eventType),
    timestamp: input.timestamp || new Date().toISOString(),
    source: assertNonEmpty("source", input.source),
    actor: input.actor,
    correlationId: assertNonEmpty("correlation_id", input.correlationId),
    causationId: input.causationId ? String(input.causationId).trim() : undefined,
    severity: input.severity,
    payload: sanitizeOperationalPayload(input.payload),
    outcome: input.outcome,
    environment: input.environment || environmentFromRuntime(),
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
  };
}

export function formatOperationalEventForLog(event: OperationalEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    source: event.source,
    actor: event.actor,
    correlationId: event.correlationId,
    causationId: event.causationId,
    severity: event.severity,
    payload: event.payload,
    outcome: event.outcome,
    environment: event.environment,
    schemaVersion: event.schemaVersion,
  });
}

export function emitOperationalEvent(
  event: OperationalEvent,
  sink: (line: string) => void = line => console.info(line),
): OperationalEvent {
  sink(formatOperationalEventForLog(event));
  return event;
}
