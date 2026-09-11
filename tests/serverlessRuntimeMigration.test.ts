import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontend = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../supabase/functions/cerberus-runtime-api/index.ts", import.meta.url), "utf8");
const telegram = readFileSync(new URL("../supabase/functions/cerberus-telegram-gateway/index.ts", import.meta.url), "utf8");
const publicApi = readFileSync(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260911183500_serverless_runtime_telegram.sql", import.meta.url), "utf8");
const rateMigration = readFileSync(new URL("../supabase/migrations/20260911183700_edge_rate_limits.sql", import.meta.url), "utf8");
const legacyBaselineMigration = readFileSync(new URL("../supabase/migrations/20260911184500_legacy_baseline_rotation.sql", import.meta.url), "utf8");

test("frontend public/admin runtime no longer calls Render", () => {
  assert.doesNotMatch(frontend, /cerberus-forge-deploy-backend\.onrender\.com/);
  assert.match(frontend, /cerberus-runtime-api/);
  assert.match(frontend, /\/social-links/);
  assert.match(frontend, /\/newsletter/);
  assert.match(frontend, /\/track-click/);
  assert.match(frontend, /\/meta-capi/);
  assert.match(frontend, /\/admin\/verify/);
  assert.match(frontend, /\/admin\/products/);
  assert.match(frontend, /\/admin\/extract/);
  assert.match(frontend, /catalog-overlay/);
  assert.doesNotMatch(frontend, /getPublicCatalogBackendFallbackUrl/);
});

test("public Edge runtime owns newsletter, click tracking, CAPI and admin fail-closed operations", () => {
  assert.doesNotMatch(runtime, /onrender\.com/);
  assert.match(runtime, /confirm_newsletter_consent_with_outbox/);
  assert.match(runtime, /newsletter-signup-v1/);
  assert.match(runtime, /\.from\("product_clicks"\)/);
  assert.match(runtime, /META_PIXEL_ID/);
  assert.match(runtime, /META_ACCESS_TOKEN/);
  assert.doesNotMatch(runtime, /body\.metaAccessToken|body\.metaPixelId/);
  assert.match(runtime, /CERBERUS_ADMIN_PASSWORD/);
  assert.match(runtime, /PUBLIC_PRODUCT_IMMUTABLE_FROM_ADMIN_API/);
  assert.match(runtime, /ativo:\s*false/);
  assert.match(runtime, /status:\s*"pending"/);
  assert.match(runtime, /cerberus_consume_edge_rate_limit/);
});

test("Telegram gateway is a real Edge handler rather than a Render relay", () => {
  assert.doesNotMatch(telegram, /BACKEND_WEBHOOK|onrender\.com|forwardTelegramUpdate/);
  assert.match(telegram, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(telegram, /TELEGRAM_ALLOWED_USER_IDS/);
  assert.match(telegram, /x-telegram-bot-api-secret-token/);
  assert.match(telegram, /confirm_pub:/);
  assert.match(telegram, /cancel_rev:/);
  assert.match(telegram, /product_rotate:/);
  assert.match(telegram, /rotation_approve:/);
  assert.match(telegram, /rotation_retry:/);
  assert.match(telegram, /rotation_cancel:/);
  assert.match(telegram, /cerberus_telegram_publish_review/);
  assert.match(telegram, /cerberus_telegram_discard_review/);
  assert.match(telegram, /cerberus_telegram_apply_rotation/);
  assert.match(telegram, /cerberus_telegram_rotation_decision/);
  assert.match(telegram, /\/card/);
  assert.match(telegram, /\/rotation-card/);
  assert.match(telegram, /\/register-webhook/);
  assert.match(telegram, /humanGate:\s*"telegram-db-authorization-v1"/);
  assert.match(telegram, /legacyBaselineAware:\s*true/);
  assert.match(telegram, /catalog_legacy_baseline/);
  assert.match(telegram, /sourceWasLegacyBaseline/);
});

test("database transaction persists callback proof before the publication guard can activate a product", () => {
  assert.match(migration, /create table if not exists public\.telegram_decision_events/);
  assert.match(migration, /callback_query_id/);
  assert.match(migration, /create table if not exists public\.telegram_webhook_updates/);
  assert.match(migration, /cerberus_telegram_publish_review/);
  assert.match(migration, /humanManualApproval/);
  assert.match(migration, /approval_origin/);
  assert.match(migration, /human_approval_evidence/);
  assert.match(migration, /status='publishing'/);
  assert.match(migration, /update public\.products\s+set ativo=true, status='published'/s);
  assert.match(migration, /grant execute on function public\.cerberus_telegram_publish_review[\s\S]*service_role/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*\bto anon\b/i);
});

test("legacy Cloudflare baseline supports governed rotation without fabricating approval", () => {
  assert.match(legacyBaselineMigration, /create table if not exists public\.catalog_legacy_baseline/);
  assert.match(legacyBaselineMigration, /949fef27ace775f53b98901db616a759ce4cc025/);
  assert.match(legacyBaselineMigration, /'humanApprovalBackfill',false/);
  assert.match(legacyBaselineMigration, /created_by is null/);
  assert.match(legacyBaselineMigration, /human_editorial_review_id is null/);
  assert.match(legacyBaselineMigration, /human_editorial_authorization_id is null/);
  assert.match(legacyBaselineMigration, /sourceWasLegacyBaseline/);
  assert.match(legacyBaselineMigration, /catalog_overlay_entries/);
  assert.match(legacyBaselineMigration, /'hide','telegram_rotation'/);
  assert.match(legacyBaselineMigration, /'upsert','telegram_rotation'/);
  assert.doesNotMatch(legacyBaselineMigration, /update public\.products[\s\S]{0,120}human_editorial_review_id/i);
});

test("catalog overlay exposes only public-gated upserts and explicit tombstones", () => {
  assert.match(publicApi, /catalog_overlay_entries/);
  assert.match(publicApi, /eligibleProductsByIds/);
  assert.match(publicApi, /publicationGate/);
  assert.match(publicApi, /ineligibleUpsertIds/);
  assert.match(publicApi, /catalog-overlay-v1/);
});

test("public Edge routes have atomic database-backed rate limits", () => {
  assert.match(rateMigration, /edge_rate_limit_windows/);
  assert.match(rateMigration, /cerberus_consume_edge_rate_limit/);
  assert.match(rateMigration, /on conflict\(scope,key_hash\) do update/);
  assert.match(rateMigration, /grant execute[\s\S]*service_role/);
  assert.doesNotMatch(rateMigration, /grant execute[\s\S]*\bto anon\b/i);
});
