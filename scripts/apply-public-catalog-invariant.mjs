import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function patch(path, edits) {
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of edits) {
    if (!source.includes(from)) throw new Error(`PATCH_SOURCE_NOT_FOUND:${path}:${from.slice(0,80)}`);
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

const helper = `import type { Product } from "../../src/types";\n\nexport const PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION = "edge-v3";\n\nfunction imageCurationReady(value: unknown): boolean {\n  return Boolean(value) && typeof value === "object" && String((value as Record<string, unknown>).status || "") === "ready";\n}\n\nexport function isPublicCatalogEligibleProduct(product: Product): boolean {\n  return product.ativo === true\n    && product.status === "published"\n    && product.displayTitleStatus === "reviewed"\n    && product.imageEditorialStatus === "clean"\n    && product.displayTitle !== undefined\n    && product.displayTitle !== null\n    && imageCurationReady(product.imageCuration);\n}\n\nexport function isPublicCatalogEligibleDbRow(row: Record<string, unknown>): boolean {\n  return row.ativo === true\n    && String(row.status || "") === "published"\n    && String(row.display_title_status || "") === "reviewed"\n    && String(row.image_editorial_status || "") === "clean"\n    && row.display_title !== null\n    && row.display_title !== undefined\n    && imageCurationReady(row.image_curation);\n}\n`;
writeFileSync('server/services/publicCatalogEligibility.ts', helper);

patch('server/services/operatorHealthChecksV2.ts', [
  [
    'import type { ComponentObservation, OperationalStatus } from "./operatorAutonomy";\n',
    'import type { ComponentObservation, OperationalStatus } from "./operatorAutonomy";\nimport { isPublicCatalogEligibleDbRow, PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION } from "./publicCatalogEligibility";\n'
  ],
  [
    'const { data, error } = await client.from("products").select("id,status,ativo");',
    'const { data, error } = await client.from("products").select("id,status,ativo,categoria,display_title,display_title_status,image_editorial_status,image_curation");'
  ],
  [
    'const expectedIds = input.supabaseRows.filter(productIsPublic).map(productId).filter(Boolean).sort();',
    'const expectedIds = input.supabaseRows.filter(isPublicCatalogEligibleDbRow).map(productId).filter(Boolean).sort();'
  ],
  [
    'diagnostic: { urlRole: "public_catalog_projection", expectedCount: expectedIds.length, projectedCount: projectedIds.length, missingCount: missing.length, extraCount: extra.length, missingIds: missing.slice(0, 20), extraIds: extra.slice(0, 20) },',
    'diagnostic: { urlRole: "public_catalog_projection", eligibilityContract: PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, expectedCount: expectedIds.length, projectedCount: projectedIds.length, missingCount: missing.length, extraCount: extra.length, missingIds: missing.slice(0, 20), extraIds: extra.slice(0, 20) },'
  ],
]);

patch('server/services/catalogSync.ts', [
  [
    'import { persistOperationalEvent, persistOperationalOperation } from "../repositories/operationalMemoryRepository";\n',
    'import { persistOperationalEvent, persistOperationalOperation } from "../repositories/operationalMemoryRepository";\nimport { isPublicCatalogEligibleProduct, PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION } from "./publicCatalogEligibility";\n'
  ],
  [
    'const expectedPublic = canonicalProducts.filter(product => product.ativo !== false && product.status === "published");',
    'const expectedPublic = canonicalProducts.filter(isPublicCatalogEligibleProduct);'
  ],
  [
    'metadata: { productId: productId || undefined, publicJsonCount, storefrontUrl: staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontCatalogApiUrl, runtimeProjection: true }, schemaVersion: "1.0"',
    'metadata: { productId: productId || undefined, publicJsonCount, storefrontUrl: staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontCatalogApiUrl, runtimeProjection: true, eligibilityContract: PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION }, schemaVersion: "1.0"'
  ],
]);

patch('server/services/autonomousCuratorCategoryPolicy.ts', [
  [
    'import {\n  PUBLIC_PRODUCT_CATEGORIES,\n  type PublicProductCategory,\n} from "../../src/lib/productCategory";\n',
    'import {\n  PUBLIC_PRODUCT_CATEGORIES,\n  type PublicProductCategory,\n} from "../../src/lib/productCategory";\nimport { isPublicCatalogEligibleProduct } from "./publicCatalogEligibility";\n'
  ],
  [
    'if (!isActivePublishedProduct(product)) continue;',
    'if (!isPublicCatalogEligibleProduct(product)) continue;'
  ],
]);

const test = `import assert from "node:assert/strict";\nimport test from "node:test";\nimport type { Product } from "../src/types";\nimport {\n  isPublicCatalogEligibleDbRow,\n  isPublicCatalogEligibleProduct,\n  PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION,\n} from "../server/services/publicCatalogEligibility";\nimport { categoryCounts } from "../server/services/autonomousCuratorCategoryPolicy";\n\nfunction product(overrides: Partial<Product> = {}): Product {\n  return {\n    id: "p1", produto: "Peça", displayTitle: "Peça editorial", displayTitleStatus: "reviewed",\n    categoria: "Iluminação", preco: 10, imagens: ["https://cdn.example/p1.jpg"],\n    imageEditorialStatus: "clean", imageCuration: { status: "ready", raw: [], gallery: [], principal: "https://cdn.example/p1.jpg", decision: "approved", confidence: 1, reason: "test" } as any,\n    link: "https://shopee.example/p1", ativo: true, destaque: false, status: "published", ...overrides,\n  };\n}\n\ntest("public catalog eligibility mirrors Edge v3 editorial contract", () => {\n  assert.equal(PUBLIC_CATALOG_ELIGIBILITY_CONTRACT_VERSION, "edge-v3");\n  assert.equal(isPublicCatalogEligibleProduct(product()), true);\n  assert.equal(isPublicCatalogEligibleProduct(product({ displayTitleStatus: "unreviewed" })), false);\n  assert.equal(isPublicCatalogEligibleProduct(product({ imageEditorialStatus: "pending" as any })), false);\n  assert.equal(isPublicCatalogEligibleProduct(product({ imageCuration: { status: "rejected" } as any })), false);\n  assert.equal(isPublicCatalogEligibleProduct(product({ ativo: false })), false);\n});\n\ntest("database-row predicate requires the exact Edge v3 fields", () => {\n  const row = { id: "p1", ativo: true, status: "published", display_title: "Peça", display_title_status: "reviewed", image_editorial_status: "clean", image_curation: { status: "ready" } };\n  assert.equal(isPublicCatalogEligibleDbRow(row), true);\n  assert.equal(isPublicCatalogEligibleDbRow({ ...row, display_title_status: "unreviewed" }), false);\n  assert.equal(isPublicCatalogEligibleDbRow({ ...row, image_curation: { status: "pending" } }), false);\n});\n\ntest("category deficit counts only products eligible for the public Edge catalog", () => {\n  const counts = categoryCounts([\n    product({ id: "ok" }),\n    product({ id: "bad-title", displayTitleStatus: "unreviewed" }),\n    product({ id: "bad-image", imageEditorialStatus: "pending" as any }),\n  ]);\n  assert.equal(counts["Iluminação"], 1);\n});\n`;
writeFileSync('tests/publicCatalogEligibilityInvariant.test.ts', test);

console.log('public catalog invariant patch applied');
