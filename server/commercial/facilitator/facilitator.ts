/**
 * ============================================================================
 * BLOCO N11 — DISCOVERY FACILITATOR
 * FASE 2 — RUNTIME (coordenação pura)
 * ----------------------------------------------------------------------------
 * DATA: 18/08/2026
 *
 * O DiscoveryFacilitator coordena a execução de um lote (DiscoveryBatch) de
 * descobertas por URL. Ele é uma camada de COORDENAÇÃO EM MEMÓRIA:
 *
 *   - NÃO faz fetch HTTP, NÃO valida SSRF, NÃO resolve URLs;
 *   - NÃO extrai identidade (autoridade N10 — injetada via executor);
 *   - NÃO cria candidates, NÃO calcula listing_key (autoridade N1);
 *   - NÃO acessa secrets/APIs de afiliados, NÃO agenda jobs,
 *     NÃO persiste batches.
 *
 * O executor (DiscoveryExecutor) é injetado — o Facilitator não importa
 * discoverFromSource.
 *
 * GOVERNANÇA (inalterável):
 *   FAIL-CLOSED PERMANECE FAIL-CLOSED — retry é PROIBIDO para erros
 *   determinísticos/segurança (SSRF, domain_not_allowed, url_recusada,
 *   marketplace inválido, connector_ausente, fail-closed N10/N2).
 *
 *   UNKNOWN PERMANECE UNKNOWN — o Facilitator nunca converte identidade
 *   UNKNOWN em CONFIRMED e nunca promove.
 * ============================================================================
 */

import type {
  ConnectorErrorResult,
  ConnectorResult,
  ExternalIdentity,
} from "../sourceConnector/contracts";
import {
  FACILITATOR_FAILURE_REASONS as FR,
  FACILITATOR_LIMITS as LIMITS,
  type DiscoveryBatch,
  type DiscoveryBatchMetrics,
  type DiscoveryBatchResult,
  type DiscoveryBatchStatus,
  type DiscoveryCoordination,
  type DiscoveryExecutor,
  type DiscoveryItem,
  type DiscoveryItemContext,
  type DiscoveryItemResult,
  type DiscoveryItemStatus,
  type DiscoveryRequest,
} from "./contracts";

/**
 * MAX_CONCURRENCY_LIMIT — teto conservador de configuração por request.
 * Impede configuração ilimitada (autoridade do N2: circuit breaker).
 * NOTA DE CONTRATO: adicionado ao runtime na Fase 2; o limite por request
 * é clampado em [1, MAX_CONCURRENCY_LIMIT].
 */
export const MAX_CONCURRENCY_LIMIT = 8;

/**
 * Fila de concorrência simples (sem dependência externa).
 * Garante inflight <= limit em todos os momentos, respeita cancelamento
 * (AbortSignal) antes de iniciar novo trabalho e preserva o resultado por
 * posição de entrada.
 */
export class ConcurrentQueue<T> {
  private inflight = 0;
  private pending: Array<() => void> = [];
  private cancelled = false;
  private abortReason = "lote_cancelado";

  constructor(
    private readonly limit: number,
    private readonly signal: AbortSignal,
  ) {
    this.signal.addEventListener(
      "abort",
      () => {
        this.cancelled = true;
        // Libera todos os aguardando com sinal de cancelamento.
        const waiters = this.pending.splice(0);
        for (const w of waiters) w();
      },
      { once: true },
    );
  }

  /** Número máximo simultâneo registrado (para métricas/testes). */
  peakInflight = 0;

  async enqueue<R>(task: (index: number) => Promise<R>): Promise<R> {
    if (this.signal.aborted || this.cancelled) {
      throw new FacilitatorCancelledError(this.abortReason);
    }
    // Espera vaga na fila (respeitando o limite de concorrência).
    if (this.inflight >= this.limit) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
      if (this.signal.aborted || this.cancelled) {
        throw new FacilitatorCancelledError(this.abortReason);
      }
    }
    this.inflight += 1;
    this.peakInflight = Math.max(this.peakInflight, this.inflight);
    try {
      return await task(this.peakInflight);
    } finally {
      this.inflight -= 1;
      const next = this.pending.shift();
      if (next) next();
    }
  }
}

/**
 * Erro interno de cancelamento (não polui resultados públicos).
 */
export class FacilitatorCancelledError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * Valida a configuração de coordenação contra os limites aprovados.
 * Retorna a configuração normalizada ou o motivo de rejeição.
 */
export function normalizeCoordination(
  coordination?: DiscoveryCoordination,
): { ok: true; config: Required<DiscoveryCoordination> } | {
  ok: false;
  reason: string;
} {
  const defaults: Required<DiscoveryCoordination> = {
    concurrency_limit: LIMITS.DEFAULT_CONCURRENCY_LIMIT,
    item_timeout_ms: LIMITS.DEFAULT_ITEM_TIMEOUT_MS,
    max_retries: 0,
    retry_backoff_ms: LIMITS.DEFAULT_RETRY_BACKOFF_MS,
  };
  if (!coordination) return { ok: true, config: defaults };

  const concurrency = coordination.concurrency_limit ?? defaults.concurrency_limit;
  const timeout = coordination.item_timeout_ms ?? defaults.item_timeout_ms;
  const retries = coordination.max_retries ?? defaults.max_retries;
  const backoff = coordination.retry_backoff_ms ?? defaults.retry_backoff_ms;

  if (!Number.isFinite(concurrency) || concurrency < 1) {
    return { ok: false, reason: "concurrency_invalida" };
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { ok: false, reason: "timeout_invalido" };
  }
  if (!Number.isFinite(retries) || retries < 0 || retries > LIMITS.MAX_COORDINATION_RETRIES) {
    return { ok: false, reason: "retries_invalidos" };
  }
  if (!Number.isFinite(backoff) || backoff < 0) {
    return { ok: false, reason: "backoff_invalido" };
  }

  return {
    ok: true,
    config: {
      concurrency_limit: Math.min(concurrency, MAX_CONCURRENCY_LIMIT),
      item_timeout_ms: timeout,
      max_retries: retries,
      retry_backoff_ms: backoff,
    },
  };
}

/**
 * batchId — mecanismo de correlation já adotado no projeto: randomUUID
 * (equivalente a UUID v4, sem dependência externa).
 */
function generateBatchId(): string {
  // Fallback seguro para runtimes sem crypto.randomUUID.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `facilitator-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Razões de falha do executor N10 que são TRANSIENTES e admitem retentativa
 * de coordenação. Lista fechada derivada da semântica real de
 * ConnectorErrorResult.failure_reason — NUNCA especulativa.
 */
const TRANSIENT_FAILURE_REASONS = new Set<string>([
  "collection_failed",
  "network_error",
  "network_timeout",
  "timeout",
]);

/**
 * Razões determinísticas/fail-closed que NUNCA admitem retry.
 * Lista fechada: segurança + contratos N8/N10/N2.
 */
const PERMANENT_FAILURE_REASONS = new Set<string>([
  "domain_not_allowed",
  "url_recusada",
  "url_invalida",
  "marketplace_invalido",
  "connector_ausente",
  "source_url_invalida",
  "entrada inválida",
  "auth_required",
  "AUTH_REQUIRED",
  "signature_failed",
  "invalid_signature",
]);

/**
 * isRetryable — classificação governada do motivo de falha do executor.
 * Um item só pode ser retentado se o motivo for TRANSIENT e o executor
 * tiver retornado ConnectorErrorResult (ok=false).
 */
export function isRetryableFailureReason(failure_reason: string | null): boolean {
  if (failure_reason === null) return false;
  if (PERMANENT_FAILURE_REASONS.has(failure_reason)) return false;
  return TRANSIENT_FAILURE_REASONS.has(failure_reason);
}

/**
 * classifyItemStatus — mapeia o resultado do executor para o status final
 * do item, SEM inventar estados e SEM converter UNKNOWN em confirmado.
 *
 * O Facilitator não gera candidate_id: quem cria o candidate é o N1
 * (autoridade) através do executor. O Facilitator só propaga.
 */
export function classifyItemStatus(
  result: ConnectorResult | ConnectorErrorResult | null,
  timedOut: boolean,
): DiscoveryItemStatus {
  if (timedOut) return "timed_out";
  if (!result) return "failed";
  const isOk = result.ok === true;
  const reason = result.failure_reason;
  if (isOk) {
    const dr = result.discover_result;
    const created = dr && dr.ok ? dr.created ?? 0 : 0;
    const duplicates = dr && dr.ok ? dr.duplicates ?? 0 : 0;
    const conflicts = dr && dr.ok ? dr.conflicts ?? 0 : 0;
    if (conflicts > 0) return "conflict";
    if (duplicates > 0) return "duplicate";
    if (created > 0) return "created";
    // Delegação concluiu sem registro: a identidade decide o estado.
    if (result.external_identity.status === "UNKNOWN") {
      return "unknown_identity";
    }
    return "failed";
  }
  // ConnectorErrorResult (ok=false): a coleta falhou — o item é "failed".
  // A external_identity (incluindo UNKNOWN + rationale) continua propagada
  // no DiscoveryItemResult para observabilidade/auditoria, mas o ESTADO do
  // item não é "unknown_identity" (estado reservado a desfechos OK sem
  // registro com identidade não confirmada).
  if (reason === "domain_not_allowed" || reason === "url_recusada") {
    return "failed"; // falha fechada de segurança — nunca retry
  }
  return "failed";
}

/**
 * sleep cancelável por AbortSignal (usado no backoff).
 */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new FacilitatorCancelledError("batch_cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new FacilitatorCancelledError("batch_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * executeItemWithTimeout — executa um item com timeout próprio de
 * coordenação (AbortController combinado com o signal do request).
 * Ao expirar: aborta a execução e retorna timed_out com duration registrada.
 */
async function executeItemWithTimeout(
  executor: DiscoveryExecutor,
  item: DiscoveryItem,
  context: DiscoveryItemContext,
): Promise<{ result: ConnectorResult | ConnectorErrorResult | null; timedOut: boolean; aborted: boolean; duration_ms: number }> {
  const started = Date.now();
  let timedOut = false;
  try {
    const result = await new Promise<ConnectorResult | ConnectorErrorResult>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new FacilitatorTimeoutError());
        }, context.timeout_ms);
        executor(item, context).then(
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
    return { result, timedOut, aborted: false, duration_ms: Date.now() - started };
  } catch (err) {
    if (err instanceof FacilitatorTimeoutError) return { result: null, timedOut: true, aborted: false, duration_ms: Date.now() - started };
    if (err instanceof FacilitatorCancelledError) throw err;
    // Execução interrompida pelo cancelamento do lote (o executor recebeu
    // o signal abortado e abortou a operação): preservar o resultado
    // governado da interrupção sem transformar em falha comum.
    if (context.signal.aborted) return { result: null, timedOut: false, aborted: true, duration_ms: Date.now() - started };
    // Erro inesperado do executor (lançado, não retornado como resultado):
    return {
      result: {
        ok: false,
        marketplace: null,
        source_url: item.source_url,
        external_identity: {
          status: "UNKNOWN",
          marketplace: null,
          type: "UNKNOWN",
          rationale: "executor_lancou_erro",
        } as unknown as ExternalIdentity,
        discover_result: null,
        candidate_id: null,
        collection_failed: false,
        failure_reason: "executor_erro",
        error: err instanceof Error ? err.message : "executor_erro",
      } as ConnectorErrorResult,
      timedOut: false,
      aborted: false,
      duration_ms: Date.now() - started,
    };
  }
}

/**
 * Erro interno de timeout (não polui resultados públicos).
 */
export class FacilitatorTimeoutError extends Error {
  constructor() {
    super("item_timed_out");
  }
}

/**
 * runItem — executa um item do lote com retry governado.
 *
 * Regras:
 *   - retry APENAS para motivos transientes (isRetryableFailureReason);
 *   - máximo max_retries retentativas (0 = nenhuma);
 *   - backoff >= retry_backoff_ms entre tentativas, cancelável;
 *   - signal.aborted interrompe imediatamente o retry loop.
 */
async function runItem(
  executor: DiscoveryExecutor,
  item: DiscoveryItem,
  config: Required<DiscoveryCoordination>,
  base: { batch_id: string; proof_run_id: string | null; signal: AbortSignal },
): Promise<DiscoveryItemResult> {
  const maxAttempts = 1 + Math.min(config.max_retries, LIMITS.MAX_COORDINATION_RETRIES);
  let attempts = 0;
  let status: DiscoveryItemStatus = "failed";
  let result: ConnectorResult | ConnectorErrorResult | null = null;
  let timedOut = false;
  let duration_ms: number | null = null;
  let failure_reason: string | null = FR.DELEGATION_FAILED;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    if (base.signal.aborted) {
      // Cancelamento interrompe imediatamente — sem nova tentativa.
      return buildItemResult(item, base, attempt, 0, "cancelled", null, null, FR.ITEM_CANCELLED);
    }
    const context: DiscoveryItemContext = {
      batch_id: base.batch_id,
      proof_run_id: base.proof_run_id,
      attempt,
      signal: base.signal,
      timeout_ms: config.item_timeout_ms,
    };
    try {
      const exec = await executeItemWithTimeout(executor, item, context);
      timedOut = exec.timedOut;
      result = exec.result;
      duration_ms = exec.duration_ms;
      if (exec.aborted) {
        // Execução interrompida pelo cancelamento do lote: estado governado
        // da interrupção, sem retry e sem falha comum.
        return {
          index: taggedIndex(item),
          item: { marketplace: item.marketplace, source_url: item.source_url },
          status: "cancelled",
          candidate_id: null,
          external_identity: null,
          attempts,
          duration_ms,
          failure_reason: FR.ITEM_CANCELLED,
          batch_id: base.batch_id,
          proof_run_id: base.proof_run_id,
        };
      }
      status = classifyItemStatus(result, timedOut);
      if (timedOut) {
        failure_reason = FR.ITEM_TIMED_OUT;
      } else if (result && !result.ok) {
        failure_reason = result.failure_reason ?? FR.DELEGATION_FAILED;
      } else if (status === "failed") {
        failure_reason = FR.DELEGATION_FAILED;
      } else {
        failure_reason = null;
      }
    } catch (err) {
      if (err instanceof FacilitatorCancelledError) {
        return buildItemResult(item, base, attempt, duration_ms, "cancelled", null, null, FR.ITEM_CANCELLED);
      }
      // Queda de energia do executor fora do contrato: falha governada.
      result = null;
      status = "failed";
      failure_reason = err instanceof Error ? err.message : "executor_erro";
      duration_ms = duration_ms ?? 0;
    }

    // Retry somente para transientes; fail-closed é permanente por contrato.
    // Timeout de coordenação NÃO é retentável (o guard de rede do N2 já
    // agiu; repetir gastaria carga contra o mesmo destino).
    const hasRetryLeft = attempt + 1 < maxAttempts;
    if (hasRetryLeft && status === "failed" && !timedOut && isRetryableFailureReason(failure_reason)) {
      try {
        await cancellableSleep(config.retry_backoff_ms, base.signal);
        continue;
      } catch (err) {
        if (err instanceof FacilitatorCancelledError) {
          return buildItemResult(
            item,
            base,
            attempt,
            duration_ms,
            "cancelled",
            result,
            null,
            FR.ITEM_CANCELLED,
          );
        }
        throw err;
      }
    }
    break;
  }

  const retried = attempts - 1;
  if (retried > 0 && status === "failed" && failure_reason !== FR.ITEM_CANCELLED) {
    // Retentativas esgotadas para falha transitente persistente.
    status = "failed";
    failure_reason = FR.RETRIES_EXHAUSTED;
  }

  const eid = result ? result.external_identity : null;
  return {
    index: taggedIndex(item),
    item: { marketplace: item.marketplace, source_url: item.source_url },
    status,
    candidate_id: result ? result.candidate_id : null,
    external_identity: eid,
    attempts,
    duration_ms,
    failure_reason,
    batch_id: base.batch_id,
    proof_run_id: base.proof_run_id,
  };
}

/**
 * taggedIndex — acesso seguro ao índice interno do item (auxiliar).
 */
function taggedIndex(item: DiscoveryItem): number {
  return (item as DiscoveryItem & { __index: number }).__index;
}

/**
 * buildItemResult — item result com tentativa esgotada pelo cancelamento
 * antes de qualquer execução (auxiliar interno).
 */
function buildItemResult(
  item: DiscoveryItem,
  base: { batch_id: string; proof_run_id: string | null },
  _attempt: number,
  duration_ms: number | null,
  status: DiscoveryItemStatus,
  _result: ConnectorResult | ConnectorErrorResult | null,
  _eid: ExternalIdentity | null,
  failure_reason: string,
): DiscoveryItemResult {
  return {
    index: (item as DiscoveryItem & { __index: number }).__index,
    item: { marketplace: item.marketplace, source_url: item.source_url },
    status,
    candidate_id: null,
    external_identity: null,
    attempts: 0,
    duration_ms,
    failure_reason,
    batch_id: base.batch_id,
    proof_run_id: base.proof_run_id,
  };
}

/**
 * computeMetrics — métricas derivadas 100% dos estados finais dos items.
 * Não há contadores incrementados durante a execução (invariante N11-28):
 * as métricas são sempre a projeção dos resultados, nunca um registro
 * paralelo que possa divergir.
 */
export function computeMetrics(
  items: ReadonlyArray<DiscoveryItemResult>,
  received: number,
): DiscoveryBatchMetrics {
  let processed = 0;
  let created = 0;
  let duplicates = 0;
  let conflicts = 0;
  let unknownIdentity = 0;
  let failed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let retried = 0;
  for (const it of items) {
    processed += 1;
    if (it.status === "created") created += 1;
    else if (it.status === "duplicate") duplicates += 1;
    else if (it.status === "conflict") conflicts += 1;
    else if (it.status === "unknown_identity") unknownIdentity += 1;
    else if (it.status === "timed_out") timedOut += 1;
    else if (it.status === "cancelled") cancelled += 1;
    else failed += 1;
    if (it.attempts > 1) retried += 1;
  }
  return {
    received,
    processed,
    created,
    duplicates,
    conflicts,
    unknown_identity: unknownIdentity,
    failed,
    timed_out: timedOut,
    cancelled,
    retried,
  } as DiscoveryBatchMetrics;
}

/**
 * determineBatchStatus — status agregado do lote a partir dos estados finais.
 *
 *   success   → todos os items terminaram em estado não-falho
 *               (created/duplicate/conflict/unknown_identity)
 *   partial   → ao menos um failed/timed_out e ao menos um desfecho útil
 *   failed    → nenhum desfecho útil produzido
 *   cancelled → lote cancelado (signal antes/durante) e 0 processados
 */
export function determineBatchStatus(
  items: ReadonlyArray<DiscoveryItemResult>,
  wasCancelled: boolean,
): DiscoveryBatchStatus {
  const outcomes = items.map((it) => it.status);
  const nonFailure = outcomes.every((s) =>
    s === "created" || s === "duplicate" || s === "conflict" || s === "unknown_identity",
  );
  if (nonFailure) return "success";
  if (wasCancelled && items.length === 0) return "cancelled";
  const hadAnyDefinitive = outcomes.some((s) =>
    s === "created" || s === "duplicate" || s === "conflict" || s === "unknown_identity",
  );
  if (hadAnyDefinitive) return "partial";
  if (wasCancelled) return "cancelled";
  return "failed";
}

/**
 * DiscoveryFacilitator — coordenador de batches de discovery.
 *
 * Injeção: o executor é recebido no construtor (ou no executeBatch via
 * parâmetro). Sem injeção padrão — o Facilitator nunca conhece o
 * discoverFromSource (autoridade N10) diretamente.
 */
export class DiscoveryFacilitator {
  constructor(private readonly executor: DiscoveryExecutor) {}

  async executeBatch(request: DiscoveryRequest): Promise<DiscoveryBatchResult> {
    const batchId = generateBatchId();
    const startedAt = new Date().toISOString();
    const proofRunId = request.batch.proof_run_id ?? null;

    // 1) Validação do batch.
    const items = request.batch.items;
    if (!items || items.length === 0) {
      return {
        batch_id: batchId,
        status: "failed",
        proof_run_id: proofRunId,
        items: [],
        metrics: computeMetrics([], 0),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: 0,
      };
    }
    if (items.length > LIMITS.MAX_BATCH_ITEMS) {
      // Nenhum item é executado; métricas refletem não processamento.
      return {
        batch_id: batchId,
        status: "failed",
        proof_run_id: proofRunId,
        items: items.map((_, i) => ({
          index: i,
          item: items[i],
          status: "failed" as DiscoveryItemStatus,
          candidate_id: null,
          external_identity: null,
          attempts: 0,
          duration_ms: null,
          failure_reason: FR.BATCH_EXCEEDED,
          batch_id: batchId,
          proof_run_id: proofRunId,
        })),
        metrics: {
          received: items.length,
          processed: 0,
          created: 0,
          duplicates: 0,
          conflicts: 0,
          unknown_identity: 0,
          failed: 0,
          timed_out: 0,
          cancelled: 0,
          retried: 0,
        },
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: 0,
      };
    }

    // 2) Normalização da coordenação (rejeição de valores inválidos).
    const norm = normalizeCoordination(request.coordination);
    if (!norm.ok) {
      return {
        batch_id: batchId,
        status: "failed",
        proof_run_id: proofRunId,
        items: items.map((_, i) => ({
          index: i,
          item: items[i],
          status: "failed" as DiscoveryItemStatus,
          candidate_id: null,
          external_identity: null,
          attempts: 0,
          duration_ms: null,
          failure_reason: (norm as { ok: false; reason: string }).reason,
          batch_id: batchId,
          proof_run_id: proofRunId,
        })),
        metrics: computeMetrics([], items.length),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: 0,
      };
    }
    const config = norm.config;
    const signal = request.signal ?? new AbortController().signal;

    // 3) Deduplicação intra-batch por URL normalizada.
    const seenUrls = new Map<string, DiscoveryItem>();
    const tagged: Array<DiscoveryItem & { __index: number }> = items.map((it, i) => ({
      ...it,
      __index: i,
    })) as Array<DiscoveryItem & { __index: number }>;

    const results: DiscoveryItemResult[] = new Array(items.length);

    // 4) Fila de concorrência com limite rigoroso + cancelamento.
    const queue = new ConcurrentQueue<number>(config.concurrency_limit, signal);

    // 5) Execução respeitando ordem de entrada (results[i] por índice).
    const executions: Array<Promise<DiscoveryItemResult | null>> = tagged.map((it, i) => {
      // Duplicata intra-batch: 1ª ocorrência executa, demais → duplicate.
      const key = normalizeIntraBatchKey(it.source_url);
      const first = seenUrls.get(key);
      if (first && first !== it) {
        results[i] = {
          index: i,
          item: { marketplace: it.marketplace, source_url: it.source_url },
          status: "duplicate",
          candidate_id: null,
          external_identity: null,
          attempts: 0,
          duration_ms: null,
          failure_reason: FR.INTRA_BATCH_DUPLICATE,
          batch_id: batchId,
          proof_run_id: proofRunId,
        };
        return Promise.resolve(null);
      }
      if (!seenUrls.has(key)) seenUrls.set(key, it);

      return queue
        .enqueue(async () => runItem(this.executor, it, config, {
          batch_id: batchId,
          proof_run_id: proofRunId,
          signal,
        }))
        .then((r) => {
          results[i] = r;
          return r;
        })
        .catch((err) => {
          if (err instanceof FacilitatorCancelledError) {
            results[i] = {
              index: i,
              item: { marketplace: it.marketplace, source_url: it.source_url },
              status: "cancelled",
              candidate_id: null,
              external_identity: null,
              attempts: 0,
              duration_ms: null,
              failure_reason: FR.ITEM_CANCELLED,
              batch_id: batchId,
              proof_run_id: proofRunId,
            };
            return null;
          }
          results[i] = {
            index: i,
            item: { marketplace: it.marketplace, source_url: it.source_url },
            status: "failed",
            candidate_id: null,
            external_identity: null,
            attempts: 0,
            duration_ms: null,
            failure_reason: err instanceof Error ? err.message : "executor_erro",
            batch_id: batchId,
            proof_run_id: proofRunId,
          };
          return null;
        });
    });

    await Promise.all(executions);

    const wasCancelled = signal.aborted;
    const metrics = computeMetrics(results, items.length);
    const finishedAt = new Date().toISOString();

    return {
      batch_id: batchId,
      status: determineBatchStatus(results, wasCancelled),
      proof_run_id: proofRunId,
      items: results,
      metrics,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    };
  }
}

/**
 * Normalização mínima para deduplicação intra-batch.
 * Usa apenas a URL (lowercase + trim) — NÃO consulta listing_key do N1
 * (autoridade canônica) e NÃO toca identidade.
 */
export function normalizeIntraBatchKey(source_url: string): string {
  try {
    const u = new URL(source_url.trim().toLowerCase());
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  } catch {
    return source_url.trim().toLowerCase();
  }
}
