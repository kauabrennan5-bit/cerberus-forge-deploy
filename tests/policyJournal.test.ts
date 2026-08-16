/**
 * Cerberus Finds Archive — Bloco 15 — Fase C — Decision Journal
 * Suíte determinística de testes (20 casos).
 *
 * Fronteiras: POLICY != EXECUTION · DECISION JOURNAL != EXECUTOR
 *             MEMORY != AUTHORITY · journalFailure !== decisionDenied
 *
 * Cliente Supabase falso injetado via setPolicyJournalClientForTests.
 * Nenhum registro real é criado (prova viva somente mediante
 * autorização explícita separada).
 */
import { test } from "node:test";
// O client do journal é um singleton injetável; o teste de ausência de
// Supabase (test 15/16) injeta null/erro, o que corromperia qualquer test
// rodando em paralelo — execução serial obrigatória.

import assert from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePolicy } from "../server/policyEngine/policyEngine";
import type { PolicyDecision, PolicyRequest } from "../server/policyEngine/types";
import {
  canonicalJson,
  requestFingerprint,
  decisionFingerprint,
  sanitizeText,
  sanitizeMetadata,
  sanitizeChecks,
  validateEvaluationRecord,
  insertEvaluation,
  getEvaluation,
  deriveEvaluationId,
  setPolicyJournalClientForTests,
  POLICY_JOURNAL_SCHEMA_VERSION,
} from "../server/repositories/policyJournalRepository";

const FIXED_CLOCK = () => "2026-08-16T00:00:00.000Z";

/** Fake client Supabase — mesmo padrão FakeQueryBuilder dos repositórios dos Blocos 13/14.
 *  Suporta as cadeias usadas pelo journal: .from(t).insert(r).select().single()
 *  e .from(t).select().eq().limit().maybeSingle(). */
function makeFakeClient(options: { failWith?: { message: string; code: string } | null } = {}) {
  const store = new Map<string, Record<string, unknown>[]>();
  class FakeQueryBuilder {
    private mode: "insert" | "read" = "read";
    private input: Record<string, unknown> | null = null;
    private filters: Array<[string, unknown]> = [];
    private orderColumn = "evaluated_at";
    private orderAsc = false;
    private maxRows = 100;
    constructor(private table: string) {}
    insert(row: Record<string, unknown>): this {
      this.mode = "insert";
      this.input = row;
      return this;
    }
    select(): this {
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
    range(_from: number, _to: number): this {
      this.maxRows = _to - _from + 1;
      return this;
    }
    limit(n: number): this {
      this.maxRows = n;
      return this;
    }
    single(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
      return Promise.resolve(this.runInsert());
    }
    maybeSingle(): Promise<{ data: unknown | null; error: { message: string; code?: string } | null }> {
      if (this.mode === "insert") return Promise.resolve(this.runInsert());
      const matched = this.sorted(this.rows()).slice(0, this.maxRows);
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    }
    private runInsert(): { data: unknown | null; error: { message: string; code: string } | null } {
      if (options.failWith) {
        return { data: null, error: options.failWith };
      }
      const rowObj = this.input ?? {};
      const arr = store.get(this.table) ?? [];
      if (arr.some(r => r.evaluation_id === rowObj.evaluation_id)) {
        return { data: null, error: { message: "duplicate key value violates unique constraint policy_evaluations_pkey", code: "23505" } };
      }
      const stored = { ...rowObj, created_at: "2026-08-16T00:00:01Z" };
      arr.push(stored);
      store.set(this.table, arr);
      return { data: stored, error: null };
    }
    private matches(row: Record<string, unknown>): boolean {
      return this.filters.every(([column, value]) => row[column] === value);
    }
    private rows(): Record<string, unknown>[] {
      return [...(store.get(this.table) ?? [])].filter(r => this.matches(r));
    }
    private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
      return [...rows].sort((a, b) => {
        const cmp = String(a[this.orderColumn] ?? "").localeCompare(String(b[this.orderColumn] ?? ""));
        return this.orderAsc ? cmp : -cmp;
      });
    }
  }
  const client = {
    from(table: string): FakeQueryBuilder {
      return new FakeQueryBuilder(table);
    },
  } as unknown as SupabaseClient;
  return { client, store };
}

function makeRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    // Contrato real do security-agent: READ_OPERATIONAL_EVENT → operational.read
    // on operational_events, maxRisk LOW, memoryScope none.
    agentId: "security-agent",
    agentVersion: "1.0",
    policyVersion: "1.0",
    tool: "operational.read",
    action: "READ_OPERATIONAL_EVENT",
    targetTable: "operational_events",
    risk: "LOW",
    memoryScope: "OPERATIONAL_EVENTS",
    ...overrides,
  };
}

function evaluateWithDecision(decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL", overrides: Partial<PolicyRequest> = {}): PolicyDecision {
  const request = makeRequest(overrides);
  const decisionFromEngine = evaluatePolicy(request, FIXED_CLOCK);
  if (decisionFromEngine.decision === decision) return decisionFromEngine;
  // Força a decisão apenas em cenários sintéticos de teste via decision override
  // (a decisão do engine permanece a fonte real; o journal registra o que recebe).
  return { ...decisionFromEngine, decision } as PolicyDecision;
}

function makeDecision(decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL", overrides: Partial<PolicyRequest> = {}): { decision: PolicyDecision; evaluationId: string } {
  const d = evaluateWithDecision(decision, overrides);
  return {
    decision: { ...d, decision } as PolicyDecision,
    evaluationId: deriveEvaluationId(d as PolicyDecision & { context?: string; approvalState?: string }),
  };
}

// 0. smoke: canonicalJson é determinístico
test("00. canonicalJson e sha256 são determinísticos", { concurrency: false }, () => {
  const a = canonicalJson({ b: "1", a: "2", c: ["x", { y: 3 }] });
  const b = canonicalJson({ c: ["x", { y: 3 }], a: "2", b: "1" });
  assert.equal(a, b);
  assert.equal(requestFingerprint({ ...makeDecision("DENY").decision, context: undefined, approvalState: undefined } as any),
    requestFingerprint({ ...makeDecision("DENY").decision, context: undefined, approvalState: undefined } as any));
});

// 1. criação da avaliação
test("01. criação da avaliação: inserted com record completo", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const result = await insertEvaluation({ decision, evaluationId });
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record?.evaluation_id, evaluationId);
  assert.equal(result.record?.decision, "DENY");
  assert.equal(result.record?.schema_version, POLICY_JOURNAL_SCHEMA_VERSION);
  assert.equal(result.record?.evaluated_at, "2026-08-16T00:00:00.000Z");
  assert.equal(result.journalFailure, false);
});

// 2. decisão ALLOW persistida
test("02. decisão ALLOW persistida", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  // Nenhum agente real do registry está habilitado (todos enabled=false);
  // ALLOW só ocorre com agente habilitado dentro do contrato. O journal
  // registra o que o Policy Engine produz — um decision sintético com a
  // forma exata produzida pelo engine (mesmos campos, reasonCode do
  // catálogo) é registrado normalmente, sem reavaliação.
  const { decision: d, evaluationId } = makeDecision("DENY");
  const decisionAllowed: PolicyDecision = {
    ...d,
    decision: "ALLOW",
    reasonCode: "POLICY_ALLOW",
    reason: "decisão sintética de teste com forma idêntica à produzida pelo engine; o journal registra sem reavaliar",
  };
  const result = await insertEvaluation({ decision: decisionAllowed, evaluationId: deriveEvaluationId(decisionAllowed as any) });
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record?.decision, "ALLOW");
  assert.equal(result.record?.reason_code, "POLICY_ALLOW");
  assert.equal(result.journalFailure, false);
});

// 3. decisão DENY persistida
test("03. decisão DENY persistida com reason_code do catálogo", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  // request legítimo para o security-agent com risk acima do maxRisk (LOW)
  const { decision, evaluationId } = makeDecision("DENY", { risk: "HIGH" });
  assert.equal(decision.reasonCode, "RISK_EXCEEDS_MAX", `reason real: ${decision.reasonCode}`);
  const result = await insertEvaluation({ decision, evaluationId });
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record?.decision, "DENY");
  assert.equal(result.record?.reason_code, "RISK_EXCEEDS_MAX");
});

// 4. REQUIRES_APPROVAL persistido
test("04. REQUIRES_APPROVAL persistido", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  // security-agent é enabled=false; a regra de approvalState PENDING
  // precede o gating enabled (ver cadeia do engine) e emite REQUIRES_APPROVAL.
  // Aprovação pendente declarada (APPROVED seria exigida pela política nas
  // actions que exigem aprovação). REQUIRES_APPROVAL é emitido antes do
  // gating enabled; a avaliação é declarativa e nunca cria PendingApproval.
  const request: PolicyRequest = {
    agentId: "security-agent",
    agentVersion: "1.0",
    policyVersion: "1.0",
    tool: "operational.read",
    action: "READ_OPERATIONAL_EVENT",
    targetTable: "operational_events",
    risk: "LOW",
    memoryScope: "OPERATIONAL_EVENTS",
    approvalState: "PENDING",
  };
  const decision = evaluatePolicy(request, FIXED_CLOCK);
  assert.equal(decision.decision, "REQUIRES_APPROVAL", `decisão real do engine: ${decision.decision}/${decision.reasonCode}`);
  const result = await insertEvaluation({ decision, evaluationId: deriveEvaluationId(decision as any) });
  assert.equal(result.outcome, "inserted");
  assert.equal(result.record?.decision, "REQUIRES_APPROVAL");
  assert.equal(result.record?.reason_code, "APPROVAL_REQUIRED");
});

// 5. evaluation_id único (mesmo evaluation_id → duplicate detectado)
test("05. evaluation_id único: segunda inserção com mesmo ID não cria duplicata em memória", { concurrency: false }, async () => {
  const { client, store } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const first = await insertEvaluation({ decision, evaluationId });
  assert.equal(first.outcome, "inserted");
  const second = await insertEvaluation({ decision, evaluationId });
  // O fake retorna 23505 → o repository resolve o duplicate por conteúdo
  assert.ok(second.outcome === "identical_duplicate" || second.outcome === "conflict_rejected", second.outcome);
  // Apenas UMA linha física criada
  const tableRows = (store.get("policy_evaluations") as Record<string, unknown>[]) ?? [];
  const physical = tableRows.filter(r => r.evaluation_id === evaluationId);
  assert.equal(physical.length, 1);
});

// 6. duplicate idêntico
test("06. duplicate idêntico → identical_duplicate", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  await insertEvaluation({ decision, evaluationId });
  const second = await insertEvaluation({ decision, evaluationId });
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.record?.evaluation_id, evaluationId);
  assert.equal(second.journalFailure, false);
});

// 6b. regressão: JSONB do Postgres reordena chaves — checks em ordem
// divergente, com conteúdo idêntico, devem ser identical_duplicate
// (nunca false conflict_rejected).
test("06b. duplicate idêntico com checks em ordem divergente → identical_duplicate", { concurrency: false }, async () => {
  const { client, store } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const first = await insertEvaluation({ decision, evaluationId });
  assert.equal(first.outcome, "inserted");
  // Simular a reordenação de chaves do JSONB: reconstruir checks com
  // ordem deliberadamente diferente (Postgres reordena na leitura).
  const tableRows = (store.get("policy_evaluations") as Record<string, unknown>[]) ?? [];
  const existing = tableRows.find(r => r.evaluation_id === evaluationId) as Record<string, unknown>;
  const originalChecks = existing.checks as Record<string, unknown>;
  const reordered: Record<string, unknown> = {};
  const keys = Object.keys(originalChecks).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const k of keys) reordered[k] = originalChecks[k];
  existing.checks = reordered;
  const second = await insertEvaluation({ decision, evaluationId });
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.journalFailure, false);
});

// 7. duplicate conflitante
test("07. duplicate conflitante (mesma evaluation_id, decisão divergente) → conflict_rejected", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  await insertEvaluation({ decision, evaluationId });
  const conflicting = { ...decision, decision: "ALLOW" } as PolicyDecision;
  const colliding = await insertEvaluation({ decision: conflicting, evaluationId });
  assert.equal(colliding.outcome, "conflict_rejected");
  assert.equal(colliding.journalFailure, true);
});

// 8. reason_code válido
test("08. reason_code válido do catálogo aceito; fora do catálogo rejeitado", { concurrency: false }, async () => {
  const ok1 = validateEvaluationRecord({ decision: "DENY", reason_code: "AGENT_DISABLED", risk: "LOW" });
  assert.equal(ok1.valid, true);
  const ok2 = validateEvaluationRecord({ decision: "ALLOW", reason_code: "POLICY_ALLOW", risk: "MEDIUM" });
  assert.equal(ok2.valid, true);
  const ok3 = validateEvaluationRecord({ decision: "REQUIRES_APPROVAL", reason_code: "APPROVAL_REQUIRED", risk: "HIGH" });
  assert.equal(ok3.valid, true);
  const bad = validateEvaluationRecord({ decision: "DENY", reason_code: "INVENTED_CODE_99", risk: "LOW" });
  assert.equal(bad.valid, false);
});

// 9. decision inválida rejeitada
test("09. decision inválida rejeitada", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision } = makeDecision("DENY");
  const invalid = { ...decision, decision: "EXECUTE" } as unknown as PolicyDecision;
  const result = await insertEvaluation({ decision: invalid, evaluationId: deriveEvaluationId(invalid as any) });
  assert.equal(result.outcome, "conflict_rejected");
  assert.match(result.error ?? "", /decision inválida/);
});

// 10. risk inválido rejeitado
test("10. risk inválido rejeitado", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision } = makeDecision("DENY");
  const invalid = { ...decision, risk: "CATASTROPHIC" } as unknown as PolicyDecision;
  const result = await insertEvaluation({ decision: invalid, evaluationId: deriveEvaluationId(invalid as any) });
  assert.equal(result.outcome, "conflict_rejected");
  assert.match(result.error ?? "", /risk inválido/);
});

// 11. checks estruturados
test("11. checks estruturados preservados e filtrados por chave permitida", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const withExtra = {
    ...decision,
    checks: { ...decision.checks, injected: "value" } as PolicyDecision["checks"],
  };
  const result = await insertEvaluation({ decision: withExtra, evaluationId });
  assert.equal(result.outcome, "inserted");
  assert.equal((result.record?.checks as any).injected, undefined);
  assert.equal((result.record?.checks as any).agent, "PASS");
  assert.equal((result.record?.checks as any).risk, "PASS");
});

// 12. sanitização
test("12. sanitização: token, secret, prompt e conteúdo bruto nunca persistem", { concurrency: false }, () => {
  const dirtyText = "contexto com Authorization: Bearer sk-123 e TELEGRAM_BOT_TOKEN exposto SUPABASE service_role";
  assert.equal(sanitizeText(dirtyText).includes("Bearer"), false);
  assert.equal(sanitizeText(dirtyText).includes("sk-"), false);
  assert.match(sanitizeText(dirtyText), /\[SANITIZED\]/);
  const dirtyMeta = { token: "abc", secret: "x", authorization: "y", api_key: "z", prompt: "p", safe: "ok" };
  const clean = sanitizeMetadata(dirtyMeta);
  for (const key of ["token", "secret", "authorization", "api_key", "prompt"]) {
    assert.equal((clean as any)[key], undefined);
  }
  assert.equal(clean.safe, "ok");
});

// 13. ausência de secrets
test("13. ausência de secrets em decision/evaluatedAt/metadata persistidos", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const dirty = { ...decision, reason: "motivo com Bearer sk-456 dentro", metadata: { secret: "123" } } as unknown as PolicyDecision;
  const result = await insertEvaluation({ decision: dirty, evaluationId });
  assert.equal(result.outcome, "inserted");
  const serialized = JSON.stringify(result.record);
  assert.equal(serialized.includes("sk-456"), false);
  assert.equal(serialized.includes("Bearer"), false);
});

// 14. ausência de execução
test("14. journal jamais importa ou chama qualquer executor", { concurrency: false }, async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync("server/repositories/policyJournalRepository.ts", "utf8");
  const forbidden = [
    "jobQueueRepository", "jobQueueScheduler", "telegramBot", "telegram",
    "PendingApproval", "cerberusOperator", "autoHeal", "productLifecycle",
    "marketplace", "productAutomation", "agentRunner", "GoogleGenAI", "worker",
  ];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `import proibido presente: ${token}`);
  }
  assert.ok(source.includes("POLICY != EXECUTION") || source.includes("DECISION JOURNAL != EXECUTOR"));
});

// 15. banco indisponível
test("15. banco indisponível → missing_supabase (nunca falha silenciosa)", { concurrency: false }, async () => {
  setPolicyJournalClientForTests(null);
  const { decision, evaluationId } = makeDecision("DENY");
  const result = await insertEvaluation({ decision, evaluationId });
  assert.equal(result.outcome, "missing_supabase");
  assert.equal(result.journalFailure, true);
  assert.equal(result.record, undefined);
});

// 16. ausência de fallback silencioso
test("16. erro do banco → database_error explícito, journalFailure=true", { concurrency: false }, async () => {
  const { client } = makeFakeClient({ failWith: { message: "table does not exist", code: "42P01" } });
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const result = await insertEvaluation({ decision, evaluationId });
  assert.equal(result.outcome, "database_error");
  assert.equal(result.journalFailure, true);
  assert.ok((result.error ?? "").length > 0);
});

// 17. determinismo
test("17. determinismo: mesmo request → mesmo requestFingerprint e evaluationId (100 repetições)", { concurrency: false }, () => {
  const { decision } = makeDecision("DENY");
  const fp1 = requestFingerprint(decision as any);
  for (let i = 0; i < 100; i++) {
    assert.equal(requestFingerprint(decision as any), fp1, `iteração ${i} divergiu`);
  }
  // Avaliação diferente (mesmo agente, risk maior) produz digest distinto
  const { decision: d2 } = makeDecision("DENY", { risk: "CRITICAL" });
  assert.notEqual(requestFingerprint(d2 as any), fp1);
});

// 18. preservação de versões
test("18. preservação de versões: policyVersion, agentVersion e policyEngineVersion persistidos exatamente", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const result = await insertEvaluation({ decision, evaluationId });
  assert.equal(result.record?.policy_version, decision.policyVersion);
  assert.equal(result.record?.agent_version, decision.agentVersion);
  assert.equal(result.record?.policy_engine_version, decision.policyEngineVersion);
  assert.equal(result.record?.policy_reason_code_version, "1.0");
});

// 19. preservação de correlation_id
test("19. preservation de correlation_id e causation_id", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  const { decision, evaluationId } = makeDecision("DENY");
  const result = await insertEvaluation({
    decision,
    evaluationId,
    correlationId: "corr-diagnostico-1",
    causationId: "incidente-op-42",
  });
  assert.equal(result.record?.correlation_id, "corr-diagnostico-1");
  assert.equal(result.record?.causation_id, "incidente-op-42");
});

// 20. journal não altera a decisão
test("20. journal não altera a decisão: decisão persistida idêntica à produzida pelo engine", { concurrency: false }, async () => {
  const { client } = makeFakeClient();
  setPolicyJournalClientForTests(client as any);
  // security-agent desabilitado + action fora do contrato → DENY real do engine.
  const decision = evaluatePolicy(makeRequest({ action: "PUBLISH_PRODUCT" }), FIXED_CLOCK);
  assert.equal(decision.decision, "DENY");
  assert.ok(decision.reasonCode === "AGENT_DISABLED" || decision.reasonCode === "ACTION_NOT_ALLOWED" || decision.reasonCode === "TOOL_ACTION_MISMATCH", decision.reasonCode);
  const beforeReason = decision.reason;
  const beforeChecks = decision.checks;
  const result = await insertEvaluation({ decision, evaluationId: deriveEvaluationId(decision as any) });
  assert.equal(result.record?.decision, decision.decision);
  assert.equal(result.record?.reason_code, decision.reasonCode);
  assert.equal(result.record?.reason, beforeReason);
  assert.deepEqual(result.record?.checks, beforeChecks);
  assert.equal(result.record?.decision_fingerprint, decisionFingerprint(decision));
  // Leitura read-only reproduz o registro
  const read = await getEvaluation(result.record!.evaluation_id);
  assert.equal(read.outcome, "inserted");
  assert.equal(read.record?.decision_fingerprint, decisionFingerprint(decision));
});
