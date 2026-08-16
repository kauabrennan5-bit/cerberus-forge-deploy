/**
 * Cerberus Finds Archive — Bloco 15 — Fase D — testes das rotas read-only
 * do Policy Engine (POST /api/policy/evaluate e GET /api/policy/journal).
 *
 * Todas as rotas exigem admin auth; sem autenticação → 401. A rota avalia
 * mas NUNCA executa actions. Persistência é idempotente.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert";
import express from "express";
import request from "supertest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerPolicyEngineRoutes } from "../server/routes/policyEngineRoutes";
import {
  setPolicyJournalClientForTests,
} from "../server/repositories/policyJournalRepository";
import { POLICY_REASON_CODE_CATALOG } from "../server/policyEngine/types";

// ---------------------------------------------------------------------------
// Infraestrutura mínima: app em memória com requireAdminAuth falso (o
// objetivo é testar o contrato das rotas do Bloco 15; a autenticação real
// é garantida pelo requireAdminAuth do server.ts e por seus testes).
// ---------------------------------------------------------------------------
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.headers["x-admin-password"] === "testpass") return next();
    return res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      error: "Autenticação administrativa obrigatória.",
    });
  };
  registerPolicyEngineRoutes({ app, requireAdminAuth });
  return app;
}

function makeRequest(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    agent_id: "security-agent",
    agent_version: "1.0",
    policy_version: "1.0",
    tool: "operational.read",
    action: "READ_OPERATIONAL_EVENT",
    target_table: "operational_events",
    risk: "LOW",
    memory_scope: "OPERATIONAL_EVENTS",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Journal fake: o client real depende do Supabase de produção; os testes de
// persistência injetam um cliente falso no módulo compartilhado.
// ---------------------------------------------------------------------------
import type { StoredEvaluation } from "../server/repositories/policyJournalRepository";

const journalStore = new Map<string, Record<string, unknown>[]>();

class JournalFakeQueryBuilder {
  private mode: "insert" | "read" = "read";
  private input: Record<string, unknown> | null = null;
  private filters: Array<[string, unknown]> = [];
  private orderColumn: string | null = null;
  private orderAsc = true;
  private fromIdx = 0;
  private toIdx = 0;
  private countRequested = false;
  constructor(private table: string) {}
  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }
  select(_columns?: string, _opts?: { count?: string }): this { if (_opts?.count) this.countRequested = true;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  range(from: number, to: number): this {
    this.fromIdx = from;
    this.toIdx = to;
    return this;
  }
  limit(_n: number): this {
    return this;
  }
  single(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
    return (async () => this.run())();
  }
  maybeSingle(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
    return (async () => this.run())();
  }
  then<T>(resolve: (value: { data: unknown[] | null; error: { message: string; code?: string } | null; count: number | null }) => T): Promise<T> {
    if (!this.countRequested) {
      // Cadeias sem {count} (single/maybeSingle) resolvem pelo método próprio.
      return Promise.resolve(this.run()).then(resolve as never);
    }
    return (async () => this.runForList())().then(resolve);
  }
  private run(): { data: unknown | null; error: { message: string; code: string } | null } {
    if (this.mode === "insert") {
      const rowObj = this.input ?? {};
      const arr = journalStore.get(this.table) ?? [];
      const stored = { ...rowObj, created_at: "2026-08-16T00:00:01Z" };
      arr.push(stored);
      journalStore.set(this.table, arr);
      return { data: stored, error: null };
    }
    const match = this.sorted(this.rows()).filter(r => this.matches(r))[0] ?? null;
    return { data: match, error: null };
  }
  private runForList(): { data: unknown[] | null; error: { message: string; code?: string } | null; count: number | null } {
    const rows = this.rows();
    const sorted = this.sorted(rows);
    return {
      data: sorted.slice(this.fromIdx, this.toIdx + 1),
      error: null,
      count: rows.length,
    };
  }
  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }
  private rows(): Record<string, unknown>[] {
    return [...(journalStore.get(this.table) ?? [])].filter(r => this.matches(r));
  }
  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const col = this.orderColumn;
    const asc = this.orderAsc ? 1 : -1;
    return [...rows].sort((a, b) =>
      asc * String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
    );
  }
}

const journalFakeClient = {
  from(table: string): JournalFakeQueryBuilder {
    return new JournalFakeQueryBuilder(table);
  },
} as unknown as SupabaseClient;

setPolicyJournalClientForTests(journalFakeClient);

beforeEach(() => {
  // Cada teste parte de um journal limpo: o store é compartilhado no módulo.
  journalStore.clear();
});

// ---------------------------------------------------------------------------
// Suíte: 17 casos
// ---------------------------------------------------------------------------
test("D01. POST /api/policy/evaluate sem autenticação → 401", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .send(makeRequest());
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test("D02. GET /api/policy/journal sem autenticação → 401", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .get("/api/policy/journal")
    .set("x-admin-password", "wrong");
  assert.equal(res.status, 401);
});

test("D03. avaliar com payload válido: AGENT_DISABLED (security-agent desligado)", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest());
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.decision, "DENY");
  assert.equal(res.body.reason_code, "AGENT_DISABLED");
  assert.equal(res.body.persisted, false);
  assert.equal(typeof res.body.evaluationId, "string");
  assert.equal(typeof res.body.checks, "object");
  assert.match(res.body.note, /nenhuma ação foi executada/i);
});

test("D04. avaliação NEVER executa actions: mesmo request legítimo persistido", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.persisted, true);
  assert.match(res.body.journal.outcome, /inserted|identical_duplicate/);
  assert.equal(res.body.journal.evaluation_id, res.body.evaluationId);
});

test("D05. idempotência: segunda avaliação persistida com mesmo payload → identical_duplicate", { concurrency: false }, async () => {
  const app = buildApp();
  const first = await request(app)
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  assert.equal(first.body.journal.outcome, "inserted");
  assert.equal(first.body.decision, "DENY");
  const second = await request(app)
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  if (second.body.journal.outcome !== "identical_duplicate") {
    console.error("[D05] body:", JSON.stringify(second.body).slice(0, 400));
  }
  assert.equal(second.body.journal.outcome, "identical_duplicate");
  assert.equal(second.body.decision, "DENY");
  assert.equal(
    second.body.evaluationId,
    first.body.evaluationId,
    "evaluation_id determinístico idêntico entre as duas avaliações",
  );
});

test("D06. persist=false não grava no journal", { concurrency: false }, async () => {
  const res0 = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "false" }));
  assert.equal(res0.body.persisted, false);
  const list = await request(buildApp())
    .get("/api/policy/journal")
    .set("x-admin-password", "testpass");
  assert.equal(list.body.evaluations.length, 0);
});

test("D07. payload inválido → 400 sem avaliar", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send({ agent_id: "security-agent" }); // campos obrigatórios faltando
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "INVALID_PAYLOAD");
  assert.ok(Array.isArray(res.body.errors) && res.body.errors.length > 0);
  assert.equal(res.body.decision, undefined);
});

test("D08. campos vazios → 400", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send({ ...makeRequest(), action: "   " });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_PAYLOAD");
});

test("D09. approval_state fora do catálogo → 400", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send({ ...makeRequest(), approval_state: "AUTO_APPROVED" });
  assert.equal(res.status, 400);
  assert.ok(res.body.errors[0].includes("approval_state"));
});

test("D10. avaliação com aprovação pendente declarativa: REQUIRES_APPROVAL", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ approval_state: "PENDING" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.decision, "REQUIRES_APPROVAL");
  assert.equal(res.body.reason_code, "APPROVAL_REQUIRED");
  assert.equal(res.body.persisted, false);
});

test("D11. reason codes da resposta pertencem ao catálogo fechado", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ risk: "CRITICAL" }));
  assert.ok(POLICY_REASON_CODE_CATALOG.includes(res.body.reason_code));
});

test("D12. journal read-only: GET listagem sem parâmetros", { concurrency: false }, async () => {
  const app = buildApp();
  await request(app)
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  const list = await request(app)
    .get("/api/policy/journal")
    .set("x-admin-password", "testpass");
  assert.equal(list.status, 200);
  assert.equal(list.body.success, true);
  assert.ok(Array.isArray(list.body.evaluations));
  assert.equal(list.body.evaluations.length, 1);
  assert.equal(list.body.page, 1);
  assert.equal(list.body.total, 1);
});

test("D13. journal read-only: GET por evaluation_id", { concurrency: false }, async () => {
  const app = buildApp();
  const post = await request(app)
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  const get = await request(app)
    .get(`/api/policy/journal?evaluation_id=${post.body.evaluationId}`)
    .set("x-admin-password", "testpass");
  if (get.status !== 200) {
    console.error("[D13] body:", JSON.stringify(get.body));
  }
  assert.equal(get.status, 200);
  assert.equal(get.body.success, true);
  assert.equal(get.body.evaluation.evaluation_id, post.body.evaluationId);
  assert.equal(get.body.evaluation.decision, "DENY");
});

test("D14. journal read-only: evaluation_id inexistente → 404", { concurrency: false }, async () => {
  const res = await request(buildApp())
    .get("/api/policy/journal?evaluation_id=nao-existe-123")
    .set("x-admin-password", "testpass");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "EVALUATION_NOT_FOUND");
});

test("D15. journal read-only: filtro por decisão", { concurrency: false }, async () => {
  const app = buildApp();
  await request(app)
    .post("/api/policy/evaluate")
    .set("x-admin-password", "testpass")
    .send(makeRequest({ persist: "true" }));
  const list = await request(app)
    .get("/api/policy/journal?decision=DENY")
    .set("x-admin-password", "testpass");
  assert.equal(list.body.evaluations.length, 1);
  const listAllow = await request(app)
    .get("/api/policy/journal?decision=ALLOW")
    .set("x-admin-password", "testpass");
  assert.equal(listAllow.body.evaluations.length, 0);
});

test("D16. journal read-only: não existe rota PUT/PATCH/DELETE", { concurrency: false }, async () => {
  const app = buildApp();
  for (const [method, fn] of [
    ["put", (a: express.Express) => request(a).put("/api/policy/journal")],
    [
      "patch",
      (a: express.Express) => request(a).patch("/api/policy/journal"),
    ],
    [
      "delete",
      (a: express.Express) => request(a).delete("/api/policy/journal"),
    ],
  ] as const) {
    const res = await fn(app).set("x-admin-password", "testpass");
    assert.equal(
      res.status,
      404,
      `${method} /api/policy/journal NÃO deve existir (superfície somente leitura)`,
    );
  }
});

test("D17. journal indisponível → resposta explícita de falha, decisão preservada", { concurrency: false }, async () => {
  const app = buildApp();
  setPolicyJournalClientForTests(null as unknown as SupabaseClient);
  try {
    const res = await request(app)
      .post("/api/policy/evaluate")
      .set("x-admin-password", "testpass")
      .send(makeRequest({ persist: "true" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.decision, "DENY");
    assert.equal(res.body.journal.persisted_actual, false);
    assert.match(String(res.body.journal.warning), /falha de persistência/i);
  } finally {
    setPolicyJournalClientForTests(journalFakeClient);
  }
});
