// ============================================================================
// BLOCO N12 — RESEARCH AUTOMATIZADO — FASE 2 — RUNTIME (coordenação pura)
// ----------------------------------------------------------------------------
// DATA: 18/08/2026
//
// O AutomatedResearchOrchestrator coordena um lote (AutomatedResearchBatch)
// de pesquisas sobre candidatos existentes no funil N1. Ele é uma camada
// de COORDENAÇÃO EM MEMÓRIA:
//
//   - NÃO faz fetch HTTP, NÃO valida SSRF, NÃO coleta dados de página
//     (autoridade N2, atravessada via N3 através do executor injetado);
//   - NÃO cria/altera candidates (autoridade N1 — read-only);
//   - NÃO decide estado de evidência, NÃO resolve CONTRADICTED,
//     NÃO calcula verdade canônica (autoridade N3);
//   - NÃO acessa products, affiliate_links, publications, job_queue,
//     scheduler, agentes, Telegram ou qualquer ação externa.
//
// O executor (ResearchExecutor) é injetado — o orquestrador não importa
// startResearch diretamente (padrão: executeIntegratedResearch do N3).
//
// GOVERNANÇA (inalterável):
//   - CANDIDATE != FACT CANÔNICO — pesquisa; NUNCA promove.
//   - OBSERVATION != FACT CANÔNICO — evidência persiste como candidata.
//   - RESEARCH != PUBLICATION / PROMOTION — nenhuma rota tocada.
//   - FAIL-CLOSED — erros determinísticos NUNCA são retentáveis.
//   - UNKNOWN PERMANECE UNKNOWN — unknowns não são failure por si só e
//     nunca são promovidos a "conhecido".
// ============================================================================

import {
  AUTOMATED_RESEARCH_BATCH_STATUSES,
  AUTOMATED_RESEARCH_FAILURE_REASONS,
  AUTOMATED_RESEARCH_ITEM_STATUSES,
  AUTOMATED_RESEARCH_TRANSIENT_ERRORS,
  RESEARCH_LIMITS,
  validateAutomatedResearchRequest,
  resolveFields,
  type AutomatedResearchBatchResult,
  type AutomatedResearchBatchStatus,
  type AutomatedResearchCandidate,
  type AutomatedResearchContract,
  type AutomatedResearchFailureReason,
  type AutomatedResearchFieldResult,
  type AutomatedResearchItemResult,
  type AutomatedResearchItemStatus,
  type AutomatedResearchItemContext,
  type AutomatedResearchMetrics,
  type AutomatedResearchRequest,
  type ResearchExecutor,
  type ResearchExecutorResult,
} from "./researchContracts";
import { getCandidate } from "../../repositories/candidatesRepository";

/** Catálogo fechado de razões governadas (Set, para lookup de fail-closed). */
const REASON_SET: ReadonlySet<string> = new Set(AUTOMATED_RESEARCH_FAILURE_REASONS);

/**
 * MAX_COORDINATION_CONCURRENCY_LIMIT — teto conservador por request.
 * Impede configuração ilimitada (autoridade N2: circuit breaker).
 */
export const MAX_COORDINATION_CONCURRENCY_LIMIT = 8;

/**
 * concurrentExec — executa tarefas com limite de concorrência e
 * cancelamento AbortSignal. Fila interna simples, sem dependência externa.
 * Resultados preservados por índice de entrada.
 */
async function concurrentExec<T>(
  limit: number,
  signal: AbortSignal,
  tasks: Array<() => Promise<T>>,
): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(tasks.length);
  let inflight = 0;
  let index = 0;

  const inflightPromises: Array<Promise<void>> = [];

  // Mecanismo de wake-up: quando um slot é liberado (item concluído ou
  // cancelamento), resolveSlot acorda o loop para reavaliar a enfilagem
  // e o check de signal.aborted no topo.
  let resolveSlot: (() => void) | null = null;
  let onSlotFree: Promise<void> = new Promise<void>((resolve) => {
    resolveSlot = resolve;
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal.aborted) break;
    while (index < tasks.length && inflight < limit) {
      const taskIndex = index;
      index += 1;
      inflight += 1;
      inflightPromises.push(
        tasks[taskIndex]().then(
          (r) => {
            results[taskIndex] = r;
          },
          (err) => {
            results[taskIndex] = null;
          },
        ).finally(() => {
          inflight -= 1;
          // Libera o aguardo do loop para reavaliar a enfilagem e o
          // cancelamento; cria nova Promise para o próximo aguardo.
          const release = resolveSlot;
          if (release) {
            resolveSlot = null;
            release();
          }
          onSlotFree = new Promise<void>((resolve) => {
            resolveSlot = resolve;
          });
        }),
      );
    }
    if (index >= tasks.length) break;
    // Espera interrompível: o cancelamento do lote (signal abortado) ou a
    // liberação de um slot devem acordar o loop imediatamente para que o
    // check de signal.aborted no topo encerre a enfilagem.
    await Promise.race([
      onSlotFree,
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new BatchCancelledError("batch_cancelled"));
          return;
        }
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(new BatchCancelledError("batch_cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).catch((err) => {
      if (err instanceof BatchCancelledError) {
        // Abort recebido durante o aguardo: sair do loop no topo.
        return;
      }
      throw err;
    });
    if (signal.aborted) break;
  }

  // Cancelamento prevalece sobre conclusão: tarefas em voo NÃO são
  // aguardadas após o abort (a coleta N3 iniciada pode continuar em
  // background — dívida D1; os slots pendentes são mapeados a
  // "cancelled" pelo orquestrador). Sem abort, aguarda todas as tarefas
  // em voo concluírem antes de retornar os resultados por índice.
  if (signal.aborted) {
    return results;
  }
  await Promise.all(inflightPromises);
  return results;
}

/**
 * cancellableSleep — sleep com AbortSignal (usado no backoff).
 */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BatchCancelledError("batch_cancelled"));
      return;
    }
    const timer = setTimeout(() => {  
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BatchCancelledError("batch_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Erro interno de cancelamento do lote (não polui resultados públicos). */
export class BatchCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/** Erro interno de timeout de coordenação do item. */
export class CoordinationTimeoutError extends Error {
  constructor() {
    super("item_timed_out");
  }
}

/**
 * executeItemWithTimeout — executa um item com timeout próprio de
 * coordenação (AbortController combinado com o signal do lote).
 * O timeout de coordenação NÃO substitui o timeout de rede do N2:
 * (dívita D1 — startResearch não aceita AbortSignal; a coleta N3/N2
 * iniciada pode continuar em background).
 */
async function executeItemWithTimeout(
  executor: ResearchExecutor,
  candidate_id: string,
  requested_fields: ReadonlyArray<string>,
  context: AutomatedResearchItemContext,
): Promise<{ result: ResearchExecutorResult | null; timedOut: boolean; duration_ms: number }> {
  const started = Date.now();
  let timedOut = false;
  try {
    const result = await new Promise<ResearchExecutorResult>(
      (resolve, reject) => {
        const timer = setTimeout(() => {  
          timedOut = true;
          reject(new CoordinationTimeoutError());
        }, context.timeout_ms);
        executor(candidate_id, requested_fields, context).then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      },
    );
    return { result, timedOut, duration_ms: Date.now() - started };
  } catch (err) {
    if (err instanceof CoordinationTimeoutError) {
      return { result: null, timedOut: true, duration_ms: Date.now() - started };
    }
    if (err instanceof BatchCancelledError) throw err;
    // Execução interrompida pelo cancelamento do lote: preservar o fato
    // de que a coleta N3 pode continuar em background (dívita D1).
    if (context.signal.aborted) {
      return { result: null, timedOut: false, duration_ms: Date.now() - started };
    }
    // Executor lançou erro fora do contrato: não mascarar (fail-closed).
    return {
      result: {
        ok: false,
        research_id: null,
        error: err instanceof Error ? err.message : "executor_erro",
        fetch_failed: false,
        fields: [],
        contradictions: 0,
        unknowns: 0,
      },
      timedOut: false,
      duration_ms: Date.now() - started,
    };
  }
}

/**
 * classifyItemStatus — classificação determinística do item a partir do
 * resultado do executor (subset do N3), conforme o contrato N12.
 *
 * - completed: ok e ao menos um campo avaliado (created/rejected/UNKNOWN)
 * - duplicate: ok e TODOS os campos identical_duplicate
 * - no_fields: ok mas nenhum campo avaliado
 * - failed: !ok (erro definitivo)
 */
export function classifyItemStatus(
  result: ResearchExecutorResult,
): AutomatedResearchItemStatus {
  if (!result.ok) return "failed";
  if (result.fields.length === 0) return "no_fields";
  const allDuplicates = result.fields.every((f) => f.outcome === "identical_duplicate");
  if (allDuplicates) return "duplicate";
  return "completed";
}

/**
 * isRetryableFailure — retry SOMENTE para erros transitórios listados no
 * contrato (fetch_failed, session_registration_failed). Fail-closed:
 * erros determinísticos nunca retentáveis.
 */
function isRetryableFailure(
  result: ResearchExecutorResult | null,
): boolean {
  if (!result) return false;
  if (result.fetch_failed) return true;
  const reason = result.error ?? "";
  return AUTOMATED_RESEARCH_TRANSIENT_ERRORS.includes(reason);
}

/**
 * deriveFailureReason — razão governada a partir do estado final do item.
 */
function deriveFailureReason(
  status: AutomatedResearchItemStatus,
  result: ResearchExecutorResult | null,
  timedOut: boolean,
  retriesExhausted: boolean,
): AutomatedResearchFailureReason | null {
  if (timedOut) return "timeout";
  if (retriesExhausted) return "erro_transiente_esgotado";
  if (status === "failed") {
    if (result?.error === "candidate_not_found") return "candidate_inexistente";
    if (result?.fetch_failed) {
      // Falha de coleta N2: derivar razão governada a partir do fetch_reason
      // do N2 (catálogo fechado, fail-closed). O fetch_failed é transitório
      // por natureza; sem retries disponíveis a razão final é a de esgotado
      // (governada) ou o fetch_reason governado quando a lista fechada o
      // reconhece como determinístico.
      const base = result.fetch_reason ?? "fetch_failed";
      if (REASON_SET.has(base)) return base as AutomatedResearchFailureReason;
      // Razões de coleta do N2 reconhecidas: rate_limited, circuit_open,
      // http_error, no_content_read, fetch_failed (mensagem longa é
      // normalizada para o catálogo fechado).
      const normalized =
        base === "rate_limited" ||
        base === "circuit_open" ||
        base === "http_error" ||
        base === "no_content_read"
          ? base
          : base.startsWith("fetch_failed")
            ? "fetch_failed"
            : null;
      if (normalized && REASON_SET.has(normalized)) {
        return normalized as AutomatedResearchFailureReason;
      }
      return "generic_error";
    }
    if (result?.error && result.error !== "candidate_not_found") {
      return REASON_SET.has(result.error)
        ? (result.error as AutomatedResearchFailureReason)
        : "generic_error";
    }
    return "generic_error";
  }
  return null;
}

/**
 * computeMetrics — métricas derivadas 100% dos estados finais dos items.
 * Nenhum contador é incrementado durante a execução: as métricas são a
 * projeção determinística dos resultados.
 */
export function computeMetrics(
  items: ReadonlyArray<AutomatedResearchItemResult>,
  received: number,
): AutomatedResearchMetrics {
  let processed = 0;
  let completed = 0;
  let duplicates = 0;
  let noFields = 0;
  let failed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let retried = 0;
  for (const it of items) {
    processed += 1;
    if (it.status === "completed") completed += 1;
    else if (it.status === "duplicate") duplicates += 1;
    else if (it.status === "no_fields") noFields += 1;
    else if (it.status === "timed_out") timedOut += 1;
    else if (it.status === "cancelled") cancelled += 1;
    else failed += 1;
    if (it.attempts > 1) retried += 1;
  }
  return {
    received,
    processed,
    completed,
    duplicates,
    no_fields: noFields,
    failed,
    timed_out: timedOut,
    cancelled,
    retried,
  };
}

/**
 * determineBatchStatus — status agregado do lote a partir dos estados
 * finais (determinístico):
 *
 *   success   → todos os itens em completed/duplicate/no_fields
 *   partial   → ao menos um failed/timed_out e ao menos um desfecho útil
 *   failed    → nenhum item produziu desfecho útil
 *   cancelled → lote cancelado antes de concluir e sem desfecho útil
 */
export function determineBatchStatus(
  items: ReadonlyArray<AutomatedResearchItemResult>,
  wasCancelled: boolean,
): AutomatedResearchBatchStatus {
  const outcomes = items.map((it) => it.status);
  const nonFailure = outcomes.every(
    (s) => s === "completed" || s === "duplicate" || s === "no_fields",
  );
  if (nonFailure) return "success";
  if (wasCancelled && items.length === 0) return "cancelled";
  const hadUseful = outcomes.some(
    (s) => s === "completed" || s === "duplicate" || s === "no_fields",
  );
  if (hadUseful) return "partial";
  if (wasCancelled) return "cancelled";
  return "failed";
}

/**
 * batchId — correlation do lote (randomUUID sem dependência externa).
 */
function generateBatchId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rsb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * normalizeCoordination — normaliza a configuração de coordenação contra
 * os limites aprovados (fail-closed para valores inválidos).
 */
function normalizeCoordination(
  coordination?: AutomatedResearchRequest["coordination"],
): { ok: true; config: { concurrency: number; item_timeout_ms: number; max_retries: number } } | {
  ok: false;
  reason: AutomatedResearchFailureReason;
} {
  const defaults = {
    concurrency: RESEARCH_LIMITS.DEFAULT_CONCURRENCY_LIMIT,
    item_timeout_ms: RESEARCH_LIMITS.DEFAULT_ITEM_TIMEOUT_MS,
    max_retries: 0,
  };
  if (!coordination) return { ok: true, config: defaults };

  const concurrency = coordination.concurrency ?? defaults.concurrency;
  const timeout = coordination.item_timeout_ms ?? defaults.item_timeout_ms;
  const retries = coordination.max_retries ?? defaults.max_retries;

  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return { ok: false, reason: "lote_excedido" };
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { ok: false, reason: "timeout" };
  }
  if (!Number.isFinite(retries) || retries < 0 || retries > RESEARCH_LIMITS.MAX_COORDINATION_RETRIES) {
    return { ok: false, reason: "generic_error" };
  }

  return {
    ok: true,
    config: {
      concurrency: Math.min(concurrency, MAX_COORDINATION_CONCURRENCY_LIMIT),
      item_timeout_ms: timeout,
      max_retries: retries,
    },
  };
}

/**
 * AutomatedResearchOrchestrator — coordenador de batches de pesquisa
 * automatizada (autoridade deste módulo).
 *
 * - NÃO faz pesquisa diretamente (executor injetado);
 * - NÃO muta candidates/evidência (read-only);
 * - valida request fail-closed ANTES de qualquer execução;
 * - preserva ordem de entrada nos resultados.
 */
export class AutomatedResearchOrchestrator implements AutomatedResearchContract {
  constructor(private readonly executor: ResearchExecutor) {}

  async executeBatch(request: AutomatedResearchRequest): Promise<AutomatedResearchBatchResult> {
    const batchId = generateBatchId();
    const startedAt = new Date().toISOString();
    const proofRunId = request.proof_run_id ?? null;

    // 1) Validação do request (fail-closed, antes de qualquer execução).
    const validation = validateAutomatedResearchRequest(request);
    if (!validation.ok) {
      const finishedAt = new Date().toISOString();
      return {
        batch_id: batchId,
        status: "failed",
        proof_run_id: proofRunId,
        items: [],
        metrics: computeMetrics([], 0),
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      };
    }

    // 2) Normalização da coordenação (rejeição de valores inválidos).
    const norm = normalizeCoordination(request.coordination);
    if (!norm.ok) {
      const finishedAt = new Date().toISOString();
      return {
        batch_id: batchId,
        status: "failed",
        proof_run_id: proofRunId,
        items: [],
        metrics: computeMetrics([], request.candidates.length),
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      };
    }
    const config = norm.config;
    const signal = request.coordination?.signal ?? new AbortController().signal;

    // 3) Resolução dos campos por candidato (fail-closed).
    const fieldsByCandidate = request.candidates.map((c) => {
      const resolved = resolveFields(c.requested_fields);
      return resolved;
    });

    // 4) Pré-validação read-only do candidate no N1.
    const existenceByCandidate = await Promise.all(
      request.candidates.map((c) => getCandidate(c.candidate_id)),
    );

    // 5) Construção das tarefas de execução.
    const results: Array<AutomatedResearchItemResult | null> = new Array(
      request.candidates.length,
    );

    const tasks = request.candidates.map(
      (candidate: AutomatedResearchCandidate, index: number) =>
        async (): Promise<AutomatedResearchItemResult> => {
          const fieldsResolved = fieldsByCandidate[index];
          const existence = existenceByCandidate[index];

          // Candidate inexistente (N1): falha determinística, executor
          // nunca chamado (pré-validação read-only).
          if (!existence.ok || !existence.candidate) {
            return {
              candidate_id: candidate.candidate_id,
              research_id: null,
              status: "failed",
              fields: [],
              contradictions: 0,
              unknowns: 0,
              attempts: 0,
              duration_ms: null,
              failure_reason: "candidate_inexistente",
              batch_id: batchId,
              proof_run_id: proofRunId,
            };
          }

          // Cancelamento antes de iniciar.
          if (signal.aborted) {
            return {
              candidate_id: candidate.candidate_id,
              research_id: null,
              status: "cancelled",
              fields: [],
              contradictions: 0,
              unknowns: 0,
              attempts: 0,
              duration_ms: null,
              failure_reason: "lote_cancelado",
              batch_id: batchId,
              proof_run_id: proofRunId,
            };
          }

          if (!fieldsResolved.ok) {
            return {
              candidate_id: candidate.candidate_id,
              research_id: null,
              status: "failed",
              fields: [],
              contradictions: 0,
              unknowns: 0,
              attempts: 0,
              duration_ms: null,
              failure_reason: "campos_invalidos",
              batch_id: batchId,
              proof_run_id: proofRunId,
            };
          }
          const fieldsToResearch = fieldsResolved.fields;

          // 6) Retry loop governado (transitório apenas, fail-closed).
          const maxAttempts =
            1 + Math.min(config.max_retries, RESEARCH_LIMITS.MAX_COORDINATION_RETRIES);
          let attempts = 0;
          let status: AutomatedResearchItemStatus = "failed";
          let result: ResearchExecutorResult | null = null;
          let timedOut = false;
          let duration_ms: number | null = null;
          let failure_reason: AutomatedResearchFailureReason | null = "generic_error";

          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            attempts = attempt + 1;
            if (signal.aborted) {
              return {
                candidate_id: candidate.candidate_id,
                research_id: null,
                status: "cancelled",
                fields: [],
                contradictions: 0,
                unknowns: 0,
                attempts,
                duration_ms,
                failure_reason: "lote_cancelado",
                batch_id: batchId,
                proof_run_id: proofRunId,
              };
            }
            const context: AutomatedResearchItemContext = {
              batch_id: batchId,
              proof_run_id: proofRunId,
              attempt,
              signal,
              timeout_ms: config.item_timeout_ms,
            };

            const exec = await executeItemWithTimeout(
              this.executor,
              candidate.candidate_id,
              fieldsToResearch,
              context,
            );
            timedOut = exec.timedOut;
            result = exec.result;
            duration_ms = exec.duration_ms;

            if (exec.result && !timedOut) {
              status = classifyItemStatus(exec.result);
              failure_reason = deriveFailureReason(
                status,
                exec.result,
                timedOut,
                false,
              );
            } else if (timedOut) {
              status = "timed_out";
              failure_reason = "timeout";
            } else {
              status = "failed";
              failure_reason = "generic_error";
            }

            // Retry somente para transientes; fail-closed é permanente.
            const hasRetryLeft = attempt + 1 < maxAttempts;
            if (hasRetryLeft && status === "failed" && !timedOut && result && isRetryableFailure(result)) {
              try {
                const backoff =
                  RESEARCH_LIMITS.RETRY_BACKOFF_MS[attempt] ??
                  RESEARCH_LIMITS.RETRY_BACKOFF_MS[RESEARCH_LIMITS.RETRY_BACKOFF_MS.length - 1];
                await cancellableSleep(backoff, signal);
                continue;
              } catch (err) {
                if (err instanceof BatchCancelledError) {
                  return {
                    candidate_id: candidate.candidate_id,
                    research_id: result?.research_id ?? null,
                    status: "cancelled",
                    fields: [],
                    contradictions: 0,
                    unknowns: 0,
                    attempts,
                    duration_ms,
                    failure_reason: "lote_cancelado",
                    batch_id: batchId,
                    proof_run_id: proofRunId,
                  };
                }
                throw err;
              }
            }
            break;
          }

          // Falha transitória que encerra o item sem concluir (retries
          // não disponíveis ou todos esgotados) → razão governada
          // "erro_transiente_esgotado" (nunca falha transitória em aberto).
          const endedTransitory =
            status === "failed" && !timedOut && result && isRetryableFailure(result);
          const retriesExhausted = endedTransitory;
          const finalFailureReason = retriesExhausted
            ? "erro_transiente_esgotado"
            : failure_reason;
          const finalDuration = duration_ms ?? null;

          const fields: ReadonlyArray<AutomatedResearchFieldResult> = result
            ? result.fields
            : [];

          return {
            candidate_id: candidate.candidate_id,
            research_id: result?.research_id ?? null,
            status,
            fields,
            contradictions: result?.contradictions ?? 0,
            unknowns: result?.unknowns ?? 0,
            attempts,
            duration_ms: finalDuration,
            failure_reason: finalFailureReason,
            batch_id: batchId,
            proof_run_id: proofRunId,
          };
        },
    );

    // 7) Execução concorrente com limite e cancelamento.
        // As tarefas retornam o item; o results local deste método é preenchido
    // pelas próprias tarefas (concurrentExec não copia o retorno). Para
    // eliminar ambiguidade, capturar o retorno de concurrentExec:
    const executed = await concurrentExec(config.concurrency, signal, tasks);
    for (let index = 0; index < executed.length; index += 1) {
      results[index] = executed[index];
    }
    // 8) Preservação de ordem (results[i] alinhado ao índice de entrada).
    const items = request.candidates.map(
      (_, index) =>
        (results[index] ?? {
          candidate_id: request.candidates[index].candidate_id,
          research_id: null,
          status: "cancelled",
          fields: [],
          contradictions: 0,
          unknowns: 0,
          attempts: 0,
          duration_ms: null,
          failure_reason: "lote_cancelado",
          batch_id: batchId,
          proof_run_id: proofRunId,
        }) as AutomatedResearchItemResult,
    );

    const wasCancelled = signal.aborted;
    const metrics = computeMetrics(items, request.candidates.length);
    const finishedAt = new Date().toISOString();

    return {
      batch_id: batchId,
      status: determineBatchStatus(items, wasCancelled),
      proof_run_id: proofRunId,
      items,
      metrics,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    };
  }
}

// Reexport para conveniência de testes (sem mudar a autoridade).
export {
  AUTOMATED_RESEARCH_BATCH_STATUSES,
  AUTOMATED_RESEARCH_FAILURE_REASONS,
  AUTOMATED_RESEARCH_ITEM_STATUSES,
  RESEARCH_LIMITS,
};
