import { exportStaticProductsJson } from "./exportProductsJson";
import { getProducts } from "../repositories/productsRepository";
import { syncCatalogToGitHub } from "./githubCatalogSync";
import {
  createOperationId,
  createOperationalDiagnostic,
  sanitizeOperationalText,
  type OperationalDiagnostic,
} from "./operationalDiagnostics";

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

async function fetchJsonWithTimeout(url: string, timeoutMs = 15_000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "cerberus-catalog-sync" } });
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
      message: "A projeção local do catálogo não foi gerada.",
      likelyCause: "Filtro de publicação, serialização ou gravação de products.json falhou.",
      impact: "Não existe artefato consistente para versionar no GitHub.",
      recoverability: "AUTO",
      retryable: true,
    },
    PUBLIC_CATALOG_VALIDATION: {
      code: "PUBLIC_CATALOG_VALIDATION_ERROR",
      message: "O catálogo público não confirmou a projeção versionada dentro do prazo.",
      likelyCause: "Build pendente/falho no Static Site, propagação de CDN ou divergência entre o artefato público e o commit gerado.",
      impact: "A publicação não pode ser declarada concluída para o administrador.",
      recoverability: "ADMIN_APPROVAL",
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

/**
 * Pipeline canônico: public.products → products.json local → GitHub/main → Static Site público.
 * Uma operação só retorna sucesso após identidade e contagem compatíveis no catálogo público.
 */
export async function syncCatalogAndDeploy(productTitle?: string, productId?: string, operationId = createOperationId("SYNC")): Promise<SyncLogResult> {
  const release = await acquireCatalogSyncLock();
  const staticSiteUrl = (process.env.STATIC_CATALOG_URL || "https://cerberus-static-catalog.onrender.com").replace(/\/+$/, "");
  let supabaseCount = 0;
  let jsonCount = 0;
  let publicJsonCount = 0;
  let productFoundPublic = false;

  try {
    let canonicalProducts;
    try {
      canonicalProducts = await getProducts();
      supabaseCount = canonicalProducts.length;
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "SUPABASE_READ", "Supabase", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, diagnostic, error: diagnostic.code };
    }

    try {
      jsonCount = await exportStaticProductsJson();
    } catch (error) {
      const diagnostic = diagnosticForFailure(operationId, "CATALOG_EXPORT", "Exportador", error);
      return { success: false, operationId, product: productTitle, productId, supabaseCount, jsonCount, publicJsonCount, productFoundPublic, staticSiteUrl, diagnostic, error: diagnostic.code };
    }

    const github = await syncCatalogToGitHub(
      productTitle ? `update: catalog ${productTitle}` : "update: manual catalog sync",
      { operationId },
    );
    if (!github.success) {
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
        diagnostic: github.diagnostic,
        error: github.diagnostic?.code || "GITHUB_SYNC_ERROR",
      };
    }

    const expectedPublicIds = new Set(
      canonicalProducts
        .filter(product => product.ativo !== false && product.status === "published")
        .map(product => product.id),
    );
    let lastFailure: unknown = new Error("O Static Site ainda não forneceu a projeção esperada.");
    const maxAttempts = 18;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { body } = await fetchJsonWithTimeout(`${staticSiteUrl}/data/products.json?t=${Date.now()}`, 10_000);
        if (!Array.isArray(body)) throw new Error("products.json público não contém uma lista.");
        publicJsonCount = body.length;
        const publicIds = new Set(body.map((product: any) => product?.id).filter(Boolean));
        const missingIds = [...expectedPublicIds].filter(id => !publicIds.has(id));
        const unexpectedIds = [...publicIds].filter(id => !expectedPublicIds.has(id));
        const hasInvalidIdentity = body.some((product: any) => !product?.id || !product?.slug || !product?.produto || !product?.link);
        productFoundPublic = productId ? publicIds.has(productId) : missingIds.length === 0;

        if (missingIds.length === 0 && unexpectedIds.length === 0 && !hasInvalidIdentity && productFoundPublic) {
          console.info(`[Catalog Sync] operation=${operationId} commit=${github.commitSha?.slice(0, 7)} public=${publicJsonCount}/${expectedPublicIds.size}`);
          return {
            success: true,
            operationId,
            product: productTitle,
            productId,
            supabaseCount,
            jsonCount,
            publicJsonCount,
            productFoundPublic,
            staticSiteUrl,
            commitSha: github.commitSha,
          };
        }
        lastFailure = new Error(`Divergência de catálogo: ${missingIds.length} ID(s) ausente(s), ${unexpectedIds.length} ID(s) órfão(s), identidade inválida=${hasInvalidIdentity}.`);
      } catch (error) {
        lastFailure = error;
      }
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 5_000));
    }

    const diagnostic = diagnosticForFailure(operationId, "PUBLIC_CATALOG_VALIDATION", "Render Static Site", lastFailure);
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
      commitSha: github.commitSha,
      diagnostic,
      error: diagnostic.code,
    };
  } finally {
    release();
  }
}
