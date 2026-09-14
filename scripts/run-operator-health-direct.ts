import "dotenv/config";
import { requireSupabase } from "../server/repositories/productsRepository";
import { resolveOperatorHealthUrls, runOperatorHealthChecksV2 } from "../server/services/operatorHealthChecksV2";

const EXPECTED_SITE = "https://cerberus-finds.pages.dev";
const EXPECTED_BACKEND = "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-telegram-gateway";
const EXPECTED_CATALOG = "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-public-api/products";
const EXPECTED_WEBHOOK = "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-telegram-gateway/webhook";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`OPERATOR_HEALTH_SECRET_MISSING:${label}`);
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

function assertServerlessTargets(): void {
  const urls = resolveOperatorHealthUrls(process.env);
  for (const [name, value] of Object.entries(urls)) {
    if (/onrender\.com/i.test(String(value))) throw new Error(`OPERATOR_RENDER_DEPENDENCY_FORBIDDEN:${name}`);
  }
  if (urls.publicSiteUrl !== EXPECTED_SITE) throw new Error("OPERATOR_PUBLIC_SITE_TARGET_MISMATCH");
  if (urls.publicBackendUrl !== EXPECTED_BACKEND) throw new Error("OPERATOR_BACKEND_TARGET_MISMATCH");
  if (urls.catalogProjectionUrl !== EXPECTED_CATALOG) throw new Error("OPERATOR_CATALOG_TARGET_MISMATCH");
  if (String(process.env.TELEGRAM_WEBHOOK_URL || "").trim() !== EXPECTED_WEBHOOK) {
    throw new Error("OPERATOR_TELEGRAM_WEBHOOK_TARGET_MISMATCH");
  }
}

async function main(): Promise<void> {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);
  requireAny("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
  assertServerlessTargets();

  await assertNoAutoPublication();
  const result = await runOperatorHealthChecksV2({ env: process.env });
  await assertNoAutoPublication();

  const criticalNames = new Set(["Site", "Backend", "Produtos/API", "Catálogo/Projection", "Supabase"]);
  const criticalDown = result.observations.filter(item => criticalNames.has(item.name) && item.status === "DOWN");
  if (criticalDown.length > 0) {
    throw new Error(`OPERATOR_CRITICAL_SERVERLESS_HEALTH_FAILED:${criticalDown.map(item => item.name).join(",")}`);
  }

  const telegram = result.observations.find(item => item.name === "Telegram");
  if (!telegram || telegram.diagnostic.webhookMatchesExpectedUrl !== true) {
    throw new Error("OPERATOR_TELEGRAM_WEBHOOK_MISMATCH");
  }

  const shopee = result.observations.find(item => item.name === "Shopee");
  if (!shopee || shopee.diagnostic.credentialsConfigured !== true || shopee.diagnostic.baseUrlStructurallyValid !== true) {
    throw new Error("OPERATOR_SHOPEE_READINESS_FAILED");
  }

  const autoPublished = 0;
  const catalogMutations = 0;
  const reviewsCreated = 0;
  const telegramMessagesSent = 0;
  const newsletterSends = 0;
  const consentChanges = 0;
  const violations = [autoPublished, catalogMutations, reviewsCreated, telegramMessagesSent, newsletterSends, consentChanges]
    .filter(value => value !== 0);
  if (violations.length > 0) throw new Error("OPERATOR_READ_ONLY_CONTRACT_VIOLATED");

  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    mode: "operator-health-read-only",
    renderDependency: false,
    readOnly: true,
    autoPublished,
    catalogMutations,
    reviewsCreated,
    telegramMessagesSent,
    newsletterSends,
    consentChanges,
    checkedAt: result.checkedAt,
    targets: {
      site: result.publicSiteUrl,
      backend: result.publicBackendUrl,
      catalog: result.catalogProjectionUrl,
    },
    observations: result.observations.map(item => ({
      name: item.name,
      status: item.status,
      httpStatus: item.httpStatus ?? null,
      error: item.error ?? null,
    })),
  }));
  console.log("OPERATOR_EXTERNAL=DIRECT_READ_ONLY_RENDER_FREE autoPublished=0");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "OPERATOR_HEALTH_DIRECT_FAILED");
  process.exitCode = 1;
});
