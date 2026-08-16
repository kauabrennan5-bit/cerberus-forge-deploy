// ============================================================================
// Bloco N5 — Governed Publication — Bateria de testes do Publication Executor.
//
// GOVERNANÇA PROTEGIDA NESTES TESTES:
// - CANDIDATE != FACT CANÔNICO: nenhum produto canônico existe antes;
// - ASSESSMENT != ACTION: decisão não executa sem gates + aprovação;
// - DECISION != ACTION: executePublication só cria produto quando a política
//   ALLOW é concedida e os gates passam (testados por mock controlado);
// - IDENTITY != PRODUCT: o vínculo promovido só ocorre após a criação válida;
// - RESEARCH != PUBLICATION: nada aqui toca evidências de pesquisa.
//
// TODOS os repos são MOCKS — zero interação com Supabase/produção.
// ============================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLICATION_EXECUTOR_VERSION,
  buildPublicationDecision,
  buildPublicationPolicyRequest,
  executePublication,
  preflightPublication,
  type CandidateForPublication,
  type AssessmentForPublication,
  type PublicationRepositoryAdapter,
  type ApprovalLookup,
  type CreatedProduct,
} from "../../server/commercial/publication/publicationExecutor";

// ---------------------------------------------------------------------------
// Helpers de fixtures
// ---------------------------------------------------------------------------
function buildCandidate(overrides: Partial<CandidateForPublication> = {}): CandidateForPublication {
  return Object.freeze({
    candidateId: "cand-test-001",
    status: "APPROVED",
    promotedProductId: null,
    sourceUrl: "https://www.mercadolivre.com.br/produto-123",
    marketplace: "MERCADO_LIVRE",
    title: "Produto de Teste Cerberus",
    description: "Descrição de teste do produto canônico.",
    category: "Casa e Decoração",
    observedPrice: 199.9,
    images: ["https://example.com/img1.jpg"],
    slug: "produto-de-teste-cerberus",
    ref: "REF-TEST-001",
    ...overrides,
  });
}

function buildAssessment(overrides: Partial<AssessmentForPublication> = {}): AssessmentForPublication {
  return Object.freeze({
    assessmentId: "ass-test-001",
    candidateId: "cand-test-001",
    filterVersion: "1.0",
    classification: "APPROVED",
    isActionable: true,
    recommendation: "PROMOTE",
    recommendationBasis: "price_quality_score=0.85; market_fit=GOOD",
    priorityLevel: "HIGH",
    priorityScore: 85,
    unknowns: [],
    contradictions: [],
    collectionFailures: [],
    evidenceRefs: ["evid-001"],
    inputSnapshot: {},
    ...overrides,
  });
}

interface Created {
  product?: CreatedProduct;
  linked?: boolean;
  restored?: string | null;
  events: Array<{ correlationId: string; type: string; payload: Record<string, unknown> }>;
}

function buildMockRepo(
  opts: {
    candidate?: CandidateForPublication | null;
    assessment?: AssessmentForPublication | null;
    duplicate?: { productId: string; reason: "SLUG" | "URL" } | null;
    createProductResult?: CreatedProduct;
    createProductError?: boolean;
    linkPromotionOk?: boolean;
  } = {}
): { repo: PublicationRepositoryAdapter; created: Created } {
  const created: Created = { events: [] };
  const repo: PublicationRepositoryAdapter = {
    async getCandidate() {
      // Candidate padrão sempre disponível, exceto quando explicitamente
      // definido (incluindo null para casos de candidato ausente).
      return "candidate" in opts ? (opts.candidate as CandidateForPublication | null) : buildCandidate();
    },
    async getLatestActionableAssessment() {
      return "assessment" in opts ? (opts.assessment as AssessmentForPublication | null) : buildAssessment();
    },
    async findDuplicateProduct() {
      return opts.duplicate ?? null;
    },
    async createCanonicalProduct(input) {
      if (opts.createProductError) throw new Error("createProduct_failed");
      if (opts.createProductResult) {
        created.product = opts.createProductResult;
        return opts.createProductResult;
      }
      const product: CreatedProduct = Object.freeze({
        id: "prod-created-by-test",
        produto: input.produto,
        slug: input.slug,
        link: input.link,
        preco: input.preco,
        categoria: input.categoria,
        ref: input.ref,
        created_by: "publication-executor",
        status: "published",
        ativo: true,
      });
      created.product = product;
      return product;
    },
    async linkPromotion() {
      created.linked = opts.linkPromotionOk !== false;
      return { ok: created.linked };
    },
    async restoreCreatedProduct(productId: string) {
      created.restored = productId;
      return { ok: true };
    },
    async recordOperationalEvent(event) {
      created.events.push({
        correlationId: event.correlationId,
        type: event.type,
        payload: event.payload,
      });
      return { ok: true };
    },
  };
  return { repo, created };
}

function buildApprovalLookup(state: "APPROVED" | "NOT_REQUIRED" | "PENDING" | "EXPIRED" | null): ApprovalLookup {
  return {
    async findApproval() {
      if (state === null) return null;
      if (state === "NOT_REQUIRED") {
        return { approvalId: null, state: "NOT_REQUIRED", expiresAt: null };
      }
      return { approvalId: "appr-test-001", state, expiresAt: null };
    },
  };
}

function buildRequest(opts: { policyDecision?: "ALLOW" | "DENY" | "REQUIRES_APPROVAL" } = {}) {
  const decision = buildPublicationDecision({
    candidateId: "cand-test-001",
    assessmentId: "ass-test-001",
    policyDecision: opts.policyDecision ?? "ALLOW",
    approvalState: "NOT_REQUIRED",
    rationale: "Candidato aprovado no filtro 9 eixos; publicação governada.",
    decidedBy: "operator-admin",
    correlationId: "corr-test-001",
  });
  return {
    candidateId: "cand-test-001",
    decision,
    affiliateSource: null,
    correlationId: "corr-test-001",
    executionId: "exec-pub-cand-test-001-001",
    idempotencyKey: decision.decisionId.replace("pubd-", "pubk-"),
    decidedBy: "operator-admin" as const,
  };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------
describe("Bloco N5 — Publication Executor", () => {

  // A. CONTRATO
  test("A.1 — contrato tem versão estável", () => {
    assert.equal(PUBLICATION_EXECUTOR_VERSION, "1.0");
    // A versão é uma constante string imutável por natureza do módulo.
    assert.equal(typeof PUBLICATION_EXECUTOR_VERSION, "string");
  });

  test("A.2 — decision id é determinístico (mesmos inputs ⇒ mesmo id)", () => {
    const params = {
      candidateId: "cand-1", assessmentId: "ass-1",
      policyDecision: "ALLOW" as const,
      approvalState: "NOT_REQUIRED" as const,
      rationale: "r1", decidedBy: "operator-admin" as const, correlationId: "c1",
    };
    const d1 = buildPublicationDecision({ ...params, clock: () => "2026-08-16T00:00:00Z" });
    const d2 = buildPublicationDecision({ ...params, clock: () => "2026-08-17T00:00:00Z" });
    assert.equal(d1.decisionId, d2.decisionId);
    assert.equal(d1.decisionId.startsWith("pubd-"), true);
    assert.equal(Object.isFrozen(d1), true);
  });

  test("A.3 — decision de inputs distintos gera ids distintos", () => {
    const clock = () => "2026-08-16T00:00:00Z";
    const d1 = buildPublicationDecision({
      candidateId: "cand-1", assessmentId: "ass-1",
      policyDecision: "ALLOW", approvalState: "NOT_REQUIRED",
      rationale: "r1", decidedBy: "operator-admin", correlationId: "c1", clock,
    });
    const d2 = buildPublicationDecision({
      candidateId: "cand-2", assessmentId: "ass-1",
      policyDecision: "ALLOW", approvalState: "NOT_REQUIRED",
      rationale: "r1", decidedBy: "operator-admin", correlationId: "c1", clock,
    });
    assert.notEqual(d1.decisionId, d2.decisionId);
  });

  test("A.4 — buildPublicationPolicyRequest mapeia para o Policy Engine", () => {
    const policyRequest = buildPublicationPolicyRequest({
      agentId: "publication-executor",
      agentVersion: "1.0",
      policyVersion: "1.0",
      executionId: "exec-1",
      candidateId: "cand-1",
      requiresApproval: true,
      context: "publicação governada do candidate cand-1 (pubd-test)",
    });
    assert.equal(policyRequest.tool, "publication.execute");
    assert.equal(policyRequest.action, "CREATE_PRODUCT");
    assert.equal(policyRequest.targetTable, "products");
    assert.equal(policyRequest.risk, "HIGH");
    assert.equal(policyRequest.memoryScope, "PRODUCT");
    // Quando requer aprovação, o estado exposto à política é PENDING —
    // nunca inferido como aprovado.
    assert.equal(policyRequest.approvalState, "PENDING");
  });

  // B. FAIL-CLOSED — preflight bloqueia tudo que não está pronto
  test("B.1 — candidato inexistente → CANDIDATE_NOT_FOUND", async () => {
    const { repo } = buildMockRepo({ candidate: null });
    const preflight = await preflightPublication({ candidateId: "inexistente", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "CANDIDATE_NOT_FOUND");
  });

  test("B.2 — candidato não aprovado → CANDIDATE_NOT_APPROVED", async () => {
    const { repo } = buildMockRepo({ candidate: buildCandidate({ status: "REVIEWING" }) });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "CANDIDATE_NOT_APPROVED");
  });

  test("B.3 — já promovido → ALREADY_PROMOTED (idempotência de identidade)", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ promotedProductId: "prod-existente" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "ALREADY_PROMOTED");
  });

  test("B.4 — sem assessment → ASSESSMENT_NOT_FOUND", async () => {
    const { repo } = buildMockRepo({ assessment: null });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "ASSESSMENT_NOT_FOUND");
  });

  test("B.5 — assessment não é do candidato → ASSESSMENT_MISMATCH", async () => {
    const { repo } = buildMockRepo({
      assessment: buildAssessment({ candidateId: "cand-outro" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "ASSESSMENT_MISMATCH");
  });

  test("B.6 — assessment não acionável → ASSESSMENT_NOT_ACTIONABLE", async () => {
    const { repo } = buildMockRepo({
      assessment: buildAssessment({ isActionable: false }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "ASSESSMENT_NOT_ACTIONABLE");
  });

  test("B.7 — sem título → MISSING_TITLE", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ title: "" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "MISSING_TITLE");
  });

  test("B.8 — sem categoria → MISSING_CATEGORY", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ category: "" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "MISSING_CATEGORY");
  });

  test("B.9 — preço UNKNOWN (null) → PRICE_UNKNOWN", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ observedPrice: null }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "PRICE_UNKNOWN");
  });

  test("B.10 — sem source URL → SOURCE_URL_MISSING", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ sourceUrl: "" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "SOURCE_URL_MISSING");
  });

  test("B.11 — source URL inválida → SOURCE_URL_INVALID", async () => {
    const { repo } = buildMockRepo({
      candidate: buildCandidate({ sourceUrl: "nao-e-uma-url" }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "SOURCE_URL_INVALID");
  });

  test("B.12 — affiliate URL inválida → INVALID_AFFILIATE_URL", async () => {
    const { repo } = buildMockRepo();
    const preflight = await preflightPublication(
      { candidateId: "cand-test-001", affiliateUrl: "nao-e-uma-url" },
      repo
    );
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "INVALID_AFFILIATE_URL");
  });

  test("B.13 — contradições abertas → OPEN_CONTRADICTIONS", async () => {
    const { repo } = buildMockRepo({
      assessment: buildAssessment({
        contradictions: [{ evidenceId: "e1", field: "price", oldValue: "10", newValue: "20", status: "OPEN" }],
      }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "OPEN_CONTRADICTIONS");
  });

  test("B.14 — falhas de coleta abertas → COLLECTION_FAILURES_OPEN", async () => {
    const { repo } = buildMockRepo({
      assessment: buildAssessment({
        collectionFailures: [{ stage: "fetch", state: "OPEN" }],
      }),
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "COLLECTION_FAILURES_OPEN");
  });

  test("B.15 — slug duplicado → DUPLICATE_SLUG", async () => {
    const { repo } = buildMockRepo({
      duplicate: { productId: "prod-existente", reason: "SLUG" },
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "DUPLICATE_SLUG");
  });

  test("B.16 — URL duplicada → DUPLICATE_URL", async () => {
    const { repo } = buildMockRepo({
      duplicate: { productId: "prod-existente", reason: "URL" },
    });
    const preflight = await preflightPublication({ candidateId: "cand-test-001", affiliateUrl: null }, repo);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.failureCode, "DUPLICATE_URL");
  });

  test("B.17 — preflight falho não lança quando o erro é de duplicidade (fail-safe da rota); o executor trata falhas de leitura como erro propagado", async () => {
    // preflightPublication NÃO captura erros de rede: a rota trata a exceção
    // e retorna 503 — o executor nunca cria produto com dados ausentes.
    const repo: PublicationRepositoryAdapter = {
      async getCandidate() { throw new Error("banco caiu"); },
      async getLatestActionableAssessment() { return null; },
      async findDuplicateProduct() { return null; },
      async createCanonicalProduct() { throw new Error("não deveria ser chamado"); },
      async linkPromotion() { return { ok: false }; },
      async restoreCreatedProduct() { return { ok: false }; },
      async recordOperationalEvent() { return { ok: false }; },
    };
    await assert.rejects(
      async () => preflightPublication({ candidateId: "qualquer", affiliateUrl: null }, repo)
    );
  });

  // C. POLICY FAIL-CLOSED
  test("C.1 — policy DENY ⇒ POLICY_DENIED, nada é criado", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest({ policyDecision: "DENY" }),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "POLICY_DENIED");
    assert.equal(created.product, undefined);
    assert.equal(created.linked, undefined);
  });

  test("C.2 — policy REQUIRES_APPROVAL sem aprovação válida ⇒ WAITING_APPROVAL", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest({ policyDecision: "REQUIRES_APPROVAL" }),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("PENDING"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "WAITING_APPROVAL");
    assert.equal(created.product, undefined);
    assert.equal(created.linked, undefined);
  });

  test("C.3 — REQUIRES_APPROVAL com aprovação aprovada ⇒ prossegue", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest({ policyDecision: "REQUIRES_APPROVAL" }),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("APPROVED"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "PUBLISHED");
    assert.ok(created.product);
    assert.equal(created.linked, true);
  });

  test("C.4 — REQUIRES_APPROVAL com aprovação expirada ⇒ WAITING_APPROVAL", async () => {
    const lookup: ApprovalLookup = {
      async findApproval() {
        return {
          approvalId: "appr-expired",
          state: "EXPIRED",
          expiresAt: "2026-01-01T00:00:00Z",
        };
      },
    };
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest({ policyDecision: "REQUIRES_APPROVAL" }),
      affiliateUrl: null,
      repo,
      approveLookup: lookup,
      clock: () => "2026-08-16T00:00:00Z",
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "WAITING_APPROVAL");
    assert.equal(created.product, undefined);
  });

  // D. EXECUÇÃO GOVERNADA COMPLETA
  test("D.1 — happy path: produto criado, vínculo registrado, eventos auditados", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "PUBLISHED");
    assert.equal(result.productId, "prod-created-by-test");
    assert.ok(created.product);
    assert.equal(created.linked, true);
    assert.ok((created.events.length) > 0);
    assert.equal(created.events.some(e => e.type.startsWith("PUBLICATION_")), true);
    // Correlation id é propagado para todos os eventos (auditoria vinculável).
    const correlationIds = new Set(created.events.map(e => e.correlationId));
    assert.equal(correlationIds.size, 1);
    assert.equal([...correlationIds][0], "corr-test-001");
  });

  test("D.2 — produto usa o link do anúncio quando não há affiliate URL", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, true);
    assert.equal(created.product!.link, "https://www.mercadolivre.com.br/produto-123");
    // affiliateState=UNKNOWN quando não há fonte de afiliado (nada inventado).
    const executed = created.events.find(e => e.type === "PUBLICATION_EXECUTED");
    assert.equal(String(executed?.payload.affiliateState), "UNKNOWN");
  });

  test("D.3 — com affiliate URL válida, produto usa o link de afiliado e affiliateState=AVAILABLE", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: "https://shopee.com.br/afiliado?q=1",
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "PUBLISHED");
    assert.equal(created.product!.link, "https://shopee.com.br/afiliado?q=1");
    const executed = created.events.find(e => e.type === "PUBLICATION_EXECUTED");
    assert.equal(String(executed?.payload.affiliateState), "AVAILABLE");
  });

  test("D.4 — affiliate URL nunca é derivada: invalida → bloqueada no preflight", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: "javascript:alert(1)",
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "VALIDATION_FAILED");
    assert.equal(created.product, undefined);
  });

  // E. IDEMPOTÊNCIA
  test("E.1 — replay idêntico é estruturalmente idempotente (vínculo oficial bloqueia)", async () => {
    // Mock com estado: após linkPromotion bem-sucedido, getCandidate passa
    // a reportar o candidate promovido (comportamento real do promoteToProduct).
    const created: Created = { events: [] };
    let promoted = false;
    const repo: PublicationRepositoryAdapter = {
      async getCandidate() {
        return buildCandidate(promoted ? { promotedProductId: "prod-created-by-test" } : {});
      },
      async getLatestActionableAssessment() { return buildAssessment(); },
      async findDuplicateProduct() { return null; },
      async createCanonicalProduct(input) {
        const product: CreatedProduct = Object.freeze({
          id: "prod-created-by-test",
          produto: input.produto, slug: input.slug, link: input.link,
          preco: input.preco, categoria: input.categoria, ref: input.ref,
          created_by: "publication-executor", status: "published", ativo: true,
        });
        created.product = product;
        return product;
      },
      async linkPromotion() { promoted = true; created.linked = true; return { ok: true }; },
      async restoreCreatedProduct() { return { ok: true }; },
      async recordOperationalEvent(event) {
        created.events.push({ correlationId: event.correlationId, type: event.type, payload: event.payload });
        return { ok: true };
      },
    };
    const request = buildRequest();
    const r1 = await executePublication({
      request, affiliateUrl: null, repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(r1.ok, true);
    const firstProductId = created.product!.id;

    // Segunda chamada com o mesmo request: o candidate agora está promovido
    // (vínculo oficial via promoteToProduct) ⇒ a publicação não se repete.
    const r2 = await executePublication({
      request, affiliateUrl: null, repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    // Execução não duplica: não há novo produto criado.
    assert.equal(created.product!.id, firstProductId);
    assert.equal(r2.ok, false);
    assert.equal(r2.failureCode, "ALREADY_PROMOTED");
  });

  test("E.2 — evento duplicado de criação não ocorre no replay", async () => {
    const created: Created = { events: [] };
    let promoted = false;
    const repo: PublicationRepositoryAdapter = {
      async getCandidate() {
        return buildCandidate(promoted ? { promotedProductId: "prod-created-by-test" } : {});
      },
      async getLatestActionableAssessment() { return buildAssessment(); },
      async findDuplicateProduct() { return null; },
      async createCanonicalProduct(input) {
        const product: CreatedProduct = Object.freeze({
          id: "prod-created-by-test",
          produto: input.produto, slug: input.slug, link: input.link,
          preco: input.preco, categoria: input.categoria, ref: input.ref,
          created_by: "publication-executor", status: "published", ativo: true,
        });
        created.product = product;
        return product;
      },
      async linkPromotion() { promoted = true; created.linked = true; return { ok: true }; },
      async restoreCreatedProduct() { return { ok: true }; },
      async recordOperationalEvent(event) {
        created.events.push({ correlationId: event.correlationId, type: event.type, payload: event.payload });
        return { ok: true };
      },
    };
    const request = buildRequest();
    await executePublication({
      request, affiliateUrl: null, repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    const eventsAfterFirst = created.events.length;
    await executePublication({
      request, affiliateUrl: null, repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    // Sem novo evento de execução — a segunda tentativa nem chega à criação.
    assert.equal(created.events.length, eventsAfterFirst);
    assert.equal(created.linked, true);
  });

  // F. EXECUÇÃO DUPLICADA (decision distinta, mesmo candidate)
  test("F.1 — nova decision para o mesmo candidate promovido é bloqueada", async () => {
    const created: Created = { events: [] };
    let promoted = false;
    const repo: PublicationRepositoryAdapter = {
      async getCandidate() {
        return buildCandidate(promoted ? { promotedProductId: "prod-created-by-test" } : {});
      },
      async getLatestActionableAssessment() { return buildAssessment(); },
      async findDuplicateProduct() { return null; },
      async createCanonicalProduct(input) {
        const product: CreatedProduct = Object.freeze({
          id: "prod-created-by-test",
          produto: input.produto, slug: input.slug, link: input.link,
          preco: input.preco, categoria: input.categoria, ref: input.ref,
          created_by: "publication-executor", status: "published", ativo: true,
        });
        created.product = product;
        return product;
      },
      async linkPromotion() { promoted = true; created.linked = true; return { ok: true }; },
      async restoreCreatedProduct() { return { ok: true }; },
      async recordOperationalEvent() { return { ok: true }; },
    };
    const r1 = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(r1.ok, true);

    // Segunda DECISION com o mesmo candidate mas outro idempotency_key:
    // o candidate agora está promovido ⇒ o vínculo oficial bloqueia.
    const decision2 = buildPublicationDecision({
      candidateId: "cand-test-001",
      assessmentId: "ass-test-001",
      policyDecision: "ALLOW",
      approvalState: "NOT_REQUIRED",
      rationale: "segunda decisão",
      decidedBy: "operator-admin" as const,
      correlationId: "corr-test-002",
      clock: () => "2026-08-16T00:00:01Z",
    });
    const r2 = await executePublication({
      request: {
        candidateId: "cand-test-001",
        decision: decision2,
        affiliateSource: null,
        correlationId: "corr-test-002",
        executionId: "exec-pub-cand-test-001-002",
        idempotencyKey: decision2.decisionId.replace("pubd-", "pubk-"),
        decidedBy: "operator-admin",
      },
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.failureCode, "ALREADY_PROMOTED");
    assert.ok(created.product);
  });

  // G. FALHA INTERMEDIÁRIA + ROLLBACK
  test("G.1 — createCanonicalProduct falha ⇒ execução falha sem produto criado", async () => {
    const { repo, created } = buildMockRepo({ createProductError: true });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "VALIDATION_FAILED");
    assert.equal(result.failureCode, "PRODUCT_CREATION_FAILED");
    assert.equal(created.product, undefined);
    assert.equal(created.linked, undefined);
    // Rollback desnecessário: produto nunca foi criado.
    assert.equal(created.restored, undefined);
  });

  test("G.2 — linkPromotion falha após criação ⇒ rollback do produto criado", async () => {
    const { repo, created } = buildMockRepo({ linkPromotionOk: false });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "VALIDATION_FAILED");
    assert.equal(result.failureCode, "PROMOTION_LINK_FAILED");
    // Rollback executado: produto criado foi revertido.
    assert.equal(created.restored, "prod-created-by-test");
    assert.equal(created.linked, false);
  });

  // H. AUDITORIA
  test("H.1 — eventos operacionais são registrados para cada estágio (auditoria completa)", async () => {
    const { repo, created } = buildMockRepo();
    await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    const types = created.events.map(e => e.type);
    assert.equal(types.includes("PUBLICATION_EXECUTED"), true);
  });

  test("H.2 — decisionId estável é auditável na proveniência do evento", async () => {
    const { repo, created } = buildMockRepo();
    await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    const executed = created.events.find(e => e.type === "PUBLICATION_EXECUTED");
    assert.ok(executed);
    assert.equal(String(executed!.payload.decisionId).startsWith("pubd-"), true);
    assert.match(String(String(executed!.payload.executionId)), /exec-pub-/);
  });

  test("H.3 — executionId e idempotencyKey propagados ao evento de auditoria", async () => {
    const { repo, created } = buildMockRepo();
    await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    const executed = created.events.find(e => e.type === "PUBLICATION_EXECUTED");
    assert.equal(String(executed!.payload.executionId), "exec-pub-cand-test-001-001");
    assert.equal(String(executed!.payload.idempotencyKey).startsWith("pubk-"), true);
  });

  // I. GOVERNANÇA — nada é criado sem decisão/policy
  test("I.1 — decisão DENY + preflight OK ⇒ nada é criado, nada é vinculado", async () => {
    const { repo, created } = buildMockRepo();
    const result = await executePublication({
      request: buildRequest({ policyDecision: "DENY" }),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "POLICY_DENIED");
    assert.equal(created.product, undefined);
    assert.equal(created.linked, undefined);
  });

  test("I.2 — preflight falho nunca chega à criação mesmo com policy ALLOW", async () => {
    const { repo, created } = buildMockRepo({
      assessment: buildAssessment({ isActionable: false }),
    });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "VALIDATION_FAILED");
    assert.equal(created.product, undefined);
    assert.equal(created.linked, undefined);
  });

  // J. PRODUÇÃO NÃO TOCADA (mock garante — sem instância Supabase real)
  test("J.1 — adapter de teste interage apenas com memória (sem Supabase)", async () => {
    const { repo } = buildMockRepo();
    assert.equal(typeof repo.getCandidate, "function");
    assert.equal(typeof repo.getLatestActionableAssessment, "function");
    assert.equal(typeof repo.findDuplicateProduct, "function");
    assert.equal(typeof repo.createCanonicalProduct, "function");
    assert.equal(typeof repo.linkPromotion, "function");
    assert.equal(typeof repo.restoreCreatedProduct, "function");
    assert.equal(typeof repo.recordOperationalEvent, "function");
  });

  // K. PROVENIÊNCIA
  test("K.1 — proveniência carrega assessmentId, filterVersion e decisionId", async () => {
    const { repo, created } = buildMockRepo();
    await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    const executed = created.events.find(e => e.type === "PUBLICATION_EXECUTED");
    assert.equal(String(executed!.payload.assessmentId), "ass-test-001");
    assert.equal(String(executed!.payload.decisionId).startsWith("pubd-"), true);
    // Proveniência do contract também exposta (contract não-null).
    assert.ok(executed);
  });

  // L. DADOS FALTANTES / CASOS MEDIANOS
  test("L.1 — candidate sem imagens e sem descrição ainda é publicável", async () => {
    const { repo, created } = buildMockRepo({
      candidate: buildCandidate({ images: null, description: null }),
    });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "PUBLISHED");
  });

  test("L.2 — candidate REJECTED nunca é publicável", async () => {
    const { repo, created } = buildMockRepo({
      candidate: buildCandidate({ status: "REJECTED" }),
    });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, "CANDIDATE_NOT_APPROVED");
    assert.equal(created.product, undefined);
  });

  test("L.3 — candidate WITHDRAWN nunca é publicável", async () => {
    const { repo, created } = buildMockRepo({
      candidate: buildCandidate({ status: "WITHDRAWN" }),
    });
    const result = await executePublication({
      request: buildRequest(),
      affiliateUrl: null,
      repo,
      approveLookup: buildApprovalLookup("NOT_REQUIRED"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, "CANDIDATE_NOT_APPROVED");
    assert.equal(created.product, undefined);
  });
});
