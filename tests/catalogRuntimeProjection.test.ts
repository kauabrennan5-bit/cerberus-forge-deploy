import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogSyncInternals } from "../server/services/catalogSync";

const catalogSyncSource = readFileSync(new URL("../server/services/catalogSync.ts", import.meta.url), "utf8");
const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const frontendMainSource = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const runtimeManifest = JSON.parse(readFileSync(new URL("../public/catalog-runtime.json", import.meta.url), "utf8"));
const edgeSource = readFileSync(new URL("../supabase/functions/cerberus-public-api/index.ts", import.meta.url), "utf8");

test("legacy catalog sync validator remains isolated from the new storefront runtime", () => {
  assert.equal(catalogSyncSource.includes(["cerberus-static", "catalog.onrender.com"].join("-")), false);
  assert.equal(catalogSyncSource.includes("syncCatalogToGitHub"), false);
  assert.match(catalogSyncSource, /catalog-runtime\.json/);
  assert.match(catalogSyncSource, /storefrontHealthy/);
  assert.match(catalogSyncSource, /missingPublicIds/);
  assert.match(catalogSyncSource, /categoryMismatchIds/);
  assert.match(catalogSyncSource, /expectedPublicIds\.has\(productId\) && publicIds\.has\(productId\)/);
});

test("post-publication validation still rejects preview/static-catalog targets", () => {
  assert.doesNotThrow(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    "https://cerberus-finds.pages.dev",
    "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  ));
  assert.throws(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    ["https://cerberus-design", "-preview.onrender.com"].join(""),
    "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  ), /NON_CANONICAL_PUBLIC_VALIDATION_TARGET/);
});

test("storefront runtime manifest remains frontend-only while migration is incremental", () => {
  assert.equal(runtimeManifest.version, 2);
  assert.equal(runtimeManifest.mode, "runtime");
  assert.equal(runtimeManifest.frontendOnly, true);
  assert.deepEqual(catalogSyncInternals.parseStorefrontManifest(runtimeManifest), runtimeManifest);
});

test("runtime public list only treats active published rows as visible", () => {
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "published" }), true);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: false, status: "published" }), false);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "paused" }), false);
  assert.deepEqual(catalogSyncInternals.publicListFromPayload({ products: [{ id: "a" }] }), [{ id: "a" }]);
});

test("frontend combines the versioned legacy baseline with a governed serverless overlay", () => {
  const getProductsBody = frontendApiSource.slice(
    frontendApiSource.indexOf("export async function getProducts"),
    frontendApiSource.indexOf("export async function getPublicSocialLinks"),
  );
  assert.match(frontendApiSource, /function getLastKnownGoodCatalogUrl\(\).*\/data\/products\.json/s);
  assert.match(frontendApiSource, /function getCatalogOverlayUrl\(\).*catalog-overlay/s);
  assert.match(frontendApiSource, /function applyCatalogOverlay/);
  assert.match(getProductsBody, /applyCatalogOverlay\(snapshot, await loadCatalogOverlay\(\)\)/);
  assert.match(frontendApiSource, /ppsxlclycyinhhoqijvz\.supabase\.co\/functions\/v1\/cerberus-public-api/);
  assert.doesNotMatch(frontendApiSource, /juiychcfdqxgnatffnla\.supabase\.co/);
  assert.doesNotMatch(getProductsBody, /getPublicCatalogBackendFallbackUrl/);
  assert.match(frontendApiSource, /toPublicProductDTOs\(list\)/);
  assert.match(serverSource, /app\.get\("\/api\/products"/);
});

test("archive title hotfix loads after dark surface so the original h1 cannot reappear", () => {
  const darkSurfaceIndex = frontendMainSource.indexOf("design-system-dark-surface.css");
  const archiveFixIndex = frontendMainSource.indexOf("design-system-archive-title-fix.css");
  assert.ok(darkSurfaceIndex >= 0);
  assert.ok(archiveFixIndex > darkSurfaceIndex);
});

test("public Edge exposes only gated products and overlay mutations", () => {
  assert.match(edgeSource, /toPublicProductDTOs/);
  assert.match(edgeSource, /\.eq\("ativo", true\)/);
  assert.match(edgeSource, /\.eq\("status", "published"\)/);
  assert.match(edgeSource, /human_editorial_review_id/);
  assert.match(edgeSource, /human_editorial_authorization_id/);
  assert.match(edgeSource, /catalog_overlay_entries/);
  assert.match(edgeSource, /catalog-overlay-v1/);
  assert.match(edgeSource, /ineligibleUpsertIds/);
  assert.doesNotMatch(edgeSource, /curator_note/);
  assert.doesNotMatch(edgeSource, /AUTONOMOUS_DEFICIT_FALLBACK/);
});
