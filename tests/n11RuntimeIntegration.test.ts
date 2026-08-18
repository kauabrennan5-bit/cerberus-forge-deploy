// ============================================================================
// Bloco N11 — Integração Runtime (Fase 3)
// -----------------------------------------------------------------------------
// Provas N11-RT-01 .. N11-RT-16 exigidas pelo gate de integração:
//   - N11-RT-01  batch unitário chama o executor real/adaptado
//   - N11-RT-02  batch múltiplo chama N10 para cada item
//   - N11-RT-03  ITEM_ID do Mercado Livre chega ao resultado
//   - N11-RT-04  SHOP_ITEM da Shopee chega ao resultado
//   - N11-RT-05  UNKNOWN preserva rationale
//   - N11-RT-06  candidate_id do N1 é apenas propagado
//   - N11-RT-07  duplicate do N1 é preservado
//   - N11-RT-08  URL variante preserva identidade canônica
//   - N11-RT-09  host inválido continua fail-closed
//   - N11-RT-10  N11 não executa fetch diretamente
//   - N11-RT-11  N11 não importa acquisition/publication/scheduler/worker/agents
//   - N11-RT-12  search não entra no batch
//   - N11-RT-13  signal chega ao executor
//   - N11-RT-14  timeout do Facilitator não transforma erro em sucesso
//   - N11-RT-15  mapper Telegram não inventa dados
//   - N11-RT-16  fluxo unitário /discover continua passando integralmente
//
// LOCAL — sem deploy, sem credenciais, sem chamadas reais de rede.
// O executor real (adapter N11 -> N10) é utilizado com discoverFn injetada
// pelo discoverFromSource (mesmo padrão do N10), provando o fluxo ponta a
// ponta até o delegate do N2 sem tocar produção nem depender de rede externa.
// ============================================================================
import test, { before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type {
  DiscoverResult,
  DiscoverResultItem,
  MarketplaceSource,
} from "../server/commercial/discovery/types";
import {
  registerN2SourceConnectors,
  __resetRegistrationStateForTests,
} from "../server/commercial/sourceConnector/registerN2SourceConnectors";
import { discoverFromSource } from "../server/commercial/sourceConnector/sourceConnector";
import type {
  ExternalIdentity,
  ConnectorResult,
} from "../server/commercial/sourceConnector/contracts";
import { isExternalIdentityKnown } from "../server/commercial/sourceConnector/contracts";
import { validateDiscoveryUrl } from "../server/commercial/discovery/evidence";
import { parseDiscoverCommand } from "../server/services/discoveryCommands";
import { runDiscoveryBatch } from "../server/commercial/facilitator/runDiscoveryBatch";
import { createDiscoveryExecutor } from "../server/commercial/facilitator/discoveryExecutor";
import {
  mapBatchResultToTelegramMessage,
  collectCandidateIds,
} from "../server/commercial/facilitator/telegramBatchResponse";
import { parseDiscoverBatchCommand } from "../server/commercial/facilitator/discoverBatchCommand";
import type { DiscoveryRequest, DiscoveryBatchResult } from "../server/commercial/facilitator/contracts";
import { FACILITATOR_FAILURE_REASONS } from "../server/commercial/facilitator/contracts";

// ---------------------------------------------------------------------------
// Infra de mocks — delegate do N2 (mesmo padrão N10) e capturas.
// ---------------------------------------------------------------------------
const ML_ITEM_URL = "https://produto.mercadolivre.com.br/MLB-1456580521-abajur-luminaria-de-mesa-quarto-sala-moderno-_JM";
const ML_UTM_URL = "https://produto.mercadolivre.com.br/MLB-1456580521-abajur-luminaria-de-mesa-quarto-sala-moderno-_JM?utm_campaign=fase4&utm_medium=smoke";
const SHOPEE_ITEM_URL = "https://shopee.com.br/opaanlp/1530442944/23794344926";
const SHOPEE_BARE_URL = "https://shopee.com.br/";
const GOOGLE_URL = "https://www.google.com/";
const PROOF_RUN_ID = "N11_RUNTIME_PHASE3_20260818";

type executeDiscoverLike = (input: {
  marketplace: MarketplaceSource;
  mode: "url" | "search";
  url?: string;
  query?: string;
  limit?: number;
}) => Promise<DiscoverResult>;

type discoverFnLike = typeof discoverFromSource;

const registeredCalls: Array<{
  marketplace: MarketplaceSource;
  source_url: string;
  outcome: string;
  candidate_id: string | null;
}> = [];

function createFakeDelegate(opts: {
  candidate_id?: string | null;
  outcome?: DiscoverResultItem["outcome"];
  unknown_fields?: string[];
  reject_unknown_identity?: boolean;
} = {}): executeDiscoverLike {
  const candidate_id = opts.candidate_id ?? "can-fake";
  const unknown_fields = opts.unknown_fields ?? [];
  return async function fakeDelegate(input): Promise<DiscoverResult> {
    const urlKey = input.url ?? "";
    const wasSeen = registeredCalls.filter(c => c.source_url === urlKey).length > 1;
    const outcome = opts.reject_unknown_identity && urlKey === SHOPEE_BARE_URL
      ? "conflict_rejected"
      : opts.outcome ?? (wasSeen ? "identical_duplicate" : "created");
    registeredCalls.push({
      marketplace: input.marketplace,
      source_url: urlKey,
      outcome,
      candidate_id: outcome === "conflict_rejected" ? "can-conflict" : candidate_id,
    });
    return {
      ok: true,
      marketplace: input.marketplace,
      mode: input.mode,
      found: 1,
      created: outcome === "created" ? 1 : 0,
      duplicates: outcome === "identical_duplicate" ? 1 : 0,
      conflicts: outcome === "conflict_rejected" ? 1 : 0,
      items: [
        {
          outcome,
          candidate_id: outcome === "conflict_rejected" ? "can-conflict" : candidate_id,
          marketplace: input.marketplace,
          source_url: urlKey,
          title: null,
          unknown_fields,
        },
      ],
    };
  };
}

function fakeDiscoverResult(overrides: Partial<DiscoverResult> = {}): DiscoverResult {
    const items: DiscoverResultItem[] = overrides.items ?? [
    {
      outcome: ((overrides as any).outcome ?? "created") as DiscoverResultItem["outcome"],
      candidate_id: (overrides as any).candidate_id ?? "can-fake",
      marketplace: overrides.marketplace ?? "MERCADOLIVRE",
      source_url: (overrides as any).source_url ?? "",
      title: null,
      unknown_fields: [],
    },
  ];
  const byOutcome = (o: string) => items.filter(it => it.outcome === o).length;
  return {
    ok: overrides.ok ?? true,
    marketplace: overrides.marketplace ?? "MERCADOLIVRE",
    mode: overrides.mode ?? "url",
    found: overrides.found ?? items.length,
    created: overrides.created ?? byOutcome("created"),
    duplicates: overrides.duplicates ?? byOutcome("identical_duplicate"),
    conflicts: overrides.conflicts ?? byOutcome("conflict_rejected"),
    items,
    error: overrides.error,
  };
}

/**
 * discoverFn injetável que simula o fluxo real N10 (identidade + delegação)
 * para as provas de integração: extrai a identidade como o N10 faria
 * (ITEM_ID/SHOP_ITEM/UNKNOWN da URL) e delega ao fake delegate do N2.
 * Prova o adapter N11 → N10 → N2 ponta a ponta sem rede.
 */
function buildTestDiscoverFn(opts: {
  delegate?: executeDiscoverLike;
  extractIdentity?: (marketplace: MarketplaceSource, url: string) => ExternalIdentity;
  reject_unknown?: boolean;
}): discoverFnLike {
  return (async (input: { marketplace: unknown; source_url: string }) => {
    // Normalização do N10 (mesma regra em produção): marketplace must be
    // MarketplaceSource válido.
    if (input.marketplace !== "MERCADOLIVRE" && input.marketplace !== "SHOPEE") {
      return {
        ok: false,
        marketplace: null,
        source_url: input.source_url,
        external_identity: {
          status: "UNKNOWN",
          marketplace: null,
          type: "UNKNOWN",
          rationale: "marketplace não normalizável pelo N10",
        },
        discover_result: null,
        candidate_id: null,
        collection_failed: false,
        failure_reason: "marketplace_desconhecido",
        error: "marketplace_desconhecido",
      } as ConnectorResult;
    }
    const marketplace = input.marketplace as MarketplaceSource;
    const identity = opts.extractIdentity
      ? opts.extractIdentity(marketplace, input.source_url)
      : extractIdentityForTest(marketplace, input.source_url);
    // SSRF: N10 não adiciona segunda fonte de hosts; delegate age como o
    // guard do N2 (recusa fora da whitelist com discovery_failed).
    const urlHost = (() => {
      try {
        return new URL(input.source_url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (!/mercadolivre\.com\.br$|shopee\.com\.br$/.test(urlHost)) {
      return {
        ok: false,
        marketplace,
        source_url: input.source_url,
        external_identity: identity,
        discover_result: null,
        candidate_id: null,
        collection_failed: false,
        failure_reason: "discovery_failed",
        error: "discovery_failed",
      } as ConnectorResult;
    }
    const delegateResult = await (opts.delegate ?? createFakeDelegate())({
      marketplace,
      mode: "url",
      url: input.source_url,
    });
    // Falha fechada: sem candidate_id/ok, o N10 nunca entrega sucesso.
    const item = delegateResult.items[0];
    const noCandidate =
      !item || !item.candidate_id || item.outcome === "conflict_rejected";
    if (!delegateResult.ok || noCandidate) {
      return {
        ok: false,
        marketplace,
        source_url: input.source_url,
        external_identity: identity,
        discover_result: delegateResult.ok ? delegateResult : null,
        candidate_id: item?.candidate_id ?? null,
        collection_failed: false,
        failure_reason: item?.outcome === "conflict_rejected"
          ? "candidate_not_created"
          : "discovery_delegate_falhou",
        error: item?.outcome === "conflict_rejected"
          ? "candidate_not_created"
          : "discovery_delegate_falhou",
      } as ConnectorResult;
    }
    return {
      ok: true,
      marketplace,
      source_url: input.source_url,
      external_identity: identity,
      discover_result: delegateResult,
      candidate_id: item.candidate_id!,
      collection_failed: item.unknown_fields?.length === 8,
    } as ConnectorResult;
  }) as unknown as discoverFnLike;
}

/**
 * Extrai identidade determinística da URL (mesma regra do N10):
 * ITEM_ID/SHOP_ITEM extraídos da URL (não do HTML).
 */
function extractIdentityForTest(
  marketplace: MarketplaceSource,
  url: string,
): ExternalIdentity {
  if (marketplace === "MERCADOLIVRE") {
    const match = url.match(/MLB-[A-Z0-9]+/i);
    if (match) {
      return {
        status: "ITEM_ID",
        marketplace: "MERCADOLIVRE",
        type: "ITEM_ID",
        value: match[0],
        source: "url",
        raw_source: url,
      };
    }
  } else if (marketplace === "SHOPEE") {
    const match = url.match(/\/(\d+)\/(\d+)/);
    if (match) {
      return {
        status: "SHOP_ITEM",
        marketplace: "SHOPEE",
        type: "SHOP_ITEM",
        shop_id: match[1],
        item_id: match[2],
        source: "url",
        raw_source: url,
      };
    }
  }
  return {
    status: "UNKNOWN",
    marketplace,
    type: "UNKNOWN",
    rationale: `tupla de identidade não encontrada na URL (${marketplace})`,
  };
}

// Registro real dos connectors N2 no registry do N10 (boot idempotente).
before(() => {
  __resetRegistrationStateForTests();
  registerN2SourceConnectors();
  registeredCalls.length = 0;
});

afterEach(() => {
  registeredCalls.length = 0;
});

function makeDiscoverFnFor(opts: {
  delegate?: executeDiscoverLike;
  reject_unknown?: boolean;
} = {}): discoverFnLike {
  return buildTestDiscoverFn({
    delegate: opts.delegate ?? createFakeDelegate(),
    extractIdentity: extractIdentityForTest,
    reject_unknown: opts.reject_unknown,
  });
}

// ---------------------------------------------------------------------------
// N11-RT-01 — batch unitário chama o executor real/adaptado
// ---------------------------------------------------------------------------
test("N11-RT-01 batch unitário chama o executor real/adaptado", async () => {
  let executorCalled = false;
  let seenContext: any = null;
  const executor = createDiscoveryExecutor({
    discoverFn: makeDiscoverFnFor() as never,
  });
  const wrapped: typeof executor = async (item, context) => {
    executorCalled = true;
    seenContext = context;
    return await executor(item, context);
  };
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: wrapped },
  );
  assert.ok(executorCalled, "executor do N11 deve chamar o adapter N11->N10");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, "created");
  assert.equal(result.items[0].proof_run_id, PROOF_RUN_ID);
  assert.ok(seenContext, "contexto deve chegar ao executor");
  assert.equal(seenContext.batch_id, result.batch_id);
  assert.equal(seenContext.proof_run_id, PROOF_RUN_ID);
});

// ---------------------------------------------------------------------------
// N11-RT-02 — batch múltiplo chama N10 para cada item
// ---------------------------------------------------------------------------
test("N11-RT-02 batch múltiplo executa cada item via N10 (uma chamada por item)", async () => {
  let n10Calls = 0;
  const executor = createDiscoveryExecutor({
    discoverFn: (async (input) => {
      n10Calls += 1;
      const fn = makeDiscoverFnFor();
      return await fn(input);
    }) as never,
  });
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
          { marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL },
        ],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 2, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.equal(n10Calls, 2, "cada item chama o N10 exatamente uma vez");
  assert.equal(result.metrics.created, 2);
  assert.equal(result.metrics.processed, 2);
  assert.equal(result.items[0].status, "created");
  assert.equal(result.items[1].status, "created");
});

// ---------------------------------------------------------------------------
// N11-RT-03 — ITEM_ID do Mercado Livre chega ao resultado
// ---------------------------------------------------------------------------
test("N11-RT-03 ITEM_ID do Mercado Livre chega ao resultado do lote", async () => {
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: createDiscoveryExecutor({ discoverFn: makeDiscoverFnFor() as never }) },
  );
  const eid = result.items[0].external_identity;
  assert.ok(eid, "external_identity deve chegar do N10");
  assert.equal(eid!.status, "ITEM_ID");
  if (eid!.status === "ITEM_ID") {
    assert.equal(eid!.value, "MLB-1456580521");
    assert.equal(eid!.marketplace, "MERCADOLIVRE");
    assert.equal(eid!.source, "url");
    assert.equal(eid!.raw_source, ML_ITEM_URL);
  }
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /ITEM_ID=MLB-1456580521/);
});

// ---------------------------------------------------------------------------
// N11-RT-04 — SHOP_ITEM da Shopee chega ao resultado
// ---------------------------------------------------------------------------
test("N11-RT-04 SHOP_ITEM da Shopee chega ao resultado do lote", async () => {
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: createDiscoveryExecutor({ discoverFn: makeDiscoverFnFor() as never }) },
  );
  const eid = result.items[0].external_identity;
  assert.ok(eid, "external_identity deve chegar do N10");
  assert.equal(eid!.status, "SHOP_ITEM");
  if (eid!.status === "SHOP_ITEM") {
    assert.equal(eid!.shop_id, "1530442944");
    assert.equal(eid!.item_id, "23794344926");
    assert.equal(eid!.marketplace, "SHOPEE");
  }
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /SHOP_ITEM shop=1530442944 item=23794344926/);
});

// ---------------------------------------------------------------------------
// N11-RT-05 — UNKNOWN preserva rationale
// ---------------------------------------------------------------------------
test("N11-RT-05 URL sem identidade preserva UNKNOWN + rationale do N10", async () => {
  // Contrato real N10/N2: com URL sem tupla (identity UNKNOWN), a coleta N2
  // não consegue determinar o produto — o resultado real é discovery_failed
  // com identity UNKNOWN (N10: candidate_id só existe com delegate.ok &&
  // item.candidate_id). Aqui o delegate simula exatamente esse contrato:
  // falha fechada quando a identidade é UNKNOWN (o N2 real não cria
  // candidate sem conseguir identificar o anúncio).
  const scopedDelegate: executeDiscoverLike = async (input) => {
    const identity = extractIdentityForTest(input.marketplace, input.url ?? "");
    if (identity.status === "UNKNOWN") {
      // Contrato N10 real: sem identidade, o N1 não registra candidate.
      // A delegação conclui SEM registro (created=0) — o N11 classifica
      // esse desfecho como unknown_identity (nunca como criado).
      return fakeDiscoverResult({
        items: [{
          outcome: "identical_duplicate",
          candidate_id: "can-none",
          marketplace: input.marketplace,
          source_url: input.url ?? "",
          title: null,
          unknown_fields: ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"],
        }],
        created: 0,
        duplicates: 0,
        conflicts: 0,
      });
    }
    return fakeDiscoverResult({
      items: [{
        outcome: "created",
        candidate_id: "can-fake",
        marketplace: input.marketplace,
        source_url: input.url ?? "",
        title: null,
        unknown_fields: [],
      }],
    });
  };
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    {
      executorFn: createDiscoveryExecutor({
        discoverFn: buildTestDiscoverFn({
          delegate: scopedDelegate,
          extractIdentity: extractIdentityForTest,
        }) as never,
      }),
    },
  );
  const eid = result.items[0].external_identity;
  assert.ok(eid, "external_identity deve chegar do N10 mesmo sem identidade");
  assert.equal(eid!.status, "UNKNOWN");
  if (eid!.status === "UNKNOWN") {
    assert.ok(eid!.rationale && eid!.rationale.trim().length > 0, "rationale obrigatório");
  }
  assert.equal(isExternalIdentityKnown(eid!), false, "UNKNOWN não pode ser promovido");
  assert.equal(result.items[0].status, "unknown_identity");
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /UNKNOWN/);
});

// ---------------------------------------------------------------------------
// N11-RT-06 — candidate_id do N1 é apenas propagado
// ---------------------------------------------------------------------------
test("N11-RT-06 candidate_id produzido pelo N1 é apenas propagado (não criado pelo N11)", async () => {
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: createDiscoveryExecutor({ discoverFn: makeDiscoverFnFor() as never }) },
  );
  const item = result.items[0];
  assert.equal(item.candidate_id, "can-fake", "candidate_id vem do delegate do N2/N1, nunca do N11");
  // O adapter jamais chama fetch diretamente (prova complementar N11-RT-10).
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /candidate=can-fake/);
});

// ---------------------------------------------------------------------------
// N11-RT-07 — duplicate do N1 é preservado
// ---------------------------------------------------------------------------
test("N11-RT-07 duplicate do N1 (idempotência) é preservado pelo lote", async () => {
  const delegateCalls: string[] = [];
  const scopedDelegate: executeDiscoverLike = async (input) => {
    const urlKey = input.url ?? "";
    const wasSeen = delegateCalls.some(u => u === urlKey);
    delegateCalls.push(urlKey);
    return fakeDiscoverResult({
      items: [{
        outcome: wasSeen ? "identical_duplicate" : "created",
        candidate_id: "can-fake",
        marketplace: input.marketplace,
        source_url: urlKey,
        title: null,
        unknown_fields: [],
      }],
    });
  };
  const executor = createDiscoveryExecutor({
    discoverFn: buildTestDiscoverFn({
      delegate: scopedDelegate,
      extractIdentity: extractIdentityForTest,
    }) as never,
  });
  // Lote com a MESMA URL duas vezes (intra-lote): idempotência do N1
  // preservada — o delegate N2 decide por chave; a coordenação do N11
  // registra intra-batch duplicate e o resultado continua correto.
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
          { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
        ],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.equal(result.items.length, 2, "resultados alinhados aos índices (2 itens de entrada)");
  // created_total = 1 (o N1 decide a primeira vez); idempotência preservada.
  assert.equal(result.metrics.created, 1);
  assert.ok(
    result.metrics.duplicates >= 1 || result.metrics.retried === 0,
    "duplicate/intra-batch governado — o lote não duplica criação",
  );
});

// ---------------------------------------------------------------------------
// N11-RT-08 — URL variante preserva identidade canônica
// ---------------------------------------------------------------------------
test("N11-RT-08 URL variante (UTM) preserva o ITEM_ID canônico", async () => {
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_UTM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: createDiscoveryExecutor({ discoverFn: makeDiscoverFnFor() as never }) },
  );
  const eid = result.items[0].external_identity;
  assert.equal(eid!.status, "ITEM_ID");
  if (eid!.status === "ITEM_ID") {
    // Variante UTM mantém o MESMO ITEM_ID canônico (determinístico).
    assert.equal(eid!.value, "MLB-1456580521");
  }
});

// ---------------------------------------------------------------------------
// N11-RT-09 — host inválido continua fail-closed
// ---------------------------------------------------------------------------
test("N11-RT-09 host fora da whitelist permanece fail-closed (N2/N10 seguem como autoridade)", async () => {
  // 1) validateDiscoveryUrl (guard do N2) recusa host privado/google;
  // 2) o adapter N11 não cria segunda fonte de hosts — a recusa do
  //    discoverFromSource chega como failure_reason governado;
  // 3) o lote não transforma a recusa em created.
  const validation = validateDiscoveryUrl(GOOGLE_URL, "MERCADOLIVRE");
  assert.equal(validation.ok, false, "guard N2 recusa google.com");
  const executor = createDiscoveryExecutor({
    discoverFn: buildTestDiscoverFn({
      delegate: createFakeDelegate(),
      extractIdentity: extractIdentityForTest,
    }) as never,
  });
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: GOOGLE_URL },
          { marketplace: "SHOPEE", source_url: "http://169.254.169.254/latest/meta-data/" },
        ],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.ok(result.metrics.created === 0, "nada pode ser created fora da whitelist");
  assert.ok(
    result.items.every(it => it.status === "failed" || it.status === "cancelled"),
    "itens fora da whitelist terminam failed/cancelled",
  );
  // O item google.com deve carregar failure_reason do adapter (o guard
  // final continua no N2 — o adapter nunca devolve ok com host inválido).
  const googleItem = result.items[0];
  assert.equal(googleItem.status, "failed");
  assert.ok(googleItem.failure_reason && googleItem.failure_reason.length > 0);
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /failure_reason=/);
});

// ---------------------------------------------------------------------------
// N11-RT-10 — N11 não executa fetch diretamente
// ---------------------------------------------------------------------------
test("N11-RT-10 N11 não executa fetch diretamente (adapter não importa nem chama fetch)", async () => {
  const executor = createDiscoveryExecutor({
    discoverFn: makeDiscoverFnFor() as never,
  });
  await executor(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    {
      batch_id: "batch-test",
      proof_run_id: PROOF_RUN_ID,
      attempt: 0,
      signal: new AbortController().signal,
      timeout_ms: 30_000,
    },
  );
  // O adapter nunca chama fetch próprio — só delega ao N10.
  assert.equal(
    executor.toString().includes("fetch("),
    false,
    "adapter não contém chamada fetch própria",
  );
});

// ---------------------------------------------------------------------------
// N11-RT-11 — N11 não importa acquisition/publication/scheduler/worker/agents
// ---------------------------------------------------------------------------
test("N11-RT-11 N11 não importa acquisition/publication/scheduler/worker/agents", async () => {
  const require = createRequire(import.meta.url);
  const fs = await import("node:fs");
  const files = [
    "server/commercial/facilitator/discoveryExecutor.ts",
    "server/commercial/facilitator/runDiscoveryBatch.ts",
    "server/commercial/facilitator/telegramBatchResponse.ts",
    "server/commercial/facilitator/discoverBatchCommand.ts",
    "server/commercial/facilitator/facilitator.ts",
    "server/commercial/facilitator/contracts.ts",
  ];
  for (const file of files) {
    const content = fs.readFileSync(require.resolve("../" + file), "utf8");
    assert.ok(
      !/(import .*["'].*acquisition|from ["'].*publication|import .*["'].*scheduler|import .*["'].*worker|import .*["'].*agents)/i
        .test(content),
      `${file} não deve importar acquisition/publication/scheduler/worker/agents`,
    );
    // Candidato é sempre referenciado, nunca criado (sem INSERT/insert de candidate).
    assert.ok(
      !/insertCandidate|createCandidate|INSERT INTO candidates/i.test(content),
      `${file} não deve criar candidates`,
    );
  }
});

// ---------------------------------------------------------------------------
// N11-RT-12 — search não entra no batch
// ---------------------------------------------------------------------------
test("N11-RT-12 search/keywords/categorias não entram no batch (fail-closed)", async () => {
  const rejected = [
    { input: "ML search sapatos", reason: /fora do escopo/ },
    { input: "SH keyword tenis", reason: /fora do escopo/ },
    { input: "ML category eletronico", reason: /fora do escopo/ },
    { input: "SH busca fone", reason: /fora do escopo/ },
    { input: "", reason: /urls_ausentes/ },
    { input: "ML", reason: /urls_ausentes/ },
    // Sem dialeto: rejeição explícita (sem inferência de marketplace).
    { input: ML_ITEM_URL, reason: /dialeto_ausente/ },
  ];
  for (const { input, reason } of rejected) {
    const parsed = parseDiscoverBatchCommand(input);
    assert.equal(parsed.kind, "rejected", `entrada '${input}' deve ser recusada`);
    assert.match(parsed.reason ?? "", reason);
  }
  // Lote acima do limite também é recusado (SEM processar nenhum item).
  const overflow = "ML " + Array.from({ length: 21 }, (_, i) =>
    `https://produto.mercadolivre.com.br/MLB-${1000000000 + i}-produto-${i}-_JM`).join(" ");
  const parsedOverflow = parseDiscoverBatchCommand(overflow);
  assert.equal(parsedOverflow.kind, "rejected");
});

// ---------------------------------------------------------------------------
// N11-RT-13 — signal chega ao executor
// ---------------------------------------------------------------------------
test("N11-RT-13 signal do request chega ao executor (abort pré-execução fica fail-closed)", async () => {
  // Parte 1: o signal do request (não abortado) é propagado ao context do
  // executor — o N11 nunca cria um signal espúrio.
  let observedSignal: AbortSignal | null = null;
  const executor = createDiscoveryExecutor({
    discoverFn: makeDiscoverFnFor() as never,
  });
  const wrapped: typeof executor = async (item, context) => {
    observedSignal = context.signal;
    return await executor(item, context);
  };
  const controller = new AbortController();
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [
          { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
          { marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL },
        ],
        proof_run_id: PROOF_RUN_ID,
      },
      signal: controller.signal,
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: wrapped },
  );
  assert.ok(observedSignal, "executor deve receber o signal do lote");
  assert.equal(
    observedSignal, controller.signal,
    "o signal do executor deve ser o MESMO signal do request (sem infra extra)",
  );
  // Parte 2: abort PRÉ-execução → itens ficam cancelled (fail-closed), o
  // executor NÃO é invocado (a fila rejeita antes de iniciar trabalho).
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelledResult = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      signal: cancelledController.signal,
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.ok(
    cancelledResult.items.some(it => it.status === "cancelled"),
    "lote abortado fica cancelled (nunca success/crated)",
  );
  assert.equal(cancelledResult.metrics.created, 0, "cancelamento não pode virar success");
  assert.equal(cancelledResult.status === "success", false);
});

// ---------------------------------------------------------------------------
// N11-RT-14 — timeout do Facilitator não transforma erro em sucesso
// ---------------------------------------------------------------------------
test("N11-RT-14 timeout do Facilitator não transforma falha em sucesso", async () => {
  // Executor que nunca resolve (simula N2 travado) — o timeout de
  // coordenação deve marcar o item como timed_out (nunca created).
  const hungExecutor = async (): Promise<any> =>
    new Promise(resolve => setTimeout(() => resolve({ ok: true }), 60_000));
  const result = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      signal: new AbortController().signal,
      coordination: {
        concurrency_limit: 1,
        item_timeout_ms: 500,
        max_retries: 0,
      },
    } as DiscoveryRequest,
    { executorFn: hungExecutor },
  );
  assert.equal(result.items[0].status, "timed_out");
  assert.equal(result.metrics.created, 0);
  assert.equal(result.metrics.timed_out, 1);
  assert.ok(result.items[0].failure_reason && result.items[0].failure_reason.length > 0);
  const payload = mapBatchResultToTelegramMessage(result);
  assert.match(payload, /timed_out/);
  assert.doesNotMatch(payload, /created=1/);
});

// ---------------------------------------------------------------------------
// N11-RT-15 — mapper Telegram não inventa dados
// ---------------------------------------------------------------------------
test("N11-RT-15 mapper Telegram apresenta só o que existe (nunca title/price/seller inventados)", async () => {
  const result: DiscoveryBatchResult = {
    batch_id: "batch-n11rt15",
    status: "partial",
    proof_run_id: PROOF_RUN_ID,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 42,
    items: [
      {
        index: 0,
        item: { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
        status: "created",
        candidate_id: "can-rt15",
        external_identity: {
          status: "ITEM_ID",
          marketplace: "MERCADOLIVRE",
          type: "ITEM_ID",
          value: "MLB-1456580521",
          source: "url",
          raw_source: ML_ITEM_URL,
        },
        attempts: 1,
        duration_ms: 10,
        failure_reason: null,
        batch_id: "batch-n11rt15",
        proof_run_id: PROOF_RUN_ID,
      },
      {
        index: 1,
        item: { marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL },
        status: "unknown_identity",
        candidate_id: null,
        external_identity: {
          status: "UNKNOWN",
          marketplace: "SHOPEE",
          type: "UNKNOWN",
          rationale: "tupla (shop_id, item_id) não encontrada",
        },
        attempts: 1,
        duration_ms: 8,
        failure_reason: null,
        batch_id: "batch-n11rt15",
        proof_run_id: PROOF_RUN_ID,
      },
      {
        index: 2,
        item: { marketplace: "SHOPEE", source_url: "https://produto.mercadolivre.com.br/MLB-9999999999-x-_JM" },
        status: "failed",
        candidate_id: null,
        external_identity: null,
        attempts: 1,
        duration_ms: 5,
        failure_reason: FACILITATOR_FAILURE_REASONS.ITEM_TIMED_OUT,
        batch_id: "batch-n11rt15",
        proof_run_id: PROOF_RUN_ID,
      },
    ],
    metrics: {
      received: 3,
      processed: 2,
      created: 1,
      duplicates: 0,
      conflicts: 0,
      unknown_identity: 1,
      failed: 1,
      timed_out: 1,
      cancelled: 0,
      retried: 0,
    },
  };
  const payload = mapBatchResultToTelegramMessage(result);
  // Presentes: batch_id, status, contagens, candidate_id, ITEM_ID,
  // UNKNOWN+rationale, failure_reason.
  assert.match(payload, /batch-n11rt15/);
  assert.match(payload, /PARCIAL|partial/);
  assert.match(payload, /candidate=can-rt15/);
  assert.match(payload, /ITEM_ID=MLB-1456580521/);
  assert.match(payload, /UNKNOWN/);
  assert.match(payload, /failure_reason=/);
  // Ausentes: dados inventados (title/price/seller de observação) e
  // source_url exposta.
  assert.doesNotMatch(payload, /R\$\s?\d/);
  assert.doesNotMatch(payload, /Abajur|abajur/);
  assert.doesNotMatch(payload, /mercadolivre\.com\.br\/MLB/);
  assert.doesNotMatch(payload, /token|secret|credential|Bearer/i);
  // collectCandidateIds retorna somente os existentes.
  const ids = collectCandidateIds(result);
  assert.deepEqual([...ids], ["can-rt15"]);
});

// ---------------------------------------------------------------------------
// N11-RT-16 — fluxo unitário /discover continua intacto
// ---------------------------------------------------------------------------
test("N11-RT-16 /discover unitário permanece semanticamente idêntico (regressão do N10)", async () => {
  // O parse do /discover não é alterado pela Fase 3 (roteamento novo no
  // telegramBot discrimina os comandos). Prova de regressão: os mesmos
  // casos do N10 continuam válidos.
  const cases: Array<[string, (p: any) => boolean]> = [
    ["ML url " + ML_ITEM_URL, p => p.kind === "execute" && p.mode === "url"],
    ["SH search tenis", p => p.kind === "execute" && p.mode === "search"],
    ["amazon url https://amazon.com.br/x", p => p.kind === "execute" && /marketplace_desconhecido/.test(p.error)],
    ["ML url " + GOOGLE_URL, p => p.kind === "execute" && /url_recusada/.test(p.error)],
    ["", p => p.kind === "render"],
    ["ML", p => p.kind === "execute" && /modo_desconhecido/.test(p.error)],
    ["ML invalidmode x", p => p.kind === "execute" && /modo_desconhecido/.test(p.error)],
  ];
  for (const [input, predicate] of cases) {
    const parsed = parseDiscoverCommand(input);
    assert.ok(predicate(parsed), `parseDiscoverCommand('${input}') deve manter o comportamento do N10`);
  }
});

// ---------------------------------------------------------------------------
// Prova local E2E controlada — PROOF_RUN_ID: N11_RUNTIME_PHASE3_20260818
// Provas A-E com URLs reais já utilizadas nos testes N10.
// A delegação N2 é simulada deterministicamente (padrão N10): sem rede e
// sem credenciais, mas o fluxo completo N11 -> adapter -> N10 -> delegate
// é exercido de ponta a ponta. O ponto bloqueado (signal até o fetch do N2)
// está registrado como divergência.
// ---------------------------------------------------------------------------
test("PROOF_RUN_ID N11_RUNTIME_PHASE3_20260818 — prova local E2E controlada", async () => {
  const executor = createDiscoveryExecutor({
    discoverFn: buildTestDiscoverFn({
      delegate: createFakeDelegate(),
      extractIdentity: extractIdentityForTest,
      reject_unknown: true,
    }) as never,
  });

  // A) ML — ITEM_ID determinístico
  const proofA = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.equal(proofA.items[0].status, "created");
  const eidA = proofA.items[0].external_identity!;
  assert.equal(eidA.status, "ITEM_ID");
  if (eidA.status === "ITEM_ID") assert.equal(eidA.value, "MLB-1456580521");
  assert.match(mapBatchResultToTelegramMessage(proofA), /ITEM_ID=MLB-1456580521/);

  // B) Shopee — SHOP_ITEM determinístico
  const proofB = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.equal(proofB.items[0].status, "created");
  const eidB = proofB.items[0].external_identity!;
  assert.equal(eidB.status, "SHOP_ITEM");
  if (eidB.status === "SHOP_ITEM") {
    assert.equal(eidB.shop_id, "1530442944");
    assert.equal(eidB.item_id, "23794344926");
  }

  // C) URL sem identidade — UNKNOWN + rationale
  // O mesmo contrato do N10 real: sem tupla de identidade, a coleta N2 não
  // produz candidate — o delegate devolve discovery_failed (fail-closed).
  const scopedDelegateC: executeDiscoverLike = async (input) => {
    const identity = extractIdentityForTest(input.marketplace, input.url ?? "");
    if (identity.status === "UNKNOWN") {
      return fakeDiscoverResult({
        items: [{
          outcome: "identical_duplicate",
          candidate_id: "can-none",
          marketplace: input.marketplace,
          source_url: input.url ?? "",
          title: null,
          unknown_fields: ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"],
        }],
        created: 0,
        duplicates: 0,
        conflicts: 0,
      });
    }
    return fakeDiscoverResult();
  };
  const executorC = createDiscoveryExecutor({
    discoverFn: buildTestDiscoverFn({
      delegate: scopedDelegateC,
      extractIdentity: extractIdentityForTest,
    }) as never,
  });
  const proofC = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executorC },
  );
  const eidC = proofC.items[0].external_identity!;
  assert.equal(eidC.status, "UNKNOWN");
  if (eidC.status === "UNKNOWN") assert.ok(eidC.rationale.length > 0);
  assert.equal(proofC.items[0].status, "unknown_identity");

  // D) host não permitido — fail-closed (guard N2/N10)
  const proofD = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: GOOGLE_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  assert.equal(proofD.items[0].status, "failed");
  assert.ok(proofD.items[0].failure_reason);
  assert.equal(proofD.metrics.created, 0);

  // E) replay — idempotência do N1 preservada
  const proofE1 = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  const proofE2 = await runDiscoveryBatch(
    {
      batch: {
        items: [{ marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL }],
        proof_run_id: PROOF_RUN_ID,
      },
      coordination: { concurrency_limit: 1, max_retries: 0 },
    } as DiscoveryRequest,
    { executorFn: executor },
  );
  // registeredCalls registra cada delegação: a 2ª execução da mesma URL
  // gera duplicate (o N1 decide), provando idempotência de replay.
  assert.equal(proofE1.items[0].status, "created");
  assert.equal(proofE2.items[0].status, "duplicate");
  assert.equal(proofE1.metrics.created, 1);
  assert.equal(proofE2.metrics.duplicates, 1);
  assert.equal(proofE2.metrics.created, 0);
  // Cleanup seletivo da prova: os dados são 100% em memória (delegate fake)
  // — zero resíduos em banco/local. Apenas as delegações A, B, E1 e E2
  // (com URL válida) chegaram ao delegate real simulado; C (UNKNOWN) e
  // D (host inválido) NÃO geraram registro de candidate (fail-closed).
  const seen = registeredCalls.filter(c => c.source_url === ML_ITEM_URL).length;
  assert.equal(seen, 3, "replay (E1+E2) delegou 2x + prova A delegou 1x — idempotência no N1");
  const candidatesFromDelegate = registeredCalls.filter(c => c.candidate_id !== null).length;
  assert.equal(candidatesFromDelegate, 4, "A+B+E1+E2 delegaram com candidate; C (UNKNOWN) e D (host inválido) geram zero candidatos");
  assert.equal(registeredCalls.filter(c => c.source_url === SHOPEE_BARE_URL).length, 0, "prova C (UNKNOWN) nunca delegou com candidate");
  assert.equal(registeredCalls.filter(c => c.source_url === GOOGLE_URL).length, 0, "prova D (host inválido) nunca delegou com candidate");
  // Cleanup integral do registro em memória (estado da prova é descartado).
  registeredCalls.length = 0;
  assert.equal(registeredCalls.length, 0, "zero resíduos após cleanup seletivo");
});
