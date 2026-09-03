import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogSyncInternals } from "../server/services/catalogSync";

const catalogSyncSource = readFileSync(new URL("../server/services/catalogSync.ts", import.meta.url), "utf8");
const frontendApiSource = readFileSync(new URL("../src/services/api.ts", import.meta.url), "utf8");

test("catalog sync validates the new frontend runtime and no longer promotes a static catalog branch", () => {
  assert.equal(catalogSyncSource.includes("cerberus-static-catalog.onrender.com"), false);
  assert.equal(catalogSyncSource.includes("syncCatalogToGitHub"), false);
  assert.match(catalogSyncSource, /https:\/\/cerberus-design-preview\.onrender\.com/);
  assert.match(catalogSyncSource, /https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/api\/products/);
  assert.match(catalogSyncSource, /storefrontHealthy/);
  assert.match(catalogSyncSource, /missingPublicIds/);
  assert.match(catalogSyncSource, /categoryMismatchIds/);
});

test("runtime public list only treats active published rows as visible", () => {
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "published" }), true);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: false, status: "published" }), false);
  assert.equal(catalogSyncInternals.isPublicRow({ id: "a", ativo: true, status: "paused" }), false);
  assert.deepEqual(catalogSyncInternals.publicListFromPayload({ products: [{ id: "a" }] }), [{ id: "a" }]);
});

test("frontend consumes the canonical backend API instead of its branch-local products.json", () => {
  const getProductsBody = frontendApiSource.slice(
    frontendApiSource.indexOf("export async function getProducts"),
    frontendApiSource.indexOf("export async function verifyAdminPassword"),
  );
  assert.match(getProductsBody, /getPublicCatalogApiUrl\(\)/);
  assert.equal(getProductsBody.includes("/data/products.json"), false);
  assert.match(getProductsBody, /product\.ativo !== false/);
  assert.match(getProductsBody, /product\.status === 'published'/);
  assert.match(frontendApiSource, /cerberus-forge-deploy-backend\.onrender\.com/);
});
