import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";

export const AUTONOMOUS_CURATOR_RUN_RECOVERY_VERSION = "1";
const DEFAULT_STALE_MINUTES = 20;
const MIN_STALE_MINUTES = 5;
const MAX_STALE_MINUTES = 24 * 60;

export type AbandonedRunCandidate = {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  metadata?: Record<string, unknown> | null;
};

export type RunRecoveryResult = {
  checked: number;
  recovered: number;
  skipped: number;
  recoveredRunIds: string[];
  catalogEvidence: {
    activePublished: number;
    boundIdentities: number;
    danglingIdentities: number;
  };
};

function boundedStaleMinutes(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_STALE_MINUTES;
  return Math.max(MIN_STALE_MINUTES, Math.min(MAX_STALE_MINUTES, parsed));
}

function parseTimestamp(value: unknown): number | null {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cycleStartedAt(run: AbandonedRunCandidate): number | null {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  return parseTimestamp(metadata.continuous_cycle_started_at);
}

function cycleCompletedAt(run: AbandonedRunCandidate): number | null {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  return parseTimestamp(metadata.continuous_cycle_completed_at);
}

export function isAbandonedAutonomousCuratorRun(
  run: AbandonedRunCandidate,
  bootTimeMs: number,
  staleMinutes: number,
): boolean {
  if (run.status !== "running" || run.completed_at) return false;
  const started = parseTimestamp(run.started_at);
  if (started === null || started >= bootTimeMs) return false;
  const cycleStarted = cycleStartedAt(run);
  const cycleCompleted = cycleCompletedAt(run);
  if (cycleStarted !== null && cycleCompleted !== null) return false;
  const activityTimestamp = cycleStarted ?? started;
  return bootTimeMs - activityTimestamp >= boundedStaleMinutes(staleMinutes) * 60_000;
}

function previousCycleId(run: AbandonedRunCandidate): string | null {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  const value = String(metadata.continuous_cycle_id || "").trim();
  return value || null;
}

async function collectCatalogEvidence(client: SupabaseClient): Promise<RunRecoveryResult["catalogEvidence"]> {
  const [productsResult, identitiesResult] = await Promise.all([
    client.from("products").select("id,status,ativo"),
    client.from("product_source_identities").select("product_id").not("product_id", "is", null),
  ]);
  if (productsResult.error) throw productsResult.error;
  if (identitiesResult.error) throw identitiesResult.error;
  const products = Array.isArray(productsResult.data) ? productsResult.data : [];
  const identities = Array.isArray(identitiesResult.data) ? identitiesResult.data : [];
  const productIds = new Set(products.map(row => String(row.id)));
  const boundIds = identities.map(row => String(row.product_id || "")).filter(Boolean);
  return {
    activePublished: products.filter(row => row.status === "published" && row.ativo !== false).length,
    boundIdentities: boundIds.length,
    danglingIdentities: boundIds.filter(productId => !productIds.has(productId)).length,
  };
}

export async function recoverAbandonedAutonomousCuratorRuns(options: {
  client?: SupabaseClient;
  bootTime?: Date;
  staleMinutes?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<RunRecoveryResult> {
  const client = options.client || requireSupabase();
  const env = options.env || process.env;
  const bootTime = options.bootTime || new Date();
  const bootTimeMs = bootTime.getTime();
  const staleMinutes = boundedStaleMinutes(
    options.staleMinutes ?? env.AUTONOMOUS_CURATOR_STALE_RUN_MINUTES,
  );
  const recoveryTimestamp = bootTime.toISOString();

  // Reconcile facts first. Recovery never replays a publication whose completion
  // is uncertain; it only records the catalog/identity evidence observed at boot.
  const catalogEvidence = await collectCatalogEvidence(client);
  const { data, error } = await client
    .from("autonomous_curator_runs")
    .select("id,status,started_at,completed_at,metadata")
    .eq("status", "running")
    .is("completed_at", null)
    .lt("started_at", recoveryTimestamp)
    .order("started_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  const candidates = (Array.isArray(data) ? data : []) as AbandonedRunCandidate[];
  const recoveredRunIds: string[] = [];
  let skipped = 0;

  for (const run of candidates) {
    if (!isAbandonedAutonomousCuratorRun(run, bootTimeMs, staleMinutes)) {
      skipped += 1;
      continue;
    }
    const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
    const cycleId = previousCycleId(run);
    const reason = cycleId
      ? "PROCESS_BOOT_RECOVERY_STALE_CONTINUOUS_CYCLE"
      : "PROCESS_BOOT_RECOVERY_STALE_RUN";
    const { data: updated, error: updateError } = await client
      .from("autonomous_curator_runs")
      .update({
        status: "recovered",
        completed_at: recoveryTimestamp,
        interrupted_at: recoveryTimestamp,
        recovered_at: recoveryTimestamp,
        recovery_reason: reason,
        previous_cycle_id: cycleId,
        metadata: {
          ...metadata,
          recovery_version: AUTONOMOUS_CURATOR_RUN_RECOVERY_VERSION,
          recovery_reason: reason,
          interrupted_at: recoveryTimestamp,
          recovered_at: recoveryTimestamp,
          previous_cycle_id: cycleId,
          continuous_cycle_completed_at: metadata.continuous_cycle_completed_at || recoveryTimestamp,
          cycle_interrupted: true,
          recovery_replayed_publication: false,
          recovery_catalog_evidence: catalogEvidence,
        },
        updated_at: recoveryTimestamp,
      })
      .eq("id", run.id)
      .eq("status", "running")
      .is("completed_at", null)
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (updated?.id) recoveredRunIds.push(String(updated.id));
    else skipped += 1;
  }

  return {
    checked: candidates.length,
    recovered: recoveredRunIds.length,
    skipped,
    recoveredRunIds,
    catalogEvidence,
  };
}

export const autonomousCuratorRunRecoveryInternals = {
  boundedStaleMinutes,
  parseTimestamp,
  cycleStartedAt,
  cycleCompletedAt,
  previousCycleId,
  collectCatalogEvidence,
};
