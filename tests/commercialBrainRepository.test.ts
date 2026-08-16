import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ARTIFACT_TABLE,
  SIGNAL_TABLE,
  type ArtifactInsertInput,
  type SignalInsertInput,
  setCommercialBrainClientForTests,
  insertSignal,
  insertArtifact,
  getSignal,
  getArtifact,
  getSignalsByProduct,
  getSignalsByPeriod,
  getSignalsByType,
  getSignalsByAnalysisVersion,
  getArtifactsByProduct,
  getArtifactsByPeriod,
  getArtifactsByType,
  getArtifactsByScoringVersion,
  sanitizeText,
  sanitizeMetadata,
  __testIsContentCompatibleSignal,
  __testIsContentCompatibleArtifact,
} from "../server/repositories/commercialBrainRepository";

// ============================================================================
// Fake Supabase client (mesmo padrão do teste do repositório de observações)
// ============================================================================
class FakeQueryBuilder {
  private filters: Array<[string, unknown, "eq" | "gte" | "lte"]> = [];
  private orderColumn?: string;
  private orderAsc = true;
  private maxRows?: number;
  private mode: "select" | "insert" = "select";
  private insertedRows: unknown[] = [];
  private input?: Record<string, unknown>;

  constructor(
    private readonly store: Map<string, Record<string, unknown>[]>,
    private readonly table: string,
  ) {}

  select(_columns?: string): this {
    if (this.mode !== "insert") this.mode = "select";
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

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number): this {
    this.maxRows = n;
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    this.insertedRows.push(row);
    return this;
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(([column, value, op]) => {
      if (op === "gte") return String(row[column] ?? "") >= String(value);
      if (op === "lte") return String(row[column] ?? "") <= String(value);
      return row[column] === value;
    });
  }

  private get filtersSnapshot(): unknown[] {
    return JSON.parse(JSON.stringify(this.filters));
  }

  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return [...rows].sort((a, b) => {
      if (!this.orderColumn) return 0;
      const cmp = String(a[this.orderColumn] ?? "").localeCompare(String(b[this.orderColumn] ?? ""));
      return this.orderAsc ? cmp : -cmp;
    });
  }

  private compareContent(existing: Record<string, unknown>, candidate: Record<string, unknown>): boolean {
    if (this.table === SIGNAL_TABLE) {
      return __testIsContentCompatibleSignal(existing as never, candidate);
    }
    return __testIsContentCompatibleArtifact(existing as never, candidate);
  }

  /** Executa o insert: idempotência, colisão e persistência. */
  private runInsert(): { data: unknown[] | null; error: { message: string; code: string } | null } {
    const rowObj = this.input ?? {};
    const arr = this.store.get(this.table) ?? [];

    if (rowObj.idempotency_key) {
      const existing = arr.find(r => r.idempotency_key === rowObj.idempotency_key);
      if (existing) {
        return this.compareContent(existing, rowObj)
          ? { data: null, error: { message: "duplicate key violates unique constraint", code: "23505" } }
          : { data: null, error: { message: "conteúdo incompatível (colisão)", code: "23505" } };
      }
    }
    const primaryKey = this.table === SIGNAL_TABLE ? "signal_id" : "artifact_id";
    if (arr.some(r => r[primaryKey] === rowObj[primaryKey])) {
      return { data: null, error: { message: "duplicate key", code: "23505" } };
    }
    const stored = { ...rowObj, created_at: "2026-08-15T20:00:00Z" };
    arr.push(stored);
    this.store.set(this.table, arr);
    return { data: [stored], error: null };
  }

  maybeSingle(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") return Promise.resolve(this.runInsert());
    const matched = this.sorted(this.rows().filter(r => this.matches(r))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }

  private rows(): Record<string, unknown>[] {
    return [...(this.store.get(this.table) ?? [])].filter(r => this.matches(r));
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.mode === "insert") {
      return Promise.resolve(this.runInsert()).then(onfulfilled as never, onrejected as never);
    }
    const matched = this.sorted(this.rows().filter(r => this.matches(r))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched, error: null }).then(onfulfilled as never, onrejected as never);
  }
}

class FakeSupabaseClient {
  store = new Map<string, Record<string, unknown>[]>();
  failWith?: { message: string; code: string } | null;

  from(table: string): FakeQueryBuilder {
    if (this.failWith) {
      const fb: FakeQueryBuilder & { select: () => typeof fb; eq: () => typeof fb; gte: () => typeof fb; lte: () => typeof fb; order: () => typeof fb; limit: () => typeof fb; maybeSingle: () => Promise<{ data: null; error: { message: string; code: string } }>; insert: () => typeof fb; then: never } = Object.assign(new FakeQueryBuilder(this.store, table), {
        select: () => fb,
        eq: () => fb,
        gte: () => fb,
        lte: () => fb,
        order: () => fb,
        limit: () => fb,
        maybeSingle: async () => ({ data: null, error: this.failWith! }),
        insert: () => fb,
        then: ((onfulfilled, onrejected) =>
          Promise.resolve({ data: null, error: this.failWith! }).then(onfulfilled as never, onrejected as never)) as never,
      });
      return fb as never;
    }
    return new FakeQueryBuilder(this.store, table);
  }
}

// ============================================================================
// Fixtures
// ============================================================================
const DETECTED_AT = "2026-08-15T20:00:00.000Z";

function makeSignalInput(overrides: Partial<SignalInsertInput> = {}): SignalInsertInput {
  return {
    signalId: "sig-20260815-1",
    productId: "REF-008",
    signalType: "PRICE_IMPROVEMENT",
    signalCategory: "price",
    metric: "observed_price_brl",
    currentValue: "R$ 69,00",
    baselineValue: "R$ 79,00",
    delta: "-12,7%",
    window: "7d",
    baselineWindow: "7d",
    evidenceRefs: [{ sourceType: "price_observation", sourceTable: "product_price_observed", sourceIds: ["obs-1"] }],
    confidence: "HIGH",
    confidenceBasis: "base: 1 registro, sem contradição, recência ok",
    analysisVersion: "commercial_brain_v1",
    inputSnapshot: { subject: "REF-008", window: "7d", recordCount: 1, evaluatedAt: DETECTED_AT },
    detectedAt: DETECTED_AT,
    correlationId: "corr-1",
    idempotencyKey: "idem-sig-1",
    ...overrides,
  };
}

function makeArtifactInput(overrides: Partial<ArtifactInsertInput> = {}): ArtifactInsertInput {
  return {
    artifactId: "rec-20260815-1",
    productId: "REF-008",
    artifactType: "recommendation",
    subject: "REF-008",
    subjectRef: "REF-008",
    signalType: "PRICE_IMPROVEMENT",
    signalId: "sig-20260815-1",
    suggestedAction: "considerar destacar REF-008",
    confidence: "HIGH",
    confidenceBasis: "base sólida",
    priority: { magnitude: 0.635, confidence: 1.0, recency: 0.929, impact: 0.9, evidence: 0.4, score: 0.782, level: "HIGH", modelVersion: "priority_model_v1" },
    priorityLevel: "HIGH",
    priorityScore: 0.782,
    impact: "MEDIUM",
    cost: "LOW",
    risk: "LOW",
    status: "ACTIVE",
    baselineStatement: "R$ 79,00",
    reviewDeadline: "2026-08-17T20:00:00Z",
    evidence: [{ evidenceId: "ev-1", sourceTable: "product_price_observed", sourceIds: ["obs-1"] }],
    scoringVersion: "priority_model_v1",
    confidenceVersion: "confidence_model_v1",
    analysisVersion: "commercial_brain_v1",
    correlationId: "corr-1",
    idempotencyKey: "idem-rec-1",
    ...overrides,
  };
}

let fake: FakeSupabaseClient;

test.before(() => {
  test.before = undefined as never;
});

function withClient(fn: () => Promise<void> | void) {
  return async () => {
    fake = new FakeSupabaseClient();
    setCommercialBrainClientForTests(fake as unknown as SupabaseClient);
    await fn();
    setCommercialBrainClientForTests(null);
  };
}

// ============================================================================
// Criação e leitura
// ============================================================================
test("insertSignal persiste com todos os campos e colunas snake_case", withClient(async () => {
  const result = await insertSignal(makeSignalInput());
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record!.signal_id, "sig-20260815-1");
  assert.equal(result.record!.product_id, "REF-008");
  assert.equal((result.record!.evidence_refs[0] as Record<string, unknown>).sourceType, "price_observation");
  assert.equal(result.record!.analysis_version, "commercial_brain_v1");
}));

test("insertArtifact persiste recomendação com priority breakdown e versões", withClient(async () => {
  const result = await insertArtifact(makeArtifactInput());
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record!.artifact_type, "recommendation");
  assert.equal(result.record!.scoring_version, "priority_model_v1");
  assert.equal(result.record!.confidence_version, "confidence_model_v1");
  assert.equal((result.record!.priority as Record<string, unknown>).score, 0.782);
}));

test("getSignal recupera pelo signal_id", withClient(async () => {
  await insertSignal(makeSignalInput());
  const r = await getSignal("sig-20260815-1");
  assert.equal(r.outcome, "inserted");
  assert.equal(r.record!.signal_id, "sig-20260815-1");
}));

test("getArtifact recupera pelo artifact_id", withClient(async () => {
  await insertArtifact(makeArtifactInput());
  const r = await getArtifact("rec-20260815-1");
  assert.equal(r.outcome, "inserted");
  assert.equal(r.record!.artifact_id, "rec-20260815-1");
}));

// ============================================================================
// Recuperação por product_id, período, tipo e versão
// ============================================================================
test("getSignalsByProduct e getArtifactsByProduct filtram por produto", withClient(async () => {
  await insertSignal(makeSignalInput({ productId: "REF-008" }));
  await insertSignal(makeSignalInput({ signalId: "sig-20260815-2", productId: "REF-001", idempotencyKey: "idem-sig-2" }));
  const r = await getSignalsByProduct("REF-008");
  assert.equal(r.record!.length, 1);
  assert.equal(r.record![0].signal_id, "sig-20260815-1");

  await insertArtifact(makeArtifactInput());
  const ar = await getArtifactsByProduct("REF-008");
  assert.equal(ar.record!.length, 1);
}));

test("getSignalsByPeriod filtra pela janela detectada_at", withClient(async () => {
  await insertSignal(makeSignalInput({ detectedAt: "2026-08-05T00:00:00.000Z" }));
  const out = await getSignalsByPeriod({ from: "2026-08-01T00:00:00Z", to: "2026-08-06T00:00:00Z" });
  assert.equal(out.record!.length, 1);
  const empty = await getSignalsByPeriod({ from: "2026-08-12T00:00:00Z", to: "2026-08-14T00:00:00Z" });
  assert.equal(empty.record!.length, 0);
}));

test("getSignalsByType filtra por signal_type", withClient(async () => {
  await insertSignal(makeSignalInput());
  const r = await getSignalsByType("PRICE_IMPROVEMENT");
  assert.equal(r.record!.length, 1);
  const none = await getSignalsByType("AVAILABILITY_RISK");
  assert.equal(none.record!.length, 0);
}));

test("getSignalsByAnalysisVersion filtra por versão da análise", withClient(async () => {
  await insertSignal(makeSignalInput());
  const r = await getSignalsByAnalysisVersion("commercial_brain_v1");
  assert.equal(r.record!.length, 1);
  const none = await getSignalsByAnalysisVersion("commercial_brain_v2");
  assert.equal(none.record!.length, 0);
}));

test("getArtifactsByPeriod / ByType / ByScoringVersion filtram corretamente", withClient(async () => {
  await insertArtifact(makeArtifactInput());
  await insertArtifact(makeArtifactInput({ artifactId: "opp-20260815-1", artifactType: "opportunity", idempotencyKey: "idem-opp-1" }));
  const byType = await getArtifactsByType("opportunity");
  assert.equal(byType.record!.length, 1);
  const byVersion = await getArtifactsByScoringVersion("priority_model_v1");
  assert.equal(byVersion.record!.length, 2);
  const byPeriod = await getArtifactsByPeriod({ from: "2026-08-01Z", to: "2026-08-14Z" });
  assert.equal(byPeriod.record!.length, 0);
}));

// ============================================================================
// Idempotência e colisão
// ============================================================================
test("idempotência: mesma chave + mesmo conteúdo = duplicate sem duplicar", withClient(async () => {
  const first = await insertSignal(makeSignalInput());
  assert.equal(first.outcome, "inserted");
  const second = await insertSignal(makeSignalInput());
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.record!.signal_id, "sig-20260815-1");
  assert.equal(fake.store.get(SIGNAL_TABLE)!.length, 1);
}));

test("colisão: mesma chave + conteúdo incompatível = rejeição explícita", withClient(async () => {
  await insertSignal(makeSignalInput());
  const colliding = await insertSignal(makeSignalInput({ delta: "+99,9%" }));
  assert.equal(colliding.outcome, "conflict_rejected");
  assert.match(colliding.error ?? "", /incompatível/);
  assert.equal(fake.store.get(SIGNAL_TABLE)!.length, 1);
}));

test("idempotência em artefatos: duplicate idêntico vs colisão", withClient(async () => {
  const first = await insertArtifact(makeArtifactInput());
  assert.equal(first.outcome, "inserted");
  assert.equal((await insertArtifact(makeArtifactInput())).outcome, "identical_duplicate");
  assert.equal((await insertArtifact(makeArtifactInput({ suggestedAction: "outra sugestão" }))).outcome, "conflict_rejected");
  assert.equal(fake.store.get(ARTIFACT_TABLE)!.length, 1);
}));

test("sem idempotency_key: mesmo signal_id é rejeitado pelo PK", withClient(async () => {
  await insertSignal(makeSignalInput({ idempotencyKey: null }));
  const second = await insertSignal(makeSignalInput({ idempotencyKey: null }));
  assert.equal(second.outcome, "conflict_rejected");
}));

// ============================================================================
// Ausência de produto (signal/artifact sem product_id)
// ============================================================================
test("signal sem product_id é persistido (portfolio)", withClient(async () => {
  const r = await insertSignal(makeSignalInput({ productId: null, idempotencyKey: "idem-portfolio" }));
  assert.equal(r.outcome, "inserted");
  assert.equal(r.record!.product_id, null);
}));

test("getSignal de id inexistente não falha silenciosamente", withClient(async () => {
  const r = await getSignal("sig-inexistente");
  assert.notEqual(r.outcome, "inserted");
  assert.match(r.error ?? "", /não encontrado/);
}));

// ============================================================================
// Sanitização
// ============================================================================
test("sanitizeText remove tokens, secrets e authorization", () => {
  assert.equal(sanitizeText("normal ok"), "normal ok");
  assert.match(sanitizeText("Authorization: Bearer xyz"), /\[SANITIZED\]/);
  assert.match(sanitizeText("token: sk-abc123"), /\[SANITIZED\]/);
  assert.match(sanitizeText("service_role visível"), /\[SANITIZED\]/);
});

test("sanitizeMetadata remove chaves sensíveis", () => {
  const out = sanitizeMetadata({
    nota: "ok",
    token: "secreto",
    Authorization: "Bearer x",
    raw_content: "<html>…",
    prompt: "instrução externa",
    aninhado: { secret: "interno", ok: 1 },
  });
  assert.equal(out.nota, "ok");
  assert.equal(out.token, undefined);
  assert.equal(out.Authorization, undefined);
  assert.equal(out.raw_content, undefined);
  assert.equal(out.prompt, undefined);
  assert.equal((out.aninhado as Record<string, unknown>).ok, 1);
  assert.equal((out.aninhado as Record<string, unknown>).secret, undefined);
});

test("metadata de entrada não-objeto vira {} sem silenciar erro de esquema", () => {
  assert.deepEqual(sanitizeMetadata("string"), {});
  assert.deepEqual(sanitizeMetadata(null), {});
  assert.deepEqual(sanitizeMetadata([1, 2]), {});
});

// ============================================================================
// Cliente indisponível — sem fallback silencioso
// ============================================================================
test("insert sem cliente retorna missing_supabase (nunca falha silenciosa)", async () => {
  setCommercialBrainClientForTests(null);
  const r = await insertSignal(makeSignalInput());
  assert.equal(r.outcome, "missing_supabase");
  assert.ok(r.error);
  const ar = await insertArtifact(makeArtifactInput());
  assert.equal(ar.outcome, "missing_supabase");
  setCommercialBrainClientForTests(null);
});

test("erros do banco são reportados com outcome database_error", async () => {
  fake = new FakeSupabaseClient();
  fake.failWith = { message: "connection refused", code: "PGRST301" };
  setCommercialBrainClientForTests(fake as unknown as SupabaseClient);
  const r = await insertSignal(makeSignalInput());
  assert.equal(r.outcome, "database_error");
  const g = await getSignal("sig-20260815-1");
  assert.equal(g.outcome, "database_error");
  setCommercialBrainClientForTests(null);
});

// ============================================================================
// Ausência de autoridade — o repository não expõe mutação proibida
// ============================================================================
test("repository não expõe métodos de execução, publicação ou mutação de products", async () => {
  const repo = await import("../server/repositories/commercialBrainRepository");
  const exports = Object.keys(repo);
  const banned = [/execute/i, /mutate/i, /publish/i, /applyRecommend/i, /approve/i, /deleteArtifact/i, /updateProduct/i];
  const violating = exports.filter(n => banned.some(re => re.test(n)));
  assert.deepEqual(violating, [], `métodos proibidos expostos: ${violating.join(",")}`);
});

test("tables exportadas são as duas aprovadas", () => {
  assert.equal(SIGNAL_TABLE, "commercial_signals");
  assert.equal(ARTIFACT_TABLE, "commercial_artifacts");
});
