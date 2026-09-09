import { supabase } from "../repositories/telegramRepository";

export type TelegramPublicationReconciliationRow = {
  review_id: string;
  outcome: "published" | "released_to_error" | "active_execution";
  published_product_id: string | null;
};

export type TelegramPublicationReconciliationResult = {
  status: "ok" | "skipped";
  inspected: number;
  published: number;
  released: number;
  active: number;
  rows: TelegramPublicationReconciliationRow[];
};

type ReconcilerDeps = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

const DEFAULT_TTL_MINUTES = 15;
const DEFAULT_LIMIT = 100;

export async function reconcileStaleTelegramPublications(
  input: { ttlMinutes?: number; limit?: number } = {},
  deps?: ReconcilerDeps,
): Promise<TelegramPublicationReconciliationResult> {
  const ttlMinutes = Math.max(5, Math.min(24 * 60, Math.floor(input.ttlMinutes ?? DEFAULT_TTL_MINUTES)));
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  const client = deps ?? (supabase ? {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const result = await supabase.rpc(name, args);
      return { data: result.data, error: result.error };
    },
  } : null);

  if (!client) {
    return { status: "skipped", inspected: 0, published: 0, released: 0, active: 0, rows: [] };
  }

  const { data, error } = await client.rpc("reconcile_stale_telegram_publications", {
    p_ttl: `${ttlMinutes} minutes`,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`TELEGRAM_PUBLICATION_RECONCILIATION_FAILED:${error.code || "unknown"}:${error.message || "rpc_failed"}`);
  }

  const rows = (Array.isArray(data) ? data : [])
    .filter((row): row is TelegramPublicationReconciliationRow => Boolean(
      row
      && typeof row === "object"
      && typeof (row as TelegramPublicationReconciliationRow).review_id === "string"
      && ["published", "released_to_error", "active_execution"].includes(
        String((row as TelegramPublicationReconciliationRow).outcome),
      ),
    ));

  return {
    status: "ok",
    inspected: rows.length,
    published: rows.filter(row => row.outcome === "published").length,
    released: rows.filter(row => row.outcome === "released_to_error").length,
    active: rows.filter(row => row.outcome === "active_execution").length,
    rows,
  };
}

export const telegramPublicationReconcilerInternals = {
  DEFAULT_TTL_MINUTES,
  DEFAULT_LIMIT,
};
