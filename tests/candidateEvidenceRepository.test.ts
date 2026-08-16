import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  EVIDENCE_KINDS,
  FIELD_STATES,
  SOURCE_TYPES,
  COLLECTION_METHODS,
  EVIDENCE_QUALITIES,
  FIELD_NAMES,
  fieldHash,
  persistEvidence,
  listEvidence,
  listResearchSessions,
  listFieldEvidence,
  listCandidateEvidence,
  deleteEvidenceForProof,
  setCandidateEvidenceClientForTests,
} from "../server/repositories/candidateEvidenceRepository";

// ============================================================================
// Fake Supabase client (padrão Blocos N1/N2/13/14/15/16/17)
// ============================================================================

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private sortColumn?: string;
  private sortAscending = true;
  private maxRows?: number;
  private rangeStart?: number;
  private rangeEnd?: number;
  private mode: string = "select";
  private input?: Record<string, unknown>;
  private inFilters: Array<[string, unknown[]]> = [];

  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}

  select(_columns?: string, _options?: unknown): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.inFilters.push([column, values]);
    // No Supabase real, delete() pode vir antes do .in() (chain delete().in()).
    // Se já estamos em modo delete, executar a remoção imediatamente e
    // guardar o resultado para o then() final resolver.
    if (this.mode === "delete") {
      this._executeDelete();
    }
    return this;
  }

  private _executeDelete(): void {
    const store = this.client.store.get(this.table) ?? [];
    const remaining = store.filter(row => !this.matches(row));
    this._deleted = store.length - remaining.length;
    this.client.store.set(this.table, remaining);
    this.mode = "delete_done"; // marcador interno; então() resolve o payload
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.sortColumn = column;
    this.sortAscending = options?.ascending ?? true;
    return this;
  }

  limit(value: number): this {
    this.maxRows = value;
    return this;
  }

  range(start: number, end: number): this {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }

  delete(): this {
    this.mode = "delete";
    return this;
  }
  private _deleted = 0;


  single(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const row = { ...(this.input ?? {}) };
      const rows = this.client.store.get(this.table) ?? [];
      // Respeitar o UNIQUE de field_hash (simulação do Postgres)
      if (row.field_hash) {
        const duplicate = rows.find(r => r.field_hash === row.field_hash);
        if (duplicate) {
          const err = { message: "duplicate key value violates unique constraint field_hash", code: "23505" };
          return Promise.resolve({ data: null, error: err });
        }
      }
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  private rows(): Record<string, unknown>[] {
    return this.client.store.get(this.table) ?? [];
  }

  private matches(row: Record<string, unknown>): boolean {
    const eqMatch = this.filters.every(([column, value]) => row[column] === value);
    const inMatch = this.inFilters.every(([column, values]) =>
      Array.isArray(values) && values.includes(row[column]),
    );
    return eqMatch && inMatch;
  }

  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let out = [...rows];
    if (this.sortColumn) {
      out.sort((a, b) => {
        const av = String(a[this.sortColumn!] ?? "");
        const bv = String(b[this.sortColumn!] ?? "");
        return this.sortAscending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.rangeStart !== undefined && this.rangeEnd !== undefined) {
      out = out.slice(this.rangeStart, this.rangeEnd + 1);
    }
    if (this.maxRows !== undefined) out = out.slice(0, this.maxRows);
    return out;
  }

  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const matched = this.sorted(this.rows().filter(row => this.matches(row)));
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    // delete().in() executado no in() (chain Supabase): se pendente, executar
    if (this.mode === "delete") {
      this._executeDelete();
    }
    const matched = this.sorted(this.rows().filter(row => this.matches(row)));
    const payload = {
      data: matched,
      error: null,
      count: matched.length,
      deleted: this._deleted,
    };
    return Promise.resolve(payload).then(onfulfilled as never, onrejected as never);
  }
}

class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();

  constructor() {
    this.store.set("candidate_evidence", []);
  }

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }
}

// ============================================================================
// Setup
// ============================================================================

let client: FakeSupabaseClient;

test.beforeEach(() => {
  client = new FakeSupabaseClient();
  setCandidateEvidenceClientForTests(client as unknown as SupabaseClient);
});

test.after(() => {
  setCandidateEvidenceClientForTests(null);
});

const sessionInput = {
  candidate_id: "can-test-001",
  research_id: "rs-test-session-1",
  kind: "RESEARCH_SESSION",
  source_url: "https://produto.mercadolivre.com.br/MLB-12345",
  source_type: "scrape",
  collection_method: "SCRAPE",
  observed_at: "2026-08-16T10:00:00Z",
  evidence_hash: "sha256:session-digest",
};

const fieldInput = (overrides: Record<string, unknown> = {}) => ({
  candidate_id: "can-test-001",
  research_id: "rs-test-session-1",
  kind: "FIELD",
  field_name: "price",
  field_value: { value: 99.9, unknown: false },
  field_state: "KNOWN",
  source_url: "https://produto.mercadolivre.com.br/MLB-12345",
  source_type: "marketplace_page",
  collection_method: "SCRAPE",
  observed_at: "2026-08-16T10:00:01Z",
  evidence_hash: "sha256:field-digest-1",
  quality: "HIGH",
  ...overrides,
});

// ============================================================================
// Testes de contrato
// ============================================================================

test("catálogos fechados espelham a migration (CHECKs)", () => {
  assert.deepEqual(EVIDENCE_KINDS, ["RESEARCH_SESSION", "FIELD"]);
  assert.deepEqual(FIELD_STATES, ["KNOWN", "UNKNOWN", "DERIVED", "COLLECTION_FAILED", "CONTRADICTED"]);
  assert.deepEqual(SOURCE_TYPES, ["marketplace_page", "url_slug", "manual", "api", "scrape", "other"]);
  assert.deepEqual(COLLECTION_METHODS, ["MANUAL", "SCRAPE", "API", "OTHER"]);
  assert.deepEqual(EVIDENCE_QUALITIES, ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
  assert.deepEqual(FIELD_NAMES, ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"]);
});

test("cria sessão de pesquisa com proveniência e temporalidade completas", async () => {
  const result = await persistEvidence(sessionInput);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.ok(result.evidence_id?.startsWith("evi-"));
  assert.equal(result.evidence?.kind, "RESEARCH_SESSION");
  assert.equal(result.evidence?.candidate_id, "can-test-001");
  assert.equal(result.evidence?.field_state, "UNKNOWN");
  assert.equal(result.evidence?.field_value, null); // sessão NUNCA tem field_value
  assert.equal(result.evidence?.field_hash, null); // sessão NUNCA tem field_hash
  assert.equal(result.evidence?.metadata?.discovery_block, "N3");
});

test("cria evidência de campo KNOWN com proveniência completa", async () => {
  const result = await persistEvidence(fieldInput());
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "created");
  assert.equal(result.evidence?.field_state, "KNOWN");
  assert.equal(result.evidence?.field_value?.value, 99.9);
  assert.equal(result.evidence?.field_value?.unknown, false);
  assert.equal(result.evidence?.quality, "HIGH");
  assert.ok(result.evidence?.field_hash);
  assert.equal(result.evidence?.metadata?.discovery_block, "N3");
});

test("CONTRADIÇÃO: nova evidência CONTRADICTED preserva referência às anteriores (ambas permanecem)", async () => {
  const first = await persistEvidence(fieldInput({ evidence_hash: "sha256:price-99" }));
  assert.equal(first.ok, true);

  // Segunda coleta com preço diferente — CONTRADIÇÃO explícita
  const second = await persistEvidence(
    fieldInput({
      evidence_hash: "sha256:price-149",
      field_value: { value: 149.9, unknown: false },
      field_state: "CONTRADICTED",
      contradicted_by_evidence_ids: [first.evidence_id!],
    }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.outcome, "created");
  assert.equal(second.evidence?.field_state, "CONTRADICTED");
  assert.equal(second.evidence?.field_value?.value, 149.9);
  assert.equal(result_evidence_count(), 2);
  // A primeira evidência (KNOWN, 99.9) permanece INTACTA — nada foi apagado
  const all = await listFieldEvidence("can-test-001", "price");
  const firstStill = all.evidence.find(e => e.evidence_id === first.evidence_id);
  assert.ok(firstStill);
  assert.equal(firstStill?.field_state, "KNOWN");
  assert.equal(firstStill?.field_value?.value, 99.9);
  // A contradição referencia a anterior
  assert.deepEqual(second.evidence?.metadata?.contradiction_with, [first.evidence_id]);
});

test("DERIVED/url_slug: valor derivado da URL nunca vira KNOWN de página", async () => {
  const result = await persistEvidence(
    fieldInput({
      field_state: "DERIVED",
      source_type: "url_slug",
      evidence_hash: "sha256:derived",
      quality: "LOW",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.field_state, "DERIVED");
  assert.equal(result.evidence?.source_type, "url_slug");
  assert.equal(result.evidence?.quality, "LOW");
});

test("COLLECTION_FAILED preserva a tentativa identificável com UNKNOWN no dado", async () => {
  const result = await persistEvidence(
    fieldInput({
      field_state: "COLLECTION_FAILED",
      field_value: { value: null, unknown: true },
      evidence_hash: "sha256:failed",
      quality: "UNKNOWN",
      metadata: { fetch_failed: true, http_status: 403 },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.field_state, "COLLECTION_FAILED");
  assert.equal(result.evidence?.field_value?.value, null);
  assert.equal(result.evidence?.field_value?.unknown, true);
  assert.equal(result.evidence?.quality, "UNKNOWN");
  assert.equal(result.evidence?.metadata?.fetch_failed, true);
  assert.equal(result.evidence?.metadata?.http_status, 403);
});

test("UNKNOWN é estado de ausência, nunca confundido com valor negativo", async () => {
  const result = await persistEvidence(
    fieldInput({
      field_state: "UNKNOWN",
      field_value: { value: null, unknown: true },
      evidence_hash: "sha256:unknown",
      quality: "UNKNOWN",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.field_state, "UNKNOWN");
  assert.equal(result.evidence?.field_value?.value, null);
  assert.equal(result.evidence?.field_value?.unknown, true);
});

test("idempotência: replay idêntico (mesmo field_hash) retorna identical_duplicate sem duplicar", async () => {
  const first = await persistEvidence(fieldInput());
  assert.equal(first.ok, true);
  assert.equal(first.outcome, "created");
  const firstCount = result_evidence_count();

  const second = await persistEvidence(fieldInput());
  assert.equal(second.ok, true);
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.evidence_id, first.evidence_id);
  assert.equal(result_evidence_count(), firstCount);
});

test("evidências de campo DIFERENTE coexistem (field_hash por campo)", async () => {
  const price = await persistEvidence(fieldInput({ evidence_hash: "sha256:price" }));
  const title = await persistEvidence(
    fieldInput({ field_name: "title", field_value: { value: "Luminária", unknown: false }, evidence_hash: "sha256:title" }),
  );
  assert.equal(price.ok, true);
  assert.equal(title.ok, true);
  assert.notEqual(price.evidence_id, title.evidence_id);
  assert.notEqual(price.evidence?.field_hash, title.evidence?.field_hash);
  assert.equal(result_evidence_count(), 2);
});

test("catálogos fechados: kind/field_state/source_type/quality inválidos → rejected", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["kind inválido", { kind: "GHOST" }],
    ["field_state inválido", { field_state: "PROBABLY_TRUE" }],
    ["source_type inválido", { source_type: "telepathy" }],
    ["collection_method inválido", { collection_method: "GUESS" }],
    ["quality inválido", { quality: "95_PERCENT" }],
    ["field_name fora do catálogo", { field_name: "ghost_field" }],
    ["URL vazia/curta", { source_url: "x" }],
  ];
  for (const [label, overrides] of cases) {
    const result = await persistEvidence(fieldInput(overrides));
    assert.equal(result.ok, false, `esperava rejeição para: ${label}`);
    assert.equal(result.outcome, "rejected", `esperava rejeição para: ${label}`);
  }
});

test("sessão RESEARCH_SESSION com field_value → rejected (session_value_provided)", async () => {
  const result = await persistEvidence({
    ...sessionInput,
    research_id: "rs-bad",
    field_value: { value: 10 },
  } as never);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session_value_provided");
});

test("cliente indisponível → fail-closed sem fallback em memória", async () => {
  setCandidateEvidenceClientForTests(null);
  const write = await persistEvidence(fieldInput({ evidence_hash: "sha256:unavailable" }));
  const read = await listCandidateEvidence("can-test-001");
  assert.equal(write.ok, false);
  assert.equal(write.reason, "missing_supabase");
  assert.equal(read.ok, false);
  assert.equal(read.reason, "missing_supabase");
});

test("listagem por candidate/research/kind/state com scoping correto", async () => {
  await persistEvidence(sessionInput);
  await persistEvidence(fieldInput({ evidence_hash: "sha256:f1" }));
  await persistEvidence(
    fieldInput({
      field_name: "title",
      field_value: { value: "Luminária", unknown: false },
      evidence_hash: "sha256:f2",
      field_state: "DERIVED",
    }),
  );

  const sessions = await listResearchSessions("can-test-001");
  assert.equal(sessions.ok, true);
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].kind, "RESEARCH_SESSION");

  const priceFields = await listFieldEvidence("can-test-001", "price");
  assert.equal(priceFields.ok, true);
  assert.equal(priceFields.evidence.length, 1);

  const all = await listCandidateEvidence("can-test-001");
  assert.equal(all.ok, true);
  assert.equal(all.evidence.length, 3);

  const unknowns = await listEvidence({ candidate_id: "can-test-001", field_state: "DERIVED" });
  assert.equal(unknowns.ok, true);
  assert.equal(unknowns.evidence.length, 1);

  // Scoping: candidato diferente não vê as evidências
  const other = await listCandidateEvidence("can-OTHER");
  assert.equal(other.ok, true);
  assert.equal(other.evidence.length, 0);
});

test("cleanup administrativo deleteEvidenceForProof (uso exclusivo em prova viva)", async () => {
  const a = await persistEvidence(fieldInput({ evidence_hash: "sha256:clean-a" }));
  const b = await persistEvidence(fieldInput({ evidence_hash: "sha256:clean-b" }));
  const result = await deleteEvidenceForProof([a.evidence_id!, b.evidence_id!]);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 2);
  assert.equal(result_evidence_count(), 0);
});

test("deleteEvidenceForProof sem cliente → fail-closed", async () => {
  setCandidateEvidenceClientForTests(null);
  const result = await deleteEvidenceForProof(["evi-x"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_supabase");
});

test("metadata sanitiza secrets (nunca carrega credenciais)", async () => {
  const result = await persistEvidence(
    fieldInput({
      evidence_hash: "sha256:sanitized",
      metadata: { api_key: "secret-value", collector: "test" },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.metadata?.collector, "test");
  assert.notEqual(result.evidence?.metadata?.api_key, "secret-value");
  assert.match(String(result.evidence?.metadata?.api_key ?? ""), /REDACTED/);
});

function result_evidence_count(): number {
  return client.store.get("candidate_evidence")?.length ?? 0;
}
