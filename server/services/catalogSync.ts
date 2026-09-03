import { exportStaticProductsJson } from "./exportProductsJson";
import { getProducts } from "../repositories/productsRepository";
import {
  createOperationId,
  createOperationalDiagnostic,
  sanitizeOperationalText,
  type OperationalDiagnostic,
} from "./operationalDiagnostics";
import { createOperationalEvent, emitOperationalEvent } from "./operationalEvents";
import { persistOperationalEvent, persistOperationalOperation } from "../repositories/operationalMemoryRepository";

const OFFICIAL_STOREFRONT_URL = "https://cerberus-design-static.onrender.com";
const OFFICIAL_PUBLIC_CATALOG_API_URL = "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products";
const LEGACY_PUBLIC_HOSTS = ["cerberus-design-preview.onrender.com", "cerberus-static-catalog.onrender.com", "cerberus-forge-deploy-backend.onrender.com/api/products"];

export interface SyncLogResult {
  success: boolean;
  operationId: string;
  product?: string;
  productId?: string;
  supabaseCount: number;
  jsonCount: number;
  publicJsonCount?: number;
  productFoundPublic?: boolean;
  staticSiteUrl: string;
  publicCatalogApiUrl?: string;
  storefrontHealthy?: boolean;
  storefrontCatalogApiUrl?: string;
  missingPublicIds?: string[];
  unexpectedPublicIds?: string[];
  categoryMismatchIds?: string[];
  categoryCountsMatch?: boolean;
  expectedCategoryCounts?: Record<string, number>;
  publicCategoryCounts?: Record<string, number>;
  commitSha?: string;
  diagnostic?: OperationalDiagnostic;
  error?: string;
}

type StorefrontRuntimeManifest = {
  version: number;
  mode: string;
  frontendOnly: boolean;
  catalogApiUrl: string;
};

let queuedSync: Promise<void> = Promise.resolve();

async function acquireCatalogSyncLock(): Promise<() => void> {
  let release!: () => void;
  const previous = queuedSync;
  queuedSync = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}

function assertCurrentArchitecture(url: string, label: string): string {
  const normalized = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(normalized)) throw new Error(`${label}_INVALID_URL`);
  if (LEGACY_PUBLIC_HOSTS.some(host => normalized.includes(host))) throw new Error(`${label}_LEGACY_URL_FORBIDDEN`);
  return normalized;
}

function storefrontUrl(env: NodeJS.ProcessEnv = process.env): string {
  return assertCurrentArchitecture(String(env.PUBLIC_STOREFRONT_URL || OFFICIAL_STOREFRONT_URL), "PUBLIC_STOREFRONT");
}

function publicCatalogApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return assertCurrentArchitecture(String(env.PUBLIC_CATALOG_API_URL || OFFICIAL_PUBLIC_CATALOG_API_URL), "PUBLIC_CATALOG_API");
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 15_000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "cerberus-catalog-sync" },
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeApiUrl(value: unknown): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parseStorefrontManifest(body: unknown): StorefrontRuntimeManifest | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const catalogApiUrl = normalizeApiUrl(row.catalogApiUrl);
  if (Number(row.version) < 1 || row.mode !== "runtime" || row.frontendOnly !== true || !/^https:\/\//i.test(catalogApiUrl)) return null;
  if (LEGACY_PUBLIC_HOSTS.some(host => catalogApiUrl.includes(host))) return null;
  return { version: Number(row.version), mode: "runtime", frontendOnly: true, catalogApiUrl };
}

async function fetchStorefrontManifest(url: string): Promise<StorefrontRuntimeManifest> {
  const { body } = await fetchJsonWithTimeout(`${url}/catalog-runtime.json?t=${Date.now()}`, 10_000);
  const manifest = parseStorefrontManifest(body);
  if (!manifest) throw new Error("STOREFRONT_RUNTIME_MANIFEST_INVALID");
  return manifest;
}

function publicListFromPayload(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (record.source && record.source !== "supabase-edge") return [];
  if (Array.isArray(record.products)) return record.products;
  if (Array.isArray(record.data)) return record.data;
  return [];
}

function isPublicRow(product: any): boolean {
  return Boolean(product?.id)
    && product?.ativo !== false
    && String(product?.status || "published") === "published";
}

function countCategories(rows: any[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const category = String(row?.categoria || "").trim();
    if (category) counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {});
}

function sameCategoryCounts(expected: Record<string, number>, actual: Record<string, number>): boolean {
  const categories = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...categories].every(category => (expected[category] || 0) === (actual[category] || 0));
}

function diagnosticForFailure(
  operationId: string,
  stage: OperationalDiagnostic["stage"],
  dependency: OperationalDiagnostic["dependency"],
  error: unknown,
  overrides: Partial<Pick<OperationalDiagnostic, "code" | "message" | "likelyCause" | "impact" | "recoverability" | "retryable">> = {},
): OperationalDiagnostic {
  const candidate = error as { status?: number };
  const defaults: Record<string, Pick<OperationalDiagnostic, "code" | "message" | "likelyCause" | "impact" | "recoverability" | "retryable">> = {
    SUPABASE_READ: { code: "SUPABASE_PERSISTENCE_ERROR", message: "Não foi possível ler produtos da fonte canônica.", likelyCause: "Supabase indisponível, credencial inválida, RLS inesperada ou schema incompatível.", impact: "A projeção do catálogo não pode ser validada com segurança.", recoverability: "MANUAL", retryable: true },
    CATALOG_EXPORT: { code: "CATALOG_GENERATION_ERROR", message: "A projeção local de auditoria do catálogo não foi gerada.", likelyCause: "Filtro de publicação, serialização ou gravação local de products.json falhou.", impact: "A auditoria local do catálogo ficou indisponível; nenhuma publicação deve ser declarada concluída.", recoverability: "AUTO", retryable: true },
    PUBLIC_CATALOG_VALIDATION: { code: "PUBLIC_CATALOG_VALIDATION_ERROR", message: "Supabase Edge e o storefront oficial não confirmaram a projeção canônica dentro do prazo.", likelyCause: "Supabase Edge indisponível, manifest do cerberus-design-static incorreto ou divergência entre public.products e a projeção pública.", impact: "A publicação não pode ser declarada PUBLISHED_AND_PUBLICLY_VALIDATED.", recoverability: "AUTO", retryable: true },
  };
  const fallback = defaults[stage] || defaults.PUBLIC_CATALOG_VALIDATION;
  return createOperationalDiagnostic({ operationId, operation: "CATALOG_SYNC", stage, dependency, ...fallback, ...overrides, httpStatus: candidate?.status, cause: error });
}

/**
 * Arquitetura pública canônica:
 * public.products (Supabase) -> cerberus-public-api (Supabase Edge) -> cerberus-design-static.
 * Backend /api/products, design-preview e static-catalog são proibidos como fontes de validação.
 */
export async function syncCatalogAndDeploy(productTitle?: string, productId?: string, operationId = createOperationId("SYNC")): Promise<SyncLogResult> {
  const release = await acquireCatalogSyncLock();
  const staticSiteUrl = storefrontUrl();
  const catalogApiUrl = publicCatalogApiUrl();
  let supabaseCount = 0;
  let jsonCount = 0;
  let publicJsonCount = 0;
  let productFoundPublic = false;
  let storefrontHealthy = false;
  let storefrontCatalogApiUrl: string | undefined;
  let missingPublicIds: string[] = [];
  let unexpectedPublicIds: string[] = [];
  let categoryMismatchIds: string[] = [];
  let expectedCategoryCounts: Record<string, number> = {};
  let publicCategoryCounts: Record<string, number> = {};
  let categoryCountsMatch = false;
  const operationStartedAt = new Date().toISOString();

  void persistOperationalOperation({ operationId, operationType: "CATALOG_SYNC", status: "RUNNING", actor: "system", correlationId: operationId, attempt: 1, createdAt: operationStartedAt, startedAt: operationStartedAt, metadata: { productId: productId || undefined, storefrontUrl: staticSiteUrl, publicCatalogApiUrl: catalogApiUrl }, schemaVersion: "1.0" })
    .catch(error => console.warn(`[MEMORY] memory.persistence.failed operationId=${operationId} reason=${sanitizeOperationalText(error)}`));

  try {
    let canonicalProducts;
    try {
      canonicalProducts = await getProducts();
      supabaseCount = canonicalProducts.length;
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "SUPABASE_READ", "Supabase", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontHealthy, diagnostic, error: diagnostic.code };
    }

    try {
      jsonCount = await exportStaticProductsJson();
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "CATALOG_EXPORT", "Exportador", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontHealthy, diagnostic, error: diagnostic.code };
    }

    const expectedPublic = canonicalProducts.filter(product => product.ativo !== false && product.status === "published");
    const expectedPublicIds = new Set<string>(expectedPublic.map(product => String(product.id)));
    const expectedCategoryById = new Map<string, string>(expectedPublic.map(product => [String(product.id), String(product.categoria)]));
    expectedCategoryCounts = countCategories(expectedPublic);
    let lastFailure: unknown = new Error("Supabase Edge ainda não forneceu a projeção esperada.");

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      try {
        const [{ body }, manifest] = await Promise.all([
          fetchJsonWithTimeout(`${catalogApiUrl}${catalogApiUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, 10_000),
          fetchStorefrontManifest(staticSiteUrl),
        ]);
        storefrontCatalogApiUrl = manifest.catalogApiUrl;
        storefrontHealthy = normalizeApiUrl(staticSiteUrl) === OFFICIAL_STOREFRONT_URL
          && normalizeApiUrl(manifest.catalogApiUrl) === normalizeApiUrl(catalogApiUrl)
          && normalizeApiUrl(catalogApiUrl) === OFFICIAL_PUBLIC_CATALOG_API_URL
          && manifest.frontendOnly === true
          && manifest.mode === "runtime";
        const visibleRows = publicListFromPayload(body).filter(isPublicRow);
        publicJsonCount = visibleRows.length;
        const publicIds = new Set<string>(visibleRows.map((product: any) => String(product.id)).filter((id: string) => Boolean(id)));
        missingPublicIds = [...expectedPublicIds].filter(id => !publicIds.has(id));
        unexpectedPublicIds = [...publicIds].filter(id => !expectedPublicIds.has(id));
        categoryMismatchIds = visibleRows.filter((product: any) => expectedCategoryById.has(String(product.id)) && expectedCategoryById.get(String(product.id)) !== String(product.categoria)).map((product: any) => String(product.id));
        publicCategoryCounts = countCategories(visibleRows);
        categoryCountsMatch = sameCategoryCounts(expectedCategoryCounts, publicCategoryCounts);
        const hasInvalidIdentity = visibleRows.some((product: any) => !product?.id || !product?.slug || !(product?.displayTitle || product?.display_title || product?.produto) || !product?.link || !product?.categoria);
        productFoundPublic = productId ? expectedPublicIds.has(productId) && publicIds.has(productId) : missingPublicIds.length === 0;

        if (storefrontHealthy && missingPublicIds.length === 0 && unexpectedPublicIds.length === 0 && categoryMismatchIds.length === 0 && categoryCountsMatch && !hasInvalidIdentity && productFoundPublic) {
          const completionEvent = createOperationalEvent({ eventType: "catalog.build.completed", source: "catalogSync", actor: "system", correlationId: operationId, severity: "INFO", outcome: "SUCCESS", payload: { productId: productId || undefined, supabaseCount, jsonCount, publicJsonCount, expectedPublicCount: expectedPublicIds.size, expectedCategoryCounts, publicCategoryCounts, storefrontUrl: staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontCatalogApiUrl, runtimeProjection: true } });
          emitOperationalEvent(completionEvent);
          void persistOperationalEvent(completionEvent).catch(error => console.warn(`[MEMORY] memory.persistence.failed eventId=${completionEvent.eventId} reason=${sanitizeOperationalText(error)}`));
          void persistOperationalOperation({ operationId, operationType: "CATALOG_SYNC", status: "SUCCEEDED", actor: "system", correlationId: operationId, attempt: 1, createdAt: operationStartedAt, startedAt: operationStartedAt, completedAt: new Date().toISOString(), resultCode: "CATALOG_RUNTIME_VALIDATED", metadata: { productId: productId || undefined, publicJsonCount, expectedCategoryCounts, publicCategoryCounts, storefrontUrl: staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontCatalogApiUrl, runtimeProjection: true }, schemaVersion: "1.0" }).catch(error => console.warn(`[MEMORY] memory.persistence.failed operationId=${operationId} reason=${sanitizeOperationalText(error)}`));
          return { success: true, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontHealthy, storefrontCatalogApiUrl, missingPublicIds, unexpectedPublicIds, categoryMismatchIds, categoryCountsMatch, expectedCategoryCounts, publicCategoryCounts };
        }
        lastFailure = new Error(`Divergência runtime: missing=${missingPublicIds.length}, unexpected=${unexpectedPublicIds.length}, categoryMismatch=${categoryMismatchIds.length}, categoryCountsMatch=${categoryCountsMatch}, invalidIdentity=${hasInvalidIdentity}, storefrontHealthy=${storefrontHealthy}, productFoundPublic=${productFoundPublic}.`);
      } catch (error) {
        lastFailure = error;
      }
      if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 5_000));
    }

    const diagnostic = diagnosticForFailure(operationId, "PUBLIC_CATALOG_VALIDATION", "Supabase", lastFailure, { message: "A projeção pública não confirmou Supabase + Edge + cerberus-design-static.", likelyCause: "A Edge não reflete public.products, catalog-runtime.json não aponta para a Edge canônica ou existe divergência de IDs/categorias.", impact: "O produto permanece sem validação pública final e o Curator deve tratar a publicação como falha." });
    console.warn(`[Catalog Sync] operation=${operationId} code=${diagnostic.code} cause=${sanitizeOperationalText(lastFailure)}`);
    return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, publicCatalogApiUrl: catalogApiUrl, storefrontHealthy, storefrontCatalogApiUrl, missingPublicIds, unexpectedPublicIds, categoryMismatchIds, categoryCountsMatch, expectedCategoryCounts, publicCategoryCounts, diagnostic, error: diagnostic.code };
  } finally {
    release();
  }
}

export const catalogSyncInternals = { storefrontUrl, publicCatalogApiUrl, normalizeApiUrl, parseStorefrontManifest, publicListFromPayload, isPublicRow, countCategories, sameCategoryCounts, OFFICIAL_STOREFRONT_URL, OFFICIAL_PUBLIC_CATALOG_API_URL };
