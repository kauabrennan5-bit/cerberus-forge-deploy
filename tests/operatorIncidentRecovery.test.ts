import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  operatorIncidentRecoveryInternals,
  synchronizeOperatorIncidents,
  type PersistedOperatorIncident,
} from "../server/services/operatorIncidentRecovery";
import type { OperatorHealthObservation } from "../server/services/operatorHealthChecksV2";

type IncidentRow = PersistedOperatorIncident & Record<string, unknown>;
type Filter = (row: IncidentRow) => boolean;

class FakeIncidentQuery implements PromiseLike<{ data: unknown; error: null }> {
  private mode: "read" | "insert" | "update" = "read";
  private payload: Record<string, unknown> = {};
  private filters: Filter[] = [];

  constructor(private readonly rows: IncidentRow[]) {}

  select(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }

  insert(payload: Record<string, unknown>): this {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push(row => row[field] === value);
    return this;
  }

  in(field: string, values: readonly unknown[]): this {
    this.filters.push(row => values.includes(row[field]));
    return this;
  }

  private matchingRows(): IncidentRow[] {
    return this.rows.filter(row => this.filters.every(filter => filter(row)));
  }

  private async execute(single = false): Promise<{ data: unknown; error: null }> {
    if (this.mode === "read") return { data: this.matchingRows().map(row => ({ ...row })), error: null };
    if (this.mode === "insert") {
      this.rows.push({ ...this.payload } as IncidentRow);
      return { data: null, error: null };
    }
    const matches = this.matchingRows();
    for (const row of matches) Object.assign(row, this.payload);
    return { data: single && matches[0] ? { incident_id: matches[0].incident_id } : null, error: null };
  }

  maybeSingle(): Promise<{ data: unknown; error: null }> {
    return this.execute(true);
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class FakeIncidentClient {
  constructor(readonly rows: IncidentRow[]) {}
  from(table: string): FakeIncidentQuery {
    assert.equal(table, "operational_incidents");
    return new FakeIncidentQuery(this.rows);
  }
}

const currentObservation: OperatorHealthObservation = {
  name: "OpenAI",
  status: "DOWN",
  timestamp: "2026-09-09T05:36:42.034Z",
  latencyMs: 420,
  httpStatus: 429,
  error: "OPENAI_PROVIDER_DOWN",
  diagnostic: {
    state: "OPENAI_PROVIDER_DOWN",
    errorCode: "credit_balance_exhausted",
    errorParam: null,
  },
};

function staleIncident(): IncidentRow {
  return {
    incident_id: "old-invalid-payload",
    incident_type: "OPENAI_DOWN",
    fingerprint: "old-fingerprint",
    severity: "ERROR",
    status: "OPEN",
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
    source: "cerberus_operator_v2",
    correlation_id: "old-correlation",
    operation_id: "old-operation",
    summary: "OpenAI DOWN: invalid_value",
    error_code: "invalid_value",
    impact: "OpenAI health is DOWN",
    recoverability: "AUTO",
    metadata: { component: "OpenAI" },
  };
}

test("a new provider diagnosis supersedes the stale active fingerprint", async () => {
  const client = new FakeIncidentClient([staleIncident()]);
  const result = await synchronizeOperatorIncidents([currentObservation], {
    client: client as unknown as SupabaseClient,
  });

  assert.deepEqual(result.resolved, ["old-invalid-payload"]);
  assert.equal(result.opened.length, 1);
  assert.equal(result.active, 1);
  assert.equal(client.rows.find(row => row.incident_id === "old-invalid-payload")?.status, "RESOLVED");
  assert.equal(
    client.rows.find(row => row.incident_id === "old-invalid-payload")?.recovery_reason,
    "SUPERSEDED_BY_NEW_COMPONENT_HEALTH_DIAGNOSTIC",
  );
  const current = client.rows.find(row => row.status === "OPEN");
  assert.equal(current?.error_code, "OPENAI_PROVIDER_DOWN");
  assert.equal(current?.health_evidence && (current.health_evidence as Record<string, unknown>).error, "OPENAI_PROVIDER_DOWN");
});

test("repeating the same diagnosis is idempotent and keeps one active incident", async () => {
  const currentFingerprint = operatorIncidentRecoveryInternals.incidentFingerprint(currentObservation);
  const client = new FakeIncidentClient([{
    ...staleIncident(),
    incident_id: `OPV2-${currentFingerprint.slice(0, 16)}`,
    fingerprint: currentFingerprint,
    error_code: "OPENAI_PROVIDER_DOWN",
  }]);

  const result = await synchronizeOperatorIncidents([currentObservation], {
    client: client as unknown as SupabaseClient,
  });

  assert.deepEqual(result.opened, []);
  assert.deepEqual(result.resolved, []);
  assert.equal(result.updated.length, 1);
  assert.equal(result.active, 1);
  assert.equal(client.rows.filter(row => row.status === "OPEN").length, 1);
});
