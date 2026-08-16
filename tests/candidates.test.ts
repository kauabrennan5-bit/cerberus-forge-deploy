/**
 * Cerberus Finds Archive — Bloco N1 — Testes de contratos.
 *
 * Cobertura exigida:
 * - fail-closed sem cliente Supabase;
 * - registro idempotente (identical_duplicate) e conflito (conflict_rejected);
 * - validação de catálogos fechados (marketplace/availability/method);
 * - transições de status dentro do enum;
 * - veredito REJECTED/INCONCLUSIVE sem reason → recusado;
 * - promoteToProduct só com status APPROVED e sem criar produto canônico;
 * - sanitização de texto (secrets recusa/droga);
 * - cockpit renderDiscover render-only (ausência ≠ fato negativo).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// Fake PostgREST mínimo (mesmo padrão dos testes do Bloco 17)
// ============================================================================
type Rows = Array<Record<string, unknown>>;

function makeFakeClient(table: Rows, opts: { countExact?: boolean } = {}): SupabaseClient {
  function makeEqChain(filterFn: () => Rows) {
    // Proxy encadeável: .eq().eq()... .limit().maybeSingle() / .order().range() / then()
    const proxy: any = (k: string, v: unknown) => makeEqChain(() => filterFn().filter((r) => r[k] === v));
    proxy.limit = () => ({
      maybeSingle: async () => ({ data: filterFn()[0] ?? null, error: null }),
    });
    proxy.eq = proxy;
    proxy.order = () => orderBase(filterFn);
    proxy.then = async (resolve: (v: unknown) => unknown) => {
      const sorted = filterFn().slice();
      resolve({ data: sorted, count: opts.countExact ? sorted.length : undefined });
    };
    return proxy;
  }
  function orderBase(filterFn: () => Rows) {
    return {
      range: () => ({
        then: async (resolve: (v: unknown) => unknown) => {
          const sorted = filterFn().slice();
          resolve({ data: sorted, count: opts.countExact ? sorted.length : undefined });
        },
      }),
      then: async (resolve: (v: unknown) => unknown) => {
        const sorted = filterFn().slice();
        resolve({ data: sorted, count: opts.countExact ? sorted.length : undefined });
      },
    };
  }
  return {
    from: (name: string) => {
      const read = () => table;
      const chain: any = {
        update: (payload: Record<string, unknown>) => {
          // update().eq().eq()... — aplica o payload quando o primeiro .eq bate.
          const updateProxy: any = {
            eq: (k: string, v: unknown) => {
              const row = table.find((r) => r[k] === v) ?? null;
              if (row) Object.assign(row, payload);
              const merged = row ? { ...row } : null;
              const tail: any = {
                eq: () => tail,
                select: (_s?: any) => ({
                  single: async () => ({
                    data: merged,
                    error: merged ? null : { code: "PGRST116", message: "not found" },
                  }),
                }),
              };
              return tail;
            },
          };
          return updateProxy;
        },
        select: (_fields?: any, queryOpts?: any) => {
          const after = {
                        eq: (k: string, v: unknown) => makeEqChain(() => table.filter((r) => r[k] === v)),
            order: (_k: string, _opts?: any) => orderBase(() => read()),
            then: async (resolve: (v: unknown) => unknown) => {
              resolve({ data: read(), count: opts.countExact ? read().length : undefined });
            },
          };
          return after;
        },
        insert: (rows: Array<Record<string, unknown>>) => {
          const afterInsert = {
            select: () => ({
              single: async () => {
                const row = rows[0];
                table.push(row);
                return { data: row, error: null };
              },
            }),
          };
          return afterInsert;
        },
        delete: () => ({
          eq: (k: string, v: unknown) => {
            const idx = table.findIndex((r) => r[k] === v);
            if (idx >= 0) table.splice(idx, 1);
            return { then: async (resolve: (v2: unknown) => unknown) => resolve({ data: null, error: null }) };
          },
        }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

// ============================================================================
// Helpers de import
// ============================================================================
async function importRepo() {
  return import("../server/repositories/candidatesRepository");
}

function mkIntake(overrides: Record<string, unknown> = {}) {
  return {
    marketplace: "Shopee",
    source_url: "https://shopee.com.br/product/12345/67890",
    external_listing_id: "67890",
    title: "Luminária de chão",
    observed_price: 71.0,
    observed_availability: "IN_STOCK",
    collection_method: "MANUAL",
    ...overrides,
  };
}

// ============================================================================
// Fail-closed
// ============================================================================
test("N1: fail-closed — sem cliente Supabase todo registro recusa", async () => {
  const repo = await importRepo();
  repo.setCandidatesClientForTests(null);
  const result = await repo.registerCandidate(mkIntake());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_supabase");
});

// ============================================================================
// Registro + idempotência + conflito
// ============================================================================
test("N1: registro cria candidato com prefixo can- e status DISCOVERED", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const result = await repo.registerCandidate(mkIntake());
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.match(result.candidate_id ?? "", /^can-/);
  assert.equal(result.candidate?.status, "DISCOVERED");
  assert.equal(result.candidate?.funnel_stage, "INTAKE");
});

test("N1: replay idêntico retorna o registro existente (identical_duplicate)", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const payload = mkIntake({ observed_at: "2026-08-16T12:00:00.000Z" });
  const first = await repo.registerCandidate(payload);
  assert.equal(first.ok, true);
  const second = await repo.registerCandidate(payload);
  assert.equal(second.ok, true);
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.existing_id, first.candidate_id);
  assert.equal(rows.length, 1);
});

test("N1: mesmo listing com payload divergente é recusado como conflito", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const first = await repo.registerCandidate(mkIntake());
  assert.equal(first.ok, true);
  // Segundo intento com preço divergente — listing_key idêntico, design divergente.
  const second = await repo.registerCandidate(mkIntake({ observed_price: 99.9 }));
  assert.equal(second.ok, false);
  assert.equal(second.outcome, "conflict_rejected");
});

// ============================================================================
// Validação de catálogos fechados
// ============================================================================
test("N1: marketplace inválido é recusado", async () => {
  const repo = await importRepo();
  repo.setCandidatesClientForTests(makeFakeClient([], { countExact: true }));
  const result = await repo.registerCandidate(mkIntake({ marketplace: "Elo7" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_marketplace");
});

test("N1: availability e collection_method inválidos recusam", async () => {
  const repo = await importRepo();
  repo.setCandidatesClientForTests(makeFakeClient([], { countExact: true }));
  const a = await repo.registerCandidate(mkIntake({ observed_availability: "MAYBE" }));
  assert.equal(a.ok, false);
  assert.equal(a.reason, "invalid_availability");
  const b = await repo.registerCandidate(mkIntake({ collection_method: "GUESS" }));
  assert.equal(b.ok, false);
  assert.equal(b.reason, "invalid_collection_method");
});

// ============================================================================
// Sanitização
// ============================================================================
test("N1: título com padrão de secret é sanitizado (dropa token)", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const result = await repo.registerCandidate(
    mkIntake({ title: "Luminária sk-1234SECRET5678" }),
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.candidate?.title ?? "", /sk-1234SECRET5678/);
  assert.match(result.candidate?.title ?? "", /\[SANITIZED\]/);
});

// ============================================================================
// Vereditos
// ============================================================================
test("N1: veredito REJECTED sem reason é recusado", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  const rev = await repo.startReview(reg.candidate_id!);
  assert.equal(rev.ok, true);
  const verdict = await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "REJECTED",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "missing_rejection_reason");
});

test("N1: veredito REJECTED com reason transita e grava", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  await repo.startReview(reg.candidate_id!);
  const verdict = await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "REJECTED",
    rejection_reason: "Preço divergente da referência",
    reviewed_by: "humano",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.candidate?.status, "REJECTED");
  assert.equal(verdict.candidate?.funnel_stage, "FUNNEL_END");
  assert.equal(verdict.candidate?.rejection_reason, "Preço divergente da referência");
});

test("N1: APPROVED não exige reason e fixa estágio REVIEWED", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  await repo.startReview(reg.candidate_id!);
  const verdict = await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "APPROVED",
    review_notes: "Preço confirmado",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.candidate?.status, "APPROVED");
  assert.equal(verdict.candidate?.funnel_stage, "REVIEWED");
});

test("N1: transição inválida (DISCOVERED → REJECTED) é recusada", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  const verdict = await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "REJECTED",
    rejection_reason: "x",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "invalid_transition");
});

test("N1: veredito com valor fora do enum é recusado", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  const verdict = await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "SHIPPED",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "invalid_verdict_value");
});

// ============================================================================
// Promotion (registro, nunca criação de produto)
// ============================================================================
test("N1: promoteToProduct registra vínculo apenas em APPROVED", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  await repo.startReview(reg.candidate_id!);
  await repo.recordVerdict({
    candidate_id: reg.candidate_id!,
    status: "APPROVED",
  });
  const promo = await repo.promoteToProduct({
    candidate_id: reg.candidate_id!,
    promoted_product_id: "REF-009",
  });
  assert.equal(promo.ok, true);
  assert.equal(promo.candidate?.promoted_product_id, "REF-009");
  assert.notEqual(promo.candidate?.promoted_at, null);
});

test("N1: promoteToProduct sem status APPROVED recusa (sem criar nada)", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  const promo = await repo.promoteToProduct({
    candidate_id: reg.candidate_id!,
    promoted_product_id: "REF-009",
  });
  assert.equal(promo.ok, false);
  assert.equal(promo.reason, "invalid_transition");
});

// ============================================================================
// Listagem e limpeza
// ============================================================================
test("N1: listCandidates filtra por status e conta com total exato", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  await repo.registerCandidate(mkIntake());
  await repo.registerCandidate(
    mkIntake({ marketplace: "Mercado Livre", external_listing_id: "MLB-1" }),
  );
  const shopee = await repo.listCandidates({ status: "DISCOVERED", marketplace: "Shopee" });
  assert.equal(shopee.total, 1);
  assert.equal(shopee.candidates.length, 1);
  const rejected = await repo.listCandidates({ status: "REJECTED" });
  assert.equal(rejected.total, 0);
});

test("N1: deleteCandidateForProof limpa sem resíduos", async () => {
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const reg = await repo.registerCandidate(mkIntake());
  const del = await repo.deleteCandidateForProof(reg.candidate_id!);
  assert.equal(del.ok, true);
  assert.equal(del.deleted, true);
  const list = await repo.listCandidates();
  assert.equal(list.total, 0);
});

// ============================================================================
// Cockpit /discover — render-only
// ============================================================================
test("N1: renderDiscover nunca executa e exibe ausência como neutro", async () => {
  const cockpit = await import("../server/services/commercialCockpit");
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  const text = await cockpit.renderDiscover();
  assert.match(text, /CANDIDATE != FACT CANÔNICO/);
  assert.match(text, /nenhum candidato em revisão/i);
  assert.doesNotMatch(text, /reprovado|zero candidatos/i);
});

test("N1: renderDiscover com candidatos mostra funil por status", async () => {
  const cockpit = await import("../server/services/commercialCockpit");
  const repo = await importRepo();
  const rows: any[] = [];
  repo.setCandidatesClientForTests(makeFakeClient(rows, { countExact: true }));
  await repo.registerCandidate(mkIntake({ title: "Teste N1" }));
  const text = await cockpit.renderDiscover();
  assert.match(text, /DISCOVERED.*1 candidato/);
  assert.match(text, /nenhum candidato foi promovido ou publicado/i);
});
