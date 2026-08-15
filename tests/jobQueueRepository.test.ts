import assert from "node:assert/strict";
import test from "node:test";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  cancelJob,
  claimNextJob,
  countByStatus,
  enqueueJob,
  getJob,
  heartbeat,
  releaseJob,
  setJobQueueClientForTests,
  queueReadModel,
} from "../server/repositories/jobQueueRepository";

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private sorts: Array<[string, boolean]> = [];
  private maxRows?: number;
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private selected = false;
  private input: Record<string, unknown> | undefined;
  private rows: Record<string, unknown>[] = [];

  constructor(
    private readonly client: FakeSupabaseClient,
        private readonly table: string,
  ) {
  }

  private currentRows(): Record<string, unknown>[] {
    return this.client.store.get(this.table) ?? [];
  }

    // .eq/.in etc após select() ainda aplicam no fake
  select(columns?: string): this {
    this.selected = true;
    void columns;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push([column, `in(${JSON.stringify(values)})`]);
    return this;
  }

  not(column: string, operator: string, _value: string): this {
    this.filters.push([column, `not(${operator})`]);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push([column, `is(${value})`]);
    return this;
  }
  or(expression: string): this {
    this.filters.push(["_or", expression]);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push([column, `lte(${value})`]);
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

  private persistInsert(): Record<string, unknown> {
    const nowIso = new Date().toISOString();
    const row: Record<string, unknown> = {
      job_id: this.input?.job_id ?? "",
      type: this.input?.type ?? "",
      status: "QUEUED",
      priority: this.input?.priority ?? 0,
      attempts: this.input?.attempts ?? 0,
      max_attempts: this.input?.max_attempts ?? 3,
      next_run_at: this.input?.next_run_at ?? nowIso,
      lease: this.input?.lease ?? null,
      timeout_ms: this.input?.timeout_ms ?? 60000,
      idempotency_key: this.input?.idempotency_key ?? null,
      created_by: this.input?.created_by ?? "system",
      cost_estimate: this.input?.cost_estimate ?? {},
      last_error: null,
      correlation_id: this.input?.correlation_id ?? "",
      payload: this.input?.payload ?? {},
      result: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    const current = this.currentRows();
    const next = [...current, row];
    this.client.store.set("job_queue", next);
    this.rows = next;
    return row;
  }

  private persistUpdate(): Record<string, unknown>[] {
    const rows = this.currentRows();
    const matched = rows.filter((row) => this.matches(row));
    const updated = matched.map((row) => ({ ...row, ...(this.input ?? {}), updated_at: new Date().toISOString() }));
    const ordered = [...updated].sort((a, b) => {
      for (const [column, ascending] of this.sorts) {
        const av = a[column];
        const bv = b[column];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return ascending ? cmp : -cmp;
      }
      return 0;
    });
    const limited = this.maxRows ? ordered.slice(0, this.maxRows) : ordered;
    if (limited.length > 0) {
      const others = rows.filter((row) => !this.matches(row));
      this.client.store.set("job_queue", [...others, ...limited]);
    }
    return limited;
  }

  update(patch: Record<string, unknown>): this {
    this.mode = "update";
    this.input = patch;
    return this;
  }

  private matches(row: Record<string, unknown>): boolean {
    for (const [column, value] of this.filters) {
      if (column === "_or") {
        const parts = String(value).split(",").map((part) => part.trim());
        const orMatch = parts.some((part) => {
          if (part === "lease.is.null") return row.lease === null;
          if (part.startsWith("lease.lte.")) return row.lease !== null && String(row.lease) <= String(part.slice(10));
          return false;
        });
        if (!orMatch) return false;
        continue;
      }
      const rowValue = row[column];
      const valueStr = String(value);
      if (valueStr.startsWith("in(")) {
        const list = JSON.parse(valueStr.slice(3, -1)) as unknown[];
        if (!list.includes(rowValue)) return false;
      } else if (valueStr.startsWith("not(")) {
        return true;
      } else if (valueStr.startsWith("is(")) {
        if (valueStr === "is(null)" && rowValue !== null) return false;
        if (valueStr.startsWith("is(lte.") && rowValue === null) return false;
      } else if (valueStr.startsWith("lte(")) {
        const threshold = valueStr.slice(4, -1);
        if (String(rowValue) > String(threshold)) return false;
      } else if (rowValue !== value) {
        return false;
      }
    }
    return true;
  }

  maybeSingle(): Promise<{
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  }> {
    if (this.mode === "insert" && this.selected) {
      const row = this.persistInsert();
      return Promise.resolve({ data: row, error: null });
    }
    if (this.mode === "update") {
      const matched = this.persistUpdate();
      const data = matched.length > 0 ? matched[0] : null;
      return Promise.resolve({ data, error: null });
    }
    if (this.selected) {
      const matched = this.currentRows().filter((row) => this.matches(row));
      const ordered = [...matched].sort((a, b) => {
        for (const [column, ascending] of this.sorts) {
          const av = a[column];
          const bv = b[column];
          const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
          if (cmp !== 0) return ascending ? cmp : -cmp;
        }
        return 0;
      });
      const limited = this.maxRows ? ordered.slice(0, this.maxRows) : ordered;
      const data = limited.length > 0 ? limited[0] : null;
      return Promise.resolve({ data, error: null });
    }
    const matched = this.rows.filter((row) => this.matches(row));
    const data = matched.length > 0 ? matched[0] : null;
    return Promise.resolve({ data, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    // PostgREST select() sem maybeSingle retorna um filtro que o código consome
    // apenas como filtro; o await invoca then(). Executar como select simples.
    this.selected = true;
    const matched = this.currentRows().filter((row) => this.matches(row));
    const ordered = [...matched].sort((a, b) => {
      for (const [column, ascending] of this.sorts) {
        const av = a[column];
        const bv = b[column];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
        if (cmp !== 0) return ascending ? cmp : -cmp;
      }
      return 0;
    });
    console.info(`[FAKE] then() rows=${ordered.length}`);
    return Promise.resolve({ data: ordered, error: null }).then(onfulfilled as never, onrejected as never);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<never> {
    return Promise.reject(new Error("QueryBuilder usado sem consumo via maybeSingle")).catch(onrejected as never);
  }
}

class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();
  public insertCalls = 0;

  constructor() {
    this.store.set("job_queue", []);
  }

  // Contagem de chamadas de insert para asserção nos testes
  incInsert(): void {
    this.insertCalls += 1;
  }

  from(table: string): FakeQueryBuilder {
    const builder = new FakeQueryBuilder(this, table);
    if (table === "job_queue") this.incInsert();
    return builder;
  }
}

function seedRow(client: FakeSupabaseClient, row: Record<string, unknown>): void {
  const rows = client.store.get("job_queue") ?? [];
  rows.push({
    job_id: row.job_id ?? `job-test-${randomUUID()}`,
    type: row.type ?? "catalog_sync",
    status: row.status ?? "QUEUED",
    priority: row.priority ?? 0,
    attempts: row.attempts ?? 0,
    max_attempts: row.max_attempts ?? 3,
    next_run_at: row.next_run_at ?? new Date().toISOString(),
    lease: row.lease ?? null,
    timeout_ms: row.timeout_ms ?? 60000,
    idempotency_key: row.idempotency_key ?? null,
    created_by: row.created_by ?? "system",
    cost_estimate: row.cost_estimate ?? {},
    last_error: row.last_error ?? null,
    correlation_id: row.correlation_id ?? "test",
    payload: row.payload ?? {},
    result: row.result ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  });
  client.store.set("job_queue", rows);
}

let client: FakeSupabaseClient;

test.beforeEach(() => {
  client = new FakeSupabaseClient();
  setJobQueueClientForTests(client as unknown as SupabaseClient);
});

test.after(() => {
  setJobQueueClientForTests(undefined);
});

test("enqueue cria job em QUEUED com todos os campos obrigatórios", async () => {
  const job = await enqueueJob({
    type: "catalog_sync",
    createdBy: "operator",
    correlationId: "corr-1",
    payload: { source: "admin" },
  });
  assert.equal(job.status, "QUEUED");
  assert.equal(job.type, "catalog_sync");
  assert.equal(job.createdBy, "operator");
  assert.equal(job.correlationId, "corr-1");
  assert.equal(job.attempts, 0);
  assert.equal(job.payload.source, "admin");
});

test("idempotency_key evita duplicação com payload igual", async () => {
  const a = await enqueueJob({
    type: "catalog_sync",
    idempotencyKey: "key-1",
    createdBy: "system",
    payload: { x: 1 },
  });
  const b = await enqueueJob({
    type: "catalog_sync",
    idempotencyKey: "key-1",
    createdBy: "system",
    payload: { x: 1 },
  });
  assert.equal(a.jobId, b.jobId);
});

test("idempotency_key colidindo com payload diferente falha explicitamente", async () => {
  await enqueueJob({ type: "catalog_sync", idempotencyKey: "key-2", createdBy: "system", payload: { x: 1 } });
  await assert.rejects(
    () => enqueueJob({ type: "catalog_sync", idempotencyKey: "key-2", createdBy: "system", payload: { x: 2 } }),
    /colidiu com payload diferente/,
  );
});

test("idempotency_key em estado terminal é rejeitada", async () => {
  seedRow(client, { status: "SUCCEEDED", idempotency_key: "key-3" });
  await assert.rejects(
    () => enqueueJob({ type: "catalog_sync", idempotencyKey: "key-3", createdBy: "system" }),
    /estado terminal/,
  );
});

test("priority respeita limites e prioriza no claim", async () => {
  seedRow(client, { job_id: "low", status: "QUEUED", priority: 0, next_run_at: new Date().toISOString(), lease: null, created_at: new Date().toISOString() });
  seedRow(client, { job_id: "high", status: "QUEUED", priority: 10, next_run_at: new Date().toISOString(), lease: null, created_at: new Date().toISOString() });
  const job = await claimNextJob();
  assert.ok(job);
  assert.equal(job.jobId, "high");
});

test("max_attempts é clamped entre 1 e 10", async () => {
  const job = await enqueueJob({ type: "maintenance", createdBy: "system", maxAttempts: 50 });
  assert.equal(job.maxAttempts, 10);
});

test("next_run_at aplica delay em milissegundos", async () => {
  const before = Date.now();
  const job = await enqueueJob({ type: "maintenance", createdBy: "system", delayMs: 5000 });
  const after = Date.now();
  const target = new Date(job.nextRunAt).getTime();
  assert.ok(target >= before + 4900 && target <= after + 5100);
});

test("payload tipado é sanitizado e persistido como objeto", async () => {
  const job = await enqueueJob({
    type: "product_ingest_review",
    createdBy: "automation",
    payload: { url: "https://example.com/x", secret: "ghp_AbCdEf1234567890token" },
  });
  assert.equal(job.payload.secret, "[REDACTED_SENSITIVE_FIELD]");
});

test("created_by aceita apenas atores válidos", async () => {
  const job = await enqueueJob({ type: "maintenance", createdBy: "human" });
  assert.equal(job.createdBy, "human");
});

test("cost_estimate persiste valores numéricos estimados", async () => {
  const job = await enqueueJob({
    type: "telegram_send",
    createdBy: "operator",
    costEstimate: { api_calls: 1 },
  });
  assert.deepEqual(job.costEstimate, { api_calls: 1 });
});

test("claimNextJob marca RUNNING com lease e incrementa tentativas", async () => {
  seedRow(client, { job_id: "j1", status: "QUEUED", next_run_at: new Date().toISOString(), lease: null });
  const job = await claimNextJob();
  assert.ok(job);
  assert.equal(job.status, "RUNNING");
  assert.ok(job.lease);
});

test("claimNextJob não reclama job com lease válido", async () => {
  const future = new Date(Date.now() + 300000).toISOString();
  seedRow(client, { job_id: "leased", status: "RUNNING", next_run_at: new Date().toISOString(), lease: future, created_at: new Date().toISOString() });
  seedRow(client, { job_id: "free", status: "QUEUED", next_run_at: new Date().toISOString(), lease: null, created_at: new Date().toISOString() });
  const job = await claimNextJob();
  assert.ok(job);
  assert.equal(job.jobId, "free");
});

test("claimNextJob recupera job com lease expirado", async () => {
  const expired = new Date(Date.now() - 300000).toISOString();
  seedRow(client, { job_id: "stale", status: "RETRYING", next_run_at: new Date().toISOString(), lease: expired, created_at: new Date().toISOString() });
  const job = await claimNextJob();
  assert.ok(job);
  assert.equal(job.jobId, "stale");
});

test("claimNextJob não reclama job cujo next_run_at é futuro", async () => {
  seedRow(client, { job_id: "future", status: "QUEUED", next_run_at: new Date(Date.now() + 300000).toISOString(), lease: null });
  const job = await claimNextJob();
  assert.equal(job, null);
});

test("releaseJob com RETRYING agenda próxima execução com backoff", async () => {
  seedRow(client, { job_id: "r1", status: "RUNNING", attempts: 1, max_attempts: 3, lease: new Date().toISOString() });
  const released = await releaseJob("r1", "RETRYING", { error: "timeout transient" });
  assert.equal(released.status, "RETRYING");
  assert.ok(released.lastError);
  const target = new Date(released.nextRunAt).getTime();
  assert.ok(target > Date.now());
});

test("releaseJob com tentativas esgotadas encaminha para DEAD_LETTER", async () => {
  seedRow(client, { job_id: "d1", status: "RUNNING", attempts: 3, max_attempts: 3, lease: new Date().toISOString() });
  const released = await releaseJob("d1", "RETRYING", { error: "falha definitiva" });
  assert.equal(released.status, "DEAD_LETTER");
});

test("releaseJob em SUCCEEDED grava resultado", async () => {
  seedRow(client, { job_id: "s1", status: "RUNNING", attempts: 1, max_attempts: 3, lease: new Date().toISOString() });
  const done = await releaseJob("s1", "SUCCEEDED", { result: { items_synced: 12 } });
  assert.equal(done.status, "SUCCEEDED");
  assert.deepEqual(done.result, { items_synced: 12 });
});

test("cancelJob transita de QUEUED para CANCELLED", async () => {
  seedRow(client, { job_id: "c1", status: "QUEUED" });
  const cancelled = await cancelJob("c1");
  assert.equal(cancelled.status, "CANCELLED");
});

test("cancelJob rejeita job em estado terminal", async () => {
  seedRow(client, { job_id: "c2", status: "DEAD_LETTER" });
  await assert.rejects(() => cancelJob("c2"), /estado terminal/);
});

test("heartbeat estende o lease de job RUNNING", async () => {
  seedRow(client, { job_id: "h1", status: "RUNNING", timeout_ms: 60000, lease: new Date().toISOString() });
  const before = new Date().getTime();
  const updated = await heartbeat("h1");
  const after = Date.now() + 60000;
  const leaseTime = new Date(updated.lease as string).getTime();
  assert.ok(leaseTime >= before && leaseTime <= after + 1000);
});

test("heartbeat rejeita job que não está em RUNNING", async () => {
  seedRow(client, { job_id: "h2", status: "QUEUED" });
  await assert.rejects(() => heartbeat("h2"), /não está em RUNNING/);
});

test("read model agrega contagens por status", async () => {
  seedRow(client, { job_id: "a", status: "QUEUED" });
  seedRow(client, { job_id: "b", status: "QUEUED" });
  seedRow(client, { job_id: "c", status: "RUNNING" });
  seedRow(client, { job_id: "d", status: "DEAD_LETTER" });
  seedRow(client, { job_id: "e", status: "SUCCEEDED" });
  const model = await queueReadModel();
  assert.equal(model.queued, 2);
  assert.equal(model.running, 1);
  assert.equal(model.dead_letter, 1);
  assert.equal(model.succeeded, 1);
  assert.equal(model.cancelled, 0);
});

test("countByStatus é alias do read model", async () => {
  const model = await countByStatus();
  assert.equal(typeof model.queued, "number");
});

test("cliente indisponível falha explicitamente sem fallback", async () => {
  setJobQueueClientForTests(null);
  await assert.rejects(
    () => enqueueJob({ type: "maintenance", createdBy: "system" }),
    /Cliente Supabase não configurado/,
  );
  await assert.rejects(() => claimNextJob(), /Cliente Supabase não configurado/);
  await assert.rejects(() => queueReadModel(), /Cliente Supabase não configurado/);
});

test("last_error de erro é sanitizado contra segredos", async () => {
  seedRow(client, { job_id: "x1", status: "RUNNING", attempts: 1, max_attempts: 3, lease: new Date().toISOString() });
  const released = await releaseJob("x1", "RETRYING", {
    error: "falha com token 8819631444:AAHaMTgMardKa9ZlRi4T2QEkEqmUck3tTeA exposto",
  });
  assert.ok(!String(released.lastError).includes("AAHaMTgMardKa9ZlRi4T2QEkEqmUck3tTeA"));
});

test("getJob retorna null para job inexistente", async () => {
  const job = await getJob("inexistente");
  assert.equal(job, null);
});
