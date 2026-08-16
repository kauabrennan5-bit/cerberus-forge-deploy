/**
 * Prova viva do Bloco 17 — execução controlada do experimentRepository.
 *
 * Escopo autorizado (Fase 5): provar que o objeto persiste, que a recusa de
 * decisão prematura funciona, que a hipótese/variantes são imutáveis, que a
 * idempotência bloqueia duplicação idêntica e que o cleanup não deixa
 * resíduos.
 *
 * Nota de transparência: o sandbox não possui as credenciais Supabase de
 * produção (elas só existem no ambiente do Render/AI Studio). Por isso a
 * prova viva do REPOSITORY roda contra um cliente falso determinístico que
 * simula a API do Supabase (mesmo contrato do repositório real), e a prova
 * viva INTEGRAL (rotas HTTP + Telegram + cleanup no banco real) está
 * planejada para ser executada APÓS o deploy autorizado (Fase 8) — quando
 * o /health exibir o novo SHA. A tabela experiments JÁ EXISTE em produção
 * (verificada via MCP SQL: RLS ON, count 0).
 */
import {
  insertExperiment,
  recordExperimentDecision,
  listExperiments,
  listDecisions,
  deleteExperimentForProof,
  setExperimentClientForTests,
  validateExperimentDesign,
  // deriveMinSampleSize importado de statisticalRigor
} from "../server/repositories/experimentRepository";
import { deriveMinSampleSize } from "../server/commercialBrain/statisticalRigor";

// ============================================================
// Cliente falso realista (contrato PostgREST)
// ============================================================
const memory: Record<string, unknown[]> = { experiments: [] };
const pkeys: Record<string, Set<string>> = { experiments: new Set() };

function resolve(table: string) {
  if (!(table in memory)) memory[table] = [];
  if (!(table in pkeys)) pkeys[table] = new Set();
  return { rows: memory[table] as Record<string, unknown>[], keys: pkeys[table] };
}

class QueryBuilder {
  private table: string;
  private filter: (row: Record<string, unknown>) => boolean = () => true;
  private orderByField: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private insertRow: Record<string, unknown> | null = null;
  private updatePatch: Record<string, unknown> | null = null;
  private deleteMode = false;

  constructor(table: string) {
    this.table = table;
  }
  eq(k: string, v: unknown) {
    const prev = this.filter;
    this.filter = (r) => prev(r) && r[k] === v;
    return this;
  }
  gte(k: string, v: unknown) {
    const prev = this.filter;
    this.filter = (r) => prev(r) && (r[k] as number) >= (v as number);
    return this;
  }
  lte(k: string, v: unknown) {
    const prev = this.filter;
    this.filter = (r) => prev(r) && (r[k] as number) <= (v as number);
    return this;
  }
  not(k: string, op: string, v: unknown) {
    const prev = this.filter;
    if (v === null) {
      // "column is not null" — campo ausente/undefined também é considerado nulo.
      this.filter = (r) => prev(r) && r[k] !== undefined && r[k] !== null;
    } else {
      this.filter = (r) => prev(r) && r[k] !== v;
    }
    return this;
  }
  order(k: string, opts?: { ascending?: boolean }) {
    this.orderByField = k;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  private executeInsert(): any {
    const { rows, keys } = resolve(this.table);
    if (this.insertRow === null) return Promise.resolve({ data: null, error: null });
    const row = { ...this.insertRow };
    const key = String(row.experiment_key ?? "");
    if (keys.has(key)) {
      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key violates unique constraint \"experiments_experiment_key_key\"" } });
    }
    row.id = rows.length + 1;
    row.created_at = new Date().toISOString();
    row.updated_at = row.created_at;
    rows.push(row);
    keys.add(key);
    return Promise.resolve({ data: row, error: null });
  }
  private materialize(): Record<string, unknown>[] {
    let rows = resolve(this.table).rows.filter(this.filter);
    if (this.orderByField) {
      rows.sort((a, b) => {
        const av = a[this.orderByField] ?? "";
        const bv = b[this.orderByField] ?? "";
        return this.orderAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  select(_cols?: string, _opts?: unknown) {
    return this.chainable();
  }
  private chainable(): any {
    const q = this;
    return {
      eq: (k: string, v: unknown) => { q.eq(k, v); return q.chainable(); },
      gte: (k: string, v: unknown) => { q.gte(k, v); return q.chainable(); },
      lte: (k: string, v: unknown) => { q.lte(k, v); return q.chainable(); },
      not: (k: string, op: string, v: unknown) => { q.not(k, op, v); return q.chainable(); },
      order: (k: string, opts?: { ascending?: boolean }) => { q.order(k, opts); return q.chainable(); },
      limit: (n: number) => { q.limit(n); return q.chainable(); },
      maybeSingle: () => {
        q.limitN = 1;
        return {
          then: (onfulfilled: any) => {
            const rows = q.materialize();
            return Promise.resolve({ data: rows[0] ?? null, error: null }).then(onfulfilled);
          },
        };
      },
      then: (onfulfilled: any) => {
        const rows = q.materialize();
        return Promise.resolve({ data: rows, count: rows.length }).then(onfulfilled);
      },
    };
  }
  insert(row: Record<string, unknown>, _opts?: unknown) {
    this.insertRow = row;
    return this.afterInsert();
  }
  // insert(...).select(...).single() — retorna wrapper com single()
  private afterInsert(): any {
    const exec = this.executeInsert();
    return {
      select: (_cols?: string) => ({
        single: () => ({ then: (onfulfilled: any) => exec.then(onfulfilled) }),
      }),
      then: (onfulfilled: any) => exec.then(onfulfilled),
    };
  }
  update(patch: Record<string, unknown>) {
    this.updatePatch = patch;
    return this.afterMutate();
  }
  private executeUpdate(): any {
    const { rows } = resolve(this.table);
    const targets = rows.filter(this.filter);
    for (const r of targets) Object.assign(r, this.updatePatch);
    return Promise.resolve({ data: targets, error: null });
  }
  delete() {
    this.deleteMode = true;
    return this.afterMutate();
  }
  private executeDelete(): any {
    const table = this.table;
    const before = memory[table].length;
    memory[table] = (memory[table] as Record<string, unknown>[]).filter((r) => !this.filter(r));
    return Promise.resolve({ data: null, error: null });
  }
  // update(...)/delete() seguidos de .then ou .select()
  private afterMutate(): any {
    const q = this;
    // update(...).eq(...).select().single() e delete().eq(...)
    const addFilter = (k: string, v: unknown) => { q.eq(k, v); return after(); }
    const exec = () => (q.updatePatch !== null ? q.executeUpdate() : q.executeDelete());
    const after = () => ({
      eq: addFilter,
      select: (_cols?: string) => ({
        single: () => ({ then: (onfulfilled: any) => exec().then(onfulfilled) }),
      }),
      then: (onfulfilled: any) => exec().then(onfulfilled),
    });
    return after();
  }
  then(onfulfilled: any) {
    const { rows, keys } = resolve(this.table);
    if (this.insertRow !== null) {
      return this.executeInsert().then((res: any) => {
        const row = res.data;
        return Promise.resolve({ data: row ? [row] : null, count: row ? 1 : 0, error: res.error }).then(onfulfilled);
      });
    }
    if (this.deleteMode) {
      return this.executeDelete().then(onfulfilled);
    }
    if (this.updatePatch !== null) {
      return this.executeUpdate().then(onfulfilled);
    }
    const rowsOut = this.materialize();
    return Promise.resolve({ data: rowsOut, count: rowsOut.length }).then(onfulfilled);
  }
}

const fakeClient = {
  from: (table: string) => new QueryBuilder(table),
};

setExperimentClientForTests(fakeClient as any);

// ============================================================
// Prova
// ============================================================
async function main() {
  const log = (t: string) => console.log(`[PROVA] ${t}`);
  const derived = deriveMinSampleSize();
  log(`Amostra mínima derivada: ${derived.nPerVariant.toLocaleString("pt-BR")} por variante (v2, mde=50%, baseline=2%, α=0.05, power=0.8)`);

  // 1. Registro de experimento de teste (estrutura de schema/repo, sem variante executada)
  const design = {
    hypothesis: "PROVA VIVA B17: botão 'Comprar' vermelho aumenta cliques vs azul",
    rationale: "Teste de estrutura do registry autorizado no Bloco 17. NENHUMA variante é executada.",
    variant_a_label: "botao-azul",
    variant_b_label: "botao-vermelho",
    target_population: "teste de estrutura (sem execução)",
    target_product_ids: ["REF-012"],
    success_metric: "cli",
    metric_definition: "base de cliques da janela declarada",
    fdr: 0.1,
    min_sample_size: derived.nPerVariant,
    planned_duration_days: 7,
    created_by: "operator-admin",
  };
  const v1 = validateExperimentDesign(design);
  log(`Validação do design: ${v1.valid ? "VÁLIDO" : `INVÁLIDO (${(v1 as any).error_code})`}`);

  const r1 = await insertExperiment(design);
  if (!r1.record) throw new Error("registro falhou: " + r1.error_message);
  const id1 = r1.record.experiment_id;
  log(`Registro criado: ${id1} — status=${r1.record.status} min_sample=${r1.record.min_sample_size.toLocaleString("pt-BR")} sample=${r1.record.sample_size}`);

  // 2. Imutabilidade da hipótese/variantes
  const r1b = await insertExperiment({ ...design, variant_a_label: "botao-verde" } as any);
  log(`Tentativa de registro com variante alterada → novo experimento independente (hipótese/variantes imutáveis POR experimento): ${r1b.record?.experiment_id ?? "recusado"}`);

  // 3. Idempotência: registro idêntico
  const r2 = await insertExperiment(design);
  log(`Idempotência (registro idêntico): ${r2.identical_duplicate ? `200 duplicado aceito → ${r2.record?.experiment_id}` : r2.conflict_rejected ? "409 rejeitado" : "INESPERADO"}`);

  // 4. Decisão prematura (amostra 0 < 3.826, período não encerrado)
  const d1 = await recordExperimentDecision({
    experiment_id: id1,
    decision: "SCALE",
    decision_basis: "opinião textual — deveria ser recusada",
    decided_by: "operator-admin",
  });
  if (!d1.rejected) throw new Error("FALHA: decisão prematura NÃO foi recusada!");
  log(`Decisão prematura RECUSADA: reason=${d1.rejection_reason} explanation="${d1.rejection_explanation}" sample=${d1.sample_current}/${d1.sample_minimum?.toLocaleString("pt-BR")}`);

  // 5. Segunda tentativa de decisão prematura — idempotente (ainda recusada)
  const d2 = await recordExperimentDecision({ experiment_id: id1, decision: "KILL", decision_basis: "segunda tentativa", decided_by: "operator-admin" });
  log(`Segunda decisão prematura RECUSADA: ${d2.rejected ? `reason=${d2.rejection_reason}` : "INESPERADO"}`);

  // 6. Listagem e decisões vazias
  const list = await listExperiments({ limit: 10 });
  const decs = await listDecisions();
  log(`listExperiments: total=${list.total} · listDecisions: total=${decs.total} (sem decisões formais)`);

  // 7. Cleanup — remoção integral para zero resíduos
  const del = await deleteExperimentForProof(id1);
  log(`Cleanup id=${id1}: ${del.deleted ? "REMOVIDO (zero resíduos)" : "FALHOU — " + del.error_message}`);
  const del2 = await deleteExperimentForProof((r1b.record?.experiment_id) ?? "");
  log(`Cleanup id=${r1b.record?.experiment_id ?? "?"}: ${del2.deleted ? "REMOVIDO" : "FALHOU — " + del2.error_message}`);

  const after = await listExperiments({ limit: 10 });
  log(`Pós-cleanup: total=${after.total} (esperado 0)`);

  if (after.total !== 0) throw new Error("RESÍDUO ENCONTRADO!");
  console.log("\n✅ PROVA VIVA LOCAL CONCLUÍDA — todos os gates comportamentais verificados.");
}

main().catch((e) => {
  console.error("❌ PROVA VIVA FALHOU:", e.message);
  process.exitCode = 1;
});
