/**
 * Cerberus Finds Archive — Bloco 16 — Fase D — Persistência e Aprovação
 * Suíte determinística (fake client; NENHUM registro real).
 *
 * Fronteiras:
 *   POLICY != EXECUTION · DECISION JOURNAL != EXECUTOR
 *   MEMORY != AUTHORITY · APPROVAL_ID_DECLARADO != PROVA
 *   journalFailure !== decisionDenied
 *
 * Espelha o padrão de tests/policyJournal.test.ts (Bloco 15).
 * Execução serial (cliente singleton injetável).
 */
import { test } from "node:test";
import assert from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateExecutionRecord,
  insertExecution,
  updateExecutionState,
  listExecutions,
  getExecution,
  setAgentExecutionClientForTests,
  getAgentExecutionClientState,
  type ExecutionInsertInput,
} from "../server/repositories/agentExecutionsRepository";
import {
  InMemoryApprovalStore,
  OfficialApprovalProvider,
  APPROVAL_TTL_MS,
  deriveOfficialApprovalId,
  type RuntimeApproval,
} from "../server/agentRuntime/approvalPersisted";

const FIXED_CLOCK = () => "2026-08-16T00:00:00.000Z";

// ============================================================================
// Fake client (padrão FakeQueryBuilder dos Blocos 13/14/15)
// ============================================================================
function makeFakeClient(options: { failWith?: { message: string; code: string } | null } = {}) {
  const store = new Map<string, Record<string, unknown>[]>();
  class FakeQueryBuilder {
    private mode: "insert" | "read" | "update" = "read";
    private input: Record<string, unknown> | null = null;
    private updatePatch: Record<string, unknown> | null = null;
    private filters: Array<[string, unknown]> = [];
    private maxRows = 100;
    private countExact = false;
    constructor(private table: string) {}
    insert(row: Record<string, unknown>): this {
      this.mode = "insert";
      this.input = row;
      return this;
    }
    update(patch: Record<string, unknown>): this {
      this.mode = "update";
      this.updatePatch = patch;
      return this;
    }
    select(
      _columns?: string,
      _opts?: { count?: "exact" }
    ): this {
      // Suporte às duas cadeias:
      //   insert/resolve/read: .select("*").eq().limit().maybeSingle()
      //   listExecutions: .select("*", {count: "exact"}).eq().order().range()
      this.countExact = _opts?.count === "exact";
      return this;
    }
    eq(column: string, value: unknown): this {
      this.filters.push([column, value]);
      return this;
    }
    order(): this {
      return this;
    }
    limit(n: number): this {
      this.maxRows = n;
      return this;
    }
    range(_from: number, _to: number): Promise<{
      data: unknown[] | null;
      error: { message: string; code?: string } | null;
      count: number;
    }> {
      this.maxRows = _to - _from + 1;
      return this.runReadMany();
    }
    single(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
      if (this.mode === "insert") return Promise.resolve(this.runInsert());
      // update chain: .update(p).eq(...).select().single() — aplica patch e retorna row.
      return Promise.resolve(this.runRead());
    }
    maybeSingle(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
      if (this.mode === "insert") return Promise.resolve(this.runInsert());
      return Promise.resolve(this.runRead());
    }
    private rows(): Record<string, unknown>[] {
      return store.get(this.table) ?? [];
    }
    private matches(row: Record<string, unknown>): boolean {
      return this.filters.every(([column, value]) => row[column] === value);
    }
    private runRead(): { data: unknown | null; error: { message: string; code?: string } | null } {
      if (options.failWith) {
        return { data: null, error: options.failWith };
      }
      let matched = this.rows().filter(r => this.matches(r));
      if (this.updatePatch) {
        matched.forEach(r => Object.assign(r, this.updatePatch!));
      }
      matched = matched.slice(0, this.maxRows);
      return { data: matched[0] ?? null, error: null };
    }
    private runReadMany(): Promise<{
      data: unknown[] | null;
      error: { message: string; code?: string } | null;
      count: number;
    }> {
      if (options.failWith) {
        return Promise.resolve({ data: null, error: options.failWith, count: 0 });
      }
      let matched = this.rows().filter(r => this.matches(r));
      if (this.updatePatch) {
        matched.forEach(r => Object.assign(r, this.updatePatch!));
      }
      const count = matched.length;
      matched = matched.slice(0, this.maxRows);
      return Promise.resolve({ data: matched, error: null, count });
    }
    private runInsert(): { data: unknown | null; error: { message: string; code: string } | null } {
      if (options.failWith) {
        return { data: null, error: options.failWith };
      }
      const rowObj = this.input ?? {};
      const arr = store.get(this.table) ?? [];
      if (arr.some(r => r.execution_id === rowObj.execution_id)) {
        return {
          data: null,
          error: {
            message: "duplicate key value violates unique constraint agent_executions_pkey",
            code: "23505",
          },
        };
      }
      const stored = { ...rowObj, created_at: "2026-08-16T00:00:01Z" };
      arr.push(stored);
      store.set(this.table, arr);
      return { data: stored, error: null };
    }
  }
  return {
    from: (table: string) => new FakeQueryBuilder(table),
  } as unknown as SupabaseClient;
}

// ============================================================================
// Factories de teste
// ============================================================================
const FIXED_IDENTITY = {
  agentId: "product-analyst",
  agentVersion: "1.0",
  policyVersion: "1.0",
  requestedBy: "operator" as const,
  tool: "products.read",
  action: "READ_PRODUCT",
  risk: "LOW",
  targetTable: "products",
  targetType: "PRODUCT",
  targetId: "REF-001",
};

function makeInsertInput(overrides: Partial<ExecutionInsertInput> = {}): ExecutionInsertInput {
  return {
    executionId: "exec-1",
    intentionKey: "intent-a1",
    agentId: FIXED_IDENTITY.agentId,
    agentVersion: FIXED_IDENTITY.agentVersion,
    policyVersion: FIXED_IDENTITY.policyVersion,
    runtimeVersion: "1.0",
    tool: FIXED_IDENTITY.tool,
    action: FIXED_IDENTITY.action,
    risk: FIXED_IDENTITY.risk,
    targetTable: FIXED_IDENTITY.targetTable,
    targetType: FIXED_IDENTITY.targetType,
    targetId: FIXED_IDENTITY.targetId,
    decision: "ALLOW",
    reasonCode: "POLICY_ALLOWED",
    approvalState: null,
    lifecycleState: "REQUESTED",
    resultReference: null,
    inputFingerprint: "fingerprint-1",
    inputReference: "products.read/REF-001",
    identityContextDigest: "digest-1",
    executorStatus: "SKIPPED",
    correlationId: "corr-1",
    requestId: "req-1",
    ...overrides,
  };
}

// ============================================================================
// Persistência do journal
// ============================================================================
test("FaseD-1: insertExecution persiste com sucesso (inserted)", async () => {
  setAgentExecutionClientForTests(makeFakeClient());
  const result = await insertExecution(makeInsertInput());
  assert.strictEqual(result.outcome, "inserted");
  assert.ok(result.record);
  assert.strictEqual(result.record!.execution_id, "exec-1");
  assert.strictEqual(result.record!.decision, "ALLOW");
  assert.strictEqual(result.journalFailure, false);
});

test("FaseD-2: identical_duplicate — mesma intention_key + mesmo digest", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  const first = await insertExecution(makeInsertInput());
  assert.strictEqual(first.outcome, "inserted");
  // Mesma intention_key + mesmo digest → mesmo execution determinístico;
  // divergência de execution_id é conflito de contexto declaratório.
  const second = await insertExecution(makeInsertInput());
  assert.strictEqual(second.outcome, "identical_duplicate");
  assert.ok(second.record);
  assert.strictEqual(second.record!.execution_id, "exec-1");
});

test("FaseD-3: conflict_rejected — mesma intention + mesmo digest + conteúdo divergente (execution_id falso)", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  await insertExecution(makeInsertInput());
  // Mesma intention_key + mesmo digest de identidade, mas execution_id
  // derivado divergente (contexto declaratório inconsistente): o resolver
  // detecta a divergência e rejeita como conflito (default deny).
  const conflict = await insertExecution(
    makeInsertInput({ executionId: "exec-2" })
  );
  assert.strictEqual(conflict.outcome, "conflict_rejected");
  assert.strictEqual(conflict.journalFailure, true);
});

test("FaseD-4: colisão detectada mesmo quando constraint UNIQUE dispara primeiro", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  const a = await insertExecution(makeInsertInput());
  assert.strictEqual(a.outcome, "inserted");
  const b = await insertExecution(makeInsertInput({ executionId: "exec-1" }));
  assert.strictEqual(b.outcome, "identical_duplicate");
});

test("FaseD-5: database_error com journalFailure — falha do Supabase não nega decisão", async () => {
  setAgentExecutionClientForTests(
    makeFakeClient({ failWith: { message: "connection refused", code: "08001" } })
  );
  const result = await insertExecution(makeInsertInput());
  assert.strictEqual(result.outcome, "database_error");
  assert.strictEqual(result.journalFailure, true);
  assert.ok((result.error ?? "").includes("connection refused"));
});

test("FaseD-6: missing_supabase — cliente ausente → não grava, journalFailure", async () => {
  setAgentExecutionClientForTests(null);
  const result = await insertExecution(makeInsertInput());
  assert.strictEqual(result.outcome, "missing_supabase");
  assert.strictEqual(result.journalFailure, true);
  assert.strictEqual(getAgentExecutionClientState().configured, false);
});

test("FaseD-7: sanitize — metadata não aceita input bruto ou prompt", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  await insertExecution(
    makeInsertInput({ metadata: { prompt: "secret-data", note: "ok", schema_version: "99" } })
  );
  const result = await listExecutions({ page: 1, pageSize: 10 });
  assert.strictEqual(result.success, true);
  const row = result.executions![0];
  assert.strictEqual((row.metadata as Record<string, unknown>).prompt, undefined);
  assert.strictEqual((row.metadata as Record<string, unknown>).note, "ok");
});

test("FaseD-8: sanitizeText — erros textuais jamais contêm secrets/token conhecidos", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  await insertExecution(
    makeInsertInput({
      errorMessage: "falha: Authorization: Bearer sk-xxxx TELEGRAM_BOT_TOKEN vazio",
      inputReference: "products.read/REF-001",
    })
  );
  const result = await listExecutions({ page: 1, pageSize: 10 });
  assert.strictEqual(result.success, true);
  const row = result.executions![0];
  assert.ok(!row.error_message?.includes("Authorization:"));
  assert.ok(!row.error_message?.includes("Bearer "));
  assert.ok(!row.error_message?.includes("sk-"));
  assert.ok(row.error_message?.includes("[SANITIZED]"));
  // inputReference passa (não contém padrão sensível)
  assert.strictEqual(row.input_reference, "products.read/REF-001");
});

test("FaseD-9: validateExecutionRecord — catálogos fechados (decision/lifecycle/executor/risk/requested_by)", () => {
  assert.deepStrictEqual(validateExecutionRecord({
    decision: "ALLOW", lifecycleState: "REQUESTED", executorStatus: "SKIPPED", risk: "LOW",
  }), { valid: true });
  assert.strictEqual(
    validateExecutionRecord({ decision: "FORGED" as never, lifecycleState: "REQUESTED", executorStatus: "SKIPPED", risk: "LOW" }).valid,
    false
  );
  assert.strictEqual(
    validateExecutionRecord({ decision: "ALLOW", lifecycleState: "FORGED" as never, executorStatus: "SKIPPED", risk: "LOW" }).valid,
    false
  );
  assert.strictEqual(
    validateExecutionRecord({ decision: "ALLOW", lifecycleState: "REQUESTED", executorStatus: "FORGED" as never, risk: "LOW" }).valid,
    false
  );
  assert.strictEqual(
    validateExecutionRecord({ decision: "ALLOW", lifecycleState: "REQUESTED", executorStatus: "SKIPPED", risk: "FORGED" as never }).valid,
    false
  );
  assert.strictEqual(
    validateExecutionRecord({ decision: "ALLOW", lifecycleState: "REQUESTED", executorStatus: "SKIPPED", risk: "LOW", requestedBy: "fake-user" as never }).valid,
    false
  );
});

test("FaseD-10: insert rejeita registro fora do catálogo (conflict_rejected antes de gravar)", async () => {
  setAgentExecutionClientForTests(makeFakeClient());
  const result = await insertExecution(
    makeInsertInput({ decision: "FORGED" as never })
  );
  assert.strictEqual(result.outcome, "conflict_rejected");
  assert.strictEqual(result.journalFailure, true);
});

test("FaseD-11: updateExecutionState restritivo — apenas colunas de resultado mudam", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  const inserted = await insertExecution(makeInsertInput({ lifecycleState: "REQUESTED" }));
  assert.strictEqual(inserted.outcome, "inserted");
  const updated = await updateExecutionState("exec-1", {
    lifecycleState: "APPROVED",
    executorStatus: "NOT_CONNECTED",
    resultReference: "result-1",
    startedAt: "2026-08-16T00:00:10Z",
    metadata: { step: "proof" },
  });
  assert.strictEqual(updated.outcome, "inserted"); // update retorna padrão WriteResult com record atualizado
  const result = await listExecutions({ page: 1, pageSize: 10 });
  assert.strictEqual(result.success, true);
  const record = result.executions![0] as {
    lifecycle_state: string;
    executor_status: string;
    result_reference: string;
    decision: string;
  };
  assert.strictEqual(record.lifecycle_state, "APPROVED");
  assert.strictEqual(record.executor_status, "NOT_CONNECTED");
  assert.strictEqual(record.result_reference, "result-1");
  // identity/decisão permanecem imutáveis
  assert.strictEqual(record.decision, "ALLOW");
});

test("FaseD-12: update rejeita lifecycle fora do catálogo fechado", async () => {
  setAgentExecutionClientForTests(makeFakeClient());
  const result = await updateExecutionState("exec-1", { lifecycleState: "FORGED" as never });
  assert.strictEqual(result.outcome, "conflict_rejected");
  assert.strictEqual(result.journalFailure, true);
});

test("FaseD-13: listExecutions com filtros e paginação", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  await insertExecution(makeInsertInput());
  await insertExecution(makeInsertInput({ executionId: "exec-2", intentionKey: "intent-b2" }));
  const all = await listExecutions({ page: 1, pageSize: 50 });
  assert.strictEqual(all.success, true);
  assert.strictEqual(all.total, 2);
  const filtered = await listExecutions({ intentionKey: "intent-a1", page: 1, pageSize: 50 });
  assert.strictEqual(filtered.success, true);
  assert.strictEqual(filtered.total, 1);
});

test("FaseD-14: getExecution — presente e ausente", async () => {
  const client = makeFakeClient();
  setAgentExecutionClientForTests(client);
  await insertExecution(makeInsertInput());
  const found = await getExecution("exec-1");
  assert.strictEqual(found.success, true);
  assert.strictEqual(found.executions!.length, 1);
  assert.strictEqual(found.executions![0].execution_id, "exec-1");
  const missing = await getExecution("exec-inexistente");
  assert.strictEqual(missing.success, true); // ausente é resposta válida (executions vazio)
});

// ============================================================================
// ApprovalStore oficial (aprovação como autoridade externa)
// ============================================================================
function makeApprovalCreation(overrides: Partial<{
  executionId: string;
  intentionKey: string;
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  tool: string;
  action: string;
  risk: string;
  evaluationId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}> = {}) {
  return {
    executionId: "exec-1",
    intentionKey: "intent-a1",
    agentId: "product-analyst",
    agentVersion: "1.0",
    policyVersion: "1.0",
    tool: "products.read",
    action: "READ_PRODUCT",
    risk: "LOW",
    evaluationId: "eval-1",
    approvedBy: "operator-admin",
    approvedAt: "2026-08-16T00:00:00.000Z",
    expiresAt: "2026-08-16T00:30:00.000Z",
    ...overrides,
  };
}

test("FaseD-15: create gera approval_id oficial determinístico (nunca o declared)", () => {
  const id = deriveOfficialApprovalId({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
  });
  assert.ok(id.startsWith("appr-"));
  assert.ok(!id.includes("products.read"));
  assert.strictEqual(
    id,
    deriveOfficialApprovalId({ intentionKey: "intent-a1", executionId: "exec-1", policyVersion: "1.0" })
  );
});

test("FaseD-16: create por via administrativa com approvedBy operator-admin", async () => {
  const store = new InMemoryApprovalStore();
  const result = await store.create(makeApprovalCreation());
  assert.strictEqual(result.outcome, "created");
  assert.ok(result.approval);
  assert.strictEqual(result.approval!.approvedBy, "operator-admin");
  assert.strictEqual(result.approval!.state, "APPROVED");
});

test("FaseD-17: resolve sem requiresApproval → NOT_REQUIRED (agente não declara approved)", async () => {
  const store = new InMemoryApprovalStore();
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: false,
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "NOT_REQUIRED");
});

test("FaseD-18: resolve com aprovação oficial válida → APPROVED", async () => {
  const store = new InMemoryApprovalStore();
  const created = await store.create(makeApprovalCreation());
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: true,
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "APPROVED");
  assert.ok(created.approval);
});

test("FaseD-19: approvalId declarado pelo agente NÃO é prova (default deny)", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation());
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: true,
    approvalId: "appr-999-9", // declarado pelo agente — incompatível
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "PENDING");
});

test("FaseD-20: resolve após expiração → EXPIRED", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation());
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: true,
    clock: () => "2026-08-16T01:00:00.000Z", // 60min depois
  });
  assert.strictEqual(result, "EXPIRED");
});

test("FaseD-21: resolve após revogação → REJECTED (não volta a PENDING)", async () => {
  const store = new InMemoryApprovalStore();
  const created = await store.create(makeApprovalCreation());
  assert.ok(created.approval);
  await store.revoke(created.approval!.approvalId);
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: true,
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "REJECTED");
});

test("FaseD-22: POLICY_CHANGED — mesmo approval com policy_version diferente NÃO aprova", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation({ policyVersion: "1.0" }));
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "2.0", // política mudou após a aprovação
    requiresApproval: true,
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "PENDING");
});

test("FaseD-23: approval de outra execution → PENDING (default deny)", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation({ executionId: "exec-OUTRO" }));
  const result = await store.resolve({
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    requiresApproval: true,
    clock: FIXED_CLOCK,
  });
  assert.strictEqual(result, "PENDING");
});

test("FaseD-24: revoke duplicado → already_revoked; revoke inexistente → not_found", async () => {
  const store = new InMemoryApprovalStore();
  const notFound = await store.revoke("appr-inexistente");
  assert.strictEqual(notFound.outcome, "not_found");
  const created = await store.create(makeApprovalCreation());
  assert.ok(created.approval);
  const first = await store.revoke(created.approval!.approvalId);
  assert.strictEqual(first.outcome, "revoked");
  const second = await store.revoke(created.approval!.approvalId);
  assert.strictEqual(second.outcome, "already_revoked");
});

test("FaseD-25: list retorna apenas aprovações oficiais", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation());
  const list = await store.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual((list[0] as RuntimeApproval).approvedBy, "operator-admin");
});

test("FaseD-26: TTL padrão da aprovação é 30 minutos", () => {
  assert.strictEqual(APPROVAL_TTL_MS, 30 * 60 * 1000);
});

// ============================================================================
// Provider oficial (fronteira com a pipeline)
// ============================================================================
test("FaseD-27: OfficialApprovalProvider — declaração do agente nunca é prova", async () => {
  const store = new InMemoryApprovalStore();
  await store.create(makeApprovalCreation());
  const provider = new OfficialApprovalProvider(store, {
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    clock: FIXED_CLOCK,
  });
  const result = await provider.resolve({
    requiresApproval: true,
    approvalId: "appr-falso-do-agente", // agente declara — irrelevante
  });
  assert.strictEqual(result, "APPROVED");
});

test("FaseD-28: OfficialApprovalProvider — falha de leitura → PENDING (fail-closed)", async () => {
  const store = new InMemoryApprovalStore();
  const brokenStore = {
    create: store.create.bind(store),
    list: store.list.bind(store),
    revoke: store.revoke.bind(store),
    resolve: async () => {
      throw new Error("falha injetada");
    },
  };
  const provider = new OfficialApprovalProvider(brokenStore, {
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    clock: FIXED_CLOCK,
  });
  const result = await provider.resolve({ requiresApproval: true, approvalId: null });
  assert.strictEqual(result, "PENDING");
});

test("FaseD-29: OfficialApprovalProvider — requiresApproval=false → NOT_REQUIRED", async () => {
  const provider = new OfficialApprovalProvider(new InMemoryApprovalStore(), {
    intentionKey: "intent-a1",
    executionId: "exec-1",
    policyVersion: "1.0",
    clock: FIXED_CLOCK,
  });
  const result = await provider.resolve({ requiresApproval: false, approvalId: null });
  assert.strictEqual(result, "NOT_REQUIRED");
});
