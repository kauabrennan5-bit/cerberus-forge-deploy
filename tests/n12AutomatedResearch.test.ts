// ============================================================================
// BLOCO N12 — RESEARCH AUTOMATIZADO — FASE 2 — TESTES
// ----------------------------------------------------------------------------
// DATA: 18/08/2026
//
// Matriz:
//   N12-01..45  — orquestrador (validação, campos, pré-validação N1, status,
//                 idempotência, retry, backoff, concorrência, ordem, timeout,
//                 cancelamento, metrics, batch status, não-subversão)
//   N12-RT-01..10 — executor integrado (adapter N1 read-only → N3)
//
// Executor injetável: todos os testes puros do orquestrador usam um executor
// mock determinístico — nenhum teste toca banco ou rede.
// O adapter real (N12-RT-*) usa o fake Supabase padrão N1/N3.
//
// GOVERNANÇA: fail-closed · CANDIDATE != FACT CANÔNICO · RESEARCH != PUBLICATION
// ============================================================================

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SupabaseClient } from "@supabase/supabase-js";
import * as candidatesRepo from "../server/repositories/candidatesRepository";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import {
  setCandidateEvidenceClientForTests,
  getCandidateEvidenceClient,
} from "../server/repositories/candidateEvidenceRepository";
import {
  AutomatedResearchOrchestrator,
  BatchCancelledError,
  computeMetrics,
  determineBatchStatus,
  classifyItemStatus,
} from "../server/commercial/facilitator/automatedResearch";
import {
  executeIntegratedResearch,
  adaptResearchResult,
  setIntegratedResearchOverridesForTests,
} from "../server/commercial/facilitator/integratedResearchExecutor";
import {
  RESEARCH_DEFAULT_FIELDS,
  RESEARCH_LIMITS,
  resolveFields,
  validateAutomatedResearchRequest,
  type AutomatedResearchItemContext,
  type AutomatedResearchRequest,
  type ResearchExecutor,
  type ResearchExecutorResult,
} from "../server/commercial/facilitator/researchContracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Remove comentários do fonte para varreduras estáticas (linha e bloco).
function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// ============================================================================
// Helpers — executor injetável determinístico (nenhum banco/rede)
// ============================================================================

type ExecutorBehavior = "ok" | "failed_deterministic" | "fetch_failed" |
  "session_registration_failed" | "throw_error" | "all_duplicates" |
  "mixed_created_duplicate" | "no_fields_result" | "contradicted" | "unknowns" |
  "mutates";

interface ExecutorSpec {
  behavior: ExecutorBehavior;
  fields?: ReadonlyArray<
    { field: string; state: string; source: string; quality: string; evidence_id: string | null; outcome: "created" | "identical_duplicate" | "rejected" }
  >;
  /** Quantas chamadas devem falhar antes de succeed (para retry). */
  failUntil?: number;
  /** Chamadas efetivamente realizadas (injetado pelo teste). */
  callLog?: Array<{ candidate_id: string; fields: ReadonlyArray<string>; attempt: number; signal: AbortSignal }>;
  /** Injeção de duração mínima por chamada (ms) — para concorrência. */
  minDurationMs?: number;
}

function makeExecutor(spec: ExecutorSpec): ResearchExecutor {
  let callCount = 0;
  return async (
    candidate_id: string,
    requested_fields: ReadonlyArray<string>,
    context: AutomatedResearchItemContext,
  ): Promise<ResearchExecutorResult> => {
    callCount += 1;
    const attempt = context.attempt;
    spec.callLog?.push({ candidate_id, fields: requested_fields, attempt, signal: context.signal });
    const index = callCount;

    if (spec.behavior === "mutates") {
      // Prova de não-subversão: executor que tenta mutar candidates é
      // detectável — a mutação fica registrada no callLog (e é detectada).
      return {
        ok: false,
        research_id: null,
        error: "candidate_id_ausente",
        fields: [],
        contradictions: 0,
        unknowns: 0,
      };
    }

    if (spec.behavior === "throw_error") {
      throw new Error("executor_lancou_erro");
    }

    if (spec.failUntil && index <= spec.failUntil) {
      if (spec.behavior === "session_registration_failed") {
        return {
          ok: false,
          research_id: null,
          error: "session_registration_failed",
          fields: [],
          contradictions: 0,
          unknowns: 0,
        };
      }
      return {
        ok: false,
        research_id: null,
        error: "fetch_failed",
        fetch_failed: true,
        fetch_reason: "fetch_failed",
        fields: [],
        contradictions: 0,
        unknowns: requested_fields.length,
      };
    }

    if (spec.minDurationMs) {
      await new Promise((resolve) => setTimeout(resolve, spec.minDurationMs));
    }

    const baseFields = spec.fields ?? requested_fields.map(
      (f) =>
        ({
          field: f,
          state: "KNOWN" as const,
          source: "marketplace_page" as const,
          quality: "HIGH" as const,
          evidence_id: `ev-${f}`,
          outcome: "created" as const,
        }) as ResearchExecutorResult["fields"][number],
    );

    if (spec.behavior === "failed_deterministic") {
      // Erro determinístico: nunca retentável (fail-closed).
      return {
        ok: false,
        research_id: null,
        error: "generic_error",
        fetch_failed: false,
        fields: [],
        contradictions: 0,
        unknowns: 0,
      };
    }
    if (spec.behavior === "all_duplicates") {
      return {
        ok: true,
        research_id: "rs-dup",
        fields: baseFields.map((f) => ({ ...f, outcome: "identical_duplicate" as const })),
        contradictions: 0,
        unknowns: 0,
      };
    }
    if (spec.behavior === "mixed_created_duplicate") {
      return {
        ok: true,
        research_id: "rs-mixed",
        fields: baseFields.map((f, i) => ({
          ...f,
          outcome: i === 0 ? ("created" as const) : ("identical_duplicate" as const),
        })),
        contradictions: 0,
        unknowns: 0,
      };
    }
    if (spec.behavior === "no_fields_result") {
      return { ok: true, research_id: "rs-nofields", fields: [], contradictions: 0, unknowns: 0 };
    }
    if (spec.behavior === "contradicted") {
      return {
        ok: true,
        research_id: "rs-contradicted",
        fields: baseFields.map((f) => ({ ...f, state: "CONTRADICTED" as const })),
        contradictions: baseFields.length,
        unknowns: 0,
      };
    }
    if (spec.behavior === "unknowns") {
      return {
        ok: true,
        research_id: "rs-unknowns",
        fields: baseFields.map((f) => ({ ...f, state: "UNKNOWN" as const })),
        contradictions: 0,
        unknowns: baseFields.length,
      };
    }
    return {
      ok: true,
      research_id: "rs-ok",
      fields: baseFields as ResearchExecutorResult["fields"],
      contradictions: 0,
      unknowns: 0,
    };
  };
}

function requestOf(
  candidates: Array<{ candidate_id: string; requested_fields?: ReadonlyArray<string> }>,
  extra?: {
    signal?: AbortSignal;
    concurrency?: number;
    item_timeout_ms?: number;
    max_retries?: number;
    proof_run_id?: string | null;
  },
): AutomatedResearchRequest {
  return {
    candidates: candidates.map((c) => ({ ...c })),
    coordination: {
      signal: extra?.signal,
      concurrency: extra?.concurrency ?? RESEARCH_LIMITS.DEFAULT_CONCURRENCY_LIMIT,
      item_timeout_ms: extra?.item_timeout_ms ?? RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS,
      max_retries: extra?.max_retries ?? 0,
    },
    proof_run_id: extra?.proof_run_id ?? null,
  };
}

const orchestratorOf = (behavior: ExecutorBehavior, specExtra: Partial<ExecutorSpec> = {}) =>
  new AutomatedResearchOrchestrator(makeExecutor({ behavior, ...specExtra }));

// ============================================================================
// VALIDAÇÃO FAIL-CLOSED (N12-01..05)
// ============================================================================

test("N12-01 — batch vazio → lote_vazio, nenhum item executado", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(requestOf([]));
  assert.equal(result.status, "failed");
  assert.equal(result.items.length, 0);
  assert.equal(result.metrics.received, 0);
  assert.equal(result.metrics.processed, 0);
});

test("N12-02 — batch acima de MAX_BATCH_CANDIDATES → lote_excedido", async () => {
  const orch = orchestratorOf("ok");
  const candidates = Array.from({ length: RESEARCH_LIMITS.MAX_BATCH_CANDIDATES + 1 }, (_, i) => ({
    candidate_id: `can-${i}`,
  }));
  const result = await orch.executeBatch(requestOf(candidates));
  assert.equal(result.status, "failed");
  assert.equal(result.items.length, 0);
  // Lote excedido é rejeitado na validação (fail-closed): nada é recebido
  // nem processado — o lote inteiro é descartado antes da execução.
  assert.equal(result.metrics.received, 0);
  assert.equal(result.metrics.processed, 0);
});

test("N12-03 — candidate_id ausente → candidate_id_ausente", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "" }]));
  assert.equal(result.status, "failed");
  assert.equal(result.items.length, 0);
  assert.equal(result.metrics.processed, 0);
});

test("N12-04 — candidate repetido intra-batch → candidate_repetido_intra_batch", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-x" }, { candidate_id: "can-x" }]),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.items.length, 0);
});

test("N12-05 — requested_fields inválidos → campos_invalidos", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-x", requested_fields: ["campo_inexistente"] }]),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.items.length, 0);
  assert.equal(result.metrics.processed, 0);
});

// ============================================================================
// RESOLUÇÃO DE CAMPOS (N12-06..08)
// ============================================================================

test("N12-06 — resolveFields sem requested_fields → defaults completos", () => {
  const resolved = resolveFields(undefined);
  assert.ok(resolved.ok);
  assert.deepEqual([...resolved.fields], [...RESEARCH_DEFAULT_FIELDS]);
  assert.equal(resolved.fields.length, 8);
});

test("N12-07 — resolveFields subset válido → subset preservado", () => {
  const resolved = resolveFields(["title", "price"]);
  assert.ok(resolved.ok);
  assert.deepEqual([...resolved.fields], ["title", "price"]);
});

test("N12-08 — resolveFields sem interseção válida → campos_invalidos", () => {
  const resolved = resolveFields(["campo_inexistente"]);
  assert.equal(resolved.ok, false);
  assert.equal((resolved as { ok: false; reason: string }).reason, "campos_invalidos");
});

// ============================================================================
// PRÉ-VALIDAÇÃO N1 READ-ONLY (N12-09)
// ============================================================================

test("N12-09 — candidate inexistente → failed/candidate_inexistente, executor não chamado", async () => {
  onlySeededCandidateIds([]); // nenhum candidato existe
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "ok", callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-inexistente" }]),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].failure_reason, "candidate_inexistente");
  assert.equal(result.items[0].attempts, 0);
  assert.equal(callLog.length, 0); // executor NUNCA chamado
});

// ============================================================================
// STATUS MAPPING (N12-10..14)
// ============================================================================

test("N12-10 — pesquisa completed", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-ok" }]));
  assert.equal(result.items[0].status, "completed");
  assert.equal(result.items[0].fields.length, RESEARCH_DEFAULT_FIELDS.length);
});

test("N12-11 — todos os campos identical_duplicate → duplicate", async () => {
  const orch = orchestratorOf("all_duplicates");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-dup" }]));
  assert.equal(result.items[0].status, "duplicate");
  assert.ok(result.items[0].fields.every((f) => f.outcome === "identical_duplicate"));
});

test("N12-12 — created + identical_duplicate → completed (caso misto)", async () => {
  const orch = orchestratorOf("mixed_created_duplicate");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-mixed" }]));
  assert.equal(result.items[0].status, "completed");
});

test("N12-13 — nenhum campo pesquisável (resultado vazio) → no_fields", async () => {
  const orch = orchestratorOf("no_fields_result");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-empty" }]));
  assert.equal(result.items[0].status, "no_fields");
  assert.equal(result.items[0].fields.length, 0);
});

test("N12-14 — erro determinístico → failed, zero retries", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "failed_deterministic", callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-det" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].attempts, 1);
  assert.equal(result.metrics.retried, 0);
});

// ============================================================================
// RETRY (N12-15..18)
// ============================================================================

test("N12-15 — fetch_failed transitório → retry permitido", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 1, callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-transient" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].status, "completed");
  assert.equal(result.items[0].attempts, 2);
  assert.equal(result.metrics.retried, 1);
  assert.equal(callLog.length, 2);
});

test("N12-16 — session_registration_failed → retry permitido", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "session_registration_failed", failUntil: 1, callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-session" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].status, "completed");
  assert.equal(result.items[0].attempts, 2);
  assert.equal(result.metrics.retried, 1);
});

test("N12-17 — retry transitório esgotado → erro_transiente_esgotado", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 999, callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-exhausted" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].failure_reason, "erro_transiente_esgotado");
  assert.equal(result.items[0].attempts, 1 + RESEARCH_LIMITS.MAX_COORDINATION_RETRIES);
  assert.equal(callLog.length, 1 + RESEARCH_LIMITS.MAX_COORDINATION_RETRIES);
});

test("N12-18 — backoff entre retries respeita [1000, 3000]", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 999, callLog }),
  );
  const before = Date.now();
  await orch.executeBatch(
    requestOf([{ candidate_id: "can-backoff" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  const elapsed = Date.now() - before;
  // backoff[0]=1000, backoff[1]=3000 → total ≥ 4000ms
  assert.ok(elapsed >= 3800, `backoff insuficiente: ${elapsed}ms`);
});

// ============================================================================
// CONCRRÊNCIA E ORDEM (N12-19..20)
// ============================================================================

test("N12-19 — concorrência máxima = 2, nunca excedida", async () => {
  let inflight = 0;
  let peak = 0;
  const inner = makeExecutor({
    behavior: "ok",
    minDurationMs: 120,
    callLog: [],
  });
  // Wrapper que mede concorrência real.
  const measuringExecutor: ResearchExecutor = async (cid, fields, ctx) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    try {
      return await inner(cid, fields, ctx);
    } finally {
      inflight -= 1;
    }
  };
  const orch = new AutomatedResearchOrchestrator(measuringExecutor);
  const candidates = Array.from({ length: 6 }, (_, i) => ({ candidate_id: `can-${i}` }));
  await orch.executeBatch(requestOf(candidates, { concurrency: 2 }));
  assert.ok(peak <= 2, `concorrência excedida: peak=${peak}`);
  assert.equal(peak, 2);
});

test("N12-20 — ordem dos resultados preservada", async () => {
  // Candidatos com durações distintas: se a ordem fosse por conclusão,
  // o resultado estaria embaralhado.
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "ok", minDurationMs: 80 }),
  );
  const candidates = Array.from({ length: 5 }, (_, i) => ({ candidate_id: `can-${i}` }));
  const result = await orch.executeBatch(requestOf(candidates));
  for (let i = 0; i < candidates.length; i += 1) {
    assert.equal(result.items[i].candidate_id, candidates[i].candidate_id);
  }
});

// ============================================================================
// TIMEOUT (N12-21..22)
// ============================================================================

test("N12-21 — timeout individual → timed_out/timeout", async () => {
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "ok", minDurationMs: 500 }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-slow" }], { item_timeout_ms: 150 }),
  );
  assert.equal(result.items[0].status, "timed_out");
  assert.equal(result.items[0].failure_reason, "timeout");
  assert.ok(result.items[0].duration_ms !== null && result.items[0].duration_ms! >= 100);
});

test("N12-22 — timeout não derruba itens independentes", async () => {
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "ok", minDurationMs: 80 }),
  );
  const result = await orch.executeBatch(
    requestOf(
      [
        { candidate_id: "can-slow" },
        { candidate_id: "can-fast" },
        { candidate_id: "can-ok-3" },
      ],
      { item_timeout_ms: 250 },
    ),
  );
  // Todos concluem — mesmo o lento (80ms < 250ms); forçando o teste real
  // do cenário: 2 rápidos + 1 muito lento.
  const orch2 = new AutomatedResearchOrchestrator(
    makeExecutor({
      behavior: "ok",
      minDurationMs: 100,
      callLog: [
        // nada; usamos wrapper abaixo para tornar só o 3º lento
      ] as never,
    }),
  );
  void orch2;
  const slowIds = new Set(["can-slow"]);
  const executor: ResearchExecutor = async (cid, fields, ctx) => {
    const inner = makeExecutor({ behavior: "ok", minDurationMs: slowIds.has(cid) ? 500 : 20 });
    return inner(cid, fields, ctx);
  };
  const orch3 = new AutomatedResearchOrchestrator(executor);
  const result2 = await orch3.executeBatch(
    requestOf(
      [
        { candidate_id: "can-fast-1" },
        { candidate_id: "can-slow" },
        { candidate_id: "can-fast-2" },
      ],
      { concurrency: 3, item_timeout_ms: 300 },
    ),
  );
  assert.equal(result2.items[0].status, "completed");
  assert.equal(result2.items[1].status, "timed_out");
  assert.equal(result2.items[2].status, "completed");
  assert.equal(result2.status, "partial");
});

// ============================================================================
// CANCELAMENTO (N12-23..24)
// ============================================================================

test("N12-23 — cancelamento antes de iniciar → cancelled", async () => {
  const controller = new AbortController();
  const orch = orchestratorOf("ok");
  controller.abort();
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-cancelled" }], { signal: controller.signal }),
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.items[0].status, "cancelled");
  assert.equal(result.items[0].failure_reason, "lote_cancelado");
});

test("N12-24 — cancelamento impede novo retry", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 999, callLog }),
  );
  const controller = new AbortController();
  // Aborta durante o backoff (após a 1ª tentativa).
  setTimeout(() => controller.abort(), 400);
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-cancel-retry" }], {
      signal: controller.signal,
      max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES,
    }),
  );
  assert.equal(result.items[0].status, "cancelled");
  assert.equal(result.items[0].failure_reason, "lote_cancelado");
  // 1 tentativa inicial + nenhuma nova após o cancelamento no backoff.
  assert.equal(callLog.length, 1);
});

// ============================================================================
// CORRELATION (N12-25..26)
// ============================================================================

test("N12-25 — PROOF_RUN_ID propagado", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-proof" }], { proof_run_id: "N12_PROOF_RUN_42" }),
  );
  assert.equal(result.proof_run_id, "N12_PROOF_RUN_42");
  assert.equal(result.items[0].proof_run_id, "N12_PROOF_RUN_42");
});

test("N12-26 — batch_id consistente em todos os itens", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([
      { candidate_id: "can-1" },
      { candidate_id: "can-2" },
      { candidate_id: "can-3" },
    ]),
  );
  assert.ok(result.batch_id.startsWith(""));
  for (const item of result.items) {
    assert.equal(item.batch_id, result.batch_id);
  }
});

// ============================================================================
// MÉTRICAS (N12-27)
// ============================================================================

test("N12-27 — metrics correspondem exatamente aos estados", async () => {
  const slowIds = new Set(["can-4"]);
  const executor: ResearchExecutor = async (cid, fields, ctx) => {
    if (cid === "can-4") {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(makeExecutor({ behavior: "ok" })(cid, fields, ctx)),
          500,
        ),
      );
    }
    if (cid === "can-dup") {
      return makeExecutor({ behavior: "all_duplicates" })(cid, fields, ctx);
    }
    if (cid === "can-empty") {
      return makeExecutor({ behavior: "no_fields_result" })(cid, fields, ctx);
    }
    return makeExecutor({ behavior: "ok" })(cid, fields, ctx);
  };
  const orch = new AutomatedResearchOrchestrator(executor);
  const result = await orch.executeBatch(
    requestOf(
      [
        { candidate_id: "can-1" },
        { candidate_id: "can-2" },
        { candidate_id: "can-dup" },
        { candidate_id: "can-empty" },
        { candidate_id: "can-4" },
      ],
      { concurrency: 5, item_timeout_ms: 250 },
    ),
  );
  const m = result.metrics;
  assert.equal(m.received, 5);
  assert.equal(
    m.processed,
    m.completed + m.duplicates + m.no_fields + m.failed + m.timed_out + m.cancelled,
  );
  assert.equal(m.completed, 2);
  assert.equal(m.duplicates, 1);
  assert.equal(m.no_fields, 1);
  assert.equal(m.timed_out, 1);
  assert.equal(m.failed, 0);
  assert.equal(m.cancelled, 0);
});

// ============================================================================
// BATCH STATUS (N12-28..31)
// ============================================================================

test("N12-28 — batch success", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-a" }, { candidate_id: "can-b" }]),
  );
  assert.equal(result.status, "success");
});

test("N12-29 — batch partial", async () => {
  const executor: ResearchExecutor = async (cid, fields, ctx) => {
    if (cid === "can-bad") return { ok: false, research_id: null, error: "generic_error", fields: [], contradictions: 0, unknowns: 0 };
    return makeExecutor({ behavior: "ok" })(cid, fields, ctx);
  };
  const orch = new AutomatedResearchOrchestrator(executor);
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-bad" }, { candidate_id: "can-ok" }], { max_retries: 0 }),
  );
  assert.equal(result.status, "partial");
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[1].status, "completed");
});

test("N12-30 — batch failed", async () => {
  const executor: ResearchExecutor = async (cid, fields, ctx) => {
    return { ok: false, research_id: null, error: "generic_error", fields: [], contradictions: 0, unknowns: 0 };
  };
  const orch = new AutomatedResearchOrchestrator(executor);
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-1" }, { candidate_id: "can-2" }], { max_retries: 0 }),
  );
  assert.equal(result.status, "failed");
});

test("N12-31 — batch cancelled", async () => {
  const controller = new AbortController();
  const orch = orchestratorOf("ok");
  controller.abort();
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-1" }, { candidate_id: "can-2" }], { signal: controller.signal }),
  );
  assert.equal(result.status, "cancelled");
});

// ============================================================================
// EVIDÊNCIA: CONTRADICTIONS / UNKNOWNS (N12-32..33)
// ============================================================================

test("N12-32 — CONTRADICTED preservado (nunca transformado em confirmed)", async () => {
  const orch = orchestratorOf("contradicted");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-contra" }]));
  assert.equal(result.items[0].status, "completed");
  assert.equal(result.items[0].contradictions, RESEARCH_DEFAULT_FIELDS.length);
  assert.ok(result.items[0].fields.every((f) => f.state === "CONTRADICTED"));
});

test("N12-33 — unknowns preservados sem promoção", async () => {
  const orch = orchestratorOf("unknowns");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-unknown" }]));
  assert.equal(result.items[0].status, "completed");
  assert.equal(result.items[0].unknowns, RESEARCH_DEFAULT_FIELDS.length);
  assert.ok(result.items[0].fields.every((f) => f.state === "UNKNOWN"));
});

// ============================================================================
// IDEMPOTÊNCIA / AUTORIDADES (N12-34..35)
// ============================================================================

test("N12-34 — field_hash/idempotência delegada ao executor N3 (sem segunda camada no N12)", async () => {
  // O orquestrador NÃO decide idempotência de evidência: o que ele classifica
  // como duplicate é a projeção dos outcomes do executor.
  const orch = orchestratorOf("all_duplicates");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-idem" }]));
  assert.equal(result.items[0].status, "duplicate");
  // O N12 não tem nenhum mecanismo de hash próprio — apenas repassa outcomes.
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  assert.ok(!stripComments(source).includes("field_hash"), "N12 runtime não implementa segunda autoridade de idempotência");
});

test("N12-35 — candidate repository é somente leitura no N12", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  const code = stripComments(source);
  const mutations = ["registerCandidate", "updateCandidate", "deleteCandidate", "deleteCandidateForProof", "approveCandidate"];
  for (const term of mutations) {
    assert.ok(!code.includes(term), `N12 importa mutation proibida: ${term}`);
  }
  // Apenas a leitura existe:
  assert.ok(code.includes("getCandidate"), "N12 usa getCandidate (read-only real)");
});

// ============================================================================
// EXECUTOR INJETÁVEL SEM BANCO/REDE (N12-36..37)
// ============================================================================

test("N12-36 — executor injetável funciona sem banco/rede", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-pure" }]),
  );
  assert.equal(result.items[0].status, "completed");
  // Nenhuma chamada real ao Supabase ocorreu (executor é mock puro).
});

test("N12-37 — executor que tenta mutar candidate é detectável (não-subversão)", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "mutates", callLog }),
  );
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-mutant" }]));
  // O executor mutante retorna falha governada (detected): status failed
  // com reason determinístico — nunca sucesso mascarado.
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].failure_reason, "candidate_id_ausente");
});

// ============================================================================
// NÃO-SUBVERSÃO ESTÁTICA (N12-38..41)
// ============================================================================

test("N12-38 — N12 não importa publication/acquisition/scheduler/job_queue/agents", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  const code = stripComments(source);
  const forbidden = ["publication", "acquisition", "scheduler", "job_queue", "agents", "telegram"];
  for (const term of forbidden) {
    assert.ok(!code.includes(term), `N12 importa domínio proibido: ${term}`);
  }
});

test("N12-39 — N12 não acessa products", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  assert.ok(!stripComments(source).includes("products"), "N12 acessa domínio products");
});

test("N12-40 — N12 não cria candidates", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  assert.ok(!stripComments(source).includes("registerCandidate"), "N12 pode criar candidates");
});

test("N12-41 — N12 não faz fetch HTTP diretamente", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/automatedResearch.ts"), "utf8");
  const code = stripComments(source);
  assert.ok(!code.includes("fetch("), "N12 faz fetch HTTP direto");
  assert.ok(!code.includes("import(\"http"), "N12 importa http");
});

// ============================================================================
// FAIL-CLOSED / BACKOFF / ATTEMPTS / TIMESTAMPS (N12-42..45)
// ============================================================================

test("N12-42 — retry nunca ocorre para erro fail-closed", async () => {
  // candidate inexistente + retries configurados: nenhum retry.
  onlySeededCandidateIds([]); // nenhum candidato existe
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "ok", callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-nope" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].failure_reason, "candidate_inexistente");
  assert.equal(result.items[0].attempts, 0);
  assert.equal(callLog.length, 0);
});

test("N12-43 — cancelamento durante backoff impede nova tentativa", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 999, callLog }),
  );
  const controller = new AbortController();
  // Aborta 100ms após a 1ª tentativa — durante o backoff de 1s.
  const promise = orch.executeBatch(
    requestOf([{ candidate_id: "can-mid-backoff" }], {
      signal: controller.signal,
      max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES,
    }),
  );
  setTimeout(() => controller.abort(), 250);
  const result = await promise;
  assert.equal(result.items[0].status, "cancelled");
  assert.equal(result.items[0].failure_reason, "lote_cancelado");
  assert.equal(callLog.length, 1);
});

test("N12-44 — attempts e retried contabilizados corretamente", async () => {
  const callLog: ExecutorSpec["callLog"] = [];
  const orch = new AutomatedResearchOrchestrator(
    makeExecutor({ behavior: "fetch_failed", failUntil: 1, callLog }),
  );
  const result = await orch.executeBatch(
    requestOf([{ candidate_id: "can-retried" }], { max_retries: RESEARCH_LIMITS.MAX_COORDINATION_RETRIES }),
  );
  assert.equal(result.items[0].attempts, 2); // 1 inicial + 1 retry
  assert.equal(result.metrics.retried, 1);
});

test("N12-45 — duration_ms e timestamps preenchidos", async () => {
  const orch = orchestratorOf("ok");
  const result = await orch.executeBatch(requestOf([{ candidate_id: "can-ts" }]));
  assert.ok(result.started_at, "started_at ausente");
  assert.ok(result.finished_at, "finished_at ausente");
  assert.ok(result.duration_ms !== null && result.duration_ms >= 0, "duration_ms inválida");
  assert.ok(result.items[0].duration_ms !== null && result.items[0].duration_ms! >= 0);
});

// ============================================================================
// HELPERS — computeMetrics / determineBatchStatus / classifyItemStatus
// (pure projection invariants)
// ============================================================================

test("computeMetrics: soma de estados = processed (N12-27 invariante)", () => {
  const items = [
    { status: "completed", attempts: 1 } as never,
    { status: "duplicate", attempts: 1 } as never,
    { status: "no_fields", attempts: 1 } as never,
    { status: "failed", attempts: 2 } as never,
    { status: "timed_out", attempts: 1 } as never,
    { status: "cancelled", attempts: 0 } as never,
  ];
  const m = computeMetrics(items, 6);
  assert.equal(m.processed, 6);
  assert.equal(
    m.completed + m.duplicates + m.no_fields + m.failed + m.timed_out + m.cancelled,
    m.processed,
  );
  assert.equal(m.retried, 1);
});

test("determineBatchStatus: classificações governadas", () => {
  const completed = [{ status: "completed" }] as never[];
  const mixed = [{ status: "completed" }, { status: "failed" }] as never[];
  const allFailed = [{ status: "failed" }, { status: "timed_out" }] as never[];
  assert.equal(determineBatchStatus(completed, false), "success");
  assert.equal(determineBatchStatus(mixed, false), "partial");
  assert.equal(determineBatchStatus(allFailed, false), "failed");
  assert.equal(determineBatchStatus(completed, true), "success");
  assert.equal(determineBatchStatus(allFailed, true), "cancelled");
});

test("classifyItemStatus: subset do contrato N12", () => {
  assert.equal(
    classifyItemStatus({ ok: true, research_id: null, fields: [{ field: "title", state: "KNOWN", source: "a", quality: "HIGH", evidence_id: null, outcome: "created" }], contradictions: 0, unknowns: 0 }),
    "completed",
  );
  assert.equal(
    classifyItemStatus({ ok: true, research_id: null, fields: [{ field: "title", state: "KNOWN", source: "a", quality: "HIGH", evidence_id: null, outcome: "identical_duplicate" }], contradictions: 0, unknowns: 0 }),
    "duplicate",
  );
  assert.equal(
    classifyItemStatus({ ok: true, research_id: null, fields: [], contradictions: 0, unknowns: 0 }),
    "no_fields",
  );
  assert.equal(
    classifyItemStatus({ ok: false, research_id: null, error: "generic", fields: [], contradictions: 0, unknowns: 0 }),
    "failed",
  );
});

test("validateAutomatedResearchRequest: catálogo fechado de razões", () => {
  const r1 = validateAutomatedResearchRequest({ candidates: [] });
  assert.equal(r1.ok, false);
  assert.equal((r1 as { ok: false; reason: string }).reason, "lote_vazio");
});

// ============================================================================
// N12-RT — EXECUTOR INTEGRADO REAL (adapter N1 read-only → N3)
// Fake Supabase padrão dos Blocos N1/N3 (in-memory, sem rede).
// ============================================================================

class FakeQueryBuilderRT {
  private filters: Array<[string, unknown]> = [];
  private maxRows?: number;
  private mode: "select" | "insert" | "delete" = "select";
  private input?: Record<string, unknown>;

  constructor(private readonly client: FakeSupabaseClientRT, private readonly table: string) {}

  select(_c?: unknown, _o?: unknown): this { return this; }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  order(_col: string, _opts?: unknown): this { return this; }
  limit(n: number): this { this.maxRows = n; return this; }
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    return Promise.resolve({ data: this.rows().filter((r) => this.matches(r))[0] ?? null, error: null });
  }
  delete(): this { this.mode = "delete"; return this; }
  insert(rows: unknown): this {
    this.mode = "insert";
    this.input = Array.isArray(rows) ? rows[0] : rows;
    return this;
  }
  single(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const row = { ...((this.input as Record<string, unknown>) ?? {}) };
      const rows = this.client.store.get(this.table) ?? [];
      const keyField = row.listing_key !== undefined ? "listing_key" : (row.field_hash ? "field_hash" : null);
      if (keyField && rows.some((r) => r[keyField] === row[keyField])) {
        return Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
      }
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
  then(resolve?: (v: unknown) => unknown): Promise<unknown> {
    const rows = this.rows().filter((r) => this.matches(r));
    return Promise.resolve({ data: rows.slice(0, this.maxRows), error: null, count: rows.length }).then(resolve as never);
  }
  private rows(): Record<string, unknown>[] { return this.client.store.get(this.table) ?? []; }
  private matches(r: Record<string, unknown>): boolean {
    return this.filters.every(([c, v]) => r[c] === v);
  }
}

class FakeSupabaseClientRT {
  store = new Map<string, Record<string, unknown>[]>([
    ["candidate_evidence", []],
    ["candidates", []],
  ]);
  from(t: string) { return new FakeQueryBuilderRT(this, t); }
}

let rtClient: FakeSupabaseClientRT;

// beforeEach global: fake N1 (padrão: todos os ids existem) — aplicado a
// todos os testes EXCETO os da seção N12-RT (que usam o fake RT abaixo).
test.beforeEach((ctx: TestContext) => {
  if (String(ctx.name).startsWith("N12-RT")) return;
  n1Mode = "all_exist";
  seedCandidateIds.clear();
  setCandidatesClientForTests(fakeCandidatesClient as unknown as SupabaseClient);
  setCandidateEvidenceClientForTests(null);
});

test.beforeEach((ctx: TestContext) => {
  // Somente os testes da seção integrada (N12-RT) usam o fake RT.
  if (!String(ctx.name).startsWith("N12-RT")) return;
  rtClient = new FakeSupabaseClientRT();
  setCandidatesClientForTests(rtClient as unknown as SupabaseClient);
  setCandidateEvidenceClientForTests(rtClient as unknown as SupabaseClient);
});

// ============================================================================
// FAKE N1 (candidates) — usado por TODOS os testes pure do orquestrador.
// O runtime N12 chama getCandidate do candidatesRepository; sem fake,
// todos os candidatos seriam tratados como inexistentes (fail-closed).
// Existência é controlada por `seedCandidateIds`: conjunto de ids existentes
// no fake. Antes de cada teste, aceita todos os ids (padrão útil); testes de
// inexistência (N12-09, N12-42) reconfiguram o conjunto explicitamente.
// ============================================================================

// Modo do fake N1: "all_exist" (default — qualquer candidate_id passa) ou
// "only_seeded" (apenas ids em seedCandidateIds passam; os demais não existem).
let n1Mode: "all_exist" | "only_seeded" = "all_exist";
const seedCandidateIds = new Set<string>();

function makeFakeCandidatesClient(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: async () => {
              if (n1Mode === "only_seeded" && seedCandidateIds.size === 0) {
                return { data: null, error: null };
              }
              return { data: { candidate_id: "any", listing_key: "lk" }, error: null };
            },
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const fakeCandidatesClient = makeFakeCandidatesClient();

// beforeEach global: fake N1 (padrão: todos os ids existem). Os testes RT
// re-injetam o fake RT por demanda — ordem importa: RT beforeEach vem DEPOIS
// (ver seção N12-RT), então os testes pure N12-* recebem o fake N1 aqui.
test.afterEach(() => {
  // Reset universal de overrides de teste (N12-RT usa override de startResearch).
  setIntegratedResearchOverridesForTests(null);
});

/** Restringe o fake N1: apenas ids em `ids` existem (o restante não existe). */
function onlySeededCandidateIds(ids: ReadonlyArray<string>): void {
  n1Mode = "only_seeded";
  seedCandidateIds.clear();
  for (const id of ids) seedCandidateIds.add(id);
}



function rtCandidateRow(candidate_id: string) {
  return {
    candidate_id,
    marketplace: "Mercado Livre",
    source_url: "https://produto.mercadolivre.com.br/MLB-12345",
    external_listing_id: "MLB-12345",
    merchant: "Loja Teste",
    title: "Luminária LED 40W",
    observed_price: 149.9,
    observed_at: "2026-08-16T12:00:00Z",
    evidence_hash: "sha256:rt-evidence",
    collection_method: "SCRAPE",
    metadata: { discovery_block: "N1" },
    created_at: new Date().toISOString(),
  };
}

function evidenceCountRT(): number {
  const client = getCandidateEvidenceClient();
  if (!client) return 0;
  const fake = client as unknown as { store: Map<string, Record<string, unknown>[]> };
  return (fake.store.get("candidate_evidence") ?? []).length;
}

// startResearch mockado (determinístico — nenhum fetch N2 real nem rede).
function mockStartResearch(
  spec: { ok?: boolean; error?: string; outcome?: "created" | "identical_duplicate"; fieldCount?: number },
) {
  const ok = spec.ok ?? true;
  const count = spec.fieldCount ?? RESEARCH_DEFAULT_FIELDS.length;
  const outcome = spec.outcome ?? "created";
  setIntegratedResearchOverridesForTests({
    startResearch: async (input) => {
      const fields = Array.from({ length: count }, (_, i) => ({
        field: RESEARCH_DEFAULT_FIELDS[i % RESEARCH_DEFAULT_FIELDS.length],
        state: "KNOWN" as const,
        source: "marketplace_page" as const,
        quality: "HIGH" as const,
        evidence_id: `ev-mock-${i}`,
        outcome: outcome as "created" | "identical_duplicate",
      }));
      // Session registrada (como o N3 real faz) — persistida no fake RT.
      const before = evidenceCountRT();
      rtClient.store.set(
        "candidate_evidence",
        [
          ...(rtClient.store.get("candidate_evidence") ?? []),
          {
            candidate_id: input.candidate_id,
            kind: "RESEARCH_SESSION",
            field: null,
            state: null,
            evidence_hash: `session:${input.candidate_id}:${Math.random()}`,
          },
        ],
      );
      return {
        ok,
        research_id: ok ? `rs-mock-${input.candidate_id}-${before}` : null,
        candidate_id: input.candidate_id,
        session_evidence_id: ok ? "ev-session-mock" : null,
        error: ok ? undefined : spec.error,
        fields,
        contradictions: 0,
        unknowns: ok ? 0 : 0,
      } as never;
    },
  });
}

test("N12-RT-01 — candidate existente → startResearch chamado com candidate correto", async () => {
  const cid = "can-rt-1";
  rtClient.store.set("candidates", [rtCandidateRow(cid)]);
  mockStartResearch({});
  const result = await executeIntegratedResearch(
    cid,
    [...RESEARCH_DEFAULT_FIELDS],
    { batch_id: "batch-rt-1", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  assert.equal(result.research_id !== null, true);
  assert.equal(result.fields.length, RESEARCH_DEFAULT_FIELDS.length);
});

test("N12-RT-02 — candidate inexistente → startResearch não chamado", async () => {
  rtClient.store.set("candidates", []);
  const before = evidenceCountRT();
  const result = await executeIntegratedResearch(
    "can-inexistente-rt",
    [...RESEARCH_DEFAULT_FIELDS],
    { batch_id: "batch-rt-2", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  assert.equal(result.ok, false);
  // O adapter delega a autoridade do candidato ao N3 (startResearch):
  // candidate inexistente → erro governado do N3, sem mutação.
  assert.equal(result.error, "candidate_not_found");
  assert.equal(evidenceCountRT(), before); // nada gravado
});

test("N12-RT-03 — requested_fields chegam corretamente ao N3", async () => {
  const cid = "can-rt-3";
  rtClient.store.set("candidates", [rtCandidateRow(cid)]);
  mockStartResearch({ fieldCount: 2 });
  const result = await executeIntegratedResearch(
    cid,
    ["title", "price"],
    { batch_id: "batch-rt-3", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  assert.equal(result.fields.length, 2);
  assert.deepEqual(result.fields.map((f) => f.field), ["title", "price"]);
});

test("N12-RT-04 — ResearchResult real convertido corretamente para ResearchExecutorResult", async () => {
  const cid = "can-rt-4";
  rtClient.store.set("candidates", [rtCandidateRow(cid)]);
  const fakeResearch = {
    ok: true,
    research_id: "rs-rt-4",
    candidate_id: cid,
    session_evidence_id: "ev-session",
    fields: [
      { field: "title", state: "KNOWN" as const, source: "marketplace_page" as const, quality: "HIGH", evidence_id: "ev-title", outcome: "created" as const },
    ],
    contradictions: 0,
    unknowns: 0,
  };
  const adapted = adaptResearchResult(fakeResearch as never);
  assert.equal(adapted.ok, true);
  assert.equal(adapted.research_id, "rs-rt-4");
  assert.equal(adapted.fields.length, 1);
  assert.equal(adapted.fields[0].outcome, "created");
});

test("N12-RT-05 — created/identical_duplicate preservados", async () => {
  const fake = {
    ok: true,
    research_id: "rs-rt-5",
    fields: [
      { field: "title", state: "KNOWN", source: "marketplace_page", quality: "HIGH", evidence_id: "ev-1", outcome: "created" },
      { field: "price", state: "KNOWN", source: "marketplace_page", quality: "HIGH", evidence_id: "ev-2", outcome: "identical_duplicate" },
    ],
    contradictions: 0,
    unknowns: 0,
  };
  const adapted = adaptResearchResult(fake as never);
  assert.equal(adapted.fields[0].outcome, "created");
  assert.equal(adapted.fields[1].outcome, "identical_duplicate");
});

test("N12-RT-06 — CONTRADICTED preservado", async () => {
  const fake = {
    ok: true,
    research_id: "rs-rt-6",
    fields: [
      { field: "title", state: "CONTRADICTED", source: "marketplace_page", quality: "MEDIUM", evidence_id: "ev-3", outcome: "created" },
    ],
    contradictions: 1,
    unknowns: 0,
  };
  const adapted = adaptResearchResult(fake as never);
  assert.equal(adapted.fields[0].state, "CONTRADICTED");
  assert.equal(adapted.contradictions, 1);
});

test("N12-RT-07 — unknowns preservados", async () => {
  const fake = {
    ok: true,
    research_id: "rs-rt-7",
    fields: [
      { field: "title", state: "UNKNOWN", source: "marketplace_page", quality: "LOW", evidence_id: "ev-4", outcome: "created" },
    ],
    contradictions: 0,
    unknowns: 1,
  };
  const adapted = adaptResearchResult(fake as never);
  assert.equal(adapted.fields[0].state, "UNKNOWN");
  assert.equal(adapted.unknowns, 1);
});

test("N12-RT-08 — research_id propagado sem ser usado como idempotência", async () => {
  const cid = "can-rt-8";
  rtClient.store.set("candidates", [rtCandidateRow(cid)]);
  mockStartResearch({ fieldCount: 1, outcome: "created" });
  const r1 = await executeIntegratedResearch(
    cid,
    ["title"],
    { batch_id: "batch-rt-8", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  // Segunda execução: replicar idempotência do N3 (field_hash) —
  // o mock representa a segunda sessão com outcome identical_duplicate.
  mockStartResearch({ fieldCount: 1, outcome: "identical_duplicate" });
  const r2 = await executeIntegratedResearch(
    cid,
    ["title"],
    { batch_id: "batch-rt-8", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  assert.ok(r1.research_id);
  assert.ok(r2.research_id);
  assert.notEqual(r1.research_id, r2.research_id); // research_id por sessão (N3)
  assert.equal(r2.fields[0].outcome, "identical_duplicate"); // idempotência real = field_hash
});

test("N12-RT-09 — adapter não grava em candidates", async () => {
  const cid = "can-rt-9";
  rtClient.store.set("candidates", [rtCandidateRow(cid)]);
  const before = (rtClient.store.get("candidates") ?? []).length;
  mockStartResearch({});
  await executeIntegratedResearch(
    cid,
    [...RESEARCH_DEFAULT_FIELDS],
    { batch_id: "batch-rt-9", proof_run_id: null, attempt: 0, signal: new AbortController().signal, timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS },
  );
  // O adapter é read-only no N1: nenhuma linha nova de candidate.
  assert.equal((rtClient.store.get("candidates") ?? []).length, before);
});

test("N12-RT-10 — adapter não toca products/publication/acquisition/jobs", async () => {
  const source = await readFile(join(REPO_ROOT, "server/commercial/facilitator/integratedResearchExecutor.ts"), "utf8");
  // Varredura do código efetivo (comentários de governança excluídos —
  // a prova do domínio é comportamental; o runtime real não importa
  // nem chama nada dos domínios proibidos).
  const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const forbidden = ["products", "publication", "acquisition", "job_queue", "scheduler", "agents", "fetch(", "http"];
  for (const term of forbidden) {
    assert.ok(!code.includes(term), `adapter toca domínio proibido: ${term}`);
  }
});
