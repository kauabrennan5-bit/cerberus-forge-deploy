import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogSyncInternals } from "../server/services/catalogSync";

const catalogSyncSource = readFileSync(new URL("../server/services/catalogSync.ts", import.meta.url), "utf8");
const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const runtimeManifest = JSON.parse(readFileSync(new URL("../public/catalog-runtime.json", import.meta.url), "utf8"));

test("catalog sync validates the new frontend runtime and no longer promotes a static catalog branch", () => {
  assert.equal(catalogSyncSource.includes("cerberus-static-catalog.onrender.com"), false);
  assert.equal(catalogSyncSource.includes("syncCatalogToGitHub"), false);
  assert.match(catalogSyncSource, /https:\/\/juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api\/products/);
  assert.equal(catalogSyncSource.includes("https://cerberus-forge-deploy-backend.onrender.com/api/products"), false);
  assert.match(catalogSyncSource, /catalog-runtime\.json/);
  assert.match(catalogSyncSource, /storefrontHealthy/);
  assert.match(catalogSyncSource, /missingPublicIds/);
  assert.match(catalogSyncSource, /categoryMismatchIds/);
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
