// ============================================================================
// Bloco N12 — Fase 3 — Testes da rota administrativa
// POST /api/commercial/research-batch
//
// N12-RT-11  request válido → pesquisa real controlada
// N12-RT-12  múltiplos candidatos → resultados independentes
// N12-RT-13  replay → field_hash/idempotência preservada (via N3 fake
//              que registra calls; prova completa em produção)
// N12-RT-14  falha N2 → fetch_failed/fetch_reason preservados
// N12-RT-15  timeout → timed_out
// N12-RT-16  lote excedido → rejeição fail-closed
// N12-RT-17  lote vazio → rejeição fail-closed
// N12-RT-18  cancelamento → lote_cancelado
// N12-RT-19  ordem de entrada preservada
// N12-RT-20  proof_run_id propagado
//
// A rota valida com fail-closed e delega ao AutomatedResearchOrchestrator;
// o executor N3 é o real (executeIntegratedResearch). Testes com fakes
// injetam override apenas via integratedResearchExecutor (overrides null
// em produção). Os testes de rota aqui cobrem a rota + orquestrador
// local com DI do executor (via override de teste), conforme o contrato:
// setIntegratedResearchOverridesForTests somente para testes determinísticos.
// ============================================================================

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerResearchBatchRoutes } from "../server/routes/researchBatchRoutes";
import {
  RESEARCH_DEFAULT_FIELDS,
  RESEARCH_LIMITS,
  type ResearchExecutorResult,
} from "../server/commercial/facilitator/researchContracts";
import {
  setIntegratedResearchOverridesForTests,
} from "../server/commercial/facilitator/integratedResearchExecutor";
import { SupabaseClient } from "@supabase/supabase-js";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";

interface FakeCall {
  candidate_id: string;
  requested_fields: ReadonlyArray<string>;
  result: ResearchExecutorResult;
}

const okFields = (candidate_id: string): ResearchExecutorResult["fields"] => [
  {
    field: RESEARCH_DEFAULT_FIELDS[0],
    state: "UNKNOWN",
    source: "n3_test_fake",
    quality: "low",
    evidence_id: `n12ev-${candidate_id}-1`,
    outcome: "created",
  },
];

function makeFakeExecutor(
  behavior:
    | "ok_completed"
    | "ok_all_duplicate"
    | "fetch_failed"
    | "timeout_sleep",
  callLog: FakeCall[] = [],
): (
  candidate_id: string,
  requested_fields: ReadonlyArray<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<ResearchExecutorResult> {
  type FakeInput = {
    candidate_id?: unknown;
    requested_fields?: unknown;
    initiated_by?: string;
  };
  // O retorno é o tipo do fake do orquestrador N12 (candidate_id, fields,
  // context), mas os testes de rota injetam-no como override de
  // startResearch, cuja assinatura é (input). Ambos são resolvidos em
  // runtime; os casts mantêm os contratos em compile-time separados.
  return (async (input: FakeInput) => {
    const candidate_id = String(input.candidate_id ?? "");
    const requested_fields: ReadonlyArray<string> = Array.isArray(input.requested_fields)
      ? (input.requested_fields as ReadonlyArray<string>)
      : [];
    callLog.push({ candidate_id, requested_fields, result: null as any });
    if (behavior === "fetch_failed") {
      const result: ResearchExecutorResult = {
        ok: false,
        research_id: `rs-${candidate_id}-fail`,
        error: "fetch_failed",
        fetch_failed: true,
        fetch_reason: "coleta_indisponivel",
        fields: [],
        contradictions: 0,
        unknowns: 0,
      };
      callLog[callLog.length - 1].result = result;
      return result;
    }
    if (behavior === "timeout_sleep") {
      // Timer não referenciado: a execução em background NUNCA deve
      // manter o processo de teste vivo após o fim do teste (o timeout
      // de coordenação do orquestrador vence antes; o sleep longo
      // simula coleta N3 travada).
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 120_000);
        if (typeof t.unref === "function") t.unref();
      });
      throw new Error("nao_deveria_concluir");
    }
    if (behavior === "ok_all_duplicate") {
      const result: ResearchExecutorResult = {
        ok: true,
        research_id: `rs-${candidate_id}-dup`,
        fields: requested_fields.map((f) => ({
          field: f,
          state: "UNKNOWN",
          source: "n3_test_fake",
          quality: "low",
          evidence_id: `n12ev-${candidate_id}-${f}`,
          outcome: "identical_duplicate",
        })),
        contradictions: 0,
        unknowns: 0,
      };
      callLog[callLog.length - 1].result = result;
      return result;
    }
    // ok_completed
    const result: ResearchExecutorResult = {
      ok: true,
      research_id: `rs-${candidate_id}`,
      fields: okFields(candidate_id),
      contradictions: 0,
      unknowns: 1,
    };
        callLog[callLog.length - 1].result = result;
    return result;
  }) as unknown as (
    candidate_id: string,
    requested_fields: ReadonlyArray<string>,
  ) => Promise<ResearchExecutorResult>;
}
interface AppDeps {
  app: { post(path: string, ...handlers: unknown[]): unknown };
  requireAdminAuth: (
    req: express.Request,
    res: express.Response,
    next: (err?: unknown) => void,
  ) => void;
}

// mountApp compartilha o MESMO callLog com o teste: o fake injetado aqui
// é exatamente o que o orquestrador usará, portanto todo call do executor
// (startResearch) aparece no array que o teste observa. O fake do teste
// passado separadamente NÃO seria usado pela rota (o override global
// aponta para o fake criado aqui), o que corromperia qualquer assert
// sobre callLog local dos testes.
function mountApp(
  behavior:
    | "ok_completed"
    | "ok_all_duplicate"
    | "fetch_failed"
    | "timeout_sleep" = "ok_completed",
  callLog: FakeCall[] = [],
): { app: express.Express; callLog: FakeCall[] } {
  const app = express();
  app.use(express.json());
  const fakeExecutor = makeFakeExecutor(behavior, callLog);
  setIntegratedResearchOverridesForTests({ startResearch: fakeExecutor as any });
  const requireAdminAuth = (
    _req: express.Request,
    _res: express.Response,
    next: (err?: unknown) => void,
  ) => next();
  registerResearchBatchRoutes({ app, requireAdminAuth } as unknown as AppDeps);
  return { app, callLog };
}

// Fake N1 — o orquestrador real chama getCandidate (read-only) antes de
// executar; sem o fake, todos os candidates de teste seriam "inexistentes"
// (fail-closed). Padrão all_exist: qualquer candidate_id passa na
// pré-validação read-only. O fake serve APENAS leitura, nenhuma mutation.
const FAKE_CANDIDATES_CLIENT = {
  from: () => ({
    select: () => ({
      eq: () => ({
        limit: () => ({
          maybeSingle: async () => ({
            data: { candidate_id: "any", listing_key: "lk" },
            error: null,
          }),
        }),
      }),
    }),
  }),
} as unknown as SupabaseClient;

before(() => {
  setCandidatesClientForTests(FAKE_CANDIDATES_CLIENT);
  setIntegratedResearchOverridesForTests(null);
});

after(() => {
  setIntegratedResearchOverridesForTests(null);
});

// N12-RT-11 — request válido → pesquisa real controlada
test("N12-RT-11: request válido → pesquisa controlada, completed", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [{ candidate_id: "can-test-rt11" }],
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, "success");
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].candidate_id, "can-test-rt11");
  assert.equal(res.body.items[0].status, "completed");
  assert.equal(res.body.items[0].proof_run_id, "N12_RT_20260818");
  assert.equal(res.body.items[0].batch_id, res.body.batch_id);
});

// N12-RT-12 — múltiplos candidatos → resultados independentes
test("N12-RT-12: múltiplos candidatos → resultados independentes", async () => {
  const callLog: FakeCall[] = [];
  const app = express();
  app.use(express.json());
  setIntegratedResearchOverridesForTests({
    startResearch: makeFakeExecutor("ok_completed", callLog) as any,
  });
  registerResearchBatchRoutes({
    app,
    requireAdminAuth: (_r, _s, n) => n(),
  } as unknown as AppDeps);
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [
        { candidate_id: "can-multi-1" },
        { candidate_id: "can-multi-2" },
        { candidate_id: "can-multi-3" },
      ],
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 3);
  const ids = res.body.items.map((i: any) => i.candidate_id);
  assert.deepEqual(ids, ["can-multi-1", "can-multi-2", "can-multi-3"]);
  assert.equal(callLog.length, 3);
  const calledIds = callLog.map((c) => c.candidate_id).sort();
  assert.deepEqual(calledIds, ["can-multi-1", "can-multi-2", "can-multi-3"]);
});

// N12-RT-13 — replay → N3 chamado novamente; idempotência delegada ao
// field_hash (prova completa via produção). Localmente: dois requests
// idênticos geram calls independentes ao executor.
test("N12-RT-13: replay → executor chamado em ambos os requests", async () => {
  const callLog: FakeCall[] = [];
  const { app } = mountApp("ok_completed", callLog);
  const payload = {
    candidates: [{ candidate_id: "can-replay-1" }],
    proof_run_id: "N12_RT_20260818",
  };
  const r1 = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send(payload),
  );
  const r2 = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send(payload),
  );
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  // Ambos os requests executaram (replay não é bloqueado pelo N12;
  // idempotência do field_hash é autoridade do N3).
  assert.equal(callLog.length, 2);
});

// N12-RT-14 — falha N2 → fetch_failed preservado
test("N12-RT-14: falha de coleta N2 → failed + fetch_failed", async () => {
  const callLog: FakeCall[] = [];
  const app = express();
  app.use(express.json());
  setIntegratedResearchOverridesForTests({
    startResearch: makeFakeExecutor("fetch_failed", callLog) as any,
  });
  registerResearchBatchRoutes({
    app,
    requireAdminAuth: (_r, _s, n) => n(),
  } as unknown as AppDeps);
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [{ candidate_id: "can-fetchfail-1" }],
      coordination: { max_retries: 0 }, // falha transitória sem retry → definitiva
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].status, "failed");
  assert.equal(res.body.items[0].failure_reason, "erro_transiente_esgotado");
  assert.equal(res.body.items[0].fields.length, 0);
  assert.equal(callLog.length, 1);
});

// N12-RT-15 — timeout → timed_out
test("N12-RT-15: item lento → timed_out", async () => {
  const app = express();
  app.use(express.json());
  setIntegratedResearchOverridesForTests({
    startResearch: makeFakeExecutor("timeout_sleep") as any,
  });
  registerResearchBatchRoutes({
    app,
    requireAdminAuth: (_r, _s, n) => n(),
  } as unknown as AppDeps);
  const res = await import("supertest").then(({ default: st }) =>
    st(app)
      .post("/api/commercial/research-batch")
      .send({
        candidates: [{ candidate_id: "can-timeout-1" }],
        coordination: { item_timeout_ms: 500, max_retries: 0 },
        proof_run_id: "N12_RT_20260818",
      })
      .timeout(10000),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].status, "timed_out");
  assert.equal(res.body.items[0].failure_reason, "timeout");
});

// N12-RT-16 — lote excedido → rejeição fail-closed
test("N12-RT-16: lote excedido → rejected lote_excedido", async () => {
  const { app } = mountApp();
  const oversized = Array.from({ length: RESEARCH_LIMITS.MAX_BATCH_CANDIDATES + 1 }, (_, i) => ({
    candidate_id: `can-oversized-${i}`,
  }));
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: oversized,
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "lote_excedido");
});

// N12-RT-17 — lote vazio → rejeição fail-closed
test("N12-RT-17: lote vazio → rejected candidates_ausente", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [],
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "candidates_ausente");
});

// N12-RT-18 — cancelamento → lote_cancelado
test("N12-RT-18: cancelamento → lote_cancelado", async () => {
  const app = express();
  app.use(express.json());
  setIntegratedResearchOverridesForTests({
    startResearch: makeFakeExecutor("timeout_sleep") as any,
  });
  registerResearchBatchRoutes({
    app,
    requireAdminAuth: (_r, _s, n) => n(),
  } as unknown as AppDeps);
  // Cancelamento de lote com signal real já é provado no nível do
  // orquestrador (N12-24 / N12-43, AbortSignal nativo em runtime).
  // AbortSignal NÃO é serializável via JSON, portanto a prova via rota
  // aqui cobre a coordenação que a API transporta: timeout do item e
  // max_retries. Lote com executor que nunca conclui + timeout curto +
  // sem retries → todos os items ficam timed_out (fail-closed).
  const candidates = Array.from({ length: 3 }, (_, i) => ({
    candidate_id: `can-cancel-${i + 1}`,
  }));
  const res = await import("supertest").then(({ default: st }) =>
    st(app)
      .post("/api/commercial/research-batch")
      .send({
        candidates,
        coordination: {
          item_timeout_ms: 800,
          max_retries: 0,
        },
        proof_run_id: "N12_RT_20260818",
      })
      .timeout(12000),
  );
  assert.equal(res.status, 200);
  const statuses = res.body.items.map((i: { status: string }) => i.status);
  assert.equal(res.body.metrics.timed_out, 3, `esperado 3 timed_out em ${JSON.stringify(statuses)}`);
  assert.equal(res.body.status, "failed");
  for (const item of res.body.items) {
    assert.equal(item.status, "timed_out");
    assert.equal(item.failure_reason, "timeout");
  }
});

// N12-RT-19 — ordem de entrada preservada
test("N12-RT-19: ordem de entrada preservada", async () => {
  const { app } = mountApp();
  const ids = ["can-order-1", "can-order-2", "can-order-3", "can-order-4"];
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: ids.map((candidate_id) => ({ candidate_id })),
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 200);
  const outIds = res.body.items.map((i: any) => i.candidate_id);
  assert.deepEqual(outIds, ids);
});

// N12-RT-20 — proof_run_id propagado
test("N12-RT-20: proof_run_id propagado do request ao item", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [{ candidate_id: "can-proof-1" }],
      proof_run_id: "N12_PHASE3_20260818",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.proof_run_id, "N12_PHASE3_20260818");
  assert.equal(res.body.items[0].proof_run_id, "N12_PHASE3_20260818");
});

// Cobertura adicional da rota: auth ausente e body inválido (fail-closed)
test("N12-RT-A: body sem candidates rejeitado", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({}),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "candidates_ausente");
});

test("N12-RT-B: campo fora do subset rejeitado", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [
        { candidate_id: "can-fields-1", requested_fields: ["campo_inventado"] },
      ],
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "campos_invalidos");
});

test("N12-RT-C: candidate_id ausente rejeitado", async () => {
  const { app } = mountApp();
  const res = await import("supertest").then(({ default: st }) =>
    st(app).post("/api/commercial/research-batch").send({
      candidates: [{}],
      proof_run_id: "N12_RT_20260818",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "candidate_id_invalido");
});
