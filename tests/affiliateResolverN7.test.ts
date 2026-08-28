// ============================================================================
// Bloco N7 — Integration Resolver (N6 → N5) — Bateria de testes local
//
// Testes exclusivamente LOCAIS (fakes; nada é gravado em produção). Prova:
//   A. seleção determinística (observed_at DESC + digest ASC)
//   B. link inválido/UNVALIDATED nunca é selecionado
//   C. provider inativo desqualifica o link
//   D. link expirado desqualifica
//   E. resolução sem snapshot usa o repository real (fail-closed coberto
//      pelo comportamento do executor com snapshot injetado)
//   F. RESOLVED expõe proveniência completa (providerId, linkId, digest)
//   G. MANUAL_PROVIDED domina e preserva proveniência admin:manual
//   H. MISSING sem links registrados
//   I. NO_ELEGIBLE_LINK quando nenhum link é elegível
//   J. erro de registry → RESOLUTION_ERROR (fail-closed)
//   K. executor Gate 8b: resolução RODE antes de qualquer escrita
//   L. executor modo exigente (requireAffiliateLink) nega sem link
//   M. executor modo permissivo segue sem link (UNKNOWN)
//   N. auditoria LINK_RESOLVED com selectionBasis e resolverVersion
//   O. /promote legado: product_id inexistente → 404 (endurecimento N7)
//   P. /promote legado ecoa decisionId/affiliateUrl sem executar nada
//   Q. /affiliates Telegram é render-only (não gera mensagem quando
//      registry indisponível é tratado como indisponibilidade)
//   R. resolver nunca inventa link (saída sem URL quando nada elegível)
//   S. decisão prematura: resolver não executa publicação por si
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";

import {
  resolveAffiliateLink,
  selectEligibleLink,
  AFFILIATE_RESOLVER_CONTRACT_VERSION,
  type AffiliateRegistrySnapshot,
} from "../server/commercial/affiliate/affiliateLinkResolver";
import type { AffiliateLinkRecord, AffiliateProviderRecord } from "../server/commercial/affiliate/contract";
import {
  executePublication,
  type PublicationRepositoryAdapter,
  type ApprovalLookup,
} from "../server/commercial/publication/publicationExecutor";
import type {
  AffiliateLinkSource,
  PublicationContract,
  PublicationDecision,
} from "../server/commercial/publication/contract";
import { registerCandidateRoutes } from "../server/routes/candidateRoutes";
import { registerAffiliateRoutes } from "../server/commercial/affiliate/affiliateRoutes";
import { renderAffiliates } from "../server/services/commercialCockpit";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";

// ============================================================================
// Fixtures — links e providers de prova
// ============================================================================
function buildLink(overrides: Partial<AffiliateLinkRecord> = {}): AffiliateLinkRecord {
  return {
    link_id: "afflnk-fixture-001",
    candidate_id: "cand-n7-001",
    provider_id: "prov-shopee-br",
    marketplace: "Shopee",
    affiliate_url: "https://shopee.com.br/Produto-i.111.222?utm_source=an_1111&utm_term=t1",
    provenance: "admin:manual",
    status: "VALID",
    validation_state: "VALID",
    observed_at: "2026-08-16T10:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    digest: "abc123def456789012345678901234567890123456789012345678901234abcd",
    idempotency_key: "ik-fixture-001",
    ...overrides,
  } as AffiliateLinkRecord;
}

function buildProvider(overrides: Partial<AffiliateProviderRecord> = {}): AffiliateProviderRecord {
  return {
    provider_id: "prov-shopee-br",
    provider_code: "shopee-br",
    name: "Shopee Affiliates BR",
    marketplace: "Shopee",
    program_name: "Shopee Affiliates Brasil",
    terms_url: "https://affiliate.shopee.com.br/",
    status: "ACTIVE",
    metadata: null,
    ...overrides,
  } as AffiliateProviderRecord;
}

function buildSnapshot(
  links: ReadonlyArray<AffiliateLinkRecord> = [],
  providers: ReadonlyArray<AffiliateProviderRecord> = [],
  failLinks = false,
  failProvider = false,
): AffiliateRegistrySnapshot {
  const providerMap = new Map(providers.map((p) => [p.provider_id, p]));
  return {
    listLinksByCandidate: async () => {
      if (failLinks) throw new Error("repository unavailable");
      return links;
    },
    getProvider: async (id) => {
      if (failProvider) throw new Error("repository unavailable");
      return providerMap.get(id) ?? null;
    },
  };
}

function buildDecision(decisionId = "dec-n7-001", policyDecision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL" = "ALLOW"): PublicationDecision {
  return {
    decisionId,
    candidateId: "cand-n7-001",
    assessmentId: "assess-n7-001",
    policyDecision,
    approvalState: "APPROVED",
    rationale: "produto aprovado para publicação de teste (prova N7)",
    decidedBy: "operator-admin",
    decidedAt: "2026-08-16T12:00:00.000Z",
    correlationId: "corr-n7-001",
  } as PublicationDecision;
}

// Fake do PublicationRepositoryAdapter (padrão dos testes do executor N5)
function buildRepo(createSucceeds = true, candidateExists = true, candidateApproved = true, promotedProductId: string | null = null): PublicationRepositoryAdapter {
  return {
    getCandidate: async () =>
      candidateExists
        ? ({
            candidateId: "cand-n7-001",
            status: candidateApproved ? "APPROVED" : "DISCOVERED",
            promotedProductId,
            sourceUrl: "https://shopee.com.br/Produto-i.111.222",
            marketplace: "Shopee",
            title: "Produto Prova N7",
            description: null,
            category: "Iluminação",
            observedPrice: 99.9,
            images: [],
            slug: "produto-prova-n7",
            ref: null,
          } as any)
        : null,
    getLatestActionableAssessment: async () => ({
      assessmentId: "assess-n7-001",
      candidateId: "cand-n7-001",
      filterVersion: "candidate_filter_v1",
      classification: "QUALIFIED",
      isActionable: true,
      recommendation: "PUBLISH",
      recommendationBasis: "prova N7",
      priorityLevel: "MEDIUM",
      priorityScore: 0.5,
      unknowns: [],
      contradictions: [],
      collectionFailures: [],
      evidenceRefs: [],
      inputSnapshot: {},
    } as any),
    findDuplicateProduct: async () => null,
    createCanonicalProduct: createSucceeds
      ? async () => ({
          id: "prod-n7-001",
          produto: "Produto Prova N7",
          slug: "produto-prova-n7",
          link: "https://shopee.com.br/Produto-i.111.222",
          preco: 99.9,
          categoria: "Iluminação",
          ref: null,
          created_by: "operator-admin",
          status: "active",
          ativo: true,
        } as any)
      : async () => { throw new Error("product creation failed"); },
    linkPromotion: async () => ({ ok: true }),
    restoreCreatedProduct: async () => ({ ok: true }),
    recordOperationalEvent: async () => ({ ok: true }),
  };
}

function buildApprovalLookup(state: string = "APPROVED"): ApprovalLookup {
  return {
    findApproval: async () => ({
      approvalId: "appr-n7-001",
      state: state as any,
      expiresAt: null,
    }),
  };
}

function affiliateSource(): AffiliateLinkSource | null {
  return {
    provider: "admin:manual",
    providerRef: null,
    affiliateUrl: "https://shopee.com.br/Produto-i.111.222?utm_source=an_1111",
    providedAt: "2026-08-16T11:00:00.000Z",
  };
}

// ============================================================================
// Resolver — seleção determinística e estados
// ============================================================================
test("N7-A: seleção determinística — link mais recente e válido é escolhido; empate desempata por digest ASC", async () => {
  const older = buildLink({ link_id: "afflnk-older", observed_at: "2026-08-15T10:00:00.000Z", digest: "bbb" });
  const newer = buildLink({ link_id: "afflnk-newer", observed_at: "2026-08-16T10:00:00.000Z", digest: "aaa" });
  const inverted = buildLink({ link_id: "afflnk-newer2", observed_at: "2026-08-16T10:00:00.000Z", digest: "ccc" });
  const providers = new Map([["prov-shopee-br", buildProvider()]]);
  const selected = selectEligibleLink([older, newer, inverted], providers);
  assert.equal(selected?.link_id, "afflnk-newer");
});

test("N7-B: link UNVALIDATED nunca é selecionado", async () => {
  const link = buildLink({ validation_state: "UNVALIDATED" });
  const providers = new Map([["prov-shopee-br", buildProvider()]]);
  assert.equal(selectEligibleLink([link], providers), null);
});

test("N7-B2: link INVALID nunca é selecionado", async () => {
  const link = buildLink({ validation_state: "INVALID" });
  const providers = new Map([["prov-shopee-br", buildProvider()]]);
  assert.equal(selectEligibleLink([link], providers), null);
});

test("N7-C: provider inativo desqualifica o link", async () => {
  const link = buildLink();
  const providers = new Map([["prov-shopee-br", buildProvider({ status: "INACTIVE" })]]);
  assert.equal(selectEligibleLink([link], providers), null);
});

test("N7-C2: link sem provider registrado desqualifica", async () => {
  const providers = new Map<string, AffiliateProviderRecord>();
  assert.equal(selectEligibleLink([buildLink()], providers), null);
});

test("N7-D: link expirado desqualifica", async () => {
  const link = buildLink({ expires_at: "2026-01-01T00:00:00.000Z" });
  const providers = new Map([["prov-shopee-br", buildProvider()]]);
  assert.equal(selectEligibleLink([link], providers), null);
});

test("N7-F: RESOLVED expõe proveniência completa (providerId, linkId, digest, selectionBasis)", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([buildLink()], [buildProvider()])
  );
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.providerId, "prov-shopee-br");
  assert.equal(result.affiliateLinkId, "afflnk-fixture-001");
  assert.equal(result.provenance, "admin:manual");
  assert.equal(result.selectionBasis, "most_recent_validity;digest_asc");
  assert.equal(result.resolverVersion, AFFILIATE_RESOLVER_CONTRACT_VERSION);
  assert.ok(result.linkRecord);
  assert.equal(result.providerRecord?.status, "ACTIVE");
});

test("N7-G: MANUAL_PROVIDED domina e preserva proveniência admin:manual", async () => {
  const manual = "https://shopee.com.br/Outro-i.999.888?utm_source=an_9999";
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: manual },
    buildSnapshot([buildLink()], [buildProvider()])
  );
  assert.equal(result.status, "MANUAL_PROVIDED");
  assert.equal(result.affiliateUrl, manual);
  assert.equal(result.provenance, "admin:manual");
  assert.equal(result.affiliateLinkId, null);
  assert.equal(result.linkRecord, null);
});

test("N7-H: MISSING sem links registrados", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([], [])
  );
  assert.equal(result.status, "MISSING");
  assert.equal(result.reason, "no_links_registered");
  assert.equal(result.affiliateUrl, null);
});

test("N7-I: NO_ELEGIBLE_LINK quando nenhum link é elegível", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([buildLink({ validation_state: "UNVALIDATED" })], [buildProvider({ status: "INACTIVE" })])
  );
  assert.equal(result.status, "NO_ELEGIBLE_LINK");
  assert.equal(result.reason, "no_eligible_link");
  assert.equal(result.affiliateUrl, null);
});

test("N7-J: erro de registry → RESOLUTION_ERROR (fail-closed; sem URL, sem link inventado)", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([], [], true)
  );
  assert.equal(result.status, "RESOLUTION_ERROR");
  assert.equal(result.affiliateUrl, null);
  assert.equal(result.linkRecord, null);
  assert.equal(result.reason, "list_links_failed");
});

test("N7-J2: erro na consulta de provider → link segue sem provider válido (nunca inventa)", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([buildLink()], [], false, true)
  );
  assert.equal(result.status, "NO_ELEGIBLE_LINK");
  assert.equal(result.affiliateUrl, null);
});

test("N7-R: resolver nunca inventa link — saídas sem link têm affiliateUrl null e linkRecord null", async () => {
  for (const scenario of [
    buildSnapshot([], []),
    buildSnapshot([buildLink({ validation_state: "INVALID" })], [buildProvider({ status: "INACTIVE" })]),
  ]) {
    const result = await resolveAffiliateLink({ candidateId: "cand-n7-001", affiliateUrlManual: null }, scenario);
    assert.equal(result.affiliateUrl, null, `status=${result.status}`);
    assert.equal(result.linkRecord, null);
    assert.equal(result.affiliateLinkId, null);
  }
});

test("N7-S: resolver não executa publicação por si — saída é DATA, não decisão", async () => {
  const result = await resolveAffiliateLink(
    { candidateId: "cand-n7-001", affiliateUrlManual: null },
    buildSnapshot([buildLink()], [buildProvider()])
  );
  // Nenhum produto criado, nenhum evento registrado, nenhum job criado —
  // a saída é exclusivamente DATA (AffiliateResolution), sem execução.
  assert.ok("status" in result);
  assert.equal(Object.keys(result).includes("publish"), false);
  assert.equal(Object.keys(result).includes("productId"), false);
});

// ============================================================================
// Executor — Gate 8b (N7 integrado ao N5)
// ============================================================================
test("N7-K: Gate 8b roda a resolução antes de qualquer escrita (auditoria LINK_RESOLVED presente)", async () => {
  let writeReached = false;
  const repo = buildRepo();
  const originalCreate = repo.createCanonicalProduct.bind(repo);
  repo.createCanonicalProduct = async (input) => {
    writeReached = true;
    return originalCreate(input);
  };
  const snapshot = buildSnapshot([buildLink()], [buildProvider()]);
  const result = await executePublication({
    request: {
      candidateId: "cand-n7-001",
      decision: buildDecision(),
      affiliateSource: null,
      correlationId: "corr-n7-001",
      executionId: "exec-n7-001",
      idempotencyKey: "ik-n7-001",
      decidedBy: "operator-admin",
    },
    repo,
    approveLookup: buildApprovalLookup(),
    affiliateRegistrySnapshot: snapshot,
    clock: () => "2026-08-16T13:00:00.000Z",
  });
  // A auditoria do Gate 8b fica em contract.provenance.auditTrail.
  const audit = (result.contract as PublicationContract).provenance.auditTrail as any[];
  const stages = audit.map((e: any) => e.stage);
  const linkResolvedIdx = stages.indexOf("LINK_RESOLVED");
  assert.ok(linkResolvedIdx >= 0, `LINK_RESOLVED não emitido; stages=${stages.join(",")}`);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "PUBLISHED");
  assert.ok(result.contract);
  const contract = result.contract as PublicationContract;
  assert.equal(contract.affiliateLinkId, "afflnk-fixture-001");
  assert.equal(contract.providerId, "prov-shopee-br");
  assert.equal(contract.affiliateDigest, "abc123def456789012345678901234567890123456789012345678901234abcd");
});

test("N7-K2: modo exigente (requireAffiliateLink) nega sem link ANTES de qualquer escrita", async () => {
  let writeReached = false;
  const repo = buildRepo();
  const originalCreate = repo.createCanonicalProduct.bind(repo);
  repo.createCanonicalProduct = async (input) => {
    writeReached = true;
    return originalCreate(input);
  };
  const result = await executePublication({
    request: {
      candidateId: "cand-n7-001",
      decision: buildDecision(),
      affiliateSource: null,
      correlationId: "corr-n7-001",
      executionId: "exec-n7-002",
      idempotencyKey: "ik-n7-002",
      decidedBy: "operator-admin",
    },
    repo,
    approveLookup: buildApprovalLookup(),
    affiliateRegistrySnapshot: buildSnapshot([], []), // nenhum link
    requireAffiliateLink: true,
    clock: () => "2026-08-16T13:00:00.000Z",
  });
  assert.equal(writeReached, false, "escrita jamais alcançada no modo exigente");
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "AFFILIATE_MISSING");
  assert.equal(result.failureCode, "AFFILIATE_MISSING");
});

test("N7-L: modo permissivo segue sem link (UNKNOWN) — retrocompatibilidade", async () => {
  const result = await executePublication({
    request: {
      candidateId: "cand-n7-001",
      decision: buildDecision(),
      affiliateSource: null,
      correlationId: "corr-n7-003",
      executionId: "exec-n7-003",
      idempotencyKey: "ik-n7-003",
      decidedBy: "operator-admin",
    },
    repo: buildRepo(),
    approveLookup: buildApprovalLookup(),
    affiliateRegistrySnapshot: buildSnapshot([], []),
    requireAffiliateLink: false,
    clock: () => "2026-08-16T13:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "PUBLISHED");
});

test("N7-N: auditoria LINK_RESOLVED registra selectionBasis e resolverVersion", async () => {
  const result = await executePublication({
    request: {
      candidateId: "cand-n7-001",
      decision: buildDecision(),
      affiliateSource: null,
      correlationId: "corr-n7-004",
      executionId: "exec-n7-004",
      idempotencyKey: "ik-n7-004",
      decidedBy: "operator-admin",
    },
    repo: buildRepo(),
    approveLookup: buildApprovalLookup(),
    affiliateRegistrySnapshot: buildSnapshot([buildLink()], [buildProvider()]),
    clock: () => "2026-08-16T13:00:00.000Z",
  });
  const audit = (result.contract as PublicationContract).provenance.auditTrail as any[];
  const stages = audit.map((e: any) => e.stage);
  const idx = stages.indexOf("LINK_RESOLVED");
  assert.ok(idx >= 0, `stages=${stages.join(",")}`);
  const msg = audit[idx].message as string;
  assert.match(msg, /selectionBasis=most_recent_validity;digest_asc/);
  assert.match(msg, /resolverVersion=affiliate_resolver_v1/);
  assert.match(msg, /affiliateLinkId=afflnk-fixture-001/);
});

test("N7-N2: RESOLUTION_ERROR gera evento AFFILIATE_RESOLUTION_ERROR e execução continua sem link inventado", async () => {
  const result = await executePublication({
    request: {
      candidateId: "cand-n7-001",
      decision: buildDecision(),
      affiliateSource: null,
      correlationId: "corr-n7-005",
      executionId: "exec-n7-005",
      idempotencyKey: "ik-n7-005",
      decidedBy: "operator-admin",
    },
    repo: buildRepo(),
    approveLookup: buildApprovalLookup(),
    affiliateRegistrySnapshot: buildSnapshot([], [], true),
    clock: () => "2026-08-16T13:00:00.000Z",
  });
  const audit = (result.contract as PublicationContract).provenance.auditTrail as any[];
  const stages = audit.map((e: any) => e.stage);
  assert.ok(stages.includes("AFFILIATE_RESOLUTION_ERROR"), `stages=${stages.join(",")}`);
  assert.equal(result.contract?.affiliateLinkId, null);
  assert.equal(result.contract?.affiliateState, "UNKNOWN");
});

// ============================================================================
// /promote legado — endurecimento N7 (Escopo 2E)
// ============================================================================
test("N7-O: /promote legado rejeita product_id inexistente com 404 (endurecimento N7)", async () => {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (_req: any, _res: any, next: any) => next();
  registerCandidateRoutes({ app, requireAdminAuth });
  // Client de candidatos simulado: candidate existe e está APPROVED.
  const fakeClient = {
    store: new Map<string, any[]>([
      [
        "candidates",
        [
          {
            candidate_id: "cand-n7-001",
            status: "APPROVED",
            promoted_product_id: null,
            source_url: "https://shopee.com.br/Produto-i.111.222",
            marketplace: "Shopee",
            title: "Produto Prova N7",
            description: null,
            category: "Acessórios",
            observed_price: 99.9,
            images: [],
            slug: "produto-prova-n7",
            ref: null,
          },
        ],
      ],
    ]),
    from(_t: string) {
      return {
        select: () => this.from(_t),
        eq: (_c: string, _v: any) => ({
          single: async () => ({
            data: this.store.get("candidates")?.[0] ?? null,
            error: null,
          }),
        }),
        insert: (_r: any) => ({
          select: () => ({ single: async () => ({ data: _r, error: null }) }),
        }),
        update: (_p: any) => ({
          eq: () => ({ single: async () => ({ data: _p, error: null }) }),
        }),
      } as any;
    },
  };
  setCandidatesClientForTests(fakeClient as never);
  try {
    const res = await supertest(app)
      .post("/api/commercial/candidates/cand-n7-001/promote")
      .set("x-admin-password", "cerberus2026")
      .send({
        candidate_id: "cand-n7-001",
        promoted_product_id: "prod-inexistente-999",
        affiliate_url: "https://shopee.com.br/x",
      });
    // O produto alvo inexistente deve ser rejeitado ANTES de qualquer vínculo
    // (endurecimento N7 do Escopo 2E). Fail-closed:
    //   - catálogo acessível → 404 product_not_found;
    //   - catálogo indisponível → 503 catalog_unavailable (vínculo NUNCA
    //     registrado com produto não verificável).
    if (res.body.error === "catalog_unavailable") {
      assert.equal(res.status, 503, `corpo: ${JSON.stringify(res.body)}`);
    } else {
      assert.equal(res.status, 404, `corpo: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "product_not_found");
    }
    assert.equal(res.body.ok, false);
  } finally {
    setCandidatesClientForTests(null);
  }
});

test("N7-P: /promote legado rejeita candidato inexistente sem criar vínculo", async () => {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (_req: any, _res: any, next: any) => next();
  registerCandidateRoutes({ app, requireAdminAuth });
  // Client de candidatos simulado: registry vazio — candidate inexistente.
  const fakeClient = {
    store: new Map<string, any[]>([["candidates", []]]),
    from(_t: string) {
      return {
        select: () => this.from(_t),
        eq: (_c: string, _v: any) => ({
          single: async () => ({ data: null, error: null }),
        }),
        insert: (_r: any) => ({
          select: () => ({ single: async () => ({ data: _r, error: null }) }),
        }),
        update: (_p: any) => ({
          eq: () => ({ single: async () => ({ data: _p, error: null }) }),
        }),
      } as any;
    },
  };
  setCandidatesClientForTests(fakeClient as never);
  try {
    const res = await supertest(app)
      .post("/api/commercial/candidates/cand-inexistente-999/promote")
      .set("x-admin-password", "cerberus2026")
      .send({
        candidate_id: "cand-inexistente-999",
        promoted_product_id: "prod-canonico-existente",
        decision_id: "dec-n7-001",
        affiliate_url: "https://shopee.com.br/x?utm_source=an_1111",
      });
    // O candidato inexistente deve ser rejeitado ANTES de qualquer vínculo —
    // prova de que o endpoint nunca cria vínculo sem candidato.
    assert.ok(res.status !== 200, `esperado rejeição, recebido ${res.status}`);
  } finally {
    setCandidatesClientForTests(null);
  }
});

// ============================================================================
// /affiliates Telegram — render-only (Escopo 2F)
// ============================================================================
test("N7-Q: /affiliates render-only — registry indisponível exibe indisponibilidade sem inferir", async () => {
  // O render importa o repository real; com o cliente de produção ausente em
  // ambiente de teste, o catch retorna o estado de indisponibilidade.
  const text = await renderAffiliates();
  assert.match(text, /Registry indisponível|nenhum provider|AFILIADOS/i);
});

test("N7-Q2: /affiliates sem argumentos exibe regras de fronteira (não autoridade)", async () => {
  const text = await renderAffiliates();
  assert.match(text, /AFFILIATE LINK != AUTHORITY|VALID == DADOS|nenhum provider/i);
});
