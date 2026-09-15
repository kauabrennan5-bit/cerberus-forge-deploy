import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getExpectedTelegramWebhookUrl } from "../server/services/telegramDiagnostics";
import { resolvePublicSiteUrl, resolveNewsletterAssetBaseUrl } from "../server/services/newsletterInstitutional";
import { DEFAULT_PUBLIC_BACKEND_URL, DEFAULT_PUBLIC_CATALOG_URL } from "../server/services/operatorHealthChecksV2";
import { catalogSyncInternals } from "../server/services/catalogSync";

test("runtime defaults and newsletter assets use the canonical serverless deployment", () => {
  assert.equal(resolvePublicSiteUrl({}), "https://cerberus-finds.pages.dev");
  assert.equal(resolveNewsletterAssetBaseUrl({}), "https://cerberus-finds.pages.dev");
  assert.equal(DEFAULT_PUBLIC_BACKEND_URL, "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-telegram-gateway");
  assert.equal(DEFAULT_PUBLIC_CATALOG_URL, "https://ppsxlclycyinhhoqijvz.supabase.co/functions/v1/cerberus-public-api/products");
  assert.equal(catalogSyncInternals.publicCatalogApiUrl({}), DEFAULT_PUBLIC_CATALOG_URL);
  assert.throws(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    "https://cerberus-finds.pages.dev",
    "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  ), /OFFICIAL_PUBLIC_CATALOG_API_REQUIRED/);
});

test("default Telegram webhook uses the Edge route, not the Express route", () => {
  const webhook = process.env.TELEGRAM_WEBHOOK_URL;
  const backend = process.env.PUBLIC_BACKEND_URL;
  try {
    delete process.env.TELEGRAM_WEBHOOK_URL;
    delete process.env.PUBLIC_BACKEND_URL;
    assert.equal(getExpectedTelegramWebhookUrl(), `${DEFAULT_PUBLIC_BACKEND_URL}/webhook`);
    process.env.PUBLIC_BACKEND_URL = DEFAULT_PUBLIC_BACKEND_URL;
    assert.equal(getExpectedTelegramWebhookUrl(), `${DEFAULT_PUBLIC_BACKEND_URL}/webhook`);
  } finally {
    if (webhook === undefined) delete process.env.TELEGRAM_WEBHOOK_URL; else process.env.TELEGRAM_WEBHOOK_URL = webhook;
    if (backend === undefined) delete process.env.PUBLIC_BACKEND_URL; else process.env.PUBLIC_BACKEND_URL = backend;
  }
});

test("migrated runtime defaults contain no legacy production hostname", () => {
  for (const file of [
    "server/services/operatorHealthChecksV2.ts", "server/services/telegramDiagnostics.ts",
    "server/services/newsletterInstitutional.ts", "server/services/cerberusOperatorLegacy.ts",
    "server/services/autonomousCuratorContinuousV2.ts", "scripts/watchdog.mjs",
    "scripts/poll_health_phase24.sh", ".github/workflows/openai-provider-canary.yml",
    "server.ts", ".env.example", "inspect_api.py",
    "scripts/run_render_job.sh", "scripts/phase22_list_env_names.py",
  ]) assert.doesNotMatch(readFileSync(file, "utf8"), /https?:\/\/[^\s"']*onrender\.com/, file);
});

test("provider canary is direct, gated, and has no production write credentials", () => {
  const workflow = readFileSync(".github/workflows/openai-provider-canary.yml", "utf8");
  assert.match(workflow, /run-openai-provider-canary-direct\.ts/);
  assert.match(workflow, /CERBERUS_SERVERLESS_PROVIDER_CANARY_ENABLED/);
  assert.doesNotMatch(workflow, /SUPABASE|TELEGRAM|BREVO|OIDC|id-token|CERBERUS_RENDER_RUNTIME_ENABLED/);
});

test("production source and workflows have zero legacy hosting endpoint dependencies", () => {
  const files = ["server.ts", ".env.example", "inspect_api.py", "inspect_remote.py"];
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(?:[cm]?js|tsx?|py|sh|ya?ml|json)$/.test(entry.name)) files.push(path);
    }
  }
  for (const directory of ["src", "server", "scripts", "supabase", ".github/workflows"]) collect(directory);
  const dependencies = files.filter(file => /https?:\/\/[^\s"'`]*(?:onrender\.com|api\.render\.com)/i.test(readFileSync(file, "utf8")));
  assert.deepEqual(dependencies, [], "production endpoint dependencies must stay at zero");
});
