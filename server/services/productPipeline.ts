import type { Product } from "../../src/types";
import * as productsRepository from "../repositories/productsRepository";
import { syncCatalogAndDeploy } from "./catalogSync";
import { createOperationId, type OperationalDiagnostic, type OperationalFailureCode } from "./operationalDiagnostics";
import {
  curateCandidate,
  event,
  normalizeCandidate,
  transitionProductState,
  validateCandidate,
  containsRawPayloadMarkers,
  type ProductCandidate,
  type ProductCuration,
  type ProductPipelineError,
  type ProductLifecycleEvent,
  type ProductLifecycleState,
  type ProductValidation,
} from "./productLifecycle";

export interface LifecycleRecord {
  id: string;
  candidate: ProductCandidate;
  state: ProductLifecycleState;
  validation: ProductValidation;
  curation: ProductCuration;
  audit: ProductLifecycleEvent[];
  publishedProductId?: string;
  operationId?: string;
  error?: ProductPipelineError | OperationalFailureCode;
  diagnostic?: OperationalDiagnostic;
}

export interface PublicationVerification {
  success: boolean;
  operationId?: string;
  error?: string;
  diagnostic?: OperationalDiagnostic;
}

export interface ProductPipelineAdapters {
  getProducts: () => Promise<Product[]>;
  createCanonicalProduct: (candidate: ProductCandidate) => Promise<Product>;
  syncAndValidatePublication: (product: Product, operationId: string) => Promise<PublicationVerification>;
  pauseCanonicalProduct: (productId: string) => Promise<void>;
}

const recentLifecycleRecords = new Map<string, LifecycleRecord>();
const MAX_LIFECYCLE_TELEMETRY = 100;

function rememberLifecycleRecord(record: LifecycleRecord): void {
  recentLifecycleRecords.set(record.id, structuredClone(record));
  if (recentLifecycleRecords.size > MAX_LIFECYCLE_TELEMETRY) {
    const oldestId = recentLifecycleRecords.keys().next().value;
    if (oldestId) recentLifecycleRecords.delete(oldestId);
  }
}

export function getProductPipelineTelemetry(): { total: number; pendingApproval: number; errors: number; published: number; recent: LifecycleRecord[] } {
  const recent = [...recentLifecycleRecords.values()];
  return {
    total: recent.length,
    pendingApproval: recent.filter(record => record.state === "PENDING_APPROVAL").length,
    errors: recent.filter(record => record.state === "ERROR" || Boolean(record.error)).length,
    published: recent.filter(record => record.state === "PUBLISHED").length,
    recent: recent.slice(-10),
  };
}

function lifecycleId(): string {
  return `lifecycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function advance(record: LifecycleRecord, next: ProductLifecycleState, reason: string, type: ProductLifecycleEvent["type"]): void {
  transitionProductState(record.state, next);
  record.state = next;
  record.candidate.state = next;
  record.audit.unshift(event(type, next, reason));
  rememberLifecycleRecord(record);
}

/**
 * Orquestra o processo, mas nunca descobre/publica autonomamente: publicar requer approve().
 */
export class ProductPipeline {
  constructor(private readonly adapters: ProductPipelineAdapters) {}

  async evaluate(input: Partial<ProductCandidate> & { normalizedUrl?: string; link?: string }): Promise<LifecycleRecord> {
    const candidate = normalizeCandidate(input);
    const record: LifecycleRecord = {
      id: lifecycleId(),
      candidate,
      state: "DISCOVERED",
      validation: { outcome: "FAIL", errors: [], warnings: [] },
      curation: { score: 0, category: "Não classificada", confidence: "LOW", reasons: [], risks: [], recommendation: "REVIEW" },
      audit: [event("PRODUCT_DISCOVERED", "DISCOVERED", "Produto recebido para análise humana.")],
    };

    advance(record, "COLLECTING", "Dados coletados do scraper ou da entrada administrativa.", "PRODUCT_DISCOVERED");
    advance(record, "COLLECTED", "Dados disponíveis para normalização.", "PRODUCT_DISCOVERED");
    record.candidate = normalizeCandidate({ ...candidate, state: "COLLECTED" });
    advance(record, "VALIDATING", "Iniciando validação comercial e duplicidade.", "PRODUCT_DISCOVERED");
    record.validation = validateCandidate(record.candidate, await this.adapters.getProducts());

    if (record.validation.outcome === "FAIL") {
      advance(record, "ERROR", record.validation.errors.join(" ") || "Falha de validação.", "PRODUCT_REJECTED");
      record.error = "VALIDATION_ERROR";
      rememberLifecycleRecord(record);
      return record;
    }

    advance(record, "ANALYZING", "Validação concluída; iniciando classificação estruturada.", "PRODUCT_VALIDATED");
    advance(record, "CURATING", "Classificação baseada apenas em dados disponíveis.", "PRODUCT_VALIDATED");
    record.curation = curateCandidate(record.candidate, record.validation);

    if (record.curation.recommendation === "REJECT") {
      advance(record, "REJECTED", "Curadoria rejeitou dados insuficientes ou inválidos.", "PRODUCT_REJECTED");
      return record;
    }

    advance(record, "PENDING_APPROVAL", "Aprovação humana explícita é obrigatória antes da publicação.", "PRODUCT_APPROVAL_REQUESTED");
    return record;
  }

  approve(record: LifecycleRecord): LifecycleRecord {
    if (record.state === "APPROVED" || record.state === "PUBLISHED") return record;
    if (record.state !== "PENDING_APPROVAL") throw new Error("APPROVAL_REQUIRED");
    advance(record, "APPROVED", "Administrador autorizou a publicação.", "PRODUCT_APPROVED");
    return record;
  }

  reject(record: LifecycleRecord, reason = "Administrador rejeitou a proposta."): LifecycleRecord {
    if (record.state === "REJECTED") return record;
    if (record.state !== "PENDING_APPROVAL") throw new Error("INVALID_REJECTION_STATE");
    advance(record, "REJECTED", reason, "PRODUCT_REJECTED");
    return record;
  }

  async publish(record: LifecycleRecord): Promise<LifecycleRecord> {
    if (record.state === "PUBLISHED") return record;
    if (record.state !== "APPROVED") throw new Error("APPROVAL_REQUIRED");
    if (record.validation.outcome === "FAIL") throw new Error("VALIDATION_ERROR");
    if (containsRawPayloadMarkers(record.candidate.descricao)) {
      record.error = "VALIDATION_ERROR";
      record.audit.unshift(event("PRODUCT_PUBLICATION_FAILED", "APPROVED", "VALIDATION_ERROR: descrição contém payload técnico do scraper; publicação bloqueada."));
      rememberLifecycleRecord(record);
      return record;
    }

    try {
      const operationId = createOperationId("PUB");
      record.operationId = operationId;
      const product = await this.adapters.createCanonicalProduct(record.candidate);
      record.publishedProductId = product.id;
      const verification = await this.adapters.syncAndValidatePublication(product, operationId);
      if (!verification.success) {
        const verificationOperationId = verification.operationId || operationId;
        record.error = verification.diagnostic?.code || (verification.error as ProductPipelineError | undefined) || "PUBLICATION_ERROR";
        record.diagnostic = verification.diagnostic;
        record.audit.unshift(event(
          "PRODUCT_PUBLICATION_FAILED",
          "APPROVED",
          verification.diagnostic
            ? `${verification.diagnostic.code} na etapa ${verification.diagnostic.stage}; operação ${verificationOperationId}.`
            : verification.error || "Validação pública não confirmou a publicação.",
        ));
        rememberLifecycleRecord(record);
        return record;
      }
      advance(record, "PUBLISHED", "Supabase, projeção, GitHub e vitrine pública confirmados.", "PRODUCT_PUBLISHED");
      return record;
    } catch (error: any) {
      record.error = "PERSISTENCE_ERROR";
      record.audit.unshift(event("PRODUCT_PUBLICATION_FAILED", "APPROVED", `PERSISTENCE_ERROR: ${error?.message || "Falha de persistência/publicação."}`));
      rememberLifecycleRecord(record);
      return record;
    }
  }

  async pause(record: LifecycleRecord): Promise<LifecycleRecord> {
    if (record.state !== "PUBLISHED" || !record.publishedProductId) throw new Error("PRODUCT_NOT_PUBLISHED");
    await this.adapters.pauseCanonicalProduct(record.publishedProductId);
    advance(record, "PAUSED", "Produto pausado pelo administrador sem exclusão física.", "PRODUCT_PAUSED");
    return record;
  }

  archive(record: LifecycleRecord): LifecycleRecord {
    if (record.state !== "PUBLISHED" && record.state !== "PAUSED") throw new Error("PRODUCT_NOT_ARCHIVABLE");
    advance(record, "ARCHIVED", "Produto arquivado sem exclusão física.", "PRODUCT_ARCHIVED");
    return record;
  }
}

export function restoreLifecycleRecord(value: LifecycleRecord): LifecycleRecord {
  return {
    ...value,
    candidate: normalizeCandidate(value.candidate),
    audit: Array.isArray(value.audit) ? value.audit : [],
  };
}

// --- HOOKS DE TESTE CONTROLADO (padrão setXForTests da codebase) ---
// Substitui a fábrica do pipeline de produção SOMENTE em testes unitários;
// NUNCA usar em produção. Null restaura o adaptador de Supabase canônico.
let testPipelineFactory: (() => ProductPipeline) | null = null;

/** Substitui a fábrica do pipeline de produção em testes; null restaura o real. */
export function setTestProductPipeline(factory: (() => ProductPipeline) | null): void {
  testPipelineFactory = factory;
}

/** Adaptador de produção: Supabase continua canônico e a publicação só conclui após syncCatalogAndDeploy. */
export function createProductionProductPipeline(): ProductPipeline {
  if (testPipelineFactory) return testPipelineFactory();
  return new ProductPipeline({
    getProducts: () => productsRepository.getProducts(),
    createCanonicalProduct: candidate => productsRepository.createProduct({
      produto: candidate.produto,
      categoria: candidate.categoria,
      preco: candidate.preco || 0,
      imagens: candidate.imagens,
      link: candidate.normalizedUrl,
      descricao: candidate.descricao,
      status: "approved",
      ref: candidate.ref,
    }, { syncCatalog: false }),
    syncAndValidatePublication: async (product, operationId) => {
      const promoted = await productsRepository.updateProduct(product.id, { ativo: true, status: "published" }, { syncCatalog: false });
      if (!promoted) {
        return { success: false, operationId, error: "PERSISTENCE_ERROR" };
      }
      const result = await syncCatalogAndDeploy(product.produto, product.id, operationId);
      if (result.success) {
        return { success: true, operationId, diagnostic: undefined };
      }

      // A fonte canônica não deve apresentar um produto como publicado se a validação
      // pública falhou. A compensação é não destrutiva e nunca apaga o registro.
      await productsRepository.updateProduct(product.id, { ativo: false, status: "error" }, { syncCatalog: false });
      const rollback = await syncCatalogAndDeploy(`rollback de publicação ${product.id}`, undefined, operationId);
      if (!rollback.success) {
        return {
          success: false,
          operationId,
          error: "PUBLICATION_ERROR",
          diagnostic: rollback.diagnostic || result.diagnostic,
        };
      }
      return {
        success: false,
        operationId,
        error: result.error,
        diagnostic: result.diagnostic,
      };
    },
    pauseCanonicalProduct: async productId => {
      const product = await productsRepository.pauseProduct(productId);
      if (!product) throw new Error("PERSISTENCE_ERROR");
    },
  });
}
