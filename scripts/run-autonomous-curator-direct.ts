import "dotenv/config";
import { runAutonomousCuratorDaily } from "../server/services/autonomousCurator";
import { requireSupabase } from "../server/repositories/productsRepository";

type Mode = "dry_run" | "manual_review" | "status";

function modeFromArg(): Mode {
  const value = String(process.argv[2] || process.env.CURATOR_MODE || "status").trim();
  if (value === "dry_run" || value === "manual_review" || value === "status") return value;
  throw new Error(`AUTONOMOUS_CURATOR_MODE_INVALID:${value}`);
}

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`AUTONOMOUS_CURATOR_SECRET_MISSING:${label}`);
}

function preflight(mode: Mode): void {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);
  if (mode === "status") return;

  requireAny("SHOPEE_APP_ID", ["SHOPEE_APP_ID", "SHOPEE_AFFILIATE_APP_ID"]);
  requireAny("SHOPEE_APP_SECRET", ["SHOPEE_APP_SECRET", "SHOPEE_AFFILIATE_APP_SECRET"]);

  if (mode === "manual_review") {
    requireAny("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
    requireAny("TELEGRAM_REVIEW_ACTOR", ["TELEGRAM_ADMIN_CHAT_ID", "TELEGRAM_ALLOWED_USER_IDS"]);
  }
}

async function statusSnapshot() {
  const client = requireSupabase();
  const { data: config, error: configError } = await client
    .from("autonomous_curator_config")
    .select("enabled,auto_publish_enabled,review_threshold,max_daily_per_category,max_search_candidates,max_enrich_per_category,updated_at")
    .eq("id", "default")
    .maybeSingle();
  if (configError) throw configError;

  const { data: latestRun, error: runError } = await client
    .from("autonomous_curator_runs")
    .select("id,run_date,status,dry_run,completed_at,categories_processed,auto_published,review_required,rejected,failed,updated_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) throw runError;

  if (latestRun && Number(latestRun.auto_published || 0) !== 0) {
    throw new Error(`AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED:${latestRun.auto_published}`);
  }

  return {
    runtime: "github-actions-direct",
    renderDependency: false,
    reviewOnly: true,
    config: config ? { ...config, auto_publish_enabled: false } : null,
    latestRun,
  };
}

async function main(): Promise<void> {
  const mode = modeFromArg();
  preflight(mode);

  if (mode === "status") {
    console.log(JSON.stringify(await statusSnapshot()));
    return;
  }

  const dryRun = mode === "dry_run";
  const result = await runAutonomousCuratorDaily({
    dryRun,
    notify: !dryRun,
    manual: true,
  });

  const autoPublished = Number((result as any)?.autoPublished ?? (result as any)?.auto_published ?? 0);
  if (!Number.isSafeInteger(autoPublished) || autoPublished !== 0) {
    throw new Error(`AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED:${autoPublished}`);
  }

  const status = String((result as any)?.status || "unknown");
  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    renderDependency: false,
    reviewOnly: true,
    mode,
    autoPublished,
    result,
  }));

  if (status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "AUTONOMOUS_CURATOR_DIRECT_RUN_FAILED";
  console.error(message);
  process.exitCode = 1;
});
