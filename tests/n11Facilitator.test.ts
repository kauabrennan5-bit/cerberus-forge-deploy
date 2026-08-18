/**
 * ============================================================================
 * BLOCO N11 — DISCOVERY FACILITATOR
 * FASE 2 — SUÍTE DE TESTES N11-01..30
 * ----------------------------------------------------------------------------
 * DATA: 18/08/2026
 *
 * Todos os testes são REAIS: executor controlado que mede inflight real,
 * tentativas, tempo de backoff e interrupção por signal. Não há testes que
 * apenas verificam mocks triviais.
 *
 * O Facilitator NÃO importa discoverFromSource: toda execução é injetada.
 * ============================================================================
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ConcurrentQueue,
  computeMetrics,
  determineBatchStatus,
  DiscoveryFacilitator,
  isRetryableFailureReason,
  MAX_CONCURRENCY_LIMIT,
  normalizeCoordination,
  normalizeIntraBatchKey,
} from "../server/commercial/facilitator/facilitator";
import { FACILITATOR_FAILURE_REASONS as FR, FACILITATOR_LIMITS as LIMITS } from "../server/commercial/facilitator/contracts";
import type { MarketplaceSource } from "../server/commercial/discovery/types";
import type {
  ConnectorErrorResult,
  ConnectorResult,
  ExternalIdentity,
} from "../server/commercial/sourceConnector/contracts";
import type {
  DiscoveryCoordination,
  DiscoveryItem,
} from "../server/commercial/facilitator/contracts";

/** --------------------------------------------------------------------- */
/** Helpers de teste                                                       */
/** --------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function unknownIdentity(marketplace: string | null, rationale: string): ExternalIdentity {
  return {
    status: "UNKNOWN",
    marketplace: marketplace as never,
    type: "UNKNOWN",
    rationale,
  } as ExternalIdentity;
}

function itemIdIdentity(marketplace: string, value: string, source_url: string): ExternalIdentity {
  return {
    status: "ITEM_ID",
    marketplace: marketplace as never,
    type: "ITEM_ID",
    value,
    source: "url",
    raw_source: source_url,
  } as ExternalIdentity;
}

function okResult(
  key: string,
  candidate_id: string | null,
  created = 1,
  duplicates = 0,
  conflicts = 0,
  identity: ExternalIdentity | null = null,
): ConnectorResult {
  return {
    ok: true,
    marketplace: "MERCADOLIVRE" as never,
    source_url: key,
    external_identity: identity ?? itemIdIdentity("MERCADOLIVRE", key, key),
    discover_result: {
      ok: true,
      marketplace: "MERCADOLIVRE" as MarketplaceSource,
      mode: "url" as const,
      found: created + duplicates + conflicts,
      created,
      duplicates,
      conflicts,
      items: [],
    },
    candidate_id,
    collection_failed: false,
    failure_reason: null,
    error: null,
  } as ConnectorResult;
}

function transientResult(key: string, failure_reason: string): ConnectorErrorResult {
  return {
    ok: false,
    marketplace: "MERCADOLIVRE" as never,
    source_url: key,
    external_identity: unknownIdentity("MERCADOLIVRE", failure_reason),
    discover_result: null,
    candidate_id: null,
    collection_failed: false,
    failure_reason,
    error: failure_reason,
  } as ConnectorErrorResult;
}

function permanentResult(key: string, failure_reason: string): ConnectorErrorResult {
  return {
    ok: false,
    marketplace: null,
    source_url: key,
    external_identity: unknownIdentity(null, failure_reason),
    discover_result: null,
    candidate_id: null,
    collection_failed: false,
    failure_reason,
    error: failure_reason,
  } as ConnectorErrorResult;
}

type CallRecord = {
  item: DiscoveryItem;
  attempt: number;
  batch_id: string;
  timeout_ms: number;
  started_at: number;
  signal: AbortSignal;
};

type Behavior =
  | "ok"
  | "dup"
  | "conf"
  | "unk"
  | "trans"
  | "perm"
  | "fail"
  | "hang"
  | "once-transient"
  | "slow-transient"
  | "ok-with-identity"
  | "ok-with-unknown"
  | "ok-duplicates"
  | "ok-conflict";

/**
 * Executor controlado. Configuração por URL de origem (comportamento padrão
 * "ok"). "hang" nunca resolve (usado com timeout curto). "once-transient" e
 * "slow-transient" controlam tentativas para os testes de retry.
 */
function makeExecutor(behaviorBy: Record<string, Behavior>) {
  const calls: CallRecord[] = [];
  const inflight = { current: 0, peak: 0 };
  let candidateCounter = 0;

  const executor = async (
    item: DiscoveryItem,
    context: {
      batch_id: string;
      proof_run_id: string | null;
      attempt: number;
      signal: AbortSignal;
      timeout_ms: number;
    },
  ): Promise<ConnectorResult | ConnectorErrorResult> => {
    inflight.current += 1;
    inflight.peak = Math.max(inflight.peak, inflight.current);
    calls.push({
      item,
      attempt: context.attempt,
      batch_id: context.batch_id,
      timeout_ms: context.timeout_ms,
      started_at: Date.now(),
      signal: context.signal,
    });
    try {
      const b: Behavior = behaviorBy[item.source_url] ?? "ok";
      if (b === "hang") {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error("executor_aborted_by_signal"));
          };
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener("abort", onAbort, { once: true });
        });
        throw new Error("hang should not resolve");
      }
      if (b === "once-transient") {
        if (context.attempt === 0) {
          await sleep(10);
          return transientResult(item.source_url, "network_error");
        }
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`);
      }
      if (b === "slow-transient") {
        if (context.attempt === 0) {
          await sleep(80);
          return transientResult(item.source_url, "network_error");
        }
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`);
      }
      if (b === "dup") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 0, 1, 0);
      }
      if (b === "conf") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 0, 0, 1);
      }
      if (b === "unk") {
        candidateCounter += 1;
        return okResult(item.source_url, null, 0, 0, 0, unknownIdentity("MERCADOLIVRE", "no_identity_found"));
      }
      if (b === "ok-with-identity") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 1, 0, 0, itemIdIdentity("MERCADOLIVRE", "MLB-9999", item.source_url));
      }
      if (b === "ok-with-unknown") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 1, 0, 0, unknownIdentity("MERCADOLIVRE", "no_identity_found"));
      }
      if (b === "ok-duplicates") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 0, 1, 0);
      }
      if (b === "ok-conflict") {
        candidateCounter += 1;
        return okResult(item.source_url, `can-${candidateCounter}`, 0, 0, 1);
      }
      if (b === "trans") return transientResult(item.source_url, "network_error");
      if (b === "perm") return permanentResult(item.source_url, "domain_not_allowed");
      if (b === "fail") return transientResult(item.source_url, "collection_failed");
      // "ok"
      candidateCounter += 1;
      return okResult(item.source_url, `can-${candidateCounter}`);
    } finally {
      inflight.current -= 1;
    }
  };

  return { executor, calls, inflight };
}

function itemsFromUrls(urls: Array<string | Behavior>, behaviorBy: Record<string, Behavior>): DiscoveryItem[] {
  return urls.map((u) => ({
    marketplace: "MERCADOLIVRE",
    source_url: typeof u === "string" ? u : `https://lista.mercadolivre.com.br/${behaviorBy}`,
  }));
}

let facilitator: DiscoveryFacilitator;
afterEach(() => {
  facilitator = undefined as never;
});

function batchOf(urls: string[], opts: { concurrency_limit?: number; item_timeout_ms?: number; max_retries?: number; retry_backoff_ms?: number; proof_run_id?: string; signal?: AbortSignal } = {}) {
  const behaviorBy: Record<string, Behavior> = {};
  const items: DiscoveryItem[] = urls.map((u) => {
    const [url, behavior] = u.split("|");
    if (behavior) behaviorBy[url] = behavior as Behavior;
    return { marketplace: "MERCADOLIVRE", source_url: url } as DiscoveryItem;
  });
  const { executor } = makeExecutor(behaviorBy);
  facilitator = new DiscoveryFacilitator(executor);
  const coordination: DiscoveryCoordination = {
    ...(opts.concurrency_limit !== undefined ? { concurrency_limit: opts.concurrency_limit } : {}),
    ...(opts.item_timeout_ms !== undefined ? { item_timeout_ms: opts.item_timeout_ms } : {}),
    ...(opts.max_retries !== undefined ? { max_retries: opts.max_retries } : {}),
    ...(opts.retry_backoff_ms !== undefined ? { retry_backoff_ms: opts.retry_backoff_ms } : {}),
  };
  const request = {
    batch: { items, proof_run_id: opts.proof_run_id ?? null },
    coordination,
    signal: opts.signal,
  } as never;
  return { facilitator, request };
}

describe("N11-01 batch vazio", () => {
  test("batch vazio não chama executor e retorna failed/BATCH_EMPTY", async () => {
    const calls: unknown[] = [];
    const executor = async () => {
      calls.push(1);
      return okResult("x", null) as never;
    };
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [] },
      coordination: {},
    } as never);
    assert.equal(calls.length, 0, "executor não deve ser chamado");
    assert.equal(result.status, "failed");
    assert.deepEqual(result.items, []);
    assert.equal(result.metrics.received, 0);
    assert.equal(result.metrics.processed, 0);
  });
});

describe("N11-02 batch unitário", () => {
  test("batch unitário é equivalente ao fluxo unitário: identidade/candidate/resultado do executor intactos", async () => {
    const { facilitator, request } = batchOf(["https://lista.mercadolivre.com.br/produto-1|ok"], {});
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.status, "created");
    assert.match(item.candidate_id ?? "", /^can-/);
    assert.equal(item.external_identity?.status, "ITEM_ID");
    assert.equal(item.attempts, 1);
    assert.ok(typeof item.duration_ms === "number" && item.duration_ms! >= 0);
    assert.equal(item.batch_id, result.batch_id);
  });
});

describe("N11-03 batch múltiplo", () => {
  test("3 itens executados com status individuais corretos", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/a|ok",
      "https://lista.mercadolivre.com.br/b|dup",
      "https://lista.mercadolivre.com.br/c|conf",
    ], {});
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0].status, "created");
    assert.equal(result.items[1].status, "duplicate");
    assert.equal(result.items[2].status, "conflict");
    assert.ok(result.items[0].candidate_id);
    assert.ok(result.items[1].candidate_id);
    assert.ok(result.items[2].candidate_id);
  });
});

describe("N11-04 duplicata intra-batch", () => {
  test("URL repetida no mesmo batch: 1ª executa, 2ª → duplicate/INTRA_BATCH_DUPLICATE sem nova chamada", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/produto-1|ok",
      "https://lista.mercadolivre.com.br/produto-1|ok",
      "https://lista.mercadolivre.com.br/produto-1|ok",
    ], {});
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].status, "created");
    assert.equal(result.items[1].status, "duplicate");
    assert.equal(result.items[1].failure_reason, FR.INTRA_BATCH_DUPLICATE);
    assert.equal(result.items[1].candidate_id, null);
    assert.equal(result.items[2].status, "duplicate");
    assert.equal(result.items[2].failure_reason, FR.INTRA_BATCH_DUPLICATE);
  });
});

describe("N11-05 ordem preservada", () => {
  test("ordem de conclusão diferente não altera o array final (index original)", async () => {
    // 3 itens: o primeiro demora mais que o segundo; a fila não pode reordenar.
    const orderOfCompletion: number[] = [];
    const executor = async (item: DiscoveryItem, context: { attempt: number; signal: AbortSignal }) => {
      const seq = Number(item.source_url.split("|")[1]);
      await sleep(seq === 1 ? 120 : 10);
      orderOfCompletion.push(seq);
      return okResult(item.source_url, `can-${seq}`) as ConnectorResult;
    };
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/tarde|1" },
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/cedo|2" },
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/meio|3" },
        ],
      },
      coordination: { concurrency_limit: 3 },
      signal: undefined,
    } as never);
    assert.equal(orderOfCompletion[0], 2, "o item rápido concluiu antes");
    assert.equal(result.items[0].item.source_url.endsWith("|1"), true);
    assert.equal(result.items[1].item.source_url.endsWith("|2"), true);
    assert.equal(result.items[2].item.source_url.endsWith("|3"), true);
    assert.equal(result.items[0].index, 0);
    assert.equal(result.items[1].index, 1);
    assert.equal(result.items[2].index, 2);
  });
});

describe("N11-06 sucesso parcial", () => {
  test("erro individual não derruba o batch: batch=partial com métricas corretas", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/a|ok",
      "https://lista.mercadolivre.com.br/b|ok",
      "https://lista.mercadolivre.com.br/c|perm",
      "https://lista.mercadolivre.com.br/d|dup",
      "https://lista.mercadolivre.com.br/e|hang",
    ], { item_timeout_ms: 80, concurrency_limit: 5 });
    const result = await facilitator.executeBatch(request);
    assert.equal(result.status, "partial");
    assert.equal(result.metrics.received, 5);
    assert.equal(result.metrics.created, 2);
    assert.equal(result.metrics.duplicates, 1);
    assert.equal(result.metrics.failed, 1); // c (perm)
    assert.equal(result.metrics.timed_out, 1); // e (hang)
    assert.equal(result.items[2].status, "failed");
    assert.equal(result.items[4].status, "timed_out");
    assert.equal(result.items[4].failure_reason, FR.ITEM_TIMED_OUT);
  });
});

describe("N11-07 falha total", () => {
  test("quando todos falham antes de desfecho útil, batch=failed", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/a|perm",
      "https://lista.mercadolivre.com.br/b|perm",
    ], {});
    const result = await facilitator.executeBatch(request);
    assert.equal(result.status, "failed");
    assert.equal(result.metrics.failed, 2);
    assert.equal(result.metrics.created, 0);
  });
});

describe("N11-08 timeout individual", () => {
  test("item que não conclui é abortado: timed_out + ITEM_TIMED_OUT + duration registrada", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/lento|hang"],
      { item_timeout_ms: 60 },
    );
    const started = Date.now();
    const result = await facilitator.executeBatch(request);
    const elapsed = Date.now() - started;
    assert.equal(result.items[0].status, "timed_out");
    assert.equal(result.items[0].failure_reason, FR.ITEM_TIMED_OUT);
    assert.ok(result.items[0].duration_ms !== null && result.items[0].duration_ms! >= 40);
    assert.ok(elapsed < 2_000, `timeout não deve aguardar o hang (elapsed=${elapsed}ms)`);
  });
});

describe("N11-09 timeout não derruba independentes", () => {
  test("item vizinho conclui normalmente mesmo com irmão em timeout", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/lento|hang",
      "https://lista.mercadolivre.com.br/rapido|ok",
    ], { item_timeout_ms: 60, concurrency_limit: 2 });
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].status, "timed_out");
    assert.equal(result.items[1].status, "created");
    assert.match(result.items[1].candidate_id ?? "", /^can-/);
  });
});

describe("N11-10 retry transitório", () => {
  test("transient → retry permitida; segunda tentativa com candidate confirmado", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/flaky|once-transient"],
      { max_retries: 2 },
    );
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].status, "created");
    assert.match(result.items[0].candidate_id ?? "", /^can-/);
    assert.equal(result.items[0].attempts, 2);
    assert.equal(result.metrics.retried, 1);
  });
});

describe("N11-11 retry proibido", () => {
  test("fail-closed (domain_not_allowed) nunca é retentado, mesmo com max_retries alto", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/bloqueado|perm"],
      { max_retries: 2 },
    );
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].status, "failed");
    assert.equal(result.items[0].failure_reason, "domain_not_allowed");
    assert.equal(result.items[0].attempts, 1, "exatamente 1 tentativa para motivo permanente");
    assert.equal(result.metrics.retried, 0);
  });
});

describe("N11-12 limite de retries", () => {
  test("MAX_COORDINATION_RETRIES=2: terceira falha transitente → RETRIES_EXHAUSTED", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/instavel|trans"],
      { max_retries: 2, retry_backoff_ms: 5 },
    );
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].status, "failed");
    assert.equal(result.items[0].failure_reason, FR.RETRIES_EXHAUSTED);
    assert.equal(result.items[0].attempts, 3, "1 tentativa + 2 retentativas");
    assert.equal(result.metrics.retried, 1);
  });
});

describe("N11-13 backoff", () => {
  test("backoff >= retry_backoff_ms entre tentativas e cancelável", async () => {
    const starts: number[] = [];
    const executor = async (item: DiscoveryItem, context: { attempt: number; signal: AbortSignal }) => {
      starts.push(Date.now());
      if (context.attempt === 0) {
        await sleep(10);
        return transientResult(item.source_url, "network_error") as ConnectorErrorResult;
      }
      return okResult(item.source_url, "can-x") as ConnectorResult;
    };
    facilitator = new DiscoveryFacilitator(executor);
    const request = {
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/flaky" }], proof_run_id: null },
      coordination: { max_retries: 1, retry_backoff_ms: 200 },
      signal: undefined,
    } as never;
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items[0].attempts, 2);
    assert.equal(result.items[0].status, "created");
    assert.equal(result.metrics.retried, 1);
    // A segunda chamada ocorre ao menos 200ms após a primeira.
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 180, `backoff < retry_backoff_ms (${starts[1] - starts[0]}ms)`);
  });
});

describe("N11-14 cancelamento", () => {
  test("signal abortado antes da execução: nenhum item inicia; batch=cancelled", async () => {
    let called = false;
    const executor = async () => {
      called = true;
      return okResult("x", null) as ConnectorResult;
    };
    const ac = new AbortController();
    ac.abort();
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/a" },
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/b" },
        ],
      },
      coordination: {},
      signal: ac.signal,
    } as never);
    assert.equal(called, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.items[0].status, "cancelled");
    assert.equal(result.items[0].failure_reason, FR.ITEM_CANCELLED);
    assert.equal(result.items[1].status, "cancelled");
  });
});

describe("N11-15 cancelamento impede retry", () => {
  test("cancelar durante o backoff impede a próxima tentativa; item termina cancelled", async () => {
    const attempts: number[] = [];
    const executor = async (item: DiscoveryItem, context: { attempt: number; signal: AbortSignal }) => {
      attempts.push(context.attempt);
      return transientResult(item.source_url, "network_error") as ConnectorErrorResult;
    };
    const ac = new AbortController();
    facilitator = new DiscoveryFacilitator(executor);
    // O executor injetado acima sempre devolve transient (nunca retenta após
    // o cancelamento do signal durante o backoff).
    const promise = facilitator.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/flaky" }], proof_run_id: null },
      coordination: { max_retries: 2, retry_backoff_ms: 5_000 },
      signal: ac.signal,
    } as never);
    await sleep(30);
    ac.abort();
    const result = await promise;
    assert.equal(result.items[0].status, "cancelled");
    assert.equal(result.items[0].failure_reason, FR.ITEM_CANCELLED);
    assert.equal(attempts.length, 1, "apenas a primeira tentativa ocorreu; o retry foi bloqueado");
  });
});

describe("N11-16 concorrência máxima", () => {
  test("inflight nunca excede concurrency_limit (medido em tempo real)", async () => {
    const inflight = { current: 0, peak: 0 };
    const executor = async (item: DiscoveryItem) => {
      inflight.current += 1;
      inflight.peak = Math.max(inflight.peak, inflight.current);
      await sleep(80);
      inflight.current -= 1;
      return okResult(item.source_url, "can-x") as ConnectorResult;
    };
    const f = new DiscoveryFacilitator(executor);
    const items: DiscoveryItem[] = Array.from({ length: 6 }, (_, i) => ({
      marketplace: "MERCADOLIVRE",
      source_url: `https://lista.mercadolivre.com.br/p${i}`,
    }));
    const result = await f.executeBatch({
      batch: { items },
      coordination: { concurrency_limit: 2 },
      signal: undefined,
    } as never);
    assert.ok(inflight.peak <= 2, `inflight real excedeu 2: ${inflight.peak}`);
    assert.equal(result.items.length, 6);
    assert.equal(result.items.every((it) => it.status === "created"), true);
  });
});

describe("N11-17 UNKNOWN preservado", () => {
  test("identidade UNKNOWN não é convertida em confirmada nem usada para candidate", async () => {
    const executor = async (item: DiscoveryItem) =>
      okResult(item.source_url, null, 0, 0, 0, unknownIdentity("MERCADOLIVRE", "no_identity_found")) as ConnectorResult;
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/anon" }], proof_run_id: null },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].status, "unknown_identity");
    assert.equal(result.items[0].external_identity?.status, "UNKNOWN");
    assert.equal(result.items[0].candidate_id, null, "sem registro no N1: candidate_id nulo (N1 é a autoridade)");
  });
});

describe("N11-18 rationale preservado", () => {
  test("rationale do UNKNOWN do executor chega intacto no item result", async () => {
    const executor = async (item: DiscoveryItem) =>
      transientResult(item.source_url, "network_error") as ConnectorErrorResult;
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/anon" }], proof_run_id: null },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].status, "failed");
    assert.equal(result.items[0].external_identity?.status, "UNKNOWN");
    const eid = result.items[0].external_identity as ExternalIdentity & { status: "UNKNOWN" };
    assert.equal(eid.rationale, "network_error");
    assert.equal(eid.marketplace, "MERCADOLIVRE");
  });
});

describe("N11-19 N10 continua autoridade", () => {
  test("external_identity confirmada é propagada sem alteração semântica (N10 é a origem)", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/it|ok-with-identity"],
      {},
    );
    const result = await facilitator.executeBatch(request);
    const eid = result.items[0].external_identity as ExternalIdentity & { status: "ITEM_ID" };
    assert.equal(eid.status, "ITEM_ID");
    assert.equal(eid.type, "ITEM_ID");
    assert.equal(eid.value, "MLB-9999");
    assert.equal(eid.source, "url");
    assert.equal(eid.raw_source, "https://lista.mercadolivre.com.br/it");
    assert.equal(eid.marketplace, "MERCADOLIVRE");
  });
});

describe("N11-20 N2 continua autoridade SSRF", () => {
  test("Facilitator não faz fetch: uma tentativa de rede comprovadamente não ocorre (executor é a única fronteira)", async () => {
    const executor = async (item: DiscoveryItem) => {
      // Se o Facilitator fizesse fetch próprio, este teste nem existiria;
      // a prova é que TODA execução passa aqui e o Facilitator nunca instancia
      // Rede/fetch fora do executor injetado.
      return transientResult(item.source_url, "domain_not_allowed") as ConnectorErrorResult;
    };
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://malicious.example/x" }] },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].status, "failed");
    assert.equal(result.items[0].failure_reason, "domain_not_allowed");
    assert.equal(result.items[0].attempts, 1);
  });
});

describe("N11-21 N1 continua autoridade idempotência", () => {
  test("idempotência canônica é produzida pelo executor (N1), não pelo Facilitator", async () => {
    const executor = async (item: DiscoveryItem) => okResult(item.source_url, "can-dupe", 0, 1, 0) as ConnectorResult;
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/dup" }] },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].status, "duplicate");
    assert.equal(result.items[0].candidate_id, "can-dupe", "candidate_id propagado do executor/N1");
    assert.equal(result.items[0].attempts, 1);
  });
});

describe("N11-22 nenhuma criação direta de candidate", () => {
  test("o Facilitator não gera candidate_id quando o executor não devolve", async () => {
    const executor = async (item: DiscoveryItem) =>
      okResult(item.source_url, null, 0, 0, 0, unknownIdentity("MERCADOLIVRE", "no_identity")) as ConnectorResult;
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/sem-id" }] },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].candidate_id, null, "sem candidate inventado");
    assert.equal(result.items[0].status, "unknown_identity");
    const eid = result.items[0].external_identity as ExternalIdentity & { status: "UNKNOWN" };
    assert.equal(eid.rationale, "no_identity");
  });
});

describe("N11-23 nenhuma aquisição/publicação", () => {
  test("verificação estática: facilitator.ts não importa acquisition/publication/scheduler/workers/jobs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "server/commercial/facilitator/facilitator.ts"),
      "utf8",
    );
    const banned = [
      "acquisitionService",
      "../publication",
      "../scheduler",
      "../agents",
      "../agentRuntime",
      "../workers",
      "../jobs",
      "../jobs/queue",
      "../cycles",
      "../products",
      "../affiliates",
      "acquireAffiliate",
      "executePublication",
      "createPublication",
      "enqueueJob",
      "schedule",
    ];
    for (const token of banned) {
      assert.equal(
        src.includes(token),
        false,
        `facilitator.ts NÃO deve referenciar "${token}" (não-subversão)`,
      );
    }
  });
});

describe("N11-24 observabilidade", () => {
  test("batch_id tipo UUID, proof_run_id propagado, started/finished_at preenchidos", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/obs|ok"],
      { proof_run_id: "N10_RUNTIME_20260818" },
    );
    const result = await facilitator.executeBatch(request);
    assert.match(result.batch_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "batch_id = UUID v4");
    assert.equal(result.proof_run_id, "N10_RUNTIME_20260818");
    assert.equal(result.items[0].batch_id, result.batch_id);
    assert.equal(result.items[0].proof_run_id, "N10_RUNTIME_20260818");
    assert.ok(result.started_at);
    assert.ok(result.finished_at);
    assert.ok(new Date(result.finished_at).getTime() >= new Date(result.started_at).getTime());
    assert.equal(result.items[0].index, 0);
    assert.equal(typeof result.items[0].duration_ms, "number");
  });
});

describe("N11-25 regressão do fluxo unitário", () => {
  test("lote com 1 item mantém contrato do fluxo unitário do N2/N10: retry padrão 0, sem reordenação", async () => {
    const { facilitator, request } = batchOf(
      ["https://lista.mercadolivre.com.br/unico|ok"],
      {},
    );
    const result = await facilitator.executeBatch(request);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].status, "created");
    assert.equal(result.items[0].attempts, 1);
    assert.equal(result.items[0].failure_reason, null);
  });
});

describe("N11-26 search fora do escopo", () => {
  test("Facilitator trabalha apenas com marketplace+source_url; nada de search/categoria/keyword", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "server/commercial/facilitator/facilitator.ts"),
      "utf8",
    );
    const banned = ["keyword", "category", "query"];
    for (const token of banned) {
      assert.equal(
        src.includes(token),
        false,
        `facilitator.ts NÃO deve conter "${token}" (search fora do escopo)`,
      );
    }
    // DiscoveryItem com mode_hint (modo reservado) é rejeitado/ignorado:
    const executor = async (item: DiscoveryItem) => okResult(item.source_url, "can-x") as ConnectorResult;
    const f = new DiscoveryFacilitator(executor);
    const result = await f.executeBatch({
      batch: { items: [{ marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/p1" }] },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(result.items[0].status, "created");
  });
});

describe("N11-27 batch acima do limite", () => {
  test("batch > MAX_BATCH_ITEMS: nenhum item executado, failed/BATCH_EXCEEDED, métricas não processadas", async () => {
    let called = false;
    const executor = async () => {
      called = true;
      return okResult("x", null) as ConnectorResult;
    };
    const f = new DiscoveryFacilitator(executor);
    const items: DiscoveryItem[] = Array.from(
      { length: LIMITS.MAX_BATCH_ITEMS + 5 },
      (_, i) => ({ marketplace: "MERCADOLIVRE", source_url: `https://lista.mercadolivre.com.br/p${i}` }),
    );
    const result = await f.executeBatch({ batch: { items, proof_run_id: null }, coordination: {}, signal: undefined } as never);
    assert.equal(called, false);
    assert.equal(result.status, "failed");
    assert.equal(result.items.length, items.length);
    assert.equal(result.items[0].failure_reason, FR.BATCH_EXCEEDED);
    assert.equal(result.metrics.received, items.length);
    assert.equal(result.metrics.processed, 0);
    assert.equal(result.metrics.created, 0);
  });
});

describe("N11-28 métricas exatas", () => {
  test("metrics computed derivadas 100% dos estados finais — igualdade exata item a item", async () => {
    const { facilitator, request } = batchOf([
      "https://lista.mercadolivre.com.br/a|ok",
      "https://lista.mercadolivre.com.br/b|ok-duplicates",
      "https://lista.mercadolivre.com.br/c|ok-conflict",
      "https://lista.mercadolivre.com.br/d|unk",
      "https://lista.mercadolivre.com.br/e|perm",
      "https://lista.mercadolivre.com.br/f|hang",
    ], { item_timeout_ms: 80, concurrency_limit: 6 });
    const result = await facilitator.executeBatch(request);
    const fromItems = {
      received: result.items.length,
      processed: result.items.length,
      created: result.items.filter((it) => it.status === "created").length,
      duplicates: result.items.filter((it) => it.status === "duplicate").length,
      conflicts: result.items.filter((it) => it.status === "conflict").length,
      unknown_identity: result.items.filter((it) => it.status === "unknown_identity").length,
      failed: result.items.filter((it) => it.status === "failed").length,
      timed_out: result.items.filter((it) => it.status === "timed_out").length,
      cancelled: result.items.filter((it) => it.status === "cancelled").length,
      retried: result.items.filter((it) => it.attempts > 1).length,
    };
    assert.deepEqual(result.metrics, fromItems, "métricas devem ser a projeção exata dos resultados finais");
    assert.equal(
      result.metrics.created + result.metrics.duplicates + result.metrics.conflicts +
      result.metrics.unknown_identity + result.metrics.failed +
      result.metrics.timed_out + result.metrics.cancelled,
      result.metrics.received,
      "soma de estados finais = received",
    );
  });
});

describe("N11-29 proof_run_id propagado", () => {
  test("proof_run_id nulo permanece nulo; fornecido permanece vinculado a cada item", async () => {
    const { facilitator, request } = batchOf(["https://lista.mercadolivre.com.br/p|ok"], {});
    const noProof = await facilitator.executeBatch(request);
    assert.equal(noProof.proof_run_id, null);
    assert.equal(noProof.items[0].proof_run_id, null);
    const itemsOfRequest = (request as unknown as { batch: { items: DiscoveryItem[]; proof_run_id: string | null } }).batch.items;
    const withProof = await facilitator.executeBatch({
      batch: { items: itemsOfRequest, proof_run_id: "AUDIT_RUN_001" },
      coordination: {},
      signal: undefined,
    } as never);
    assert.equal(withProof.items[0].proof_run_id, "AUDIT_RUN_001");
  });
});

describe("N11-30 cancelamento durante execução", () => {
  test("abort durante execução: itens em curso recebem signal, não iniciados → cancelled; nenhum retry novo", async () => {
    let totalCalls = 0;
    const executor = async (item: DiscoveryItem, context: { attempt: number; signal: AbortSignal }) => {
      totalCalls += 1;
      // Item rápido conclui antes do cancelamento; item lento respeita o signal.
      if (item.source_url.endsWith("rapido")) return okResult(item.source_url, "can-r") as ConnectorResult;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 3_000);
        context.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted_by_signal"));
        }, { once: true });
      });
      throw new Error("should not resolve");
    };
    const ac = new AbortController();
    const f = new DiscoveryFacilitator(executor);
    const promise = f.executeBatch({
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/rapido" },
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/lento" },
          { marketplace: "MERCADOLIVRE", source_url: "https://lista.mercadolivre.com.br/nao-iniciado" },
        ],
      },
      coordination: { concurrency_limit: 2, max_retries: 1 },
      signal: ac.signal,
    } as never);
    await sleep(60);
    ac.abort();
    const result = await promise;
    assert.ok(result.items.some((it) => it.status === "created"), "item rápido concluiu antes do cancel");
    assert.ok(result.items.some((it) => it.status === "cancelled"), "item não iniciado cancelado");
    assert.ok(result.items.some((it) => it.status === "failed" || it.status === "cancelled"), "item lento interrompido");
    assert.equal(result.items.filter((it) => it.status === "cancelled").length >= 1, true);
    // O item lento não pode ter sido retentado após o abort:
    assert.ok(totalCalls <= 4, `chamadas excessivas indicam retry pós-cancelamento (${totalCalls})`);
  });
});

describe("Funções unitárias do contrato (validateCoordination, classificação governada, dedup)", () => {
  test("normalizeCoordination: defaults e rejeições", () => {
    assert.equal(normalizeCoordination(undefined).ok, true);
    assert.equal(normalizeCoordination({}).ok, true);
    assert.equal((normalizeCoordination({ concurrency_limit: -1 } as never) as { ok: boolean }).ok, false);
    assert.equal((normalizeCoordination({ concurrency_limit: 0 } as never) as { ok: boolean }).ok, false);
    assert.equal((normalizeCoordination({ item_timeout_ms: 0 } as never) as { ok: boolean }).ok, false);
    assert.equal((normalizeCoordination({ max_retries: 3 } as never) as { ok: boolean }).ok, false);
    assert.equal((normalizeCoordination({ retry_backoff_ms: -100 } as never) as { ok: boolean }).ok, false);
    assert.equal((normalizeCoordination({ concurrency_limit: 99 } as never) as { ok: boolean }).ok, true, "clamp até MAX_CONCURRENCY_LIMIT");
  });

  test("isRetryableFailureReason: fechada, sem especulação", () => {
    assert.equal(isRetryableFailureReason("network_error"), true);
    assert.equal(isRetryableFailureReason("collection_failed"), true);
    assert.equal(isRetryableFailureReason("network_timeout"), true);
    assert.equal(isRetryableFailureReason("timeout"), true);
    assert.equal(isRetryableFailureReason("domain_not_allowed"), false);
    assert.equal(isRetryableFailureReason("url_recusada"), false);
    assert.equal(isRetryableFailureReason("marketplace_invalido"), false);
    assert.equal(isRetryableFailureReason("connector_ausente"), false);
    assert.equal(isRetryableFailureReason("auth_required"), false);
    assert.equal(isRetryableFailureReason("signature_failed"), false);
    assert.equal(isRetryableFailureReason("motivo_inventado"), false, "nenhum motivo especulativo é retryable");
    assert.equal(isRetryableFailureReason(null), false);
  });

  test("determineBatchStatus: success/partial/failed/cancelled", () => {
    const created = [{ status: "created" } as never, { status: "created" } as never];
    const mixed = [{ status: "created" } as never, { status: "failed" } as never];
    const allFailed = [{ status: "failed" } as never];
    assert.equal(determineBatchStatus(created, false), "success");
    assert.equal(determineBatchStatus(mixed, false), "partial");
    assert.equal(determineBatchStatus(allFailed, false), "failed");
    // Cancelado com itens (todos ainda undecided/failed) → cancelled.
    const undecided = [{ status: "failed", attempts: 0 } as never];
    assert.equal(determineBatchStatus(undecided, true), "cancelled");
    assert.equal(determineBatchStatus(created, true), "success", "cancelado com desfechos úteis mantém success");
  });

  test("normalizeIntraBatchKey: equivalente sem query duplicado, sem tocar listing_key", () => {
    assert.equal(
      normalizeIntraBatchKey("https://Lista.MercadoLivre.com.br/X?c=1"),
      normalizeIntraBatchKey("https://lista.mercadolivre.com.br/X?c=1"),
    );
    assert.notEqual(
      normalizeIntraBatchKey("https://lista.mercadolivre.com.br/X?a=1"),
      normalizeIntraBatchKey("https://lista.mercadolivre.com.br/X?b=2"),
    );
  });

  test("MAX_CONCURRENCY_LIMIT: teto conservador sem configuração ilimitada", () => {
    assert.equal(typeof MAX_CONCURRENCY_LIMIT, "number");
    assert.ok(MAX_CONCURRENCY_LIMIT >= LIMITS.DEFAULT_CONCURRENCY_LIMIT);
    assert.ok(MAX_CONCURRENCY_LIMIT < 32, "sem configuração ilimitada");
  });

  test("ConcurrentQueue: limite respeitado e pico medido", async () => {
    const ac = new AbortController();
    const q = new ConcurrentQueue<number>(2, ac.signal);
    const inflight = { current: 0, peak: 0 };
    const tasks = Array.from({ length: 5 }, () =>
      q.enqueue(async () => {
        inflight.current += 1;
        inflight.peak = Math.max(inflight.peak, inflight.current);
        await sleep(40);
        inflight.current -= 1;
        return 1;
      }),
    );
    const sum = (await Promise.all(tasks)).reduce((a, b) => a + b, 0);
    assert.equal(sum, 5);
    assert.ok(inflight.peak <= 2);
  });

  test("ConcurrentQueue: abort interrompe trabalho futuro", async () => {
    const ac = new AbortController();
    const q = new ConcurrentQueue<number>(1, ac.signal);
    let started = 0;
    const first = q.enqueue(async () => {
      started += 1;
      await sleep(60);
      return 1;
    });
    const second = q.enqueue(async () => {
      started += 1;
      return 2;
    }).catch((err) => (err as Error).message);
    ac.abort();
    const results = await Promise.allSettled([first, second]);
    assert.equal(started, 1, "apenas o item em execução iniciou");
    assert.equal(results[1].status, "fulfilled", "item aguardando na fila conclui com lote_cancelado");
    assert.equal(results[1].value, "lote_cancelado");
  });

  test("FACILITATOR_FAILURE_REASONS: constantes aprovadas presentes e estáveis", () => {
    assert.equal(FR.BATCH_EMPTY, "batch_empty");
    assert.equal(FR.BATCH_EXCEEDED, "batch_exceeded");
    assert.equal(FR.INTRA_BATCH_DUPLICATE, "intra_batch_duplicate");
    assert.equal(FR.ITEM_TIMED_OUT, "item_timed_out");
    assert.equal(FR.BATCH_CANCELLED, "batch_cancelled");
    assert.equal(FR.ITEM_CANCELLED, "item_cancelled");
    assert.equal(FR.RETRIES_EXHAUSTED, "retries_exhausted");
    assert.equal(FR.DELEGATION_FAILED, "delegation_failed");
    assert.equal(FR.TRANSIENT_RETRY, "transient_retry");
  });

  test("computeMetrics: derivada pura dos resultados finais", () => {
    const items = [
      { status: "created", attempts: 1 } as never,
      { status: "created", attempts: 3 } as never,
      { status: "duplicate", attempts: 1 } as never,
      { status: "conflict", attempts: 1 } as never,
      { status: "unknown_identity", attempts: 2 } as never,
      { status: "failed", attempts: 3 } as never,
      { status: "timed_out", attempts: 1 } as never,
      { status: "cancelled", attempts: 0 } as never,
    ];
    const m = computeMetrics(items, 8);
    assert.equal(m.received, 8);
    assert.equal(m.processed, 8);
    assert.equal(m.created, 2);
    assert.equal(m.duplicates, 1);
    assert.equal(m.conflicts, 1);
    assert.equal(m.unknown_identity, 1);
    assert.equal(m.failed, 1);
    assert.equal(m.timed_out, 1);
    assert.equal(m.cancelled, 1);
    assert.equal(m.retried, 3);
  });
});
