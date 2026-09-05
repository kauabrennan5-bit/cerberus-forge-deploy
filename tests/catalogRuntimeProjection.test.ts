import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogSyncInternals } from "../server/services/catalogSync";

const catalogSyncSource = readFileSync(new URL("../server/services/catalogSync.ts", import.meta.url), "utf8");
const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
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
    "https://cerberus-design-static.onrender.com",
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

test("frontend consumes the canonical Edge API instead of its branch-local products.json", () => {
  const getProductsBody = frontendApiSource.slice(
    frontendApiSource.indexOf("export async function getProducts"),
    frontendApiSource.indexOf("export async function verifyAdminPassword"),
  );
  assert.match(getProductsBody, /getPublicCatalogApiUrl\(\)/);
  assert.equal(getProductsBody.includes("/data/products.json"), false);
  assert.match(getProductsBody, /product\.ativo !== false/);
  assert.match(getProductsBody, /product\.status === 'published'/);
  assert.match(frontendApiSource, /juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api/);
});

test("public Edge exposes strict editorial rows plus technically authorized deficit fallback rows", () => {
  assert.match(edgeSource, /isStrictEditorialRow/);
  assert.match(edgeSource, /isDeficitFallbackPublicRow/);
  assert.match(edgeSource, /AUTONOMOUS_DEFICIT_FALLBACK_CREATED_BY = "autonomous_curator_queue"/);
  assert.match(edgeSource, /AUTONOMOUS_DEFICIT_FALLBACK_IMAGE_MODEL = "deficit-fallback"/);
  assert.match(edgeSource, /image_review_fingerprint/);
  assert.match(edgeSource, /validShopeeAffiliateLink/);
  assert.match(edgeSource, /\.not\("display_title", "is", null\)/);
});
