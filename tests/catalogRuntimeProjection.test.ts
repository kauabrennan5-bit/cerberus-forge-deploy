import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogSyncInternals } from "../server/services/catalogSync";

const catalogSyncSource = readFileSync(new URL("../server/services/catalogSync.ts", import.meta.url), "utf8");
const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");
const runtimeManifest = JSON.parse(readFileSync(new URL("../public/catalog-runtime.json", import.meta.url), "utf8"));
const OFFICIAL_EDGE = "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products";
const OFFICIAL_STOREFRONT = "https://cerberus-design-static.onrender.com";

test("catalog sync validates Supabase -> Edge -> official static storefront only", () => {
  assert.equal(catalogSyncSource.includes("cerberus-design-preview.onrender.com"), false);
  assert.equal(catalogSyncSource.includes("cerberus-static-catalog.onrender.com"), false);
  assert.equal(catalogSyncSource.includes("cerberus-forge-deploy-backend.onrender.com/api/products"), false);
  assert.match(catalogSyncSource, /cerberus-design-static\.onrender\.com/);
  assert.match(catalogSyncSource, /juiychcfdqxgnatffnla\.supabase\.co\/functions\/v1\/cerberus-public-api\/products/);
  assert.match(catalogSyncSource, /catalog-runtime\.json/);
  assert.match(catalogSyncSource, /categoryCountsMatch/);
  assert.match(catalogSyncSource, /productFoundPublic/);
});

test("storefront runtime manifest pins frontend-only mode to the canonical Edge API", () => {
  assert.deepEqual(runtimeManifest, { version: 2, mode: "runtime", frontendOnly: true, catalogApiUrl: OFFICIAL_EDGE });
  assert.deepEqual(catalogSyncInternals.parseStorefrontManifest(runtimeManifest), runtimeManifest);
  assert.equal(catalogSyncInternals.storefrontUrl({}), OFFICIAL_STOREFRONT);
  assert.equal(catalogSyncInternals.publicCatalogApiUrl({}), OFFICIAL_EDGE);
  assert.equal(catalogSyncInternals.parseStorefrontManifest({ ...runtimeManifest, frontendOnly: false }), null);
  assert.equal(catalogSyncInternals.parseStorefrontManifest({ ...runtimeManifest, catalogApiUrl: "https://cerberus-design-preview.onrender.com/api/products" }), null);
});

test("runtime list requires active published rows and Edge source", () => {
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "published" }), true);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: false, status: "published" }), false);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "paused" }), false);
  assert.deepEqual(catalogSyncInternals.publicListFromPayload({ source: "supabase-edge", products: [{ id: "a" }] }), [{ id: "a" }]);
  assert.deepEqual(catalogSyncInternals.publicListFromPayload({ source: "backend", products: [{ id: "a" }] }), []);
});

test("post-publication category validation detects count divergence", () => {
  assert.deepEqual(catalogSyncInternals.countCategories([{ categoria: "Infantil" }, { categoria: "Infantil" }, { categoria: "Cozinha & Mesa" }]), { Infantil: 2, "Cozinha & Mesa": 1 });
  assert.equal(catalogSyncInternals.sameCategoryCounts({ Infantil: 2 }, { Infantil: 2 }), true);
  assert.equal(catalogSyncInternals.sameCategoryCounts({ Infantil: 2 }, { Infantil: 1 }), false);
});

test("frontend public catalog has no backend fallback", () => {
  const getProductsBody = frontendApiSource.slice(frontendApiSource.indexOf("export async function getProducts"), frontendApiSource.indexOf("export async function verifyAdminPassword"));
  assert.match(getProductsBody, /getPublicCatalogApiUrl\(\)/);
  assert.match(getProductsBody, /Supabase Edge/);
  assert.equal(getProductsBody.includes("backend-fallback"), false);
  assert.equal(getProductsBody.includes("/api/products"), false);
  assert.equal(getProductsBody.includes("/data/products.json"), false);
});
