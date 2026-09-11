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

test("catalog sync validates the new frontend runtime and no longer promotes a static catalog branch", () => {
  assert.equal(catalogSyncSource.includes(["cerberus-static", "catalog.onrender.com"].join("-")), false);
  assert.equal(catalogSyncSource.includes("syncCatalogToGitHub"), false);
  assert.match(catalogSyncSource, /https:\/\/juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api\/products/);
  const obsoleteBackendProducts = ["https://cerberus-forge-deploy-backend.onrender.com", "api", "products"].join("/");
  assert.equal(catalogSyncSource.includes(obsoleteBackendProducts), false);
  assert.match(catalogSyncSource, /catalog-runtime\.json/);
  assert.match(catalogSyncSource, /storefrontHealthy/);
  assert.match(catalogSyncSource, /missingPublicIds/);
  assert.match(catalogSyncSource, /categoryMismatchIds/);
  assert.match(catalogSyncSource, /expectedPublicIds\.has\(productId\) && publicIds\.has\(productId\)/);
});

test("post-publication validation rejects preview/static-catalog targets", () => {
  assert.doesNotThrow(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    "https://cerberus-finds.pages.dev",
    "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  ));
  assert.throws(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    ["https://cerberus-design", "-preview.onrender.com"].join(""),
    "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  ), /NON_CANONICAL_PUBLIC_VALIDATION_TARGET/);
  assert.throws(() => catalogSyncInternals.assertCanonicalRuntimeTargets(
    ["https://cerberus-", "static-catalog.onrender.com"].join(""),
    "https://legacy.example/catalog",
  ), /NON_CANONICAL_PUBLIC_VALIDATION_TARGET/);
});

test("storefront runtime manifest proves frontend-only mode and canonical catalog API", () => {
  assert.deepEqual(runtimeManifest, {
    version: 2,
    mode: "runtime",
    frontendOnly: true,
    catalogApiUrl: "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products",
  });
  assert.deepEqual(catalogSyncInternals.parseStorefrontManifest(runtimeManifest), runtimeManifest);
  assert.equal(catalogSyncInternals.parseStorefrontManifest({ ...runtimeManifest, frontendOnly: false }), null);
  assert.equal(catalogSyncInternals.parseStorefrontManifest({ ...runtimeManifest, catalogApiUrl: "https://legacy.example/catalog" }), null);
});

test("runtime public list only treats active published rows as visible", () => {
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "published" }), true);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: false, status: "published" }), false);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "paused" }), false);
  assert.deepEqual(catalogSyncInternals.publicListFromPayload({ products: [{ id: "a" }] }), [{ id: "a" }]);
});

test("frontend uses the versioned Cloudflare snapshot as the fail-closed canonical public projection", () => {
  const getProductsBody = frontendApiSource.slice(
    frontendApiSource.indexOf("export async function getProducts"),
    frontendApiSource.indexOf("export async function getPublicSocialLinks"),
  );
  const snapshotIndex = getProductsBody.indexOf("getLastKnownGoodCatalogUrl()");
  const edgeIndex = getProductsBody.indexOf("getPublicCatalogApiUrl()");

  assert.ok(snapshotIndex >= 0, "versioned public snapshot must be available");
  assert.ok(edgeIndex > snapshotIndex, "optional Edge fallback must run only after the versioned snapshot fails");
  assert.match(frontendApiSource, /function getLastKnownGoodCatalogUrl\(\).*\/data\/products\.json/s);
  assert.match(getProductsBody, /snapshot público versionado/);
  assert.match(frontendApiSource, /VITE_PUBLIC_CATALOG_EDGE_BASE/);
  assert.doesNotMatch(frontendApiSource, /juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api/);
  assert.doesNotMatch(getProductsBody, /getPublicCatalogBackendFallbackUrl/);
  assert.match(frontendApiSource, /toPublicProductDTOs\(list\)/);
  assert.match(serverSource, /app\.get\("\/api\/products"/);
  assert.match(serverSource, /toPublicProductDTOs\(products\)/);
});

test("archive title hotfix loads after dark surface so the original h1 cannot reappear", () => {
  const darkSurfaceIndex = frontendMainSource.indexOf("design-system-dark-surface.css");
  const archiveFixIndex = frontendMainSource.indexOf("design-system-archive-title-fix.css");
  assert.ok(darkSurfaceIndex >= 0);
  assert.ok(archiveFixIndex > darkSurfaceIndex);
});

test("public Edge uses the shared whitelist and fetches human proof only for filtering", () => {
  assert.match(edgeSource, /toPublicProductDTOs/);
  assert.match(edgeSource, /\.eq\("ativo", true\)/);
  assert.match(edgeSource, /\.eq\("status", "published"\)/);
  assert.match(edgeSource, /human_editorial_review_id/);
  assert.match(edgeSource, /human_editorial_authorization_id/);
  assert.doesNotMatch(edgeSource, /curator_note/);
  assert.doesNotMatch(edgeSource, /AUTONOMOUS_DEFICIT_FALLBACK/);
});
