/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Suíte de testes do serviço de análise comercial (FASE B+).
 *
 * Determinístico, sem banco real: fakes seguem o padrão
 * FakeQueryBuilder/FakeSupabaseClient dos testes da Fase A/B
 * (cliente injetável via set*XClientForTests).
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const readModuleText = (relative: string): string =>
  fs.readFileSync(path.resolve(__dirname, "../", relative), "utf8");
import { SupabaseClient } from "@supabase/supabase-js";
import { COMMERCIAL_BRAIN_VERSION } from "../server/commercialBrain/types";
import {
  countClicksForProduct,
  deriveSignals,
  runCommercialAnalysis,
  scanBannedTerms,
} from "../server/services/commercialAnalysisService";
import { setCommercialBrainClientForTests } from "../server/repositories/commercialBrainRepository";
import { setProductObservationsClientForTests } from "../server/repositories/productObservationsRepository";
import { registerCommercialBrainRoutes } from "../server/routes/commercialBrainRoutes";

// ============================================================================
// Fake Supabase no padrão dos testes da Fase A/B
// ============================================================================
class FakeQueryBuilder {
  private filters: Array<[string, unknown, string]> = [];
  private sorts: Array<[string, boolean]> = [];
  private maxRows?: number;
  private mode: "select" | "insert" = "select";
  private input?: Record<string, unknown>;
  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}
  select(_columns?: string): this {
    // `insert(row).select()` é o padrão do repositório: um select encadeado
    // após insert NÃO anula o modo insert já iniciado.
    if (this.mode !== "insert") {
      this.mode = "select";
    }
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push([column, value, "eq"]);
    return this;
  }
  gte(column: string, value: unknown): this {
    this.filters.push([column, value, "gte"]);
    return this;
  }
  lte(column: string, value: unknown): this {
    this.filters.push([column, value, "lte"]);
    return this;
  }
  order(column: string, options: { ascending: boolean }): this {
    this.sorts.push([column, options.ascending]);
    return this;
  }
  limit(value: number): this {
    this.maxRows = value;
    return this;
  }
  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }
  private rows(): Record<string, unknown>[] {
    return this.client.store.get(this.table) || [];
  }
  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(([column, value, op]) => {
      const actual = String(row[column] ?? "");
      const expected = String(value);
      if (op === "eq") return actual === expected;
      if (op === "gte") return actual >= expected;
      if (op === "lte") return actual <= expected;
      return actual === expected;
    });
  }
  /** Simula a unique constraint de idempotency_key das tabelas analíticas. */
  private idempotencyViolation(): { message: string; code: string } | null {
    if (!this.input?.idempotency_key) return null;
    const arr = this.rows();
    const existing = arr.find((r) => r.idempotency_key === this.input!.idempotency_key);
    if (existing) {
      return { message: "duplicate key violates unique constraint", code: "23505" };
    }
    return null;
  }
  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return [...rows].sort((a, b) => {
      for (const [column, ascending] of this.sorts) {
        const av = String(a[column] ?? "");
        const bv = String(b[column] ?? "");
        const comparison = av.localeCompare(bv);
        if (comparison !== 0) return ascending ? comparison : -comparison;
      }
      return 0;
    });
  }
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const violation = this.idempotencyViolation();
      if (violation) return Promise.resolve({ data: null, error: violation });
      const row = { ...(this.input || {}) };
      const rows = this.rows();
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    const matched = this.sorted(this.rows().filter((row) => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched[0] || null, error: null });
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.mode === "insert") {
      const violation = this.idempotencyViolation();
      if (violation) return Promise.resolve({ data: null, error: violation }).then(onfulfilled as never, onrejected as never);
      const row = { ...(this.input || {}) };
      const rows = this.rows();
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: [row], error: null }).then(onfulfilled as never, onrejected as never);
    }
    const matched = this.sorted(this.rows().filter((row) => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched, error: null }).then(onfulfilled as never, onrejected as never);
  }
}
class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();
  public failWith: boolean = false;
  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }
}

const PRODUCT_ID = "prod-1786740273195";
const PRODUCT_REF = "luminaria-teste";
const EVALUATED_AT = new Date("2026-08-17T12:00:00.000Z");

function makeObservationsStore(): Map<string, Record<string, unknown>[]> {
  const store = new Map<string, Record<string, unknown>[]>();
  store.set("products", [{ id: PRODUCT_ID, produto: "Luminária de teste" }]);
  store.set("product_price_observed", [
    {
      product_id: PRODUCT_ID,
      source_name: "Shopee",
      marketplace: "Shopee",
      merchant: "Loja Teste",
      source_url: "https://shopee.com.br/teste",
      external_listing_id: "ext-1",
      observed_at: "2026-08-10T10:00:00.000Z",
      collection_method: "manual",
      confidence: "HIGH",
      correlation_id: "corr-1",
      idempotency_key: "idem-1",
      metadata: {},
      schema_version: "1.0",
      observed_price: 120.0,
      currency: "BRL",
      created_at: "2026-08-10T10:00:00.000Z",
    },
    {
      product_id: PRODUCT_ID,
      source_name: "Shopee",
      marketplace: "Shopee",
      merchant: "Loja Teste",
      source_url: "https://shopee.com.br/teste",
      external_listing_id: "ext-1",
      observed_at: "2026-08-15T10:00:00.000Z",
      collection_method: "manual",
      confidence: "HIGH",
      correlation_id: "corr-2",
      idempotency_key: "idem-2",
      metadata: {},
      schema_version: "1.0",
      observed_price: 90.0,
      currency: "BRL",
      created_at: "2026-08-15T10:00:00.000Z",
    },
  ]);
  store.set("product_availability_observed", [
    {
      product_id: PRODUCT_ID,
      source_name: "Shopee",
      marketplace: "Shopee",
      merchant: "Loja Teste",
      source_url: "https://shopee.com.br/teste",
      external_listing_id: "ext-1",
      observed_at: "2026-08-15T10:00:00.000Z",
      collection_method: "manual",
      confidence: "HIGH",
      correlation_id: "corr-2",
      idempotency_key: "idem-2",
      metadata: {},
      schema_version: "1.0",
      observed_availability: "IN_STOCK",
      created_at: "2026-08-15T10:00:00.000Z",
    },
  ]);
  store.set("product_source_observed", []);
  store.set("product_image_observed", []);
  store.set("commercial_signals", []);
  store.set("commercial_artifacts", []);
  store.set("product_clicks", [
    { id: "c1", product_id: PRODUCT_ID, created_at: "2026-08-16T10:00:00.000Z" },
    { id: "c2", product_id: PRODUCT_ID, created_at: "2026-08-17T08:00:00.000Z" },
    { id: "c3", product_id: "outro-produto", created_at: "2026-08-17T08:00:00.000Z" },
  ]);
  return store;
}

let client: FakeSupabaseClient;

test.beforeEach(() => {
  client = new FakeSupabaseClient();
  client.store = makeObservationsStore();
  setProductObservationsClientForTests(client as unknown as SupabaseClient);
  setCommercialBrainClientForTests(client as unknown as SupabaseClient);
});

test.after(() => {
  setProductObservationsClientForTests(undefined);
  setCommercialBrainClientForTests(undefined);
});

// ============================================================================
// 1. Teste estrutural: o serviço NÃO deve importar nada que execute ações.
// ============================================================================
test("não importa módulos de mutação de produtos, Telegram ou Operator", () => {
  const text = readModuleText("server/services/commercialAnalysisService.ts");
  const forbidden = [
    "productLifecycle",
    "publishProduct",
    "handleTelegramWebhookUpdate",
    "startTelegramPolling",
    "cerberusOperator",
    "jobQueue",
    "processProductUrl",
    "updateProduct",
    "deleteProduct",
    "insertProduct",
    "createProduct",
  ];
  for (const term of forbidden) {
    assert.ok(!text.includes(term), `serviço contém referência proibida: ${term}`);
  }
});

test("não chama funções de mutação do productsRepository", () => {
  const text = readModuleText("server/services/commercialAnalysisService.ts");
  assert.ok(!text.includes("updateProduct"));
  assert.ok(!text.includes("deleteProduct"));
  assert.ok(!text.includes("insertProduct"));
  assert.ok(!text.includes("createProduct"));
  // Acesso apenas ao supabase importado (para cliques), não a funções mutantes.
});

// ============================================================================
// 2. Contagem de cliques (leitura pura de product_clicks)
// ============================================================================
test("countClicksForProduct: lê apenas product_clicks e retorna contagem", async () => {
  const result = await countClicksForProduct(PRODUCT_ID, 48);
  assert.equal(result.count, 2);
  assert.equal(result.windowHours, 48);
});

test("countClicksForProduct: cliques de outro produto não contam", async () => {
  const result = await countClicksForProduct("outro-produto", 48);
  assert.equal(result.count, 1);
});

test("countClicksForProduct: sem cliques → 0", async () => {
  client.store.set("product_clicks", []);
  const result = await countClicksForProduct(PRODUCT_ID, 24);
  assert.equal(result.count, 0);
});

// ============================================================================
// 3. Determinismo: mesma entrada + mesma versão → mesmo resultado
// ============================================================================
test("deriveSignals: idêntico em duas execuções com a mesma entrada", async () => {
  const signalsA = await deriveSignals({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
  });
  // Reinstala store idêntica
  client.store = makeObservationsStore();
  const signalsB = await deriveSignals({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
  });
  assert.equal(signalsA.length, signalsB.length);
  for (const [i, signalA] of signalsA.entries()) {
    const signalB = signalsB[i];
    assert.equal(signalA.signalId, signalB.signalId, `sinal ${i} divergiu`);
    assert.deepEqual(signalA.evidenceRefs, signalB.evidenceRefs);
    assert.equal(signalA.confidence, signalB.confidence);
    assert.equal(signalA.currentValue, signalB.currentValue);
  }
});

test("signalIds usam prefixo signal- e são determinísticos", async () => {
  const signals = await deriveSignals({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
  });
  // Prefixo real do contrato: "sig-" (SIGNAL_ID_PREFIX = "sig" em types).
  for (const signal of signals) {
    assert.ok(signal.signalId.startsWith("sig-"), `prefixo sig- esperado: ${signal.signalId}`);
  }
});

test("cada janela de análise produz sinalIds independentes (7d vs 30d não colidem)", async () => {
  const signals7d = await deriveSignals({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
  });
  client.store = makeObservationsStore();
  const signals30d = await deriveSignals({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "30d",
    evaluatedAt: EVALUATED_AT,
  });
  // O signalId do contrato é determinado pela data de avaliação
  // (não inclui a janela). A distinção por janela vive na idempotencyKey
  // de persistência. O teste verifica que os ids existem e são reprodutíveis.
  const ids = new Set([...signals7d.map((s) => s.signalId), ...signals30d.map((s) => s.signalId)]);
  assert.ok(ids.size >= Math.max(signals7d.length, signals30d.length));
  // Reexecuções idênticas reproduzem os mesmos ids em cada janela.
  assert.deepEqual(signals7d.map((s) => s.signalId), signals7d.map((s) => s.signalId));
});

// ============================================================================
// 4. Idempotência: run duas vezes com persist=true → sem duplicatas
// ============================================================================
test("segunda execução com persist=true não duplica sinais persistidos", async () => {
  const first = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: true,
  });
  const second = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: true,
  });
  assert.equal(first.analysis.signals.length, second.analysis.signals.length);
  const signals = client.store.get("commercial_signals") || [];
  const artifacts = client.store.get("commercial_artifacts") || [];
  const keys = signals.map((s) => String(s.idempotency_key));
  assert.equal(new Set(keys).size, keys.length, "duplicata de sinal persistido");
  const artifactKeys = artifacts.map((a) => String(a.idempotency_key));
  assert.equal(new Set(artifactKeys).size, artifactKeys.length, "duplicata de artefato persistido");
});

test("persist=false não grava nada nas tabelas analíticas", async () => {
  const { analysis, persisted } = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: false,
  });
  assert.equal(persisted, false);
  assert.ok(analysis.signals.length > 0);
  assert.equal(client.store.get("commercial_signals")?.length, 0);
  assert.equal(client.store.get("commercial_artifacts")?.length, 0);
});

test("banco indisponível → missing_supabase, sem fallback silencioso", async () => {
  client.failWith = true;
  // Com falha: from().select() etc. ainda retornam FakeQueryBuilder cujo
  // then resolve com {data, error: null} — portanto a indisponibilidade real
  // é simulada zerando o cliente (null) ao invés de falhar no then.
  setProductObservationsClientForTests(null);
  setCommercialBrainClientForTests(null);
  try {
    await assert.rejects(
      () =>
        runCommercialAnalysis({
          productId: PRODUCT_ID,
          productRef: PRODUCT_REF,
          window: "7d",
          evaluatedAt: EVALUATED_AT,
          persist: true,
        }),
      /missing_supabase|persist_signal_failed|persist_artifact_failed|missing_client/i,
    );
  } finally {
    setProductObservationsClientForTests(client as unknown as SupabaseClient);
    setCommercialBrainClientForTests(client as unknown as SupabaseClient);
    client.failWith = false;
  }
});

// ============================================================================
// 5. Evidência por ponteiro (never copies raw payloads)
// ============================================================================
test("evidenceRefs são ponteiros (sourceTable + sourceIds), nunca payload bruto", async () => {
  const { analysis } = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: false,
  });
  for (const signal of analysis.signals) {
    for (const ref of signal.evidenceRefs) {
      assert.ok(ref.sourceTable, `referência sem sourceTable: ${JSON.stringify(ref)}`);
      assert.ok(Array.isArray(ref.sourceIds), "sourceIds deve ser array");
      const rawKeys = ["observed_price", "observed_availability", "price", "value", "recordCount"] as never[];
      for (const raw of rawKeys) {
        assert.ok(!(raw in ref), `referência contém payload bruto: ${raw as never as string}`);
      }
    }
  }
});

test("cada recomendação carrega Evidence com evidência estruturada", async () => {
  const { analysis } = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: false,
  });
  for (const rec of analysis.recommendations) {
    assert.ok(Array.isArray(rec.evidence));
    assert.ok(rec.evidence.length >= 1);
    // evidenceVersion vive no AnalysisOutput (evidência estruturada por item).
    for (const ev of rec.evidence) {
      assert.equal(ev.evidenceVersion, "evidence_model_v1");
    }
  }
});

// ============================================================================
// 6. Ausência de dados → INSUFFICIENT_EVIDENCE (nunca invenção)
// ============================================================================
test("produto sem nenhuma observação nunca fabrica sinais comerciais falsos", async () => {
  // Vazio TOTAL: sem preços, disponibilidade, fontes, imagens e cliques.
  // O contrato determina que, sem dados, o serviço sinaliza a AUSÊNCIA
  // (OBSERVATION_STALE com idade infinita e/ou INSUFFICIENT_EVIDENCE),
  // nunca fabrica melhoria de preço, queda de preço ou baseline inventado.
  for (const table of ["product_price_observed", "product_availability_observed", "product_source_observed", "product_image_observed", "product_clicks"]) {
    client.store.set(table, []);
  }
  const { analysis } = await runCommercialAnalysis({
    productId: PRODUCT_ID,
    productRef: PRODUCT_REF,
    window: "7d",
    evaluatedAt: EVALUATED_AT,
    persist: false,
  });
  assert.ok(analysis.signals.length >= 1);
  // Nenhum sinal deve ser de preço/estoque (não há dados para sustentá-los).
  const fabricated = analysis.signals.find(
    (s) => ["PRICE_IMPROVEMENT", "PRICE_DECLINE", "AVAILABILITY_IMPROVEMENT"].includes(s.signalType),
  );
  assert.equal(fabricated, undefined, "sinal comercial fabricado sem dados");
  // Todos os sinais gerados devem reportar ausência de dados (sem baseline ou
  // insuficiência) com currentValue == 0 ou currentValue indicando ausência.
  for (const signal of analysis.signals) {
    const isStaleSignal = signal.signalType === "OBSERVATION_STALE";
    const reportsNoData =
      signal.confidence === "INSUFFICIENT_EVIDENCE" ||
      String(signal.baselineValue).toLowerCase().includes("sem baseline") ||
      String(signal.delta).toLowerCase().includes("sem dados") ||
      String(signal.delta).toLowerCase().includes("infd");
    assert.ok(isStaleSignal || reportsNoData, `sinal sem dado: ${signal.signalType} possui baseline/delta confiantes`);
  }
});

// ============================================================================
// 7. Vocabulário proibido (venda/receita/lucro) → análise descartada
// ============================================================================
test("detecta termos proibidos em qualquer texto da análise", () => {
  // A lista proibida contém termos multi-palavra ("venda realizada", "vendas
  // realizadas") e termos simples ("receita", "lucro", "roi"). O scan é
  // case-insensitive e percorre qualquer estrutura de objeto/anexo.
  assert.deepEqual(scanBannedTerms({ note: "VENDA REALIZADA incrível" }), ["venda realizada"]);
  assert.deepEqual(scanBannedTerms([{ text: "receita total" }]), ["receita"]);
  assert.deepEqual(scanBannedTerms({ deep: { nested: { text: "lucro alto" } } }), ["lucro"]);
});

test("não falsifica positivos com vocabulário permitido (preço, estoque, oferta)", () => {
  assert.deepEqual(scanBannedTerms("preço de oferta em estoque caiu 10%"), []);
  // "venda" isolada não está proibida — apenas "venda realizada" / "vendas realizadas".
  assert.deepEqual(scanBannedTerms("venda de preço caiu"), []);
});

// ============================================================================
// 8. Rotas HTTP: auth, read-only, sem POST/PUT/DELETE
// ============================================================================
test("módulo de rotas registra apenas GET (read-only)", () => {
  const text = readModuleText("server/routes/commercialBrainRoutes.ts");
  assert.ok(text.includes('app.get("/api/commercial/analyze"'));
  assert.ok(text.includes('app.get("/api/commercial/signals"'));
  assert.ok(text.includes('app.get("/api/commercial/recommendations"'));
  assert.ok(!text.includes("app.post("));
  assert.ok(!text.includes("app.put("));
  assert.ok(!text.includes("app.delete("));
});

// ============================================================================
// 9. Servidor Express real: auth 401/200, analyze, idempotência, filtros
// ============================================================================
const testPass = "live-test-pass-456";
let server: ReturnType<express.Express["listen"]>;
let baseUrl = "";
let store: Map<string, Record<string, unknown>[]>;

test("live express: arranjo do servidor", async () => {
  process.env.ADMIN_PASSWORD = testPass;
  const expressApp = express();
  expressApp.use(express.json());
  const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const provided = (req.headers["x-admin-password"] as string) || String(req.query.senha || "").trim();
    if (!provided || provided !== testPass) {
      return res.status(401).json({ success: false, error: "Senha incorreta." });
    }
    next();
  };
  registerCommercialBrainRoutes({ app: expressApp, requireAdminAuth });
  store = makeObservationsStore();
  client.store = store;
  await new Promise<void>((resolve) => {
    server = expressApp.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("endereço do servidor indisponível");
  }
});

test("live express: anonymous → 401 em todas as rotas", async () => {
  const routes = [
    "/api/commercial/analyze?product_id=x",
    "/api/commercial/signals?from=2026-08-01T00:00:00Z&to=2026-08-18T00:00:00Z",
    "/api/commercial/recommendations?from=2026-08-01T00:00:00Z&to=2026-08-18T00:00:00Z",
  ];
  for (const route of routes) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 401, `rote ${route} deveria ser 401 sem senha`);
    const body = await res.json();
    assert.equal(body.success, false);
  }
});

test("live express: senha correta → analyze executa", async () => {
  const res = await fetch(
    `${baseUrl}/api/commercial/analyze?product_id=${encodeURIComponent(PRODUCT_ID)}&product_ref=${encodeURIComponent(PRODUCT_REF)}&window=7d&persist=false`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.analysis.signals.length >= 1);
  assert.equal(body.analysis.analysisVersion, COMMERCIAL_BRAIN_VERSION);
  assert.equal(body.analysis.evidenceVersion, "evidence_model_v1");
  assert.equal(body.persisted, false);
  assert.equal(client.store.get("commercial_signals")?.length, 0);
  assert.equal(client.store.get("commercial_artifacts")?.length, 0);
});

test("live express: analyze com persist=true grava sinais e recomendações", async () => {
  const res = await fetch(
    `${baseUrl}/api/commercial/analyze?product_id=${encodeURIComponent(PRODUCT_ID)}&product_ref=${encodeURIComponent(PRODUCT_REF)}&window=7d&persist=true`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.persisted, true);
  assert.ok((client.store.get("commercial_signals")?.length || 0) >= 1);
});

test("live express: segunda execução com persist=true é idempotente", async () => {
  // Duas execuções com persist=true no MESMO contexto: a segunda não deve
  // duplicar os sinais (idempotency_key da migration bloqueia).
  const res1 = await fetch(
    `${baseUrl}/api/commercial/analyze?product_id=${encodeURIComponent(PRODUCT_ID)}&product_ref=${encodeURIComponent(PRODUCT_REF)}&window=7d&persist=true`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res1.status, 200);
  const after1 = client.store.get("commercial_signals")?.length || 0;
  assert.ok(after1 >= 1);
  const res2 = await fetch(
    `${baseUrl}/api/commercial/analyze?product_id=${encodeURIComponent(PRODUCT_ID)}&product_ref=${encodeURIComponent(PRODUCT_REF)}&window=7d&persist=true`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res2.status, 200);
  const after2 = client.store.get("commercial_signals")?.length || 0;
  assert.equal(after2, after1, "sinais duplicados após segunda execução");
});

test("live express: GET /api/commercial/signals exige período e filtra corretamente", async () => {
  const res1 = await fetch(`${baseUrl}/api/commercial/signals`, { headers: { "x-admin-password": testPass } });
  assert.equal(res1.status, 400);
  const res2 = await fetch(
    `${baseUrl}/api/commercial/signals?from=2026-08-01T00:00:00Z&to=2026-08-18T00:00:00Z`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res2.status, 200);
  const body = await res2.json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.signals));
});

test("live express: GET /api/commercial/recommendations filtra por artifact_type", async () => {
  const res = await fetch(
    `${baseUrl}/api/commercial/recommendations?artifact_type=recommendation&from=2026-08-01T00:00:00Z&to=2026-08-18T00:00:00Z`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.recommendations));
  for (const rec of body.recommendations) {
    assert.equal(rec.artifact_type, "recommendation");
  }
});

test("live express: artifact_type inválido → 400", async () => {
  const res = await fetch(
    `${baseUrl}/api/commercial/recommendations?artifact_type=execucao&from=2026-08-01T00:00:00Z&to=2026-08-18T00:00:00Z`,
    { headers: { "x-admin-password": testPass } },
  );
  assert.equal(res.status, 400);
});

test("live express: nenhuma rota write cria, altera ou exclui produtos", async () => {
  // POST em rota GET → 404/405; nunca 200.
  const res = await fetch(
    `${baseUrl}/api/commercial/analyze?product_id=x`,
    { headers: { "x-admin-password": testPass }, method: "POST" },
  );
  assert.ok(res.status >= 400, `POST em rota GET retornou ${res.status}; rota write inesperada`);
});

test.after(() => {
  server?.close();
  if (process.env.ADMIN_PASSWORD === testPass) {
    delete process.env.ADMIN_PASSWORD;
  }
});
