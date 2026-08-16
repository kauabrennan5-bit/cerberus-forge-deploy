// ============================================================================
// Bloco N5 — Governed Publication — Adapter Supabase (production wire-up)
//
// - Conecta o Publication Executor ao N1/N4 e a products via REPOSITÓRIOS
//   existentes (sem criar segunda fonte de verdade).
// - NÃO modifica produtos existentes; apenas cria produto novo e vincula
//   o candidate promovido (promoteToProduct do N1).
// - Fail-safe: qualquer erro retorna {ok:false} e a decisão é do executor.
// ============================================================================
import * as candidatesRepository from "../../repositories/candidatesRepository";
import * as candidateAssessmentRepository from "../../repositories/candidateAssessmentRepository";
import * as productsRepository from "../../repositories/productsRepository";
import {
  createOperationalEvent,
  type OperationalEventInput,
} from "../../services/operationalEvents";
import {
  persistOperationalEvent,
} from "../../repositories/operationalMemoryRepository";
import type {
  AssessmentForPublication,
  CandidateForPublication,
  PublicationRepositoryAdapter,
} from "./publicationExecutor";

function toCandidateForPublication(
  record: candidatesRepository.CandidateRecord
): CandidateForPublication {
  return Object.freeze({
    candidateId: record.candidate_id,
    status: record.status,
    promotedProductId: record.promoted_product_id,
    sourceUrl: record.source_url,
    marketplace: record.marketplace,
    title: record.title,
    description: record.description || null,
    category: record.category,
    observedPrice: record.observed_price,
    images: Array.isArray(record.metadata?.images)
      ? ([...(record.metadata.images as ReadonlyArray<string>)] as string[])
      : null,
    slug: (typeof record.metadata?.slug === "string" ? record.metadata.slug : null) ?? `cand-${record.candidate_id}`,
    ref: typeof record.metadata?.ref === "string" ? record.metadata.ref : null,
  });
}

function toAssessmentForPublication(
  row: Record<string, unknown>
): AssessmentForPublication | null {
  const id = typeof row.assessment_id === "string" ? row.assessment_id : null;
  if (!id) return null;
  const contradictions = Array.isArray(row.contradictions) ? row.contradictions : [];
  const collectionFailures = Array.isArray(row.collection_failures) ? row.collection_failures : [];
  const isActionable = row.is_actionable === true || row.is_actionable === "true" || row.is_actionable === 1;
  return Object.freeze({
    assessmentId: id,
    candidateId: typeof row.candidate_id === "string" ? row.candidate_id : "",
    filterVersion: typeof row.filter_version === "string" ? row.filter_version : "",
    classification: typeof row.classification === "string" ? row.classification : null,
    isActionable,
    recommendation: typeof row.recommendation === "string" ? row.recommendation : null,
    recommendationBasis: typeof row.recommendation_basis === "string" ? row.recommendation_basis : "",
    priorityLevel: typeof row.priority_level === "string" ? row.priority_level : null,
    priorityScore: typeof row.priority_score === "number" ? row.priority_score : null,
    unknowns: Array.isArray(row.unknowns) ? row.unknowns : [],
    contradictions,
    collectionFailures,
    evidenceRefs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
    inputSnapshot: (row.input_snapshot as Record<string, unknown>) ?? {},
  });
}

/** Adapter Supabase — production wire-up do Publication Executor. */
export const supabasePublicationAdapter: PublicationRepositoryAdapter = {
  async getCandidate(candidateId: string): Promise<CandidateForPublication | null> {
    const lookup = await candidatesRepository.getCandidate(candidateId);
    if (!lookup.ok || !lookup.candidate) return null;
    return toCandidateForPublication(lookup.candidate);
  },

  async getLatestActionableAssessment(
    candidateId: string
  ): Promise<AssessmentForPublication | null> {
    const list = await candidateAssessmentRepository.listCandidateAssessments({
      candidateId,
      limit: 1,
    });
    if (!list.ok || !list.assessments || list.assessments.length === 0) return null;
    const first = list.assessments[0] as unknown as Record<string, unknown>;
    return toAssessmentForPublication(first);
  },

  async findDuplicateProduct(
    slug: string,
    link: string
  ): Promise<{ productId: string; reason: "SLUG" | "URL" } | null> {
    const products = await productsRepository.getProducts();
    for (const product of products) {
      if (!product.ativo) continue;
      if (product.slug && product.slug === slug) {
        return { productId: product.id, reason: "SLUG" };
      }
      if (product.link && product.link === link) {
        return { productId: product.id, reason: "URL" };
      }
    }
    return null;
  },

  async createCanonicalProduct(input) {
    const result = await productsRepository.createProduct(
      {
        produto: input.produto,
        categoria: input.categoria,
        preco: input.preco,
        imagens: input.imagens ? [...input.imagens] : [],
        link: input.link,
        descricao: input.descricao ?? undefined,
        status: "published",
      },
      { syncCatalog: input.syncCatalog ?? false }
    );
    if (!result) {
      throw new Error("createProduct_failed: retorno nulo");
    }
    return Object.freeze({
      id: result.id,
      produto: result.produto,
      slug: result.slug ?? "",
      link: result.link,
      preco: typeof result.preco === "number" ? result.preco : 0,
      categoria: result.categoria,
      ref: typeof result.ref === "string" ? result.ref : null,
      created_by: input.createdBy,
      status: result.status ?? "published",
      ativo: result.ativo ?? true,
    });
  },

  async linkPromotion(candidateId, productId, decisionId) {
    const promoted = await candidatesRepository.promoteToProduct({
      candidate_id: candidateId,
      promoted_product_id: productId,
    });
    if (!promoted.ok) {
      return { ok: false };
    }
    // Registrar proveniência da decisão na metadata do candidato via evento.
    try {
      await supabasePublicationAdapter.recordOperationalEvent({
        correlationId: `publication:${decisionId}`,
        type: "PROMOTION_LINK_REGISTERED",
        payload: { candidateId, productId, decisionId },
      });
    } catch {
      // Registro secundário: falha não desfaz o vínculo (já é o vínculo oficial).
    }
    return { ok: true };
  },

  async restoreCreatedProduct(productId: string) {
    // Rollback planejado: desativar o produto criado pela publicação
    // (compensação não destrutiva — nunca apaga o registro).
    try {
      await productsRepository.updateProduct(
        productId,
        { ativo: false, status: "error" },
        { syncCatalog: false }
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  async recordOperationalEvent(event) {
    // Delega ao sistema de eventos operacionais existente (Bloco 13).
    try {
      const input: OperationalEventInput = {
        eventType: event.type,
        source: "publication-executor",
        actor: "automation",
        correlationId: event.correlationId,
        severity: "INFO",
        payload: event.payload,
        outcome: "SUCCESS",
      };
      const built = createOperationalEvent(input);
      const result = await persistOperationalEvent(built);
      return { ok: result?.ok ?? false };
    } catch {
      return { ok: false };
    }
  },
};
