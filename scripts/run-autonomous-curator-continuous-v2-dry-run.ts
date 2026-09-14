import "dotenv/config";
import { createShopeeApiClient } from "../server/commercial/affiliate/shopeeApiClient";
import { getAutonomousCuratorConfig } from "../server/repositories/autonomousCuratorRepository";
import { AUTONOMOUS_CURATOR_PROFILES } from "../server/services/autonomousCuratorProfiles";
import {
  autonomousCuratorContinuousV2Internals,
  readAutonomousCuratorInvariant,
} from "../server/services/autonomousCuratorContinuousV2";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`CONTINUOUS_V2_DRY_RUN_SECRET_MISSING:${label}`);
}

function preflight(): void {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);
  requireAny("SHOPEE_APP_ID", ["SHOPEE_APP_ID", "SHOPEE_AFFILIATE_APP_ID"]);
  requireAny("SHOPEE_APP_SECRET", ["SHOPEE_APP_SECRET", "SHOPEE_AFFILIATE_APP_SECRET"]);
}

function positiveLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

async function main(): Promise<void> {
  preflight();

  const config = await getAutonomousCuratorConfig();
  const invariant = await readAutonomousCuratorInvariant();
  const appId = String(process.env.SHOPEE_APP_ID || process.env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = String(process.env.SHOPEE_APP_SECRET || process.env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  const client = createShopeeApiClient({
    appId,
    secret,
    baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL,
  });

  const maxCandidates = positiveLimit(
    process.env.CONTINUOUS_V2_DRY_RUN_MAX_CANDIDATES,
    Math.max(1, Math.min(config.maxSearchCandidates, 3)),
    10,
  );
  const deficitCategories = new Set(invariant.deficitCategories);
  const discovery: Array<Record<string, unknown>> = [];
  let providerFailures = 0;

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    if (!deficitCategories.has(profile.category)) continue;
    const query = profile.queries[0];
    if (!query) {
      discovery.push({ category: profile.category, ok: false, reason: "QUERY_MISSING" });
      providerFailures += 1;
      continue;
    }

    const page = autonomousCuratorContinuousV2Internals.discoveryPage(1, profile.category, 0);
    const search = await client.searchOffers({ query, page, limit: maxCandidates });
    if (!search.ok) providerFailures += 1;
    discovery.push({
      category: profile.category,
      query,
      page,
      ok: search.ok,
      reason: search.ok ? null : search.reason || "SHOPEE_SEARCH_FAILED",
      candidatesObserved: search.ok ? search.items.length : 0,
    });
  }

  const autoPublished = 0;
  const output = {
    runtime: "github-actions-direct",
    mode: "continuous-v2-dry-run-observational",
    dryRun: true,
    renderDependency: false,
    reviewOnly: true,
    autoPublished,
    catalogMutations: 0,
    reviewsCreated: 0,
    telegramMessagesSent: 0,
    productionRunOpened: false,
    config: {
      enabled: config.enabled,
      autoPublishEnabled: false,
      maxSearchCandidates: config.maxSearchCandidates,
      maxEnrichPerCategory: config.maxEnrichPerCategory,
    },
    invariant,
    discovery,
    providerFailures,
  };

  if (autoPublished !== 0) throw new Error(`AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED:${autoPublished}`);
  console.log(JSON.stringify(output));
  if (providerFailures > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "CONTINUOUS_V2_DRY_RUN_FAILED";
  console.error(message);
  process.exitCode = 1;
});
