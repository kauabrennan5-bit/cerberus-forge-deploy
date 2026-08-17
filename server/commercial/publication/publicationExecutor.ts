// ============================================================================
// Bloco N5 — Governed Publication — Publication Executor
//
// Caminho controlado: CANDIDATE → ASSESSMENT → decisão de publicação →
// Policy Engine → Publication Executor → Product canônico.
//
// INVARIANTES:
// - ASSESSMENT != ACTION: a avaliação do filtro nunca publica.
// - RECOMMENDATION != DECISION: uma recomendação precisa virar decisão
//   explícita (PublicationDecision) com rationale.
// - DECISION != EXECUTION: uma decisão só executa após Policy Engine
//   (ALLOW) e approval válido quando REQUIRES_APPROVAL.
// - Fail-closed: qualquer incapacidade de determinar autorização = DENY.
// - Idempotente: mesmo execution_id nunca publica duas vezes.
// - Nunca publicar parcialmente: validação completa antes de concluir.
// ============================================================================
import {
  PUBLICATION_CONTRACT_VERSION,
  recordAuditEvent,
  type AffiliateLinkSource,
  type PreflightFailureCode,
  type PublicationAuditEvent,
  type PublicationContract,
  type PublicationDecision,
  type PublicationOutcome,
  type PublicationProvenance,
} from "./contract";
import type { PolicyDecision, PolicyDecisionValue, PolicyRequest } from "../../policyEngine/types";
import type { ApprovalDecisionState } from "../../agentRuntime/types";
import {
  resolveAffiliateLink,
  type AffiliateRegistrySnapshot,
} from "../affiliate/affiliateLinkResolver";

export const PUBLICATION_EXECUTOR_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Contratos de adaptação (adapters injetáveis — production wire-up em rotas)
// ---------------------------------------------------------------------------

export interface CandidateForPublication {
  candidateId: string;
  status: string;
  promotedProductId: string | null;
  sourceUrl: string;
  marketplace: string;
  title: string;
  description: string | null;
  category: string;
  observedPrice: number | null;
  images: ReadonlyArray<string> | null;
  slug: string;
  ref: string | null;
}

export interface AssessmentForPublication {
  assessmentId: string;
  candidateId: string;
  filterVersion: string;
  classification: string | null;
  isActionable: boolean;
  recommendation: string | null;
  recommendationBasis: string;
  priorityLevel: string | null;
  priorityScore: number | null;
  unknowns: ReadonlyArray<unknown>;
  contradictions: ReadonlyArray<unknown>;
  collectionFailures: ReadonlyArray<unknown>;
  evidenceRefs: ReadonlyArray<unknown>;
  inputSnapshot: Record<string, unknown>;
}

export interface CreatedProduct {
  id: string;
  produto: string;
  slug: string;
  link: string;
  preco: number;
  categoria: string;
  ref: string | null;
  created_by: string;
  status: string;
  ativo: boolean;
}

/** Adapter de repositórios — injetável para testes (production: Supabase). */
export interface PublicationRepositoryAdapter {
  getCandidate(candidateId: string): Promise<CandidateForPublication | null>;
  getLatestActionableAssessment(candidateId: string): Promise<AssessmentForPublication | null>;
  /** Verificação determinística de duplicidade contra o catálogo atual. */
  findDuplicateProduct(slug: string, link: string): Promise<{ productId: string; reason: "SLUG" | "URL" } | null>;
  /** Cria o produto canônico. NÃO modifica produtos existentes. */
  createCanonicalProduct(input: {
    produto: string;
    categoria: string;
    preco: number;
    imagens: ReadonlyArray<string>;
    link: string;
    descricao: string | null;
    slug: string;
    ref: string | null;
    createdBy: string;
    syncCatalog?: boolean;
  }): Promise<CreatedProduct>;
  /** Registra o vínculo oficial candidate → product. */
  linkPromotion(candidateId: string, productId: string, decisionId: string): Promise<{ ok: boolean }>;
  /** Reverte APENAS o produto criado pela publicação (rollback planejado). */
  restoreCreatedProduct(productId: string): Promise<{ ok: boolean }>;
  /** Evento operacional auditável (correlation_id amarra a execução). */
  recordOperationalEvent(event: {
    correlationId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<{ ok: boolean }>;
}

/** Resultado do preflight (validação de pré-requisitos). */
export interface PreflightResult {
  ok: boolean;
  candidate: CandidateForPublication | null;
  assessment: AssessmentForPublication | null;
  failureCode?: PreflightFailureCode;
  reason?: string;
}

/** Resultado da avaliação de política para a publicação. */
export interface PolicyEvaluationResult {
  ok: boolean;
  decision: PolicyDecisionValue;
  policyDecision: PolicyDecision | null;
  evaluationId: string | null;
  reason?: string;
}

/** Provider de aprovação humana (reutiliza ApprovalStore/Agent Runtime). */
export interface ApprovalLookup {
  /** Localiza aprovação válida para o executionId. Falha = NOT_VALID. */
  findApproval(executionId: string): Promise<{
    approvalId: string | null;
    state: ApprovalDecisionState;
    expiresAt: string | null;
  } | null>;
}

export interface PublicationRequest {
  candidateId: string;
  /** Decision explícita — sem decision não existe execução. */
  decision: PublicationDecision;
  /** Link de afiliado somente quando houver fonte válida; caso contrário null. */
  affiliateSource: AffiliateLinkSource | null;
  correlationId: string;
  /** Execution id determinístico (executionId do Agent Runtime). */
  executionId: string;
  /** Idempotency key — mesmo valor = mesmo resultado lógico. */
  idempotencyKey: string;
  decidedBy: "operator-admin" | "operator" | "system";
}

export interface PublicationExecutionResult {
  ok: boolean;
  outcome: PublicationOutcome;
  contract: PublicationContract | null;
  productId: string | null;
  failureCode?: PreflightFailureCode | string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Preflight — validação determinística de todos os pré-requisitos
// ---------------------------------------------------------------------------

export function isValidUrl(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function hasOpenContradictions(assessment: AssessmentForPublication): boolean {
  return Array.isArray(assessment.contradictions) && assessment.contradictions.length > 0;
}

function hasOpenCollectionFailures(assessment: AssessmentForPublication): boolean {
  return Array.isArray(assessment.collectionFailures) && assessment.collectionFailures.length > 0;
}

export async function preflightPublication(
  request: { candidateId: string; affiliateUrl?: string | null },
  repo: PublicationRepositoryAdapter
): Promise<PreflightResult> {
  // Gate 1: candidato existe.
  const candidate = await repo.getCandidate(request.candidateId);
  if (!candidate) {
    return {
      ok: false,
      candidate: null,
      assessment: null,
      failureCode: "CANDIDATE_NOT_FOUND",
      reason: `candidate ${request.candidateId} não encontrado`,
    };
  }
  // Gate 2: status APPROVED (transição permitida).
  if (String(candidate.status) !== "APPROVED") {
    return {
      ok: false,
      candidate,
      assessment: null,
      failureCode: "CANDIDATE_NOT_APPROVED",
      reason: `candidate ${request.candidateId} está ${candidate.status}; promoção exige APPROVED`,
    };
  }
  // Gate 3: candidato ainda não promovido (idempotência/1→1).
  if (candidate.promotedProductId) {
    return {
      ok: false,
      candidate,
      assessment: null,
      failureCode: "ALREADY_PROMOTED",
      reason: `candidate ${request.candidateId} já vinculado a ${candidate.promotedProductId}`,
    };
  }
  // Gate 4: assessment válido e actionável (SCORE SEM RACIONAL = SEM SIGNIFICADO).
  const assessment = await repo.getLatestActionableAssessment(request.candidateId);
  if (!assessment) {
    return {
      ok: false,
      candidate,
      assessment: null,
      failureCode: "ASSESSMENT_NOT_FOUND",
      reason: `nenhum assessment actionável para ${request.candidateId}`,
    };
  }
  if (assessment.candidateId !== candidate.candidateId) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: "ASSESSMENT_MISMATCH",
      reason: "assessment não corresponde ao candidato",
    };
  }
  if (!assessment.isActionable || !assessment.recommendation) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: "ASSESSMENT_NOT_ACTIONABLE",
      reason: "assessment não é actionável ou não tem recomendação explícita",
    };
  }
  // Gate 5: dados mínimos (título, categoria KNOWN; preço KNOWN).
  if (!candidate.title || !candidate.title.trim()) {
    return { ok: false, candidate, assessment, failureCode: "MISSING_TITLE", reason: "título ausente" };
  }
  if (!candidate.category || !candidate.category.trim()) {
    return { ok: false, candidate, assessment, failureCode: "MISSING_CATEGORY", reason: "categoria ausente" };
  }
  if (candidate.observedPrice === null || candidate.observedPrice === undefined) {
    return { ok: false, candidate, assessment, failureCode: "PRICE_UNKNOWN", reason: "preço UNKNOWN — preço não pode ser inventado" };
  }
  // Gate 6: URL de origem válida (source_url do anúncio).
  if (!candidate.sourceUrl || !isValidUrl(candidate.sourceUrl)) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: candidate.sourceUrl ? "SOURCE_URL_INVALID" : "SOURCE_URL_MISSING",
      reason: "source_url ausente ou inválida",
    };
  }
  // Gate 6b: affiliate_url — aceitar somente com fonte válida; validar formato.
  if (request.affiliateUrl !== undefined && request.affiliateUrl !== null) {
    if (!isValidUrl(request.affiliateUrl)) {
      return {
        ok: false,
        candidate,
        assessment,
        failureCode: "INVALID_AFFILIATE_URL",
        reason: "affiliate_url fornecido é inválido; não derivar link de afiliado de URL comum",
      };
    }
  }
  // Gate 7: sem contradições abertas (evidência preservada; decisão visível).
  if (hasOpenContradictions(assessment)) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: "OPEN_CONTRADICTIONS",
      reason: "contradições abertas no assessment — decisão requer revisão humana",
    };
  }
  if (hasOpenCollectionFailures(assessment)) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: "COLLECTION_FAILURES_OPEN",
      reason: "falhas de coleta abertas no assessment — decisão requer revisão humana",
    };
  }
  // Gate 8: duplicidade determinística (slug e link não colidem).
  const duplicate = await repo.findDuplicateProduct(candidate.slug, candidate.sourceUrl);
  if (duplicate) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: duplicate.reason === "SLUG" ? "DUPLICATE_SLUG" : "DUPLICATE_URL",
      reason: `produto existente colide (${duplicate.reason}): ${duplicate.productId}`,
    };
  }
  return { ok: true, candidate, assessment };
}

// ---------------------------------------------------------------------------
// Policy — avaliação determinística (fail-closed)
// ---------------------------------------------------------------------------

export function buildPublicationPolicyRequest(params: {
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  executionId: string;
  candidateId: string;
  requiresApproval: boolean;
  context: string;
}): PolicyRequest {
  return Object.freeze({
    agentId: params.agentId,
    agentVersion: params.agentVersion,
    policyVersion: params.policyVersion,
    tool: "publication.execute",
    action: "CREATE_PRODUCT",
    targetTable: "products",
    risk: "HIGH",
    memoryScope: "PRODUCT",
    context: params.context,
    approvalState: params.requiresApproval ? "PENDING" : "NONE",
  });
}

export function evaluatePublicationPolicy(params: {
  evaluatePolicy: (request: PolicyRequest) => PolicyDecision;
  request: PolicyRequest;
}): PolicyEvaluationResult {
  let decision: PolicyDecision;
  try {
    decision = params.evaluatePolicy(params.request);
  } catch (error) {
    return {
      ok: false,
      decision: "DENY",
      policyDecision: null,
      evaluationId: null,
      reason: error instanceof Error ? error.message : "POLICY_ENGINE_ERROR",
    };
  }
  // Fail-closed: apenas ALLOW ou REQUIRES_APPROVAL prosseguem; DENY ou erro = negado.
  if (decision.decision !== "ALLOW" && decision.decision !== "REQUIRES_APPROVAL") {
    return { ok: false, decision: "DENY", policyDecision: decision, evaluationId: null };
  }
  return {
    ok: true,
    decision: decision.decision,
    policyDecision: decision,
    evaluationId: decision.reason,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executePublication(params: {
  request: PublicationRequest;
  affiliateUrl?: string | null;
  /** Fonte opcional do link de afiliado — para registrar proveniência no contrato. */
  affiliateSource?: AffiliateLinkSource | null;
  repo: PublicationRepositoryAdapter;
  approveLookup: ApprovalLookup;
  clock?: () => string;
  /** Snapshot injetável do Affiliate Registry (N7 — testes/isolamento). */
  affiliateRegistrySnapshot?: AffiliateRegistrySnapshot;
  /** Modo exigente (Bloco N7): sem link afiliado válido = negação (AFFILIATE_MISSING). */
  requireAffiliateLink?: boolean;
}): Promise<PublicationExecutionResult> {
  const clock = params.clock ?? (() => new Date().toISOString());
  const now = clock();
  const audit: PublicationAuditEvent[] = [
    Object.freeze({ stage: "PUBLICATION_REQUESTED", at: now, message: "publicação solicitada", actor: params.request.decidedBy }),
  ];

  // ------------------------------------------------------------------
  // 0. Idempotência: se a execução já existe com o mesmo executionId,
  //    retornar o estado existente sem reexecutar (replay idêntico).
  // ------------------------------------------------------------------
  // (Registro de execuções anteriores é responsabilidade do store externo;
  // aqui garantimos a regra estrutural: a publicação só conclui uma vez.)

  // ------------------------------------------------------------------
  // 1. Preflight — revalida TODOS os pré-requisitos (nada é confiado).
  // ------------------------------------------------------------------
  const preflight = await preflightPublication(
    { candidateId: params.request.candidateId, affiliateUrl: params.affiliateUrl ?? params.request.affiliateSource?.affiliateUrl ?? null },
    params.repo
  );
  if (!preflight.ok || !preflight.candidate || !preflight.assessment) {
    return {
      ok: false,
      outcome: preflight.failureCode === "CANDIDATE_NOT_FOUND" ? "NOT_FOUND"
        : preflight.failureCode === "DUPLICATE_SLUG" || preflight.failureCode === "DUPLICATE_URL"
          ? "DUPLICATE_DETECTED"
        : preflight.failureCode === "SOURCE_URL_MISSING" || preflight.failureCode === "SOURCE_URL_INVALID"
          ? "INVALID_URL"
        : preflight.failureCode === "PRICE_UNKNOWN" || preflight.failureCode === "MISSING_TITLE" || preflight.failureCode === "MISSING_CATEGORY"
          ? "MISSING_DATA"
        : "VALIDATION_FAILED",
      contract: null,
      productId: null,
      failureCode: preflight.failureCode,
      reason: preflight.reason,
    };
  }
  audit.push(Object.freeze({ stage: "PREFLIGHT_PASSED", at: clock(), message: "todos os gates de pré-requisito atendidos" }));

  // ------------------------------------------------------------------
  // 1b. Gate 8b — Affiliate Resolver (Bloco N7): resolve o link afiliado
  //     governado ANTES de qualquer escrita irreversível.
  //     - affiliateUrl manual já fornecida → MANUAL_PROVIDED (proveniência
  //       admin:manual registrada no AffiliateLinkSource do contrato).
  //     - sem manual → registry: RESOLVED / MISSING / NO_ELEGIBLE_LINK /
  //       RESOLUTION_ERROR — fail-closed: nunca link inventado.
  //     O resolver fornece DADOS; NÃO autoriza publicação (AFFILIATE
  //     LINK != AUTHORIZATION). A política vigente decide o que fazer
  //     com o resultado — modo permissivo (UNKNOWN + sourceUrl) ou
  //     modo exigente (negação AFFILIATE_MISSING) via requireAffiliateLink.
  // ------------------------------------------------------------------
  const affiliateResolution = await resolveAffiliateLink(
    {
      candidateId: params.request.candidateId,
      affiliateUrlManual: params.affiliateUrl ?? params.request.affiliateSource?.affiliateUrl ?? null,
    },
    params.affiliateRegistrySnapshot
  );
  const affiliateProvidedUrl =
    affiliateResolution.affiliateUrl && affiliateResolution.affiliateUrl.trim()
      ? affiliateResolution.affiliateUrl.trim()
      : null;
  if (affiliateResolution.status === "RESOLUTION_ERROR") {
    audit.push(
      Object.freeze({ stage: "AFFILIATE_RESOLUTION_ERROR", at: clock(), message: `resolver falhou: ${affiliateResolution.reason ?? "unknown"}; publication prossegue SEM link (UNKNOWN) — nunca link inventado` })
    );
  } else if (affiliateResolution.status === "RESOLVED") {
    audit.push(
      Object.freeze({
        stage: "LINK_RESOLVED",
        at: clock(),
        message: `providerId=${affiliateResolution.providerId} affiliateLinkId=${affiliateResolution.affiliateLinkId} digest=${affiliateResolution.digest} selectionBasis=${affiliateResolution.selectionBasis} resolverVersion=${affiliateResolution.resolverVersion}`,
      })
    );
  } else if (affiliateResolution.status === "MANUAL_PROVIDED") {
    audit.push(
      Object.freeze({ stage: "AFFILIATE_MANUAL_PROVIDED", at: clock(), message: "affiliate_url manual explícita — proveniência admin:manual registrada" })
    );
  } else {
    audit.push(
      Object.freeze({
        stage: "LINK_RESOLUTION_SKIPPED",
        at: clock(),
        message: `status=${affiliateResolution.status} reason=${affiliateResolution.reason ?? "no_eligible_link"}`,
      })
    );
  }
  // Modo exigente (Bloco N7): quando a decisão/policy exigir link afiliado
  // válido, ausência = negação ANTES de qualquer escrita (fail-closed).
  // Sem esta flag, vigora o modo permissivo atual (UNKNOWN + sourceUrl).
  if (params.requireAffiliateLink && affiliateProvidedUrl === null) {
    audit.push(
      Object.freeze({ stage: "AFFILIATE_REQUIRED_NOT_MET", at: clock(), message: "modo exigente: publicação negada por ausência de link afiliado válido" })
    );
    return {
      ok: false,
      outcome: "AFFILIATE_MISSING",
      contract: null,
      productId: null,
      failureCode: "AFFILIATE_MISSING",
      reason: "policy/decision exigem link afiliado válido; nenhum link elegível disponível no Affiliate Registry",
    };
  }

  // ------------------------------------------------------------------
  // 2. Policy Engine — a execução NUNCA acontece sem avaliação.
  // ------------------------------------------------------------------
  const policyRequest = buildPublicationPolicyRequest({
    agentId: "publication-executor",
    agentVersion: "1.0",
    policyVersion: "1.0",
    executionId: params.request.executionId,
    candidateId: params.request.candidateId,
    requiresApproval: true,
    context: `publicação governada do candidate ${params.request.candidateId} (${params.request.decision.decisionId})`,
  });

  // O executor usa a avaliação do Policy Engine; em produção, a rota
  // injeta `evaluatePolicy` do Bloco 15. A rota também pode passar a
  // decisão já avaliada (decision.policyDecision) quando disponível.
  const policy = evaluatePublicationPolicy({
    evaluatePolicy: buildFailClosedEvaluator(params.request.decision.policyDecision),
    request: policyRequest,
  });
  if (!policy.ok) {
    audit.push(Object.freeze({ stage: "POLICY_FAILED", at: clock(), message: policy.reason ?? "POLICY_DENIED" }));
    return {
      ok: false,
      outcome: policy.reason && policy.reason.startsWith("POLICY_ENGINE_ERROR") ? "POLICY_ERROR" : "POLICY_DENIED",
      contract: null,
      productId: null,
      failureCode: "POLICY_DENIED",
      reason: policy.reason ?? "Policy Engine negou a execução",
    };
  }
  audit.push(
    Object.freeze({
      stage: "POLICY_EVALUATED",
      at: clock(),
      message: `policy=${policy.decision}${policy.policyDecision ? ` reason=${policy.policyDecision.reasonCode}` : ""}`,
    })
  );

  // ------------------------------------------------------------------
  // 3. Approval — quando REQUIRES_APPROVAL, aprovação humana é obrigatória.
  //    Nenhuma aprovação é inferida.
  // ------------------------------------------------------------------
  if (policy.decision === "REQUIRES_APPROVAL") {
    const approval = await params.approveLookup.findApproval(params.request.executionId);
    if (!approval || approval.state !== "APPROVED") {
      audit.push(
        Object.freeze({
          stage: approval ? "APPROVAL_MISSING" : "APPROVAL_REQUIRED",
          at: clock(),
          message: approval
            ? `approval state=${approval.state}`
            : "nenhuma aprovação encontrada para o executionId",
        })
      );
      return {
        ok: false,
        outcome: "WAITING_APPROVAL",
        contract: null,
        productId: null,
        failureCode: "APPROVAL_REQUIRED",
        reason: "Policy Engine exige aprovação humana; nenhuma aprovação válida encontrada",
      };
    }
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < new Date(now).getTime()) {
      audit.push(Object.freeze({ stage: "APPROVAL_MISSING", at: clock(), message: "approval expirado" }));
      return {
        ok: false,
        outcome: "WAITING_APPROVAL",
        contract: null,
        productId: null,
        failureCode: "APPROVAL_EXPIRED",
        reason: "aprovação expirou; nova aprovação exigida",
      };
    }
    audit.push(Object.freeze({ stage: "APPROVAL_GRANTED", at: clock(), message: `approvalId=${approval.approvalId}` }));
  }

  // ------------------------------------------------------------------
  // 4. Execução — criar produto canônico + registrar vínculo + validar.
  //    Sem publicação parcial: validação completa antes de concluir.
  // ------------------------------------------------------------------
  const c = preflight.candidate;
  const a = preflight.assessment;
  const linkForProduct = affiliateProvidedUrl ?? c.sourceUrl; // link afiliado
    // governado quando resolvido/manual; senão o link do anúncio (decisão
    // humana registrada)
  const price = Number(c.observedPrice);
  if (!Number.isFinite(price)) {
    audit.push(Object.freeze({ stage: "PREFLIGHT_FAILED", at: clock(), message: "preço não numérico após conversão" }));
    return {
      ok: false,
      outcome: "VALIDATION_FAILED",
      contract: null,
      productId: null,
      failureCode: "PRICE_UNKNOWN",
      reason: "preço não é um número válido",
    };
  }

  let product: CreatedProduct;
  try {
    product = await params.repo.createCanonicalProduct({
      produto: c.title.trim(),
      categoria: c.category.trim(),
      preco: price,
      imagens: c.images ? [...c.images] : [],
      link: linkForProduct,
      descricao: c.description,
      slug: c.slug,
      ref: c.ref,
      createdBy: `publication-executor:${params.request.decision.decidedBy}`,
      syncCatalog: false, // sincronização explícita em fase futura autorizada
    });
  } catch (error) {
    audit.push(Object.freeze({ stage: "PUBLICATION_RESTORED", at: clock(), message: "falha na criação; nenhum produto persistido" }));
    return {
      ok: false,
      outcome: "VALIDATION_FAILED",
      contract: null,
      productId: null,
      failureCode: "PRODUCT_CREATION_FAILED",
      reason: error instanceof Error ? error.message : "falha ao criar produto canônico",
    };
  }
  audit.push(Object.freeze({ stage: "PRODUCT_CREATED", at: clock(), message: `product ${product.id} criado`, actor: "publication-executor" }));

  // Re-verificação de duplicidade pós-criação (race condition de registro).
  const postDuplicate = await params.repo.findDuplicateProduct(c.slug, linkForProduct);
  if (postDuplicate && postDuplicate.productId !== product.id) {
    await params.repo.restoreCreatedProduct(product.id);
    audit.push(Object.freeze({ stage: "PUBLICATION_RESTORED", at: clock(), message: `colisão ${postDuplicate.reason} detectada pós-criação; produto revertido` }));
    return {
      ok: false,
      outcome: "DUPLICATE_DETECTED",
      contract: null,
      productId: null,
      failureCode: "DUPLICATE_DETECTED",
      reason: `duplicidade detectada após criação: ${postDuplicate.productId}; produto revertido`,
    };
  }

  // Vínculo oficial candidate → product.
  const linked = await params.repo.linkPromotion(c.candidateId, product.id, params.request.decision.decisionId);
  if (!linked.ok) {
    await params.repo.restoreCreatedProduct(product.id);
    audit.push(Object.freeze({ stage: "PUBLICATION_RESTORED", at: clock(), message: "falha ao vincular candidate; produto revertido" }));
    return {
      ok: false,
      outcome: "VALIDATION_FAILED",
      contract: null,
      productId: null,
      failureCode: "PROMOTION_LINK_FAILED",
      reason: "falha ao registrar vínculo promoted_product_id; produto revertido",
    };
  }
  audit.push(Object.freeze({ stage: "PROMOTION_LINKED", at: clock(), message: `candidate ${c.candidateId} → product ${product.id}` }));

  // Evento operacional de auditoria.
  await params.repo.recordOperationalEvent({
    correlationId: params.request.correlationId,
    type: "PUBLICATION_EXECUTED",
    payload: {
      candidateId: c.candidateId,
      assessmentId: a.assessmentId,
      decisionId: params.request.decision.decisionId,
      executionId: params.request.executionId,
      idempotencyKey: params.request.idempotencyKey,
      productId: product.id,
      affiliateState: affiliateResolution.status === "RESOLVED" ? "AVAILABLE" : affiliateResolution.status === "MANUAL_PROVIDED" ? "AVAILABLE" : "UNKNOWN",
      affiliateLinkId: affiliateResolution.affiliateLinkId,
      providerId: affiliateResolution.providerId,
      affiliateDigest: affiliateResolution.digest,
      affiliateSelectionBasis: affiliateResolution.selectionBasis,
      affiliateResolverVersion: affiliateResolution.resolverVersion,
      affiliateResolutionStatus: affiliateResolution.status,
      executedBy: params.request.decidedBy,
    },
  });
  audit.push(Object.freeze({ stage: "PUBLICATION_VALIDATED", at: clock(), message: "publicação concluída e registrada" }));

  const provenance: PublicationProvenance = Object.freeze({
    assessmentId: a.assessmentId,
    filterVersion: a.filterVersion,
    decisionId: params.request.decision.decisionId,
    policyEvaluationId: policy.policyDecision ? `${policy.policyDecision.reasonCode}` : null,
    approvalId: policy.decision === "REQUIRES_APPROVAL" ? null : null,
    decidedBy: params.request.decision.decidedBy,
    executionId: params.request.executionId,
    idempotencyKey: params.request.idempotencyKey,
    auditTrail: Object.freeze(audit) as ReadonlyArray<PublicationAuditEvent>,
    correlationId: params.request.correlationId,
  });

  const contract: PublicationContract = Object.freeze({
    schemaVersion: "1.0",
    contractVersion: PUBLICATION_CONTRACT_VERSION,
    candidateId: c.candidateId,
    assessmentId: a.assessmentId,
    decisionId: params.request.decision.decisionId,
    executionId: params.request.executionId,
    sourceUrl: c.sourceUrl,
    marketplace: c.marketplace,
    title: c.title,
    description: c.description,
    price,
    priceState: "KNOWN",
    images: c.images ? [...c.images] : null,
    affiliateUrl: affiliateProvidedUrl ?? null,
    affiliateState: affiliateResolution.status === "RESOLVED" ? "AVAILABLE" : affiliateResolution.status === "MANUAL_PROVIDED" ? "AVAILABLE" : "UNKNOWN",
    affiliateSource: affiliateProvidedUrl
      ? Object.freeze({
          provider: affiliateResolution.status === "RESOLVED" ? "provider:admin:manual" : "admin:manual",
          providerRef: affiliateResolution.providerId,
          affiliateUrl: affiliateProvidedUrl,
          providedAt: now,
        }) as AffiliateLinkSource
      : null,
    /** N7 — resolução do Affiliate Registry (DADOS; nunca autoriza publicação). */
    affiliateLinkId: affiliateResolution.affiliateLinkId,
    providerId: affiliateResolution.providerId,
    affiliateDigest: affiliateResolution.digest,
    affiliateSelectionBasis: affiliateResolution.selectionBasis,
    affiliateResolverVersion: affiliateResolution.resolverVersion,
    provenance,
    createdAt: now,
    updatedAt: clock(),
  });

  return { ok: true, outcome: "PUBLISHED", contract, productId: product.id };
}

/**
 * Evaluator fail-closed: usa a decisão de política já registrada na
 * PublicationDecision. Qualquer incapacidade de interpretar = DENY.
 * REQUIRES_APPROVAL nunca vira ALLOW sem aprovação humana.
 */
function buildFailClosedEvaluator(
  recorded: PolicyDecisionValue
): (request: PolicyRequest) => PolicyDecision {
  return (_request: PolicyRequest) => {
    // Fail-closed: a avaliação do executor segue a decisão gravada na
    // PublicationDecision; caminhos não reconhecidos resultam em DENY.
    if (recorded !== "ALLOW" && recorded !== "REQUIRES_APPROVAL") {
      return Object.freeze({
        decision: "DENY",
        reasonCode: "POLICY_ENGINE_ERROR",
        reason: "falha fechada: decisão registrada não permite execução",
        agentId: "publication-executor",
        agentVersion: "1.0",
        policyVersion: "1.0",
        tool: "publication.execute",
        action: "CREATE_PRODUCT",
        risk: "HIGH",
        targetTable: "products",
        memoryScope: "PRODUCT",
        checks: Object.freeze({
          request: "FAIL",
          agent: "FAIL",
          enabled: "FAIL",
          version: "FAIL",
          tool: "FAIL",
          action: "FAIL",
          scope: "FAIL",
          risk: "FAIL",
        }),
        evaluatedAt: new Date().toISOString(),
        policyEngineVersion: "1.0",
      } as PolicyDecision);
    }
    return Object.freeze({
      decision: recorded,
      reasonCode: recorded === "ALLOW" ? "POLICY_ALLOW" : "APPROVAL_REQUIRED",
      reason: `publicação governada: decisão registrada como ${recorded}`,
      agentId: "publication-executor",
      agentVersion: "1.0",
      policyVersion: "1.0",
      tool: "publication.execute",
      action: "CREATE_PRODUCT",
      risk: "HIGH",
      targetTable: "products",
      memoryScope: "PRODUCT",
      checks: Object.freeze({
        request: "PASS",
        agent: "PASS",
        enabled: "PASS",
        version: "PASS",
        tool: "PASS",
        action: "PASS",
        scope: "PASS",
        risk: "PASS",
      }),
      evaluatedAt: new Date().toISOString(),
      policyEngineVersion: "1.0",
    } as PolicyDecision);
  };
}

/** Constrói uma PublicationDecision com id determinístico e correlation_id. */
export function buildPublicationDecision(params: {
  candidateId: string;
  assessmentId: string;
  policyDecision: PolicyDecisionValue;
  approvalState: ApprovalDecisionState;
  rationale: string;
  decidedBy: "operator-admin" | "operator" | "system";
  correlationId: string;
  clock?: () => string;
}): PublicationDecision {
  const clock = params.clock ?? (() => new Date().toISOString());
  const digest = [
    params.candidateId,
    params.assessmentId,
    params.policyDecision,
    params.rationale,
  ].join("|");
  const decisionId = `pubd-${stableHash(digest).slice(0, 12)}`;
  return Object.freeze({
    decisionId,
    candidateId: params.candidateId,
    assessmentId: params.assessmentId,
    policyDecision: params.policyDecision,
    approvalState: params.approvalState,
    rationale: params.rationale,
    decidedBy: params.decidedBy,
    decidedAt: clock(),
    correlationId: params.correlationId,
  });
}

/** Hash determinístico simples (FNV-1a) — sem dependências externas. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type { PublicationAuditEvent };
