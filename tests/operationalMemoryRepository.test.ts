import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalEvent } from "../server/services/operationalEvents";
import {
  getLastOperation,
  getOperationalEventsByCorrelationId,
  getOperationalOperation,
  persistOperationalEvent,
  persistOperationalIncident,
  persistOperationalOperation,
  persistOperationalRecoveryAttempt,
  recoverOperationalContext,
  setOperationalMemoryClientForTests,
} from "../server/repositories/operationalMemoryRepository";

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private sortColumn?: string;
  private sortAscending = true;
  private maxRows?: number;
  private mode: "select" | "insert" | "upsert" = "select";
  private input: Record<string, unknown> | undefined;
  private conflictColumn?: string;

  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}

  select(): this { return this; }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this; }
  order(column: string, options: { ascending: boolean }): this { this.sortColumn = column; this.sortAscending = options.ascending; return this; }
  limit(value: number): this { this.maxRows = value; return this; }
  insert(row: Record<string, unknown>): this { this.mode = "insert"; this.input = row; return this; }
  upsert(row: Record<string, unknown>, options: { onConflict: string }): this { this.mode = "upsert"; this.input = row; this.conflictColumn = options.onConflict; return this; }

  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    const result = this.execute();
    return Promise.resolve({ data: result.length ? result[0] : null, error: null });
  }

  then<TResult1 = { data: Record<string, unknown>[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Record<string, unknown>[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.execute(), error: null }).then(onfulfilled, onrejected);
  }

  private execute(): Record<string, unknown>[] {
    const rows = this.client.rows(this.table);
    if (this.mode === "insert" && this.input) {
      const row = { ...this.input };
      rows.push(row);
      return [row];
    }
    if (this.mode === "upsert" && this.input) {
      const index = this.conflictColumn ? rows.findIndex(row => row[this.conflictColumn as string] === this.input?.[this.conflictColumn as string]) : -1;
      if (index >= 0) rows[index] = { ...rows[index], ...this.input };
      else rows.push({ ...this.input });
      return [index >= 0 ? rows[index] : rows[rows.length - 1]];
    }
    let result = rows.filter(row => this.filters.every(([column, value]) => row[column] === value));
    if (this.sortColumn) {
      const column = this.sortColumn;
      result = [...result].sort((left, right) => {
        const a = String(left[column] || "");
        const b = String(right[column] || "");
        return this.sortAscending ? a.localeCompare(b) : b.localeCompare(a);
      });
    }
    return this.maxRows ? result.slice(0, this.maxRows) : result;
  }
}

class FakeSupabaseClient {
  private readonly storage = new Map<string, Array<Record<string, unknown>>>();
  from(table: string): FakeQueryBuilder { return new FakeQueryBuilder(this, table); }
  rows(table: string): Array<Record<string, unknown>> {
    if (!this.storage.has(table)) this.storage.set(table, []);
    return this.storage.get(table) as Array<Record<string, unknown>>;
  }
}

test.after(() => setOperationalMemoryClientForTests(undefined));

test("persiste evento sanitizado e trata repetição do mesmo eventId como idempotente", async () => {
  setOperationalMemoryClientForTests(new FakeSupabaseClient() as any);
  const event = createOperationalEvent({
    eventType: "test.memory.persisted",
    source: "test",
    actor: "system",
    correlationId: "OP-MEM-1",
    severity: "INFO",
    outcome: "SUCCESS",
    environment: "test",
    payload: { safe: "ok", password: "do-not-store", rawContent: "[conteudo da pagina]" },
  });

  const first = await persistOperationalEvent(event);
  const second = await persistOperationalEvent(event);
  const events = await getOperationalEventsByCorrelationId("OP-MEM-1");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(events.value?.length, 1);
  assert.equal(JSON.stringify(events.value).includes("do-not-store"), false);
  assert.equal(JSON.stringify(events.value).includes("conteudo da pagina"), false);
});

test("persiste operação, incidente e recovery, mas cold start continua incerto e não permite replay", async () => {
  setOperationalMemoryClientForTests(new FakeSupabaseClient() as any);
  const operationId = "OP-MEM-2";
  const incidentId = "INC-MEM-2";
  const now = new Date().toISOString();
  const operation = await persistOperationalOperation({
    operationId,
    operationType: "TEST_OPERATION",
    status: "RUNNING",
    actor: "operator",
    correlationId: operationId,
    attempt: 1,
    createdAt: now,
    startedAt: now,
    metadata: { token: "must-not-leak" },
    schemaVersion: "1.0",
  });
  await persistOperationalIncident({
    incidentId,
    incidentType: "TEST_INCIDENT",
    fingerprint: "fingerprint-2",
    severity: "ERROR",
    status: "OPEN",
    createdAt: now,
    updatedAt: now,
    source: "test",
    correlationId: operationId,
    operationId,
    summary: "Falha observável",
    impact: "Teste controlado",
    recoverability: "MANUAL",
    metadata: {},
  });
  await persistOperationalRecoveryAttempt({
    attemptId: "OP-MEM-2-ATT-1",
    incidentId,
    operationId,
    attemptNumber: 1,
    strategy: "NOOP_TEST",
    startedAt: now,
    completedAt: now,
    outcome: "SUCCESS",
    metadata: {},
  });
  await persistOperationalEvent(createOperationalEvent({
    eventType: "incident.opened",
    source: "test",
    actor: "operator",
    correlationId: operationId,
    severity: "ERROR",
    outcome: "PENDING",
    environment: "test",
    payload: { incidentId },
  }));

  const loaded = await getOperationalOperation(operationId);
  const lastOperation = await getLastOperation();
  const recovered = await recoverOperationalContext(operationId);

  assert.equal(operation.ok, true);
  assert.equal(loaded.value?.operationId, operationId);
  assert.equal(lastOperation.value?.operationId, operationId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value?.uncertain, true);
  assert.equal(recovered.value?.replayAllowed, false);
  assert.equal(recovered.value?.incident?.incidentId, incidentId);
});

test("falha de banco é explícita e não cria fallback silencioso", async () => {
  setOperationalMemoryClientForTests(null);
  const result = await persistOperationalEvent(createOperationalEvent({
    eventType: "test.memory.unavailable",
    source: "test",
    actor: "system",
    correlationId: "OP-MEM-3",
    severity: "WARNING",
    outcome: "BLOCKED",
    environment: "test",
  }));

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /Supabase|memória operacional/i);
});
