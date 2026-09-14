import "dotenv/config";
import { readAutonomousCuratorInvariant } from "../server/services/autonomousCuratorContinuousV2";
import { requireSupabase } from "../server/repositories/productsRepository";

function requireEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`CURATOR_INVARIANT_SECRET_MISSING:${name}`);
  return value;
}

async function assertNoAutoPublication(): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("autonomous_curator_runs")
    .select("id,auto_published,created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const autoPublished = Number(data?.auto_published || 0);
  if (!Number.isSafeInteger(autoPublished) || autoPublished !== 0) {
    throw new Error(`AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED:${autoPublished}`);
  }
}

async function main(): Promise<void> {
  requireEnv("SUPABASE_URL");
  if (!String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim()) {
    throw new Error("CURATOR_INVARIANT_SECRET_MISSING:SUPABASE_SERVICE_ROLE");
  }

  await assertNoAutoPublication();
  const result = await readAutonomousCuratorInvariant();
  await assertNoAutoPublication();

  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    renderDependency: false,
    readOnly: true,
    autoPublished: 0,
    result,
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "CURATOR_INVARIANT_DIRECT_FAILED");
  process.exitCode = 1;
});
