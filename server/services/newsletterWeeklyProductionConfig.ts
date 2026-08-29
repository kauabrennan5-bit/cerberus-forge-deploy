import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";

export type WeeklyProductionSyncStatus = "never" | "ready" | "failed";

export type WeeklyProductionRuntimeConfig = {
  weeklyEnabled: boolean;
  brevoListId: number | null;
  contactSyncVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: WeeklyProductionSyncStatus;
  eligibleSubscribersCount: number;
  brevoMembersCount: number;
  updatedAt: string | null;
};

const CONFIG_ID = "production";

export async function readWeeklyProductionRuntimeConfig(
  client: SupabaseClient = requireSupabase(),
): Promise<WeeklyProductionRuntimeConfig | null> {
  const { data, error } = await client
    .from("newsletter_weekly_runtime_config")
    .select("weekly_enabled,brevo_list_id,contact_sync_verified_at,last_sync_at,last_sync_status,eligible_subscribers_count,brevo_members_count,updated_at")
    .eq("id", CONFIG_ID)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    weeklyEnabled: data.weekly_enabled === true,
    brevoListId: positiveId(data.brevo_list_id),
    contactSyncVerifiedAt: data.contact_sync_verified_at ? String(data.contact_sync_verified_at) : null,
    lastSyncAt: data.last_sync_at ? String(data.last_sync_at) : null,
    lastSyncStatus: normalizeStatus(data.last_sync_status),
    eligibleSubscribersCount: nonNegativeInt(data.eligible_subscribers_count),
    brevoMembersCount: nonNegativeInt(data.brevo_members_count),
    updatedAt: data.updated_at ? String(data.updated_at) : null,
  };
}

/**
 * Runtime real: banco autoritativo. O env antigo é apenas fallback de
 * compatibilidade caso a migration ainda não exista durante rollout.
 */
export async function isWeeklyProductionEnabled(
  env: NodeJS.ProcessEnv = process.env,
  client?: SupabaseClient,
): Promise<boolean> {
  try {
    const current = await readWeeklyProductionRuntimeConfig(client || requireSupabase());
    if (current) return current.weeklyEnabled;
  } catch {
    // Fail-closed unless an explicit legacy production flag already existed.
  }
  return env.NEWSLETTER_WEEKLY_ENABLED === "true";
}

export async function recordWeeklyProductionSyncReady(input: {
  listId: number;
  eligibleSubscribersCount: number;
  brevoMembersCount: number;
  now?: Date;
  client?: SupabaseClient;
}): Promise<void> {
  const client = input.client || requireSupabase();
  const now = (input.now || new Date()).toISOString();
  const { error } = await client
    .from("newsletter_weekly_runtime_config")
    .upsert({
      id: CONFIG_ID,
      brevo_list_id: input.listId,
      contact_sync_verified_at: now,
      last_sync_at: now,
      last_sync_status: "ready",
      eligible_subscribers_count: Math.max(0, Math.trunc(input.eligibleSubscribersCount)),
      brevo_members_count: Math.max(0, Math.trunc(input.brevoMembersCount)),
      updated_at: now,
    }, { onConflict: "id" });
  if (error) throw error;
}

export async function recordWeeklyProductionSyncFailed(input: {
  now?: Date;
  client?: SupabaseClient;
} = {}): Promise<void> {
  const client = input.client || requireSupabase();
  const now = (input.now || new Date()).toISOString();
  const { error } = await client
    .from("newsletter_weekly_runtime_config")
    .upsert({
      id: CONFIG_ID,
      contact_sync_verified_at: null,
      last_sync_at: now,
      last_sync_status: "failed",
      updated_at: now,
    }, { onConflict: "id" });
  if (error) throw error;
}

export async function enableWeeklyProductionAfterVerifiedSync(
  client: SupabaseClient = requireSupabase(),
): Promise<WeeklyProductionRuntimeConfig> {
  const current = await readWeeklyProductionRuntimeConfig(client);
  if (
    !current
    || current.lastSyncStatus !== "ready"
    || !current.brevoListId
    || !current.contactSyncVerifiedAt
    || current.eligibleSubscribersCount <= 0
    || current.eligibleSubscribersCount !== current.brevoMembersCount
  ) {
    throw new Error("WEEKLY_PRODUCTION_SYNC_NOT_VERIFIED");
  }
  const now = new Date().toISOString();
  const { error } = await client
    .from("newsletter_weekly_runtime_config")
    .update({ weekly_enabled: true, updated_at: now })
    .eq("id", CONFIG_ID);
  if (error) throw error;
  const enabled = await readWeeklyProductionRuntimeConfig(client);
  if (!enabled?.weeklyEnabled) throw new Error("WEEKLY_PRODUCTION_ENABLE_NOT_CONFIRMED");
  return enabled;
}

export async function disableWeeklyProduction(
  client: SupabaseClient = requireSupabase(),
): Promise<void> {
  const { error } = await client
    .from("newsletter_weekly_runtime_config")
    .update({ weekly_enabled: false, updated_at: new Date().toISOString() })
    .eq("id", CONFIG_ID);
  if (error) throw error;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeStatus(value: unknown): WeeklyProductionSyncStatus {
  return value === "ready" || value === "failed" ? value : "never";
}
