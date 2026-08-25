import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../repositories/productsRepository";
import { isMarketingEligible, type NewsletterStatus } from "./newsletterConsent";
import {
  NewsletterProviderError,
  type NewsletterProvider,
  type NewsletterProviderInput,
  type NewsletterProviderResult,
} from "./newsletterProvider";
import { sanitizeOperationalText } from "./operationalDiagnostics";

export const NEWSLETTER_OUTBOX_EVENT_TYPE = "newsletter_subscribed" as const;
export const NEWSLETTER_OUTBOX_OPERATION_TYPE = "project_to_provider" as const;
export const NEWSLETTER_OUTBOX_PAYLOAD_VERSION = "1.0" as const;
export const NEWSLETTER_OUTBOX_DEFAULT_LEASE_MS = 60_000;
export const NEWSLETTER_OUTBOX_DEFAULT_MAX_ATTEMPTS = 3;

export type NewsletterOutboxStatus = "pending" | "processing" | "succeeded" | "retryable" | "dead_letter" | "cancelled";

export interface NewsletterOutboxRow {
  id: string;
  subscriberEmail: string;
  eventType: string;
  operationType: string;
  status: NewsletterOutboxStatus;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  payloadVersion: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  leaseToken: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  providerReference: string | null;
  createdAt: string;
  updatedAt: string;
  processingStartedAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
}

export interface NewsletterSubscriberEligibility {
  status: NewsletterStatus;
  marketing_consent: boolean;
}

export interface ClaimedNewsletterOutbox {
  row: NewsletterOutboxRow;
  leaseToken: string;
}

export interface NewsletterOutboxStore {
  claimNext(leaseMs: number): Promise<ClaimedNewsletterOutbox | null>;
  readSubscriber(email: string): Promise<NewsletterSubscriberEligibility | null>;
  markSucceeded(id: string, leaseToken: string, providerReference?: string): Promise<NewsletterOutboxRow | null>;
  markCancelled(id: string, leaseToken: string, reason: string): Promise<NewsletterOutboxRow | null>;
  markFailure(id: string, leaseToken: string, failure: NewsletterProviderError, attemptCount: number, maxAttempts: number): Promise<NewsletterOutboxRow | null>;
}

export interface NewsletterWorkerOptions {
  leaseMs?: number;
  logger?: (event: string, fields: Record<string, unknown>) => void;
}

export type NewsletterWorkerOutcome =
  | "idle"
  | "cancelled_ineligible"
  | "succeeded"
  | "duplicate"
  | "retryable"
  | "dead_letter"
  | "lease_lost";

export interface NewsletterProcessResult {
  outcome: NewsletterWorkerOutcome;
  providerCalled: boolean;
  item: NewsletterOutboxRow | null;
}

let testClient: SupabaseClient | null | undefined;

export function setNewsletterOutboxClientForTests(client: SupabaseClient | null | undefined): void {
  testClient = client;
}

export function createSupabaseNewsletterOutboxStore(client: SupabaseClient | null = getClient()): NewsletterOutboxStore {
  if (!client) throw new Error("NEWSLETTER_OUTBOX_SUPABASE_UNAVAILABLE");

  return {
    async claimNext(leaseMs) {
      const leaseToken = randomUUID();
      const { data, error } = await client.rpc("claim_newsletter_outbox", {
        p_lease_token: leaseToken,
        p_lease_ms: leaseMs,
      });
      if (error) throw new Error("NEWSLETTER_OUTBOX_CLAIM_FAILED");
      const first = Array.isArray(data) ? data[0] : data;
      if (!first || typeof first !== "object") return null;
      return { row: mapOutboxRow(first as Record<string, unknown>), leaseToken };
    },

    async readSubscriber(email) {
      const { data, error } = await client
        .from("newsletter_subscribers")
        .select("status,marketing_consent")
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error("NEWSLETTER_OUTBOX_ELIGIBILITY_READ_FAILED");
      if (!data) return null;
      return {
        status: String(data.status || "") as NewsletterStatus,
        marketing_consent: data.marketing_consent === true,
      };
    },

    async markSucceeded(id, leaseToken, providerReference) {
      const now = new Date().toISOString();
      return updateOwnedRow(client, id, leaseToken, {
        status: "succeeded",
        lease_until: null,
        lease_token: null,
        provider_reference: providerReference ? sanitizeOperationalText(providerReference) : null,
        succeeded_at: now,
        updated_at: now,
        last_error_code: null,
        last_error_message: null,
      });
    },

    async markCancelled(id, leaseToken, reason) {
      const now = new Date().toISOString();
      return updateOwnedRow(client, id, leaseToken, {
        status: "cancelled",
        lease_until: null,
        lease_token: null,
        last_error_code: "INELIGIBLE_SUBSCRIBER",
        last_error_message: sanitizeOperationalText(reason),
        updated_at: now,
      });
    },

    async markFailure(id, leaseToken, failure, attemptCount, maxAttempts) {
      const now = new Date().toISOString();
      const terminal = failure.kind === "permanent_4xx" || failure.kind === "unknown" || attemptCount >= maxAttempts;
      const retryDelayMs = Math.min(300_000, 1_000 * Math.pow(2, Math.max(0, attemptCount - 1)));
      return updateOwnedRow(client, id, leaseToken, {
        status: terminal ? "dead_letter" : "retryable",
        lease_until: null,
        lease_token: null,
        last_error_code: sanitizeOperationalText(failure.code),
        last_error_message: sanitizeOperationalText(failure.message),
        next_attempt_at: terminal ? undefined : new Date(Date.now() + retryDelayMs).toISOString(),
        failed_at: terminal ? now : null,
        updated_at: now,
      });
    },
  };
}

export async function processNewsletterOutboxOnce(
  store: NewsletterOutboxStore,
  provider: NewsletterProvider,
  options: NewsletterWorkerOptions = {},
): Promise<NewsletterProcessResult> {
  const leaseMs = clampLeaseMs(options.leaseMs);
  const log = options.logger || defaultLogger;
  const claimed = await store.claimNext(leaseMs);
  if (!claimed) return { outcome: "idle", providerCalled: false, item: null };

  const { row, leaseToken } = claimed;
  log("newsletter.outbox.claimed", {
    outbox_id: row.id,
    status: row.status,
    attempt_count: row.attemptCount,
    max_attempts: row.maxAttempts,
    correlation_id: row.correlationId,
  });

  if (!isValidOutboxItem(row)) {
    const invalid = new NewsletterProviderError("permanent_4xx", "INVALID_OUTBOX_ITEM", "Evento de outbox inválido.");
    const released = await store.markFailure(row.id, leaseToken, invalid, row.attemptCount, row.maxAttempts);
    log("newsletter.outbox.invalid", { outbox_id: row.id, outcome: released?.status || "lease_lost", correlation_id: row.correlationId });
    return released
      ? { outcome: "dead_letter", providerCalled: false, item: released }
      : { outcome: "lease_lost", providerCalled: false, item: null };
  }

  let subscriber: NewsletterSubscriberEligibility | null;
  try {
    subscriber = await store.readSubscriber(row.subscriberEmail);
  } catch {
    const failure = new NewsletterProviderError("timeout", "ELIGIBILITY_READ_FAILED", "Falha transitória ao revalidar elegibilidade.");
    const released = await store.markFailure(row.id, leaseToken, failure, row.attemptCount, row.maxAttempts);
    log("newsletter.outbox.retry", { outbox_id: row.id, outcome: released?.status || "lease_lost", error_code: failure.code, correlation_id: row.correlationId });
    return released
      ? { outcome: released.status === "dead_letter" ? "dead_letter" : "retryable", providerCalled: false, item: released }
      : { outcome: "lease_lost", providerCalled: false, item: null };
  }

  if (!subscriber || !isMarketingEligible(subscriber)) {
    const cancelled = await store.markCancelled(row.id, leaseToken, "Subscriber não é elegível no momento da revalidação.");
    log("newsletter.outbox.cancelled", { outbox_id: row.id, outcome: cancelled ? "cancelled_ineligible" : "lease_lost", correlation_id: row.correlationId });
    return cancelled
      ? { outcome: "cancelled_ineligible", providerCalled: false, item: cancelled }
      : { outcome: "lease_lost", providerCalled: false, item: null };
  }

  let providerResult: NewsletterProviderResult;
  try {
    const input: NewsletterProviderInput = {
      subscriberEmail: row.subscriberEmail,
      eventType: row.eventType,
      payload: row.payload,
    };
    providerResult = await provider.project(input, row.idempotencyKey);
  } catch (error) {
    const failure = error instanceof NewsletterProviderError
      ? error
      : new NewsletterProviderError("unknown", "UNKNOWN_PROVIDER_ERROR", "Erro não classificado do provider.");
    const released = await store.markFailure(row.id, leaseToken, failure, row.attemptCount, row.maxAttempts);
    log("newsletter.outbox.failure", {
      outbox_id: row.id,
      outcome: released?.status || "lease_lost",
      error_code: failure.code,
      correlation_id: row.correlationId,
    });
    return released
      ? { outcome: released.status === "dead_letter" ? "dead_letter" : "retryable", providerCalled: true, item: released }
      : { outcome: "lease_lost", providerCalled: true, item: null };
  }

  const succeeded = await store.markSucceeded(row.id, leaseToken, providerResult.providerReference);
  if (!succeeded) {
    log("newsletter.outbox.lease_lost", { outbox_id: row.id, provider_outcome: providerResult.status, correlation_id: row.correlationId });
    return { outcome: "lease_lost", providerCalled: true, item: null };
  }

  const outcome = providerResult.status === "duplicate" ? "duplicate" : "succeeded";
  log("newsletter.outbox.succeeded", { outbox_id: row.id, outcome, provider_called: true, correlation_id: row.correlationId });
  return { outcome, providerCalled: true, item: succeeded };
}

export function createNewsletterOutboxWorker(
  provider: NewsletterProvider,
  options: NewsletterWorkerOptions = {},
): { processOnce: () => Promise<NewsletterProcessResult> } {
  const store = createSupabaseNewsletterOutboxStore();
  return { processOnce: () => processNewsletterOutboxOnce(store, provider, options) };
}

function getClient(): SupabaseClient | null {
  return testClient === undefined ? supabase : testClient;
}

function clampLeaseMs(value: number | undefined): number {
  const parsed = Number(value ?? NEWSLETTER_OUTBOX_DEFAULT_LEASE_MS);
  return Math.min(600_000, Math.max(1_000, Number.isFinite(parsed) ? Math.floor(parsed) : NEWSLETTER_OUTBOX_DEFAULT_LEASE_MS));
}

function isValidOutboxItem(row: NewsletterOutboxRow): boolean {
  return row.eventType === NEWSLETTER_OUTBOX_EVENT_TYPE
    && row.operationType === NEWSLETTER_OUTBOX_OPERATION_TYPE
    && row.payloadVersion === NEWSLETTER_OUTBOX_PAYLOAD_VERSION
    && row.payload !== null
    && typeof row.payload === "object"
    && !Array.isArray(row.payload)
    && Boolean(row.subscriberEmail)
    && Boolean(row.idempotencyKey)
    && row.status === "processing";
}

function mapOutboxRow(row: Record<string, unknown>): NewsletterOutboxRow {
  return {
    id: String(row.id || ""),
    subscriberEmail: String(row.subscriber_email || ""),
    eventType: String(row.event_type || ""),
    operationType: String(row.operation_type || ""),
    status: String(row.status || "") as NewsletterOutboxStatus,
    correlationId: String(row.correlation_id || ""),
    causationId: row.causation_id ? String(row.causation_id) : null,
    idempotencyKey: String(row.idempotency_key || ""),
    payloadVersion: String(row.payload_version || ""),
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {},
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? NEWSLETTER_OUTBOX_DEFAULT_MAX_ATTEMPTS),
    nextAttemptAt: String(row.next_attempt_at || new Date().toISOString()),
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
    providerReference: row.provider_reference ? String(row.provider_reference) : null,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
    processingStartedAt: row.processing_started_at ? String(row.processing_started_at) : null,
    succeededAt: row.succeeded_at ? String(row.succeeded_at) : null,
    failedAt: row.failed_at ? String(row.failed_at) : null,
  };
}

async function updateOwnedRow(
  client: SupabaseClient,
  id: string,
  leaseToken: string,
  patch: Record<string, unknown>,
): Promise<NewsletterOutboxRow | null> {
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const { data, error } = await client
    .from("newsletter_outbox")
    .update(cleanPatch)
    .eq("id", id)
    .eq("status", "processing")
    .eq("lease_token", leaseToken)
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapOutboxRow(data as Record<string, unknown>);
}

function defaultLogger(event: string, fields: Record<string, unknown>): void {
  console.info(`[NEWSLETTER-OUTBOX] ${event} ${JSON.stringify(fields)}`);
}
