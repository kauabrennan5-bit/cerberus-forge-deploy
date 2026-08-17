// ============================================================================
// Bloco N9 — Ciclo Comercial Real + Decision Gate v1 — Bateria completa
// (LOCAL — sem deploy, sem credenciais, sem chamadas reais).
//
// Estratégia: injeção de dependência TEST-ONLY (padrão N1–N8) — o service N9
// aceita overrides por etapa (setCycleXxxOverrideForTests). Nenhum módulo é
// mockado: isso prova que o N9 é orquestrador injetável, sem fragilidade de
// mockagem de ESM. Os repositórios N9 usam o fakeClient injetável.
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import supertest from "supertest";
import * as cycleService from "../server/commercial/cycle/commercialCycleService";
import {
  setCycleClientForTests,
  listCycles,
  CYCLES_TABLE,
  DECISIONS_TABLE,
  STEPS_TABLE,
  type CycleRecord,
  type DecisionRecord,
  type StepRecord,
} from "../server/commercial/cycle/cycleRepository";
import { setAffiliateClientForTests as setAffClient } from "../server/commercial/affiliate/affiliateRepository";
import { setCandidateAssessmentClient as setCAssClient, getCandidateAssessmentClient } from "../server/repositories/candidateAssessmentRepository";
import { setCandidatesClientForTests as setCandsClient } from "../server/repositories/candidatesRepository";
import {
  evaluateDecisionGate,
  buildDecisionInputDigest,
  isCycleMarketplace,
} from "../server/commercial/cycle/decisionGate";
import type { GateInput } from "../server/commercial/cycle/cycleContract";
import { registerCycleRoutes } from "../server/routes/cycleRoutes";
import type { PublicationRepositoryAdapter } from "../server/commercial/publication/publicationExecutor";
import type { AcquireResult } from "../server/commercial/affiliate/acquisitionContract";
import type { AffiliateRegistrySnapshot } from "../server/commercial/affiliate/affiliateLinkResolver";
// ---------------------------------------------------------------------------
// Estado artificial de prova (artificial, sem nenhuma entidade real).
// ---------------------------------------------------------------------------
const STORE: {
  cycles: CycleRecord[];
  decisions: DecisionRecord[];
  steps: StepRecord[];
  productsInserted: unknown[];
} = { cycles: [], decisions: [], steps: [], productsInserted: [] };

function clearStore() {
  STORE.cycles.length = 0;
  STORE.decisions.length = 0;
  STORE.steps.length = 0;
  STORE.productsInserted.length = 0;
}

let cfg = {
  discoveryOk: true,
  discoveryError: null as string | null,
  candidateStatus: "APPROVED" as string,
  candidateExists: true,
  candidateObservedPrice: 123.45 as number | null,
  researchThrows: false,
  researchOk: true,
  assessmentRecommendation: "ADD_TO_NICHE" as string | null,
  assessmentClassification: null as string | null,
  assessmentUnknowns: [] as unknown[],
  assessmentContradictions: [] as unknown[],
  providers: [] as unknown[], // providers[]: snapshot do resolver N7 (vazio = sem provider ativo)
  assessmentCollectionFailures: [] as unknown[],
  assessmentPersistOk: true,
  acquisitionKind: "PROVIDER_NOT_ACTIVE" as
    | "PROVIDER_NOT_ACTIVE"
    | "SUCCESS"
    | "IDENTITY_UNCERTAIN"
    | "AUTH_REQUIRED"
    | "RESOLUTION_FAILED",
  acquisitionUrl: "https://shopee.com.br/Prova-i.715084914.23794344926",
  providerExists: false,
  linksByCandidate: [] as unknown[],
  resolutionStatus: "MISSING" as string,
  resolutionThrows: false,
  preflightOk: true,
  preflightReason: "preflight_failed" as string,
  publishExecutedCount: 0,
};

function resetCfg() {
  cfg = {
    discoveryOk: true,
    discoveryError: null,
    candidateStatus: "APPROVED",
    candidateExists: true,
    candidateObservedPrice: 123.45,
    researchThrows: false,
    researchOk: true,
    assessmentRecommendation: "ADD_TO_NICHE",
    assessmentClassification: null,
    assessmentUnknowns: [],
    assessmentContradictions: [],
    providers: [],
    assessmentCollectionFailures: [],
    assessmentPersistOk: true,
    acquisitionKind: "PROVIDER_NOT_ACTIVE",
    acquisitionUrl: "https://shopee.com.br/Prova-i.715084914.23794344926",
    providerExists: false,
    linksByCandidate: [],
    resolutionStatus: "MISSING",
    resolutionThrows: false,
    preflightOk: true,
    preflightReason: "preflight_failed",
    publishExecutedCount: 0,
  };
}

function arrayChain(arr: unknown[], keyOf?: (r: unknown) => string) {
  // Select sem single: `await db.from(x).select("*").eq().order().limit()` resolve
  // { data: T[], error: null }. Any prop não-listada retorna o próprio chain.
  const chain: any = { _eq: null as string | null };
  chain.eq = (_c: string, _v: unknown) => { chain._eq = String(_v); return chain; };
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.maybeSingle = async () => {
    const found = chain._eq !== null && keyOf ? arr.find((r) => keyOf(r) === chain._eq) ?? null : arr[0] ?? null;
    return { data: found, error: null };
  };
  chain.single = async () => ({ data: arr[0] ?? null, error: null });
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: arr.slice(), error: null }).then(resolve);
  return chain as any;
}

// ---------------------------------------------------------------------------
// Cliente fake do Supabase (padrão idêntico ao da bateria N8).
// ---------------------------------------------------------------------------
export function fakeClient() {
  const assessmentStore: unknown[] = [];
  return {
    from(table: string) {
      if (table === CYCLES_TABLE) {
        return collection(STORE.cycles, (r: unknown) => (r as CycleRecord).cycle_id);
      }
      if (table === DECISIONS_TABLE) {
        return collection(STORE.decisions, (r: unknown) => (r as DecisionRecord).decision_id);
      }
      if (table === STEPS_TABLE) {
        return collection(STORE.steps, (r: unknown) => (r as StepRecord).step_id);
      }
      if (table === "products") {
        // products NUNCA sofre insert na prova — qualquer gravação é capturada
        // (prova N9-36) e rejeitada (fail-closed: o N9 não toca products).
        return {
          insert: (_records: unknown) => ({
            single: async () => {
              STORE.productsInserted.push(_records);
              return { data: null, error: { message: "products.insert NUNCA permitido no ciclo N9" } };
            },
          }),
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        } as any;
      }
      if (table === "affiliate_links") {
        const linksStore: unknown[] = [];
        return {
          insert: (record: unknown) => {
            linksStore.push({ ...(record as Record<string, unknown>), link_id: "link-proof-n9" });
            return {
              select: () => ({
                single: async () => ({
                  data: linksStore[linksStore.length - 1] ?? null,
                  error: null,
                }),
              }),
            };
          },
          select: () => arrayChain(linksStore, (r: unknown) => ((r as Record<string, unknown>).link_id as string) ?? ""),
        } as any;
      }
      if (table === "affiliate_providers") {
        return {
          insert: () => ({ single: async () => ({ data: null, error: null }) }),
          select: () => ({
            eq: (_c: string, _v: unknown) => ({
              single: async () => ({
                data: cfg.providerExists
                  ? { provider_id: "shopee", marketplace: "shopee", status: "ACTIVE", resolution_method: "API" }
                  : null,
                error: null,
              }),
            }),
          }),
        } as any;
      }
      if (table === "candidate_assessment") {
        // Estado compartilhado entre insert e select (mesma regra do client real):
        // cada chamada de from() cria a coleção, mas insert/select compartilham
        // o array de prova do client.
        const assessmentsStore = assessmentStore;
        return {
          insert: (record: unknown) => {
            assessmentsStore.push({ ...(record as Record<string, unknown>), assessment_id: String((record as Record<string, unknown>).assessment_id ?? "asm-proof-n9") });
            return { single: async () => ({ data: assessmentsStore[assessmentsStore.length - 1] ?? null, error: null }) };
          },
          select: () => arrayChain(assessmentsStore),
        } as any;
      }
      return {
        insert: async () => ({ data: null, error: null }),
        select: () => arrayChain([]),
        update: async () => ({ data: null, error: null }),
        delete: () => arrayChain([]),
      } as any;
    },
  } as never;
}

// Coleção fake do Supabase: cada from() retorna uma consulta NOVA (estado
// eq/order isolado por query) sobre o mesmo array de prova — igual ao client real.
// Usa Proxy: qualquer operação não prevista LANÇA (fail-loud) em vez de
// hangar silenciosamente no test runner.
function collection<T>(arr: T[], keyOf: (r: unknown) => string) {
  function unexpected(name: string): never {
    throw new Error(`fakeClient: operação inesperada "${name}"`);
  }
  // O Supabase client real retorna "builders" THENABLES: `await db.from(x).insert(r)`
  // executa o insert via .then (padrão do cliente real). Persistência N9 (persistStep,
  // updateCycle, deleteCycleProof) depende disso — o builder fake precisa resolver.
  function builderOf(exec: () => Promise<{ data: unknown; error: unknown }>) {
    return {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => exec().then(resolve, reject),
    } as any;
  }
  // insert / update / delete retornam builders thenable (padrão real do Supabase):
  //   await db.from(x).insert(r)            → executa via .then
  //   await db.from(x).insert(r).select().single() → executa o select+single
  //   await db.from(x).update(p).eq(c, v)   → executa o update via .then
  const doInsert = async (record: unknown) => {
    // Duplicate key (PostgreSQL 23505): replicar o comportamento real do
    // banco para idempotencyKey (steps), decision_id (decisions) e cycle_id (cycles).
    const rec = (record ?? {}) as Record<string, unknown>;
    // Chaves de unicidade por tabela (fail-loud): idempotency_key (steps),
    // decision_id (decisions), cycle_id (cycles) e a chave primária de cada
    // coleção (keyOf). A coluna cycle_id NUNCA é usada para steps — senão o
    // segundo passo do mesmo ciclo seria rejeitado como duplicado.
    const dupExisting =
      (rec.idempotency_key !== undefined && arr.find((r) => String((r as Record<string, unknown>).idempotency_key ?? "") === String(rec.idempotency_key))) ||
      (rec.decision_id !== undefined && arr.find((r) => String((r as Record<string, unknown>).decision_id ?? "") === String(rec.decision_id))) ||
      (keyOf(record) !== undefined && rec.cycle_id !== undefined && String(keyOf(record)) === String(rec.cycle_id) && arr.find((r) => keyOf(r) === String(rec.cycle_id))) ||
      arr.find((r) => keyOf(r) === keyOf(record));
    if (dupExisting) {
      const err = new Error("duplicate key 23505") as any;
      err.code = "23505";
      err.message = "duplicate key 23505";
      return { data: null, error: err };
    }
    arr.push(record as T);
    return { data: record, error: null };
  };
  // Busca por eq(): pela PK (keyOf) OU pela coluna do eq() (ex.: cycle_id nas
  // decisions) — o client real resolve qualquer coluna filtrada.
  function findByEq(targetChain: any): T | undefined {
    const col = targetChain._eqCol as string | null;
    const val = targetChain._eq as string | null;
    if (val === null) return undefined;
    if (col) {
      // Coluna arbitrária (ex.: cycle_id em decisions): comparar campo do registro (snake_case).
      const r = arr.find((x) => String((x as Record<string, unknown>)[col] ?? "") === val);
      if (r !== undefined) return r;
    }
    return arr.find((r) => keyOf(r) === val);
  }
  // Chain de consulta compartilhável: eq()/order()/limit()/single()/maybeSingle().
  // exec: quando não-null, single()/maybeSingle() GRAVAM via exec antes de retornar
  // (insert().select() real: insert executa e retorna o registro gravado).
  function makeChain(exec: ((record?: unknown) => Promise<{ data: unknown; error: unknown }>) | null, _id?: string) {
    const chain: any = {
      _eq: null as string | null,
      eq: (_c: string, _v: unknown) => { chain._eqCol = String(_c); chain._eq = String(_v); return chain; },
      neq: () => chain,
      select: () => chain, // insert().select().single() — padrão do persistCycle N9
      order: () => chain,
      limit: () => chain,
      single: async () => {
        if (exec) {
          const res = await exec();
          if (res.error) return res;
          const found = findByEq(chain) ?? null;
          return { data: (found ?? res.data ?? null) as T | null, error: null };
        }
        const found = findByEq(chain) ?? null;
        return { data: (found ?? arr[0] ?? null) as T | null, error: null };
      },
      maybeSingle: async () => {
        const found = findByEq(chain) ?? null;
        return { data: found as T | null, error: null };
      },
    };
    return new Proxy(chain, {
      get(target: any, prop: string) {
        if (prop in target) return target[prop];
        return () => unexpected(`query.${prop}`);
      },
    }) as any;
  }
  // Chain de LEITURA (select sem gravação) — usado por getCycle/listCycles/getDecision etc.
  const readChain: any = makeChain(null as ((r: unknown) => Promise<{ data: unknown; error: unknown }>) | null);
  // listX().select().eq().order().limit() espera um ARRAY — await no thenable
  // resolve { data: arr, error: null } (padrão real do cliente Supabase).
  readChain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: arr.slice(), error: null }).then(resolve);
  return {
    insert: (record: unknown) => {
      // O builder de insert é thenable (padrão real): `await db.from(x).insert(r)`
      // executa o insert; `await db.from(x).insert(r).select().single()` usa o chain.
      const chain = makeChain(async () => doInsert(record), `insert.${(record && (record as any).cycle_id) ?? ""}`);
      chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => doInsert(record).then(resolve, reject);
      return chain;
    },
    select: (_cols?: string) => readChain,
    update: (_u: unknown) => ({
      eq: (_c: string, _v: unknown) => builderOf(async () => {
        // Atualiza o registro achado (mantém a chave) — updateCycle muda status.
        const target2 = String(_v);
        const payload = (_u ?? {}) as Record<string, unknown>;
        for (const r of arr) {
          if (keyOf(r) === target2) {
            for (const k of Object.keys(payload)) (r as Record<string, unknown>)[k] = payload[k];
          }
        }
        return { data: null, error: null };
      }),
    }),
    delete: () => ({
      eq: (_c: string, _v: unknown) => builderOf(async () => {
        const targetCol = String(_c);
        const targetVal = String(_v);
        for (let i = arr.length - 1; i >= 0; i -= 1) {
          const r = arr[i] as Record<string, unknown>;
          if (targetCol === "cycle_id" || targetCol === "candidate_id" || targetCol === "step_id") {
            if (String(r[targetCol] ?? "") === targetVal || (keyOf(r) === targetVal && targetCol === String(_c))) arr.splice(i, 1);
          } else if (keyOf(r) === targetVal) {
            arr.splice(i, 1);
          }
        }
        return { data: null, error: null };
      }),
    }),
  } as any;
}

// ---------------------------------------------------------------------------
// Overrides TEST-ONLY por etapa (injeção de dependência; recai para os
// serviços reais N2–N8 quando null).
// ---------------------------------------------------------------------------
let publishRepo: { preflightCount: number; executeCount: number } = { preflightCount: 0, executeCount: 0 };

function fakePublicationRepo(): PublicationRepositoryAdapter {
  return {
    async getCandidate(_candidateId: string) {
      publishRepo.preflightCount += 1;
      return {
        candidateId: "candidate-proof-n9",
        status: "APPROVED",
        promotedProductId: null,
        sourceUrl: PROOF_SOURCE,
        marketplace: "shopee",
        title: "Produto de Prova N9",
        description: "Descrição de prova",
        category: "Casa",
        observedPrice: 99.9,
        images: [],
        slug: "produto-de-prova-n9",
        ref: "PROOF",
      };
    },
    async getLatestActionableAssessment(_candidateId: string) {
      if (!cfg.preflightOk) return null;
      return {
        assessmentId: "asm-proof-n9",
        candidateId: "candidate-proof-n9",
        filterVersion: "proof",
        classification: null,
        isActionable: Boolean(cfg.assessmentRecommendation),
        recommendation: cfg.assessmentRecommendation,
        recommendationBasis: "prova",
        priorityLevel: "NORMAL",
        priorityScore: 0.5,
        unknowns: cfg.assessmentUnknowns,
        contradictions: cfg.assessmentContradictions,
        collectionFailures: cfg.assessmentCollectionFailures,
      } as unknown as import("../server/commercial/publication/publicationExecutor").AssessmentForPublication;
    },
    async findDuplicateProduct(_slug: string, _link: string) {
      return null;
    },
    async createCanonicalProduct(_input: unknown) {
      publishRepo.executeCount += 1;
      cfg.publishExecutedCount += 1;
      return { productId: "proof-product-id", slug: "produto-de-prova-n9", ref: "PROOF" } as any;
    },
    async linkPromotion(_candidateId: string, _productId: string, _decisionId: string) {
      return { ok: true };
    },
    async restoreCreatedProduct(_productId: string) {
      return { ok: true };
    },
    async recordOperationalEvent(_event: unknown) {
      return { ok: true };
    },
  };
}

function fakeRegistrySnapshot(): AffiliateRegistrySnapshot {
  // O resolver N7 exige a INTERFACE de snapshot (listLinksByCandidate/getProvider),
  // não um objeto bruto {links, providers} — fidelidade ao contrato real.
  return {
    listLinksByCandidate: async (candidateId: string) =>
      (cfg.linksByCandidate as Array<{ candidate_id?: string }>).filter((l) => !l.candidate_id || l.candidate_id === candidateId),
    getProvider: async (providerId: string) =>
      (cfg.providers as Array<{ provider_id?: string }>).find((p) => p.provider_id === providerId) ?? null,
  } as never;
}

function setOverrides() {
  cycleService.setCycleDiscoveryOverrideForTests(async () => {
    if (!cfg.discoveryOk || cfg.discoveryError) {
      return { ok: false, error: cfg.discoveryError ?? "rate_limited", items: [] };
    }
    return {
      ok: true,
      items: [{ candidate_id: "candidate-proof-n9", outcome: "created", title: "Produto de Prova N9" }],
    };
  });
  cycleService.setCycleResearchOverrideForTests(async () => {
    if (cfg.researchThrows) throw new Error("research_infra_error");
    if (!cfg.researchOk) return { ok: false, error: "research_failed" };
    return { ok: true, research_id: "research-proof-n9" };
  });
  cycleService.setCycleAssessmentOverrideForTests(async () => ({
    ok: true,
    dimensions: { price: 1, identity: 1 },
    classification: cfg.assessmentClassification ? { classification: cfg.assessmentClassification, basis: "prova" } : null,
    recommendation: cfg.assessmentRecommendation ? { recommendation: cfg.assessmentRecommendation, basis: "prova" } : null,
    priority: { priority_level: "NORMAL", priority_score: 0.5 },
    unknowns: cfg.assessmentUnknowns,
    contradictions: cfg.assessmentContradictions,
    collectionFailures: cfg.assessmentCollectionFailures,
    evidenceRefs: [],
    inputSnapshot: { provenance: "proof" },
  }));
  cycleService.setCyclePersistAssessmentOverrideForTests(async (input: unknown) => {
    const ok = Boolean(cfg.assessmentPersistOk);
    if (ok && input && typeof input === "object") {
      // Persistência espelhada no fake: a lista de avaliações deve ficar
      // visível para listCandidateAssessments (governança: a decisão N7
      // lê a evidência N4 exatamente como a produção).
      try {
        const caClient = getCandidateAssessmentClient();
        if (caClient) {
          // O buildGateInput (S7) lê o registro DB em snake_case; o espelho
          // precisa gravar o formato canônico do repositório, não o objeto
          // camelCase do override.
          const rec = input as Record<string, unknown>;
          const recommendation = rec?.recommendation;
          const classification = rec?.classification;
          const priority = rec?.priority;
          await caClient.from("candidate_assessment").insert({
            assessment_id: String(rec?.assessment_id ?? "asm-proof-n9"),
            candidate_id: String(rec?.candidateId ?? "candidate-proof-n9"),
            recommendation: typeof recommendation === "object" && recommendation ? (recommendation as Record<string, unknown>).recommendation ?? null : (recommendation ?? null),
            classification: typeof classification === "object" && classification ? (classification as Record<string, unknown>).classification ?? null : (classification ?? null),
            priority_level: typeof priority === "object" && priority ? (priority as Record<string, unknown>).priority_level ?? "NORMAL" : "NORMAL",
            unknowns: Array.isArray(rec?.unknowns) ? rec!.unknowns : [],
            contradictions: Array.isArray(rec?.contradictions) ? rec!.contradictions : [],
            collection_failures: Array.isArray(rec?.collectionFailures) ? rec!.collectionFailures : [],
            created_at: new Date().toISOString(),
          });
        }
      } catch {
        /* espelho opcional — a falha não é a falha testada */
      }
    }
    return {
      ok,
      outcome: "created",
      error: null,
      ...(ok && input && typeof input === "object" ? (input as Record<string, unknown>) : {}),
    };
  });
  cycleService.setCycleAcquisitionOverrideForTests(async (params: unknown) => {
    void params;
    const kind = cfg.acquisitionKind;
    const identity = {
      marketplace: "Shopee" as const,
      listingId: "23794344926",
      canonicalUrl: cfg.acquisitionUrl,
      sellerId: "715084914",
      titleSnapshot: "Produto de Prova N9",
    };
    if (kind === "SUCCESS") {
      return {
        kind: "SUCCESS",
        affiliateUrl: cfg.acquisitionUrl,
        identity,
        identityConfidence: "PRODUCT_IDENTITY_CONFIRMED",
        method: "MANUAL",
        acquisitionRef: "acq-proof-n9",
        rawResponse: null,
        acquiredAt: Date.now(),
      } satisfies AcquireResult;
    }
    if (kind === "IDENTITY_UNCERTAIN") {
      return {
        kind: "IDENTITY_UNCERTAIN",
        affiliateUrl: cfg.acquisitionUrl,
        identity,
        identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN",
        rationale: "prova identity_uncertain",
        method: "MANUAL",
        acquisitionRef: "acq-proof-n9-uncertain",
        rawResponse: null,
        acquiredAt: Date.now(),
      } satisfies AcquireResult;
    }
    if (kind === "RESOLUTION_FAILED") {
      return { kind: "RESOLUTION_FAILED", reason: "proof" } satisfies AcquireResult;
    }
    return { kind: "AUTH_REQUIRED", reason: "proof" } satisfies AcquireResult;
  });
  cycleService.setCycleResolutionOverrideForTests(async () => {
    if (cfg.resolutionThrows) throw new Error("resolver_infra_error");
    return { status: cfg.resolutionStatus, affiliateUrl: null, candidateId: "candidate-proof-n9", reason: "prova" };
  });
  cycleService.setCycleGetCandidateOverrideForTests(async (id: string) => ({
    ok: true,
    candidate: cfg.candidateExists
      ? { candidate_id: id, status: cfg.candidateStatus, observed_price: cfg.candidateObservedPrice }
      : null,
    reason: null,
  }));
}

function clearOverrides() {
  cycleService.setCycleDiscoveryOverrideForTests(null);
  cycleService.setCycleResearchOverrideForTests(null);
  cycleService.setCycleAssessmentOverrideForTests(null);
  cycleService.setCyclePersistAssessmentOverrideForTests(null);
  cycleService.setCycleAcquisitionOverrideForTests(null);
  cycleService.setCycleResolutionOverrideForTests(null);
  cycleService.setCycleGetCandidateOverrideForTests(null);
}

// ---------------------------------------------------------------------------
// Express app com as rotas N9 (admin auth bypass no teste).
// ---------------------------------------------------------------------------
function appWithRoutes(fakeDb: unknown) {
  // registerCycleRoutes injeta o client no repositório via setCycleClient(client)
  // — passar o fake garante que a rota use o mesmo storage dos testes
  // (passar null sobreporia o fake injetado pelo beforeEach e falharia com
  // cycle_repository_missing_supabase).
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (_req: any, _res: any, next: any) => next();
  registerCycleRoutes(app as any, requireAdminAuth, fakeDb as never);
  return app;
}

const PROOF_SOURCE = "https://shopee.com.br/Produto-Prova-i.715084914.23794344926";

test.beforeEach(() => {
  resetCfg();
  clearStore();
  publishRepo = { preflightCount: 0, executeCount: 0 };
  const sharedFake = fakeClient() as never;
  setCycleClientForTests(sharedFake as any);
  (globalThis as any).__n9fakeDb = sharedFake;
  setAffClient(sharedFake);
  setCAssClient(sharedFake);
  setCandsClient(sharedFake);
  cycleService.setCyclePublicationRepoForTests(fakePublicationRepo());
  cycleService.setCycleAffiliateRegistrySnapshotForTests(fakeRegistrySnapshot());
  setOverrides();
});

test.afterEach(() => {
  clearOverrides();
  cycleService.setCyclePublicationRepoForTests(null);
  cycleService.setCycleAffiliateRegistrySnapshotForTests(null);
  setCAssClient(null);
  setCandsClient(null);
  setAffClient(null as never);
  void clearStore();
});

// Helper: extrair "result" da discriminated union (testes acessam por cast).
function stepResult(step: { ok: boolean; detail?: unknown }): unknown {
  // recordStage persiste o StageResult em `detail` (união ok:false não tem detail).
  return (step as { detail?: Record<string, unknown> }).detail?.outcome ?? (step as { result?: unknown }).result;
}

// ---------------------------------------------------------------------------
// GATE v1 — determinismo e regras nomeadas (provas N9-40, N9-15..23)
// ---------------------------------------------------------------------------
function baseGateInput(overrides: Partial<GateInput> = {}): GateInput {
  return Object.freeze({
    candidateId: "candidate-proof-n9",
    candidateStatus: "APPROVED",
    recommendation: "ADD_TO_NICHE",
    classification: null,
    priority: null,
    unknownsCount: 0,
    unknownCriticalPrice: false,
    unknownCriticalTitle: false,
    contradictionsCount: 0,
    collectionFailed: false,
    identityConfidence: null,
    resolutionStatus: "MISSING",
    requireAffiliateLink: false,
    resolutionError: false,
    errorReason: null,
    ...overrides,
  }) as GateInput;
}

test("N9-40 gate: determinístico — mesma entrada → mesma saída", () => {
  const a = evaluateDecisionGate(baseGateInput());
  const b = evaluateDecisionGate(baseGateInput());
  assert.equal(a.outcome, "DECISION_ALLOWED");
  assert.equal(a.rationale, b.rationale);
});

test("N9-15 gate: BLOCK_NO_ACTION quando recommendation = PARK", () => {
  const d = evaluateDecisionGate(baseGateInput({ recommendation: "PARK" }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_NO_ACTION"));
});

test("N9-16 gate: BLOCK_CONTRADICTION", () => {
  const d = evaluateDecisionGate(baseGateInput({ contradictionsCount: 1 }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_CONTRADICTION"));
});

test("N9-17 gate: BLOCK_COLLECTION_FAILED", () => {
  const d = evaluateDecisionGate(baseGateInput({ collectionFailed: true }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_COLLECTION_FAILED"));
});

test("N9-18 gate: BLOCK_UNKNOWN_CRITICAL (price UNKNOWN)", () => {
  const d = evaluateDecisionGate(baseGateInput({ unknownCriticalPrice: true }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_UNKNOWN_CRITICAL"));
  // UNKNOWN NÃO vira estimativa — rationale preserva o fato sem estimar.
  assert.match(d.rationale, /UNKNOWN/);
});

test("N9-19 gate: BLOCK_IDENTITY_UNCERTAIN — jamais habilita publicação", () => {
  const d = evaluateDecisionGate(baseGateInput({ identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN" }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_IDENTITY_UNCERTAIN"));
});

test("N9-20 gate: BLOCK_AFFILIATE_MISSING (exigência + MISSING)", () => {
  const d = evaluateDecisionGate(baseGateInput({ requireAffiliateLink: true, resolutionStatus: "MISSING" }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_AFFILIATE_MISSING"));
});

test("N9-20b gate: BLOCK_AFFILIATE_MISSING (exigência + erro de resolução)", () => {
  const d = evaluateDecisionGate(baseGateInput({ requireAffiliateLink: true, resolutionError: true }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_AFFILIATE_MISSING"));
});

test("N9-21 gate: BLOCK_NOT_APPROVED (candidate não APPROVED)", () => {
  const d = evaluateDecisionGate(baseGateInput({ candidateStatus: "REVIEWING" }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_NOT_APPROVED"));
});

test("N9-22 gate: BLOCK_RESOLUTION_ERROR — erro de infra bloqueia (fail-closed)", () => {
  const d = evaluateDecisionGate(baseGateInput({ resolutionError: true }));
  assert.equal(d.outcome, "DECISION_BLOCKED");
  assert.ok(d.blockingRules.includes("BLOCK_RESOLUTION_ERROR"));
});

test("N9-23 gate: DECISION_ALLOWED somente quando tudo passa", () => {
  const d = evaluateDecisionGate(
    baseGateInput({ identityConfidence: "PRODUCT_IDENTITY_CONFIRMED", resolutionStatus: "LINK_VALID" }),
  );
  assert.equal(d.outcome, "DECISION_ALLOWED");
  assert.equal(d.blockingRules.length, 0);
});

test("N9-25 gate: input_digest estável (mesma entrada → mesmo digest)", () => {
  const d1 = buildDecisionInputDigest(baseGateInput());
  const d2 = buildDecisionInputDigest(baseGateInput());
  assert.equal(d1, d2);
  assert.match(d1, /^sha256:[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// startCycle (provas N9-01..03)
// ---------------------------------------------------------------------------
test("N9-01 startCycle: idempotência — replay idêntico → identical_duplicate", async () => {
  const a = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const b = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  assert.equal(a.ok, true);
  assert.equal(a.outcome, "created");
  assert.equal(b.outcome, "identical_duplicate");
  assert.equal(a.cycleId, b.cycleId);
});

test("N9-02 startCycle: marketplace inválido rejeitado", async () => {
  const r = await cycleService.startCycle({ marketplace: "amazon" as any, sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  assert.equal(r.ok, false);
});

test("N9-03 startCycle: URL inválida rejeitada", async () => {
  const r = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: "not-a-url", sourceType: "URL" });
  assert.equal(r.ok, false);
});

test("N9-03b isCycleMarketplace: catálogo fechado de marketplaces", () => {
  assert.equal(isCycleMarketplace("shopee"), true);
  assert.equal(isCycleMarketplace("mercadolivre"), true);
  assert.equal(isCycleMarketplace("amazon"), false);
});

// ---------------------------------------------------------------------------
// runDiscovery (provas N9-04..06)
// ---------------------------------------------------------------------------
test("N9-04 runDiscovery: override N2 ok → step registrado com evidenceRef", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const step = await cycleService.runDiscovery(s.cycleId!);
  assert.equal(step.ok, true);
  assert.match(step.evidenceRef, /candidate-proof-n9/);
  assert.ok(STORE.steps.some((st) => st.cycle_id === s.cycleId && st.stage === "DISCOVERY" && st.result === "created"));
});

// N9-04b: o marketplace do ciclo é snake_case ("mercadolivre"/"shopee") mas o
// executor de Discovery exige o canônico UPPER ("MERCADOLIVRE"/"SHOPEE"). A
// captura do input passado ao override prova que o service normaliza antes
// de invocar o N2 — sem essa normalização o discovery dispara erro de
// infraestrutura (marketplace_desconhecido) em produção.
test("N9-04b runDiscovery: marketplace snake_case → canônico UPPER antes do N2", async () => {
  clearStore();
  const seen: string[] = [];
  cycleService.setCycleDiscoveryOverrideForTests(async (input: unknown) => {
    const i = input as { marketplace: string };
    seen.push(i.marketplace);
    return {
      ok: true,
      items: [{ candidate_id: "candidate-proof-n9", outcome: "created", title: "Produto de Prova N9" }],
    };
  });
  const ml = await cycleService.startCycle({ marketplace: "mercadolivre", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const sh = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: "https://shopee.com.br/prova-i.715084914.999", sourceType: "URL" });
  await cycleService.runDiscovery(ml.cycleId!);
  await cycleService.runDiscovery(sh.cycleId!);
  assert.deepEqual(seen, ["MERCADOLIVRE", "SHOPEE"], "o N2 recebeu o marketplace canônico UPPER");
});

test("N9-05 runDiscovery: N2 falha operacional → DISCOVERY_FAILED recuperável", async () => {
  cfg.discoveryOk = false;
  cfg.discoveryError = "rate_limited";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const step = await cycleService.runDiscovery(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "DISCOVERY_FAILED");
  assert.ok(STORE.steps.some((st) => st.stage === "DISCOVERY" && st.blocking_code === "DISCOVERY_FAILED"));
});

test("N9-06 runDiscovery: N2 ok preserva origem da coleta (nenhum fallback inventado)", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const step = await cycleService.runDiscovery(s.cycleId!);
  assert.equal(step.ok, true);
  assert.equal(stepResult(step), "created");
});

// ---------------------------------------------------------------------------
// runCandidateCheck (prova N9-07)
// ---------------------------------------------------------------------------
test("N9-07 runCandidateCheck: status não-APPROVED → step com candidate_status", async () => {
  cfg.candidateStatus = "REJECTED";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runCandidateCheck(s.cycleId!);
  assert.equal(step.ok, true);
  assert.match(String(stepResult(step)), /candidate_status=REJECTED/);
  // Fail-closed: status não-APPROVED nunca avança a publicação; o passo grava o
  // estado com o bloqueio identificado (blockingCode = RECOVERABLE no passo).
  assert.equal(step.blockingCode, "RECOVERABLE");
  // O passo persiste o bloqueio com o status observado no detalhe (detail persisted no step).
    assert.ok(STORE.steps.some((st) => st.stage === "CANDIDATE"));
});
// ---------------------------------------------------------------------------
// runResearch (provas N9-08..09)
// ---------------------------------------------------------------------------
test("N9-08 runResearch: override N3 ok → step com research_started", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runResearch(s.cycleId!);
  assert.equal(step.ok, true);
  assert.equal(step.result, "research_started");
  assert.match(step.evidenceRef, /research-proof-n9/);
});

test("N9-09 runResearch: N3 lança → RESEARCH_FAILED recuperável", async () => {
  cfg.researchThrows = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runResearch(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "RESEARCH_FAILED");
  assert.ok(STORE.steps.some((st) => st.stage === "RESEARCH" && st.blocking_code === "RESEARCH_FAILED"));
});

// ---------------------------------------------------------------------------
// runAssessment (prova N9-10)
// ---------------------------------------------------------------------------
test("N9-10 runAssessment: override N4 ok → step registrado com assessmentId", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runAssessment(s.cycleId!);
  assert.equal(step.ok, true);
  assert.match(step.evidenceRef, /candidate_assessment:asm-candidate-proof-n9-/);
  assert.ok(STORE.steps.some((st) => st.stage === "ASSESSMENT" && st.blocking_code === null));
});

// ---------------------------------------------------------------------------
// runAcquisition (provas N9-11, N9-12, N9-38)
// ---------------------------------------------------------------------------
test("N9-11 runAcquisition: sem credenciais → AUTH_REQUIRED (fail-closed)", async () => {
  cfg.acquisitionKind = "AUTH_REQUIRED";
  cfg.providerExists = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runAcquisition(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "AUTH_REQUIRED");
});

// N9-11b: provider N6 ausente (tabela vazia, getProvider=null) NUNCA pode
// virar crash no N8 (NPE em provider.status). O passo deve ser registrado
// como PROVIDER_NOT_ACTIVE com rationale explícito e identityConfidence
// gravado (fail-closed). Reproduz o bug real encontrado na prova viva.
test("N9-11b runAcquisition: provider N6 ausente → PROVIDER_NOT_ACTIVE governado (sem NPE)", async () => {
  cfg.providerExists = false;
  cfg.providers = [];
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runAcquisition(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "PROVIDER_NOT_ACTIVE");
  assert.equal(step.result, "PROVIDER_NOT_ACTIVE");
  assert.match(String(step.rationale), /nenhum endpoint foi presumido e nenhum link foi inventado/);
});

test("N9-12 runAcquisition: override N8 SUCCESS → step SUCCESS + acquisitionRef", async () => {
  cfg.acquisitionKind = "SUCCESS";
  cfg.providerExists = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runAcquisition(s.cycleId!);
  assert.equal(step.ok, true);
  assert.equal(step.result, "SUCCESS");
  assert.match(step.evidenceRef, /affiliate_links:acq-proof-n9/);
  assert.equal((step as any).detail?.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
});

test("N9-38 runAcquisition: IDENTITY_UNCERTAIN → registro sem confirmação", async () => {
  cfg.acquisitionKind = "IDENTITY_UNCERTAIN";
  cfg.providerExists = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runAcquisition(s.cycleId!);
  // IDENTITY_UNCERTAIN não é SUCCESS: ok=false e blockingCode próprio.
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "IDENTITY_UNCERTAIN");
});

// ---------------------------------------------------------------------------
// runResolution (provas N9-13..14)
// ---------------------------------------------------------------------------
test("N9-13 runResolution: link MISSING → step com resolution=MISSING (falha recuperável, sem avançar)", async () => {
  cfg.resolutionStatus = "MISSING";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runResolution(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.result, "MISSING");
  assert.equal(step.blockingCode, "MISSING");
});

test("N9-14 runResolution: resolver lança → RESOLUTION_FAILED (fail-closed)", async () => {
  cfg.resolutionThrows = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  const step = await cycleService.runResolution(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "RESOLUTION_ERROR");
});

// ---------------------------------------------------------------------------
// runDecision (provas N9-15..29 cobertas pelo gate + integração)
// ---------------------------------------------------------------------------
test("N9-23b runDecision: DECISION_ALLOWED + persistência idempotente", async () => {
  cfg.acquisitionKind = "SUCCESS";
  cfg.assessmentRecommendation = "ADD_TO_NICHE";
  cfg.linksByCandidate = [{ link_id: "link-proof" }];
  cfg.resolutionStatus = "LINK_DRAFT";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  const step = await cycleService.runDecision(s.cycleId!);
  const { listCandidateAssessments } = await import("../server/repositories/candidateAssessmentRepository");
  const lst = await listCandidateAssessments({ candidateId: "candidate-proof-n9", limit: 1 });

  assert.equal(step.ok, true);
  const decision = STORE.decisions[0];
  assert.equal(decision?.decision, "DECISION_ALLOWED");
  assert.match(decision?.decision_version ?? "", /commercial_decision_v1/);
  // Replay: mesma decisão → identical_duplicate, mesmo decision_id.
  await cycleService.runDecision(s.cycleId!);
  assert.equal(STORE.decisions.length, 1);
});

test("N9-15b runDecision: recommendation PARK → DECISION_BLOCKED (persistido)", async () => {
  cfg.assessmentRecommendation = "PARK";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  assert.equal(STORE.decisions[0]?.decision, "DECISION_BLOCKED");
  assert.ok(STORE.decisions[0]?.blocking_rules.includes("BLOCK_NO_ACTION"));
});

test("N9-18b runDecision: price UNKNOWN → BLOCK_UNKNOWN_CRITICAL persistido", async () => {
  cfg.candidateObservedPrice = null;
  cfg.assessmentUnknowns = ["price"];
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  assert.ok(STORE.decisions[0]?.blocking_rules.includes("BLOCK_UNKNOWN_CRITICAL"));
});

test("N9-19b runDecision: IDENTITY_UNCERTAIN → BLOCK_IDENTITY_UNCERTAIN", async () => {
  cfg.acquisitionKind = "IDENTITY_UNCERTAIN";
  cfg.providerExists = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runAcquisition(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);

  assert.ok(STORE.decisions[0]?.blocking_rules.includes("BLOCK_IDENTITY_UNCERTAIN"));
});

test("N9-22b runDecision: erro de resolução → BLOCK_RESOLUTION_ERROR", async () => {
  cfg.resolutionThrows = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  assert.ok(STORE.decisions[0]?.blocking_rules.includes("BLOCK_RESOLUTION_ERROR"));
});

test("N9-16b runDecision: contradições → BLOCK_CONTRADICTION", async () => {
  cfg.assessmentContradictions = [{ field: "price", values: [1, 2] }];
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  assert.ok(STORE.decisions[0]?.blocking_rules.includes("BLOCK_CONTRADICTION"));
});

// ---------------------------------------------------------------------------
// runPublication (provas N9-26..29)
// ---------------------------------------------------------------------------
test("N9-26 runPublication: decisão BLOCKED → executor N5 NUNCA chamado", async () => {
  cfg.assessmentRecommendation = "PARK";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  const step = await cycleService.runPublication(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "DECISION_BLOCKED");
  assert.equal(publishRepo.executeCount, 0);
  assert.equal(STORE.productsInserted.length, 0);
});

test("N9-27 runPublication: DECISION_ALLOWED + preflight N5 ok → execução", async () => {
  cfg.acquisitionKind = "SUCCESS";
  cfg.linksByCandidate = [{ link_id: "link-proof", candidate_id: "candidate-proof-n9", product_id: null, marketplace: "shopee", provider_id: "shopee", affiliate_url: "https://shopee.com.br/x?utm_source=proof", provenance: "admin:manual", status: "VALID", validation_state: "VALID", validation_result: {}, digest: "d", observed_at: new Date().toISOString(), expires_at: null, notes: "", contract_version: "1.0" }];
  cfg.providers = [{ provider_id: "shopee", marketplace: "shopee", status: "ACTIVE", resolution_method: "API" }];
  cfg.resolutionStatus = "RESOLVED";
  cfg.preflightOk = true;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runAssessment(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  const step = await cycleService.runPublication(s.cycleId!);
  assert.equal(step.ok, true);
  assert.equal(publishRepo.executeCount, 1);
  assert.equal(STORE.productsInserted.length, 0); // products nunca sofre insert no N9
});

test("N9-28 runPublication: preflight N5 falha → FAILED sem publicar", async () => {
  cfg.acquisitionKind = "SUCCESS";
  cfg.linksByCandidate = [{ link_id: "link-proof" }];
  cfg.resolutionStatus = "LINK_DRAFT";
  cfg.preflightOk = false;
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  const step = await cycleService.runPublication(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(publishRepo.executeCount, 0);
});

test("N9-29 runPublication: DECISION não encontrada → DECISION_NOT_FOUND", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!); // candidate existe; decisão NÃO
  const step = await cycleService.runPublication(s.cycleId!);
  assert.equal(step.ok, false);
  assert.equal(step.blockingCode, "DECISION_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// runAllStages (prova N9-30)
// ---------------------------------------------------------------------------
test("N9-30 runAllStages: halt no primeiro bloqueio (não encadeia)", async () => {
  cfg.acquisitionKind = "AUTH_REQUIRED";
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const result = await cycleService.runAllStages(s.cycleId!);
  assert.equal(result.ok, false);
  assert.equal(result.haltedAt, "ACQUISITION");
  assert.equal(publishRepo.executeCount, 0);
});

// ---------------------------------------------------------------------------
// Render-only (provas N9-31..32)
// ---------------------------------------------------------------------------
test("N9-31 getCycleState: render-only (somente leituras)", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const state = await cycleService.getCycleState(s.cycleId!);
  assert.equal(state.ok, true);
  assert.equal(state.state?.marketplace, "shopee");
  assert.equal(state.state?.status, "OPEN");
});

test("N9-32 lista de ciclos render-only", async () => {
  await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const list = await listCycles({ limit: 10 });
  assert.equal(list.ok, true);
  assert.equal(list.cycles.length, 1);
});

// ---------------------------------------------------------------------------
// Rotas express (provas N9-33..34)
// ---------------------------------------------------------------------------
test("N9-33 rota /start: validações (marketplace/URL)", async () => {
  const app = appWithRoutes((globalThis as any).__n9fakeDb);
  const r1 = await supertest(app).post("/api/admin/cycle/start").send({ marketplace: "shopee", source_url: PROOF_SOURCE });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  const r2 = await supertest(app).post("/api/admin/cycle/start").send({ marketplace: "amazon", source_url: PROOF_SOURCE });
  assert.equal(r2.status, 400);
  const r3 = await supertest(app).post("/api/admin/cycle/start").send({ marketplace: "shopee", source_url: "bad" });
  assert.equal(r3.status, 400);
});

test("N9-34 rota /cleanup: exige proof=commercial_proof", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  const app = appWithRoutes((globalThis as any).__n9fakeDb);
  const r1 = await supertest(app).post(`/api/admin/cycle/${s.cycleId}/cleanup`).send({});
  assert.equal(r1.status, 400);
  assert.match(r1.body.reason, /proof/);
});

// ---------------------------------------------------------------------------
// Cleanup de prova (prova N9-35)
// ---------------------------------------------------------------------------
test("N9-35 cleanup: apaga cycle/steps/decisions — zero resíduos", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  const cleaned = await cycleService.deleteCycleForProof(s.cycleId!);
  assert.equal(cleaned.ok, true);
  assert.equal(STORE.cycles.length, 0);
  assert.equal(STORE.decisions.length, 0);
  assert.equal(STORE.steps.length, 0);
});

// ---------------------------------------------------------------------------
// N9-36: products.insert nunca ocorre (já provado em N9-26/N9-27).
// ---------------------------------------------------------------------------
test("N9-36 nenhum cenário cria/altera produto canônico", async () => {
  const s = await cycleService.startCycle({ marketplace: "shopee", sourceUrl: PROOF_SOURCE, sourceType: "URL" });
  await cycleService.runDiscovery(s.cycleId!);
  await cycleService.runDecision(s.cycleId!);
  await cycleService.runPublication(s.cycleId!); // mesmo com execução mock, products não recebe insert
  assert.equal(STORE.productsInserted.length, 0);
});
