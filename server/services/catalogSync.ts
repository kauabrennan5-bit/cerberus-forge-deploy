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

export interface PublicCatalogValidation {
  backendDataValidated: boolean;
  backendApiValidated: boolean;
  frontendReachable: boolean;
  productRouteReachable: boolean;
  expectedPublicCount: number;
  backendDataCount: number;
  backendApiCount: number;
}

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
  backendUrl?: string;
  validation?: PublicCatalogValidation;
  // Kept for backwards compatibility with existing callers. Runtime sync no longer
  // creates a GitHub catalog commit or waits for a frontend deploy.
  commitSha?: string;
  diagnostic?: OperationalDiagnostic;
  error?: string;
}

let queuedSync: Promise<void> = Promise.resolve();

async function acquireCatalogSyncLock(): Promise<() => void> {
  let release!: () => void;
  const previous = queuedSync;
  queuedSync = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}

async function fetchWithTimeout(url: string, timeoutMs = 15_000): Promise<Response> {
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
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 15_000): Promise<{ status: number; body: unknown }> {
  const response = await fetchWithTimeout(url, timeoutMs);
  return { status: response.status, body: await response.json() };
}

function publicProductsFromApiBody(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const envelope = body as { products?: unknown; data?: unknown };
  if (Array.isArray(envelope.products)) return envelope.products;
  if (Array.isArray(envelope.data)) return envelope.data;
  return [];
}

function activePublished(products: any[]): any[] {
  return products.filter(product => product?.ativo !== false && product?.status === "published");
}

function compareCatalogIdentity(expected: any[], actual: any[]): {
  ok: boolean;
  missingIds: string[];
  unexpectedIds: string[];
  hasInvalidIdentity: boolean;
} {
  const expectedIds = new Set(expected.map(product => String(product?.id || "")).filter(Boolean));
  const actualIds = new Set(actual.map(product => String(product?.id || "")).filter(Boolean));
  const missingIds = [...expectedIds].filter(id => !actualIds.has(id));
  const unexpectedIds = [...actualIds].filter(id => !expectedIds.has(id));
  const hasInvalidIdentity = actual.some(product => !product?.id || !product?.slug || !product?.produto || !product?.link);
  return {
    ok: missingIds.length === 0 && unexpectedIds.length === 0 && !hasInvalidIdentity,
    missingIds,
    unexpectedIds,
    hasInvalidIdentity,
  };
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
    SUPABASE_READ: {
      code: "SUPABASE_PERSISTENCE_ERROR",
      message: "Não foi possível ler produtos da fonte canônica.",
      likelyCause: "Supabase indisponível, credencial inválida, RLS inesperada ou schema incompatível.",
      impact: "A projeção do catálogo não pode ser gerada com segurança.",
      recoverability: "MANUAL",
      retryable: true,
    },
    CATALOG_EXPORT: {
      code: "CATALOG_GENERATION_ERROR",
      message: "A projeção runtime do catálogo não foi gerada.",
      likelyCause: "Filtro de publicação, serialização ou gravação de products.json falhou.",
      impact: "O backend não pode servir a projeção pública mais recente.",
      recoverability: "AUTO",
      retryable: true,
    },
    PUBLIC_CATALOG_VALIDATION: {
      code: "PUBLIC_CATALOG_VALIDATION_ERROR",
      message: "Backend, API e frontend público não confirmaram a mesma projeção dentro do prazo.",
      likelyCause: "Projeção runtime divergente, API indisponível, frontend indisponível ou produto ainda não observável publicamente.",
      impact: "A publicação não pode ser declarada PUBLISHED_AND_PUBLICLY_VALIDATED.",
      recoverability: "AUTO",
      retryable: true,
    },
  };
  const fallback = defaults[stage] || defaults.PUBLIC_CATALOG_VALIDATION;
  return createOperationalDiagnostic({
    operationId,
    operation: "CATALOG_SYNC",
    stage,
    dependency,
    ...fallback,
    ...overrides,
    httpStatus: candidate?.status,
    cause: error,
  });
}

export async function validateCatalogPublicly(
  canonicalProducts: any[],
  productId?: string,
): Promise<{ ok: boolean; validation: PublicCatalogValidation; error?: Error }> {
  const backendUrl = (
    process.env.PUBLIC_BACKEND_URL
    || process.env.RENDER_EXTERNAL_URL
    || "https://cerberus-forge-deploy-backend.onrender.com"
  ).replace(/\/+$/, "");
  const frontendUrl = (
    process.env.PUBLIC_SITE_URL
    || "https://cerberus-design-preview.onrender.com"
  ).replace(/\/+$/, "");
  const expected = activePublished(canonicalProducts);
  const expectedProduct = productId ? expected.find(product => String(product?.id) === String(productId)) : undefined;

  let backendDataValidated = false;
  let backendApiValidated = false;
  let frontendReachable = false;
  let productRouteReachable = !expectedProduct;
  let backendDataCount = 0;
  let backendApiCount = 0;
  let lastError: Error | undefined;

  try {
    const [{ body: dataBody }, { body: apiBody }] = await Promise.all([
      fetchJsonWithTimeout(`${backendUrl}/data/products.json?t=${Date.now()}`, 10_000),
      fetchJsonWithTimeout(`${backendUrl}/api/products?t=${Date.now()}`, 10_000),
    ]);

    if (!Array.isArray(dataBody)) throw new Error("products.json runtime não contém uma lista.");
    const backendData = dataBody as any[];
    const apiProducts = activePublished(publicProductsFromApiBody(apiBody));
    backendDataCount = backendData.length;
    backendApiCount = apiProducts.length;

    const dataDiff = compareCatalogIdentity(expected, backendData);
    const apiDiff = compareCatalogIdentity(expected, apiProducts);
    backendDataValidated = dataDiff.ok;
    backendApiValidated = apiDiff.ok;

    if (!dataDiff.ok) {
      throw new Error(`Runtime data divergente: missing=${dataDiff.missingIds.length} unexpected=${dataDiff.unexpectedIds.length} invalidIdentity=${dataDiff.hasInvalidIdentity}.`);
    }
    if (!apiDiff.ok) {
      throw new Error(`API divergente: missing=${apiDiff.missingIds.length} unexpected=${apiDiff.unexpectedIds.length} invalidIdentity=${apiDiff.hasInvalidIdentity}.`);
    }

    await fetchWithTimeout(`${frontendUrl}/?catalog_probe=${Date.now()}`, 10_000);
    frontendReachable = true;

    if (expectedProduct?.slug) {
      await fetchWithTimeout(`${frontendUrl}/produto/${encodeURIComponent(expectedProduct.slug)}?catalog_probe=${Date.now()}`, 10_000);
      productRouteReachable = true;
    }

    const publicIds = new Set(backendData.map(product => String(product?.id || "")).filter(Boolean));
    if (productId && !publicIds.has(String(productId))) {
      throw new Error(`Produto ${productId} não está presente na projeção pública runtime.`);
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
  }

  const validation: PublicCatalogValidation = {
    backendDataValidated,
    backendApiValidated,
    frontendReachable,
    productRouteReachable,
    expectedPublicCount: expected.length,
    backendDataCount,
    backendApiCount,
  };
  return {
    ok: backendDataValidated && backendApiValidated && frontendReachable && productRouteReachable && !lastError,
    validation,
    error: lastError,
  };
}

/**
 * Pipeline canônico runtime: public.products → products.json do backend → API → frontend atual.
 * Não cria commit de catálogo nem espera deploy. Uma operação só retorna sucesso depois que
 * a projeção pública runtime, a API e a aplicação frontend atual estão observáveis.
 */
export async function syncCatalogAndDeploy(productTitle?: string, productId?: string, operationId = createOperationId("SYNC")): Promise<SyncLogResult> {
  const release = await acquireCatalogSyncLock();
  const backendUrl = (
    process.env.PUBLIC_BACKEND_URL
    || process.env.RENDER_EXTERNAL_URL
    || "https://cerberus-forge-deploy-backend.onrender.com"
  ).replace(/\/+$/, "");
  const staticSiteUrl = (process.env.PUBLIC_SITE_URL || "https://cerberus-design-preview.onrender.com").replace(/\/+$/, "");
  let supabaseCount = 0;
  let jsonCount = 0;
  let publicJsonCount = 0;
  let productFoundPublic = false;
  const operationStartedAt = new Date().toISOString();
  void persistOperationalOperation({
    operationId,
    operationType: "CATALOG_SYNC",
    status: "RUNNING",
    actor: "system",
    correlationId: operationId,
    attempt: 1,
    createdAt: operationStartedAt,
    startedAt: operationStartedAt,
    metadata: { productId: productId || undefined },
    schemaVersion: "1.0",
  }).catch(error => console.warn(`[MEMORY] memory.persistence.failed operationId=${operationId} reason=${sanitizeOperationalText(error)}`));

  try {
    let canonicalProducts: any[];
    try {
      canonicalProducts = await getProducts();
      supabaseCount = canonicalProducts.length;
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "SUPABASE_READ", "Supabase", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, backendUrl, diagnostic, error: diagnostic.code };
    }

    try {
      jsonCount = await exportStaticProductsJson();
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "CATALOG_EXPORT", "Exportador", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, backendUrl, diagnostic, error: diagnostic.code };
    }

    let lastFailure: unknown = new Error("Catálogo runtime ainda não confirmou a projeção esperada.");
    let lastValidation: PublicCatalogValidation | undefined;
    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const checked = await validateCatalogPublicly(canonicalProducts, productId);
      lastValidation = checked.validation;
      publicJsonCount = checked.validation.backendDataCount;
      productFoundPublic = !productId || checked.ok;

      if (checked.ok) {
        const completionEvent = createOperationalEvent({
          eventType: "catalog.build.completed",
          source: "catalogSync",
          actor: "system",
          correlationId: operationId,
          severity: "INFO",
          outcome: "SUCCESS",
          payload: {
            productId: productId || undefined,
            supabaseCount,
            jsonCount,
            publicJsonCount,
            expectedPublicCount: checked.validation.expectedPublicCount,
            backendApiCount: checked.validation.backendApiCount,
            frontendReachable: checked.validation.frontendReachable,
            syncMode: "RUNTIME_NO_DEPLOY",
          },
        });
        emitOperationalEvent(completionEvent);
        void persistOperationalEvent(completionEvent).catch(error => console.warn(`[MEMORY] memory.persistence.failed eventId=${completionEvent.eventId} reason=${sanitizeOperationalText(error)}`));
        void persistOperationalOperation({
          operationId,
          operationType: "CATALOG_SYNC",
          status: "SUCCEEDED",
          actor: "system",
          correlationId: operationId,
          attempt: 1,
          createdAt: operationStartedAt,
          startedAt: operationStartedAt,
          completedAt: new Date().toISOString(),
          resultCode: "CATALOG_RUNTIME_VALIDATED",
          metadata: { productId: productId || undefined, publicJsonCount, validation: checked.validation },
          schemaVersion: "1.0",
        }).catch(error => console.warn(`[MEMORY] memory.persistence.failed operationId=${operationId} reason=${sanitizeOperationalText(error)}`));
        return {
          success: true,
          operationId,
          product: productTitle,
          productId,
          supabaseCount,
          jsonCount,
          publicJsonCount,
          productFoundPublic: true,
          staticSiteUrl,
          backendUrl,
          validation: checked.validation,
        };
      }

      lastFailure = checked.error || lastFailure;
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 2_000));
    }

    const diagnostic = diagnosticForFailure(operationId, "PUBLIC_CATALOG_VALIDATION", "Public Runtime", lastFailure);
    console.warn(`[Catalog Sync] operation=${operationId} code=${diagnostic.code} cause=${sanitizeOperationalText(lastFailure)}`);
    return {
      success: false,
      operationId,
      product: productTitle,
      productId,
      supabaseCount,
      jsonCount,
      publicJsonCount,
      productFoundPublic,
      staticSiteUrl,
      backendUrl,
      validation: lastValidation,
      diagnostic,
      error: diagnostic.code,
    };
  } finally {
    release();
  }
}
