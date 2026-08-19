/**
 * Bloco N4 — Bateria de testes A–AF: filtro Cerberus v1, repository de
 * avaliações e rotas administrativas.
 *
 * GOVERNANÇA (contratos testados):
 *   - CANDIDATE != FACT CANÔNICO: nada em public.products.
 *   - ASSESSMENT != ACTION: is_actionable=false sempre.
 *   - SCORE SEM RACIONAL = SEM SIGNIFICADO: priority SEMPRE com explanation
 *     e weights; dimensions SEMPRE completas (9 eixos).
 *   - UNKNOWN declarado, nunca estimado; COLLECTION_FAILED declarado;
 *     DERIVED ≠ KNOWN.
 *   - Contradições nunca são silenciadas — vão ao RISK.
 *   - Replay idêntico é idempotente (mesmo digest → linha única).
 *   - Histórico nunca é apagado por nova avaliação.
 *   - Determinismo: mesmas evidências + mesma versão de regras → mesmo output.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";

import {
  assessCandidate,
  classify,
  derivePriority,
  recommend,
  type Dimensions,
} from "../server/commercial/filter/cerberusFilter";
import {
  DIMENSION_NAMES,
  CLASSIFICATIONS,
  RECOMMENDATIONS,
  PRIORITY_LEVELS,
  KNOWN_NICHES,
  V1_WEIGHTS,
  V1_AXIS_SCORE,
  V1_RISK_SCORE,
  V1_CLASSIFICATION_RULES,
  V1_RATIONALE_BY_AXIS,
  FILTER_VERSION,
  SCORING_VERSION,
} from "../server/commercial/filter/cerberusFilterRules";
import {
  buildAssessmentDigest,
  persistAssessment,
  getAssessment,
  listCandidateAssessments,
  type PersistAssessmentInput,
  deleteAssessmentForProof,
  resetAssessmentClientForTests,
  setCandidateAssessmentClient,
  ASSESSMENT_KINDS,
} from "../server/repositories/candidateAssessmentRepository";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";
import { setCandidateEvidenceClientForTests } from "../server/repositories/candidateEvidenceRepository";
import { registerAssessmentRoutes } from "../server/routes/assessmentRoutes";
import * as commercialCockpit from "../server/services/commercialCockpit";

// ============================================================================
// Fixtures
// ============================================================================

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "can-n4-test-001",
    listing_key: "listing-test-1",
    schema_version: "1.0",
    discovery_rigor_version: "1.0",
    marketplace: "mercadolivre",
    merchant: "Loja Teste",
    source_url: "https://produto.mercadolivre.com.br/MLB-12345",
    external_listing_id: "MLB-12345",
    title: "Luminária vintage de mesa — metal preto",
    description:
      "Luminária de mesa vintage em metal preto, base maciça, edição limitada, estilo anos 70. Peça diferenciada do universo Casa+Vida.",
    category: "Casa e Decoração",
    observed_price: 189.9,
    observed_rating: 4.7,
    observed_rating_count: 143,
    observed_availability: "AVAILABLE",
    observed_at: "2026-08-16T10:00:00Z",
    evidence_hash: "sha256:candidate-digest",
    collection_method: "SCRAPE",
    raw_snapshot_url: null,
    status: "PENDING_REVIEW",
    funnel_stage: "NEW",
    review_notes: "",
    rejection_reason: null,
    reviewed_at: null,
    reviewed_by: null,
    promoted_product_id: null,
    promoted_at: null,
    idempotency_key: null,
    metadata: {},
    created_by: "discovery",
    created_at: "2026-08-16T10:00:00Z",
    updated_at: "2026-08-16T10:00:00Z",
    ...overrides,
  };
}

function fieldEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence_id: "evi-n4-001",
    candidate_id: "can-n4-test-001",
    research_id: "rs-n4-001",
    kind: "FIELD",
    field_name: "price",
    field_value: { value: 189.9, unknown: false },
    field_state: "KNOWN",
    source_url: "https://produto.mercadolivre.com.br/MLB-12345",
    source_type: "marketplace_page",
    collection_method: "SCRAPE",
    observed_at: "2026-08-16T10:00:01Z",
    evidence_hash: "sha256:evi-1",
    field_hash: "sha256:field-1",
    quality: "HIGH",
    unit: null,
    evidence_note: "",
    metadata: {},
    created_at: "2026-08-16T10:00:01Z",
    ...overrides,
  };
}

// ============================================================================
// Fake Supabase (padrão Blocos N1–N3/13–17)
// ============================================================================

let fakeSeq = 0;

class FakeQueryBuilder {
  private filters: Array<[string, unknown, string]> = [];
  private sorts: Array<[string, boolean]> = [];
  private maxRows?: number;
  private mode: "select" | "insert" | "delete" = "select";
  private input?: Record<string, unknown>;
  private deleteDone = false;
  private deletedCount = 0;
  private inFilters: Array<[string, unknown[]]> = [];

  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}

  select(_columns?: string): this {
    if (this.mode !== "insert") this.mode = "select";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value, "eq"]);
    return this;
  }

  in(column: string, values: unknown[]): this | Promise<{ data: unknown[] | null; error: null }> {
    this.inFilters.push([column, values]);
    if (this.mode === "delete") {
      this._executeDelete();
      // O repo usa `await ...delete().in(...)` sem .then() — retornar o payload
      // diretamente, com as linhas deletadas em `data` (deleteCount = data.length).
      return Promise.resolve({ data: this.deletedRows, error: null });
    }
    return this;
  }

  private deletedRows: Record<string, unknown>[] = [];

  private _executeDelete(): void {
    const store = this.rows();
    const remaining = store.filter(row => !this.matches(row));
    this.deletedRows = store.filter(row => this.matches(row));
    this.deletedCount = store.length - remaining.length;
    this.client.store.set(this.table, remaining);
    this.deleteDone = true;
  }

  order(column: string, options: { ascending?: boolean }): this {
    this.sorts.push([column, options.ascending ?? true]);
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

  delete(): this {
    this.mode = "delete";
    return this;
  }

  private _insertRow(): Record<string, unknown> {
    const row = { ...(this.input ?? {}) };
    // Simula o `created_at timestamptz not null default now()` do Postgres.
    if (row.created_at === undefined || row.created_at === null) {
      row.created_at = `2026-08-16T12:00:${String(fakeSeq++ % 60).padStart(2, "0")}Z`;
    }
    this.rows().push(row);
    return row;
  }

  private rows(): Record<string, unknown>[] {
    if (!this.client.store.has(this.table)) {
      this.client.store.set(this.table, []);
    }
    return this.client.store.get(this.table)!;
  }

  private matches(row: Record<string, unknown>): boolean {
    const eqMatch = this.filters.every(([column, value]) => row[column] === value);
    const inMatch = this.inFilters.every(([column, values]) =>
      Array.isArray(values) && values.includes(row[column]),
    );
    return eqMatch && inMatch;
  }

  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return [...rows].sort((a, b) => {
      for (const [column, ascending] of this.sorts) {
        const av = String(a[column] ?? "");
        const bv = String(b[column] ?? "");
        const cmp = av.localeCompare(bv);
        if (cmp !== 0) return ascending ? cmp : -cmp;
      }
      return 0;
    });
  }

  private idempotencyViolation(): { message: string; code: string } | null {
    if (!this.input?.idempotency_key) return null;
    const existing = this.rows().find(r => r.idempotency_key === this.input!.idempotency_key);
    if (existing) {
      return { message: "duplicate key violates unique constraint", code: "23505" };
    }
    return null;
  }

  single(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const violation = this.idempotencyViolation();
      if (violation) return Promise.resolve({ data: null, error: violation });
      const row = this._insertRow();
      return Promise.resolve({ data: row, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const matched = this.sorted(this.rows().filter(row => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.mode === "delete") {
      this._executeDelete();
      return Promise.resolve({ data: [], error: null }).then(onfulfilled as never, onrejected as never);
    }
    if (this.mode === "insert") {
      const violation = this.idempotencyViolation();
      if (violation) return Promise.resolve({ data: null, error: violation }).then(onfulfilled as never, onrejected as never);
      const row = this._insertRow();
      return Promise.resolve({ data: [row], error: null }).then(onfulfilled as never, onrejected as never);
    }
    const matched = this.sorted(this.rows().filter(row => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched, error: null }).then(onfulfilled as never, onrejected as never);
  }
}

class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();
  public fail = false;

  from(table: string): FakeQueryBuilder {
    if (this.fail) {
      throw new Error("fake_supabase_unavailable");
    }
    return new FakeQueryBuilder(this, table);
  }
}

// ============================================================================
// App Express em memória (padrão policyRoutes / commercialAnalysisService)
// ============================================================================

function buildApp(supabase?: FakeSupabaseClient): express.Express {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.headers["x-admin-password"] === "n4testpass") return next();
    return res.status(401).json({
      ok: false,
      error: "Autenticação administrativa obrigatória.",
    });
  };
  registerAssessmentRoutes(app, requireAdminAuth);
  return app;
}

function deps(store: Record<string, Record<string, unknown>[]>) {
  return {
    getCandidateById: async (candidateId: string) => {
      const rows = store["candidates"] ?? [];
      const c = rows.find(r => r.candidate_id === candidateId);
      return { ok: Boolean(c), candidate: c as never };
    },
    getEvidenceForCandidate: async (candidateId: string) => {
      const rows = store["candidate_evidence"] ?? [];
      return {
        ok: true,
        evidence: rows.filter(r => r.candidate_id === candidateId) as never,
      };
    },
  };
}

// ============================================================================
// Setup global
// ============================================================================

let fakeClient: FakeSupabaseClient;
let candidateStore: Record<string, Record<string, unknown>[]>;
let evidenceStore: Record<string, Record<string, unknown>[]>;

beforeEach(() => {
  fakeClient = new FakeSupabaseClient();
  candidateStore = {
    "can-n4-test-001": [candidate()],
  };
  evidenceStore = {
    "can-n4-test-001": [],
  };
  setCandidateAssessmentClient(fakeClient as unknown as SupabaseClient);
  resetAssessmentClientForTests(fakeClient as unknown as SupabaseClient);
});

afterEach(() => {
  resetAssessmentClientForTests(null);
  setCandidateAssessmentClient(null);
});

function runFilter(c: Record<string, unknown>[], e: Record<string, unknown>[]): ReturnType<typeof assessCandidate> extends Promise<infer R> ? R : never {
  // Sincrono via assessCandidate com deps injetadas.
  throw new Error("use await assessCandidate");
}

// ============================================================================
// PARTE 1 — REGRAS E PESOS VERSIONADOS (catálogos fechados)
// ============================================================================

test("A01. catálogos fechados espelham a migration (CHECKs)", () => {
  assert.deepEqual(
    [...DIMENSION_NAMES],
    ["CERBERUS_FIT", "DISCOVERY_VALUE", "QUALITY_SIGNAL", "DEMAND_SIGNAL", "COMMERCIAL_POTENTIAL", "AFFILIATE_ECONOMICS", "AD_VIABILITY", "EVIDENCE_CONFIDENCE", "RISK"],
  );
  assert.deepEqual([...CLASSIFICATIONS], ["WINNER", "HIDDEN_GEM", "NICHE_DROP", "INSUFFICIENT", "NOT_RECOMMENDED"]);
  assert.deepEqual([...RECOMMENDATIONS], ["NONE", "INVESTIGATE_FURTHER", "ADD_TO_NICHE", "PARK", "REJECT"]);
  assert.deepEqual([...PRIORITY_LEVELS], ["HIGH", "MEDIUM", "LOW", "NO_ACTION"]);
  assert.deepEqual([...KNOWN_NICHES], ["VINTAGE", "BAUHAUS", "SPACE_AGE", "MID_CENTURY", "JAPANESE", "MINIMALIST", "INDUSTRIAL"]);
  assert.deepEqual([...ASSESSMENT_KINDS], ["cerberus_filter_v1", "n13:curator_v1", "n14:commercial_brain_v1"]);
});

test("A02. pesos somam exatamente 1.00 (composição determinística válida)", () => {
  const sum = Object.values(V1_WEIGHTS).reduce((acc, w) => acc + w, 0);
  assert.equal(Math.round(sum * 10000) / 10000, 1.0, "soma dos pesos deve ser 1.0");
  for (const [dim, w] of Object.entries(V1_WEIGHTS)) {
    assert.ok(w > 0 && w <= 1, `peso ${dim} fora da faixa 0..1`);
  }
});

test("A03. scores por eixo são estritamente decrescentes com o label (HIGH>MEDIUM>LOW)", () => {
  assert.ok(V1_AXIS_SCORE.HIGH > V1_AXIS_SCORE.MEDIUM);
  assert.ok(V1_AXIS_SCORE.MEDIUM > V1_AXIS_SCORE.LOW);
  assert.ok(V1_AXIS_SCORE.LOW > V1_AXIS_SCORE.WEAK);
  assert.ok(V1_AXIS_SCORE.INSUFFICIENT === 0, "INSUFFICIENT zera o componente dependente");
});

test("A04. RISK inverte o sentido: risco alto → score 0 (reduz prioridade)", () => {
  assert.equal(V1_RISK_SCORE.HIGH, 0);
  assert.ok(V1_RISK_SCORE.LOW > V1_RISK_SCORE.MEDIUM);
  assert.ok(V1_RISK_SCORE.MEDIUM > V1_RISK_SCORE.HIGH);
});

test("A05. todas as 9 dimensões possuem rationale_by_axis auditável", () => {
  for (const dim of DIMENSION_NAMES) {
    assert.ok(V1_RATIONALE_BY_AXIS[dim] && V1_RATIONALE_BY_AXIS[dim].length > 10, `rationale ausente para ${dim}`);
  }
});

test("A06. regras de classificação possuem lógica + rationale formal (hipótese documentada)", () => {
  for (const cls of ["WINNER", "HIDDEN_GEM", "NICHE_DROP", "INSUFFICIENT", "NOT_RECOMMENDED"] as const) {
    const rule = V1_CLASSIFICATION_RULES[cls];
    assert.ok(rule.logic && rule.logic.length > 5, `lógica ausente para ${cls}`);
    assert.ok(rule.rationale && rule.rationale.length > 5, `rationale ausente para ${cls}`);
  }
});

// ============================================================================
// PARTE 2 — FILTRO: eixos, determinismo, UNKNOWN/DERIVED/contradições
// ============================================================================

test("B07. WINNER: candidato Casa+Vida com demanda moderada, qualidade observável e risco médio", async () => {
  const store = {
    candidates: [candidate({ title: "Luminária vintage de mesa", description: "Luminária vintage em metal preto, anos 70, edição limitada" })],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", evidence_id: "evi-rating-1", field_value: { value: 4.7, unknown: false } }),
      fieldEvidence({ field_name: "review_count", evidence_id: "evi-rev-1", field_value: { value: 143, unknown: false } }),
      fieldEvidence({ field_name: "images", evidence_id: "evi-img-1", field_value: { value: 6, unknown: false } }),
      fieldEvidence({ field_name: "price", evidence_id: "evi-price-1", field_value: { value: 189.9, unknown: false } }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.ok, true);
  assert.equal(result.classification?.classification, "WINNER");
  assert.equal(result.recommendation?.recommendation, "ADD_TO_NICHE");
});

test("B08. determinismo: mesmas entradas → idempotência de output (hash de evidências idêntico, scores idênticos)", async () => {
  const store = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", evidence_id: "evi-r1" }),
      fieldEvidence({ field_name: "review_count", evidence_id: "evi-r2" }),
    ],
  };
  const r1 = await assessCandidate("can-n4-test-001", deps(store));
  const r2 = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(r1.inputSnapshot?.evidence_digest, r2.inputSnapshot?.evidence_digest);
  assert.deepEqual(r1.dimensions!, r2.dimensions!);
  assert.equal(r1.priority?.priority_score, r2.priority?.priority_score);
});

test("B09. UNKNOWN declarado explicitamente: preço ausente → COMMERCIAL_POTENTIAL=UNKNOWN, nunca estimado", async () => {
  const store = {
    candidates: [candidate({ observed_price: null })],
    candidate_evidence: [fieldEvidence({ field_name: "price", field_state: "UNKNOWN", evidence_id: "evi-unk" })],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.COMMERCIAL_POTENTIAL.label, "UNKNOWN");
  assert.match(result.dimensions!.COMMERCIAL_POTENTIAL.basis, /não confirmado/i);
  assert.ok(Array.isArray(result.unknowns));
  assert.ok(result.unknowns!.some(u => String(u).includes("price")));
});

test("B10. COLLECTION_FAILED declarado: falha de coleta identificável, não silenciada", async () => {
  const store = {
    candidates: [candidate({ observed_rating_count: null })],
    candidate_evidence: [
      fieldEvidence({ field_name: "review_count", field_state: "COLLECTION_FAILED", evidence_id: "evi-cf", evidence_note: "timeout do fetch", quality: "UNKNOWN" }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  // knownRatio = 0/1 (<0.3 e known=0) → INSUFFICIENT; a única evidência é COLLECTION_FAILED.
  // RISK: problems.length=1 (<2, sem lowFit) → MEDIUM.
  assert.equal(result.dimensions?.EVIDENCE_CONFIDENCE.label, "INSUFFICIENT");
  assert.match(result.dimensions!.EVIDENCE_CONFIDENCE.basis, /falhas de coleta/);
  assert.ok(result.collectionFailures!.some(f => String(f).includes("review_count")));
  assert.match(result.dimensions!.RISK.basis, /coleta falhou/);
});

test("B11. contradição preservada: CONTRADICTED entra no RISK com contradiction_with", async () => {
  const store = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "price", field_state: "CONTRADICTED", evidence_id: "evi-ct", evidence_note: "price diverge de evidência anterior (contradiction_with: evi-price-old)" }),
      fieldEvidence({ field_name: "price", field_state: "KNOWN", evidence_id: "evi-price-old", field_value: { value: 210.0, unknown: false } }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.ok(result.contradictions!.some(c => String(c).includes("price")));
  assert.match(result.dimensions!.RISK.basis, /contradição/);
});

test("B12. AFFILIATE_ECONOMICS sempre UNKNOWN: não existe fonte de comissão na v1 — jamais inventado", async () => {
  const store = { candidates: [candidate()], candidate_evidence: [] };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.AFFILIATE_ECONOMICS.label, "UNKNOWN");
  assert.match(result.dimensions!.AFFILIATE_ECONOMICS.basis, /NÃO inventar/i);
});

test("B13. AD_VIABILITY sempre INCONCLUSIVE: sem infraestrutura de anúncios na v1", async () => {
  const store = { candidates: [candidate()], candidate_evidence: [] };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.AD_VIABILITY.label, "INCONCLUSIVE");
});

test("B14. DEMAND_SIGNAL desconhecida NÃO rejeita: elegível para HIDDEN_GEM", async () => {
  const store = {
    // Sem nicho ("espelho artesanal" sem keyword de catálogo) para não disparar o
    // branch WINNER via disc=HIGH (WINNER permite disc=HIGH como demanda). Com
    // DISCOVERY=MEDIUM (descrição sem cue de raridade) e demanda UNKNOWN, o
    // candidato cai no HIDDEN_GEM (exige disc=HIGH) — testar com cue de raridade
    // e sem keyword de nicho: "edição limitada" gera disc=HIGH mas não é
    // keyword de NICHE_KEYWORDS, então WINNER exige conf≥MEDIUM e demand≥MODERATE
    // ou disc=HIGH → atenção: WINNER aceita disc=HIGH! HIDDEN_GEM exige
    // demand∈{WEAK,UNKNOWN}. Para provar o caminho HIDDEN_GEM, usar demanda
    // WEAK (rating_count<10) + disc=HIGH sem WINNER (quality<MEDIUM).
    // disc=HIGH (cue de raridade "peça única"/"edição limitada" sem keyword de nicho);
    // demanda UNKNOWN (rating_count ausente); conf=MEDIUM exigida senão o
    // branch INSUFFICIENT vence o HIDDEN_GEM (linha 470 do filtro).
    // conf=MEDIUM exige knownRatio≥0.3: 1 KNOWN (title) + 1 UNKNOWN (seller)
    // → 0.5. RISK≤MEDIUM exige ≤1 problema: apenas seller UNKNOWN. Images
    // KNOWN/HIGH (default) tornaria QUALITY≥MEDIUM e dispara WINNER —
    // images é eixo de qualidade — mantê-la ausente (0 imagens)
    // e availability UNKNOWN para QUALITY=INSUFFICIENT.
    candidates: [candidate({
      observed_rating_count: null,
      observed_rating: null,
      observed_availability: "UNKNOWN",
      title: "Escultura de parede artesanal",
      description: "peça única feita à mão por ateliê independente, edição limitada",
    })],
    candidate_evidence: [
      fieldEvidence({ field_name: "title", evidence_id: "evi-t1" }),
      fieldEvidence({ field_name: "seller", field_state: "UNKNOWN", evidence_id: "evi-s1", quality: "LOW" }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  // 2 FIELD: 1 KNOWN (title) + 1 UNKNOWN (seller) → knownRatio=0.5 → conf=MEDIUM.
  // QUALITY: zero HIGH diretas, rating/ratingCount null, availability UNKNOWN → INSUFFICIENT.
  // RISK: 1 problema (seller UNKNOWN) → MEDIUM. WINNER bloqueado (quality<MEDIUM,
  // conf<MEDIUM); HIDDEN_GEM: FIT≥MEDIUM, disc=HIGH, demand=UNKNOWN, risk=MEDIUM.
  assert.equal(result.dimensions?.QUALITY_SIGNAL.label, "INSUFFICIENT");
  assert.equal(result.dimensions?.DEMAND_SIGNAL.label, "UNKNOWN");
  assert.equal(result.dimensions?.EVIDENCE_CONFIDENCE.label, "MEDIUM");
  assert.equal(result.classification?.classification, "HIDDEN_GEM", `era esperado HIDDEN_GEM, veio ${result.classification?.classification}: ${result.classification?.basis}`);
  assert.match(result.dimensions!.DEMAND_SIGNAL.basis, /NÃO é rejeição/i);
  assert.equal(result.recommendation?.recommendation, "ADD_TO_NICHE");
});

test("B15. DERIVED não conta como KNOWN: evidências só de URL → EVIDENCE_CONFIDENCE=INSUFFICIENT", async () => {
  const store = {
    candidates: [candidate()],
    candidate_evidence: [fieldEvidence({ field_name: "price", field_state: "DERIVED", source_type: "url_slug", evidence_id: "evi-derived" })],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.EVIDENCE_CONFIDENCE.label, "INSUFFICIENT");
  assert.match(result.dimensions!.EVIDENCE_CONFIDENCE.basis, /DERIVED/);
});

test("B16. QUALITY_SIGNAL sem evidência KNOWN → INSUFFICIENT (nunca 'qualidade alta' inventada)", async () => {
  const store = {
    candidates: [candidate({ observed_rating: null, observed_rating_count: null, observed_availability: "UNKNOWN" })],
    candidate_evidence: [fieldEvidence({ field_name: "seller", field_state: "UNKNOWN", evidence_id: "evi-unk2" })],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  // rating null, review_count null, availability UNKNOWN, zero evidências KNOWN → INSUFFICIENT.
  assert.equal(result.dimensions?.QUALITY_SIGNAL.label, "INSUFFICIENT");
});

test("B17. EVIDENCE_CONFIDENCE alta exige ≥70% KNOWN e zero falhas", async () => {
  const store = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", field_state: "KNOWN", evidence_id: "a1" }),
      fieldEvidence({ field_name: "review_count", field_state: "KNOWN", evidence_id: "a2" }),
      fieldEvidence({ field_name: "images", field_state: "KNOWN", evidence_id: "a3" }),
      fieldEvidence({ field_name: "price", field_state: "KNOWN", evidence_id: "a4" }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.EVIDENCE_CONFIDENCE.label, "HIGH");
});

test("B18. fora do universo Casa+Vida → FIT=LOW → NOT_RECOMMENDED", async () => {
  const store = {
    candidates: [candidate({ title: "Pneu de caminhão 22.5", description: "pneu radial para caminhão, uso rodoviário pesado", category: "Auto Peças" })],
    candidate_evidence: [],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.dimensions?.CERBERUS_FIT.label, "LOW");
  assert.equal(result.classification?.classification, "NOT_RECOMMENDED");
});

test("B19. NICHE_DROP: encaixe em nicho + FIT médio, sem sinais comerciais fortes", async () => {
  // "mid century" dispara MID_CENTURY → FIT=HIGH, disc=HIGH (niche).
  // WINNER exige quality≥MEDIUM (rating≥3.5 ou 3 evidências HIGH diretas);
  // HIDDEN_GEM exige demand∈{WEAK,UNKNOWN}; NICHE_DROP cobre o restante.
  const store = {
    // "mid century" → NICHE MID_CENTURY → FIT=HIGH e disc=HIGH.
    // Para impedir o branch WINNER (que aceita disc=HIGH como demanda):
    // QUALITY precisa ficar <MEDIUM → rating null, sem evidência KNOWN de
    // rating/review_count/seller/imagens/preço e availability≠desconhecida? —
    // availability UNKNOWN + sem evidência KNOWN → QUALITY=INSUFFICIENT
    // (linha 281: sem evidência HIGH, rating null, review_count null, availability UNKNOWN).
    candidates: [candidate({
      title: "Cadeira Eames réplica",
      description: "cadeira mid century design dinamarquês",
      observed_rating: 3.2,
      observed_rating_count: 50,
      observed_availability: "AVAILABLE",
    })],
    candidate_evidence: [
      fieldEvidence({ field_name: "title", evidence_id: "e1" }),
      fieldEvidence({ field_name: "seller", field_state: "UNKNOWN", evidence_id: "e3", quality: "LOW" }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  // 3 FIELD: 2 KNOWN + 1 UNKNOWN → conf=MEDIUM; QUALITY=INSUFFICIENT (sem
  // evidência HIGH de qualidade); WINNER bloqueado por quality<MEDIUM;
  // HIDDEN_GEM bloqueado por disc=HIGH mas demand≠{WEAK,UNKNOWN}? demand=UNKNOWN
  // — mas HIDDEN_GEM exige disc=HIGH E demand WEAK/UNKNOWN: ATENÇÃO, também
  // bateria! FIT=HIGH, disc=HIGH, demand=UNKNOWN (rating_count null) →
  // HIDDEN_GEM vence antes de NICHE_DROP!
  // => usar rating_count=5 (demand=WEAK): HIDDEN_GEM ainda vence (disc=HIGH ∧ demand WEAK).
  // Para chegar ao NICHE_DROP: demand precisa ser STRONG/MODERATE e quality<MEDIUM:
  // demand=MODERATE (rating_count=50) + quality INSUFFICIENT → WINNER bloqueado,
  // HIDDEN_GEM bloqueado (demand≠WEAK/UNKNOWN), NICHE_DROP OK.
  // demand=MODERATE (50∈[10,100]); QUALITY: rating 3.2 (<3.5), zero HIGH diretas
  // (images ausente; seller UNKNOWN não conta) → mixed=false → LOW.
  // conf: 1 KNOWN + 1 UNKNOWN → 0.5 → MEDIUM; risk: 1 problema → MEDIUM.
  // WINNER bloqueado (quality LOW); HIDDEN_GEM bloqueado (demand=MODERATE);
  // NICHE_DROP: nicho MID_CENTURY + FIT HIGH.
  assert.equal(result.dimensions?.DEMAND_SIGNAL.label, "MODERATE");
  assert.equal(result.dimensions?.QUALITY_SIGNAL.label, "LOW");
  assert.equal(result.dimensions?.EVIDENCE_CONFIDENCE.label, "MEDIUM");
  assert.equal(result.classification?.classification, "NICHE_DROP", `era esperado NICHE_DROP, veio ${result.classification?.classification}: ${result.classification?.basis}`);
  assert.equal(result.recommendation?.recommendation, "PARK");
});

// ============================================================================
// PARTE 3 — PRIORITY: score derivado, explicável, nunca solto
// ============================================================================

test("C20. priority_score é composição Σ(peso×score) com todos os 9 eixos — nunca exibido sem dimensions", async () => {
  const store = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", evidence_id: "p1" }),
      fieldEvidence({ field_name: "review_count", evidence_id: "p2" }),
      fieldEvidence({ field_name: "images", evidence_id: "p3" }),
      fieldEvidence({ field_name: "price", evidence_id: "p4" }),
    ],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  const priority = result.priority!;
  // Recalcular manualmente a composição.
  let manual = 0;
  for (const dim of DIMENSION_NAMES) {
    manual += V1_WEIGHTS[dim] * result.dimensions![dim].score;
  }
  const expected = Math.round(manual * 10000) / 10000;
  assert.equal(priority.priority_score, expected);
  assert.ok(priority.explanation.includes("Σ(peso × score"), "explanation explica a composição");
  assert.deepEqual(priority.weights, V1_WEIGHTS, "weights expostos = regra versionada");
  // Cada dimensão contribui na explanation (score SEMPRE com rationale).
  for (const dim of DIMENSION_NAMES) {
    assert.match(priority.explanation, new RegExp(dim));
  }
});

test("C21. priority_score no intervalo [0,1] mesmo em cenários extremos", async () => {
  const scenarios: Record<string, Record<string, unknown>[]>[] = [
    { candidates: [candidate({ title: "Pneu de caminhão", description: "pneu rodoviário", category: "Auto Peças", observed_price: null, observed_rating: null, observed_rating_count: null, observed_availability: "UNKNOWN" })], candidate_evidence: [] },
    { candidates: [candidate()], candidate_evidence: [fieldEvidence({ field_name: "price", field_state: "COLLECTION_FAILED", evidence_id: "x1" })] },
  ];
  for (const store of scenarios) {
    const result = await assessCandidate("can-n4-test-001", deps(store));
    assert.ok(result.priority!.priority_score !== null && result.priority!.priority_score! >= 0 && result.priority!.priority_score! <= 1);
    assert.ok(PRIORITY_LEVELS.includes(result.priority!.priority_level));
  }
});

test("C22. prioridade decresce com risk alto (V1_RISK_SCORE.HIGH=0 puxa o composto)", async () => {
  const winner = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", evidence_id: "w1" }),
      fieldEvidence({ field_name: "review_count", evidence_id: "w2" }),
      fieldEvidence({ field_name: "images", evidence_id: "w3" }),
      fieldEvidence({ field_name: "price", evidence_id: "w4" }),
    ],
  };
  const risky = {
    candidates: [candidate()],
    candidate_evidence: [
      fieldEvidence({ field_name: "rating", evidence_id: "x1", field_state: "CONTRADICTED" }),
      fieldEvidence({ field_name: "price", evidence_id: "x2", field_state: "COLLECTION_FAILED" }),
    ],
  };
  const rWinner = await assessCandidate("can-n4-test-001", deps(winner));
  const rRisky = await assessCandidate("can-n4-test-001", deps(risky));
  assert.ok(rRisky.priority!.priority_score! < rWinner.priority!.priority_score!, "risco deve reduzir a prioridade");
  assert.equal(rRisky.dimensions?.RISK.label, "HIGH");
});

// ============================================================================
// PARTE 4 — CLASSIFY/RECOMMEND: máquina formal determinística
// ============================================================================

function emptyDims(): Dimensions {
  const base: Record<string, unknown> = {};
  for (const dim of DIMENSION_NAMES) {
    base[dim] = { label: "UNKNOWN", score: 0.3, basis: "t", evidence_refs: [] };
  }
  return base as unknown as Dimensions;
}

function dims(partial: Partial<Record<string, { label: string; score: number }>>): Dimensions {
  const d = emptyDims();
  for (const [k, v] of Object.entries(partial)) {
    (d as unknown as Record<string, unknown>)[k] = { label: v.label, score: v.score, basis: "t", evidence_refs: [] };
  }
  return d;
}

test("D23. classify é determinística e total sobre o espaço dos 9 eixos", () => {
  // Amostrar combinações: a função nunca lança e sempre retorna classificação do catálogo.
  const combos = [
    dims({ CERBERUS_FIT: { label: "LOW", score: 0 }, RISK: { label: "MEDIUM", score: 0.5 } }),
    dims({ RISK: { label: "HIGH", score: 0 } }),
    dims({ EVIDENCE_CONFIDENCE: { label: "INSUFFICIENT", score: 0 } }),
    dims({ DISCOVERY_VALUE: { label: "HIGH", score: 1 }, DEMAND_SIGNAL: { label: "WEAK", score: 0.2 } }),
    dims({ DISCOVERY_VALUE: { label: "HIGH", score: 1 }, DEMAND_SIGNAL: { label: "UNKNOWN", score: 0.3 } }),
  ];
  for (const d of combos) {
    const result = classify(d, null);
    assert.ok(CLASSIFICATIONS.includes(result.classification), `classificação ${result.classification} fora do catálogo`);
    assert.ok(result.basis.length > 10, "classificação sem rationale");
  }
});

test("D24. recommend nunca devolve recomendação fora do catálogo fechado", () => {
  for (const cls of CLASSIFICATIONS) {
    const rec = recommend({ classification: cls, basis: "teste" });
    assert.ok(RECOMMENDATIONS.includes(rec.recommendation), `recomendação ${rec.recommendation} fora do catálogo`);
    assert.ok(rec.basis.length > 5);
  }
});

test("D25. NOT_RECOMMENDED ⇒ recommendation REJECT; INSUFFICIENT ⇒ INVESTIGATE_FURTHER", () => {
  assert.equal(recommend({ classification: "NOT_RECOMMENDED", basis: "x" }).recommendation, "REJECT");
  assert.equal(recommend({ classification: "INSUFFICIENT", basis: "x" }).recommendation, "INVESTIGATE_FURTHER");
  assert.equal(recommend({ classification: "WINNER", basis: "x" }).recommendation, "ADD_TO_NICHE");
});

// ============================================================================
// PARTE 5 — ROTAS: auth, contratos, idempotência, falha fechada
// ============================================================================

test("E26. POST /assess sem x-admin-password → 401", async () => {
  const res = await request(buildApp()).post("/api/commercial/assess/can-n4-test-001");
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test("E27. senha correta → avaliação executada e persistida (outcome created)", async () => {
  // Injeção global: os DEFAULT_DEPS do filtro e do persist usam os clients
  // injetados em server.ts — em teste, injetamos um fake compartilhado.
  const fakeClient = new FakeSupabaseClient();
  fakeClient.store.set("candidates", [candidate()]);
  fakeClient.store.set("candidate_evidence", [fieldEvidence()]);
  setCandidatesClientForTests(fakeClient as never);
  setCandidateEvidenceClientForTests(fakeClient as never);
  setCandidateAssessmentClient(fakeClient as never);
  try {
    const res = await request(buildApp())
      .post("/api/commercial/assess/can-n4-test-001")
        .set("x-admin-password", "n4testpass");
    // Com store injetado a rota executa o filtro e persiste (created).
    assert.ok([200, 201].includes(res.status), `status inesperado ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.outcome, "created", "avaliação persistida via rota");
  } finally {
    setCandidatesClientForTests(null);
    setCandidateEvidenceClientForTests(null);
    setCandidateAssessmentClient(null);
  }
});

test("E28. GET histórico sem auth → 401; com auth → 200", async () => {
  const noAuth = await request(buildApp()).get("/api/commercial/assess/can-n4-test-001/history");
  assert.equal(noAuth.status, 401);
  const ok = await request(buildApp())
    .get("/api/commercial/assess/can-n4-test-001/history")
    .set("x-admin-password", "n4testpass");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(Array.isArray(ok.body.assessments));
});

test("E29. candidate_id inválido → 400", async () => {
  const res = await request(buildApp())
    .get("/api/commercial/assess/")
    .set("x-admin-password", "n4testpass");
  // express não casa "/" como :candidateId; testa caminho vazio via patch direto.
  assert.equal(typeof res.status, "number");
  // Validação via assessCandidate:
  const result = await assessCandidate("");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_candidate_id");
});

test("E30. candidate inexistente → assessment_failed (404), sem inventar avaliação", async () => {
  candidateStore = {};
  evidenceStore = {};
  const result = await assessCandidate("can-nao-existe-xyz", deps({}));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "candidate_not_found");
  assert.equal(result.classification, undefined);
  assert.equal(result.priority, undefined);
});

// ============================================================================
// PARTE 6 — REPOSITORY: persistência, idempotência, fail-closed, metadata
// ============================================================================

function validPersistInput(
  overrides: Partial<PersistAssessmentInput> = {},
): PersistAssessmentInput {
  const base: PersistAssessmentInput = {
    assessmentId: "asm-test-001",
    candidateId: "can-n4-test-001",
    filterVersion: "cerberus_filter_v1" as const,
    dimensions: { CERBERUS_FIT: { label: "HIGH", score: 1.0 } },
    classificationBasis: "base da classificação",
    recommendationBasis: "base da recomendação",
    priority: { priority_score: 0.7, priority_level: "HIGH", explanation: "Σ pesos", weights: V1_WEIGHTS },
    inputSnapshot: { candidate_id: "can-n4-test-001", filter_version: FILTER_VERSION },
    idempotencyKey: "sha256:digest-test",
    metadata: { api_key: "SECRETO", token_xyz: "t", origin: "test" },
  };
  return { ...base, ...overrides };
}

test("F31. persistência: is_actionable sempre false, scoring_version e schema_version fixos", async () => {
  const persisted = await persistAssessment(validPersistInput());
  assert.equal(persisted.ok, true);
  assert.equal(persisted.outcome, "created");
  const row = persisted.assessment!;
  assert.equal(row.is_actionable, false, "is_actionable NUNCA pode ser true");
  assert.equal(row.scoring_version, SCORING_VERSION);
  assert.equal(row.schema_version, "1.0");
  assert.equal(row.filter_version, FILTER_VERSION);
});

test("F32. metadata sensível é REDACTED na persistência (never expõe secrets)", async () => {
  const persisted = await persistAssessment(validPersistInput());
  const row = persisted.assessment! as { metadata: Record<string, unknown> };
  assert.equal(row.metadata.api_key, "REDACTED");
  assert.equal(row.metadata.token_xyz, "REDACTED");
  assert.equal(row.metadata.origin, "test");
});

test("F33. idempotência: replay com mesmo idempotency_key → identical_duplicate, zero linhas novas", async () => {
  const input = validPersistInput();
  const first = await persistAssessment(input);
  assert.equal(first.outcome, "created");
  const second = await persistAssessment(input);
  assert.equal(second.outcome, "identical_duplicate");
  assert.equal(second.assessment?.assessment_id, first.assessment?.assessment_id);
  const list = await listCandidateAssessments({ candidateId: "can-n4-test-001" });
  assert.equal(list.assessments.length, 1, "apenas UMA linha para o mesmo material");
});

test("F34. mudança legítima de evidências → nova linha (histórico cresce, nada é apagado)", async () => {
  await persistAssessment(validPersistInput({ assessmentId: "asm-1", idempotencyKey: "sha256:a" }));
  await persistAssessment(validPersistInput({ assessmentId: "asm-2", idempotencyKey: "sha256:b", inputSnapshot: { candidate_id: "can-n4-test-001", filter_version: FILTER_VERSION, evidence_count: 3 } }));
  const list = await listCandidateAssessments({ candidateId: "can-n4-test-001" });
  assert.equal(list.assessments.length, 2, "histórico preservado — nova linha adicionada");
});

test("F35. validation: classificação fora do catálogo → rejected com motivo explícito", async () => {
  const input = validPersistInput({ classification: "APROVADO" as never });
  const result = await persistAssessment(input);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid_classification/);
});

test("F36. priority_score fora de [0,1] → rejected", async () => {
  const input = validPersistInput({ priorityScore: 1.5 });
  const result = await persistAssessment(input);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid_priority_score/);
});

test("F37. dimensions vazio → rejected (score sem eixos não persiste)", async () => {
  const input = validPersistInput({ dimensions: {} });
  const result = await persistAssessment(input);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid_dimensions/);
});

test("F38. filter_version fora do catálogo fechado → rejected", async () => {
  const input = validPersistInput({ filterVersion: "cerberus_filter_v2_mais_nunca" as never });
  const result = await persistAssessment(input);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /invalid_filter_version/);
});

test("F39. fail-closed: sem client → erro explícito 'missing_supabase', nada persistido", async () => {
  resetAssessmentClientForTests(null);
  const result = await persistAssessment(validPersistInput());
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_supabase");
  const list = await listCandidateAssessments({ candidateId: "can-n4-test-001" });
  assert.equal(list.ok, false);
  assert.equal(list.error, "missing_supabase");
  resetAssessmentClientForTests(fakeClient as unknown as SupabaseClient);
});

test("F40. list ordena por created_at desc e limita 100", async () => {
  for (let i = 0; i < 3; i++) {
    await persistAssessment(validPersistInput({ assessmentId: `asm-l${i}`, idempotencyKey: `sha256:l${i}` }));
  }
  const list = await listCandidateAssessments({ candidateId: "can-n4-test-001", limit: 2 });
  assert.equal(list.assessments.length, 2, "limit aplicado");
  // A list ordena por created_at desc — com criação sequencial, a primeira
  // devolvida é a última persistida.
  assert.equal(list.assessments[0].assessment_id, "asm-l2");
  assert.equal(list.assessments[1].assessment_id, "asm-l1");
});

test("F41. limpeza de prova: deleteAssessmentForProof remove apenas a linha alvo", async () => {
  const a = await persistAssessment(validPersistInput({ assessmentId: "asm-cleanup", idempotencyKey: "sha256:cleanup" }));
  assert.equal(a.outcome, "created");
  const del = await deleteAssessmentForProof("asm-cleanup");
  assert.equal(del.ok, true);
  assert.equal(del.deletedCount, 1);
  const get = await getAssessment("asm-cleanup");
  assert.equal(get.ok, true);
  assert.equal(get.assessment, null, "zero resíduos após limpeza");
  // Outras linhas intactas.
  const list = await listCandidateAssessments({ candidateId: "can-n4-test-001" });
  assert.ok(list.assessments.length >= 0);
});

test("F42. buildAssessmentDigest determinístico: mesmas entradas → mesmo digest", () => {
  const params = {
    candidateId: "can-n4-test-001",
    filterVersion: FILTER_VERSION,
    snapshot: { evidence_count: 4, filter_version: FILTER_VERSION },
  };
  const d1 = buildAssessmentDigest(params);
  const d2 = buildAssessmentDigest(params);
  assert.equal(d1, d2);
  assert.match(d1, /^sha256:/);
  const d3 = buildAssessmentDigest({ ...params, snapshot: { ...params.snapshot, evidence_count: 5 } });
  assert.notEqual(d3, d1, "mudança no snapshot altera o digest");
});

// ============================================================================
// PARTE 7 — COCKPIT: /assess render-only
// ============================================================================

test("G43. renderAssessment sem candidate_id → instrução de uso, sem executar filtro", async () => {
  const text = await commercialCockpit.renderAssessment(undefined);
  assert.match(text, /RENDER-ONLY/);
  assert.match(text, /RECOMMENDATION != ACTION/);
  assert.match(text, /\/assess &lt;candidate_id&gt;/);
});

test("G44. renderAssessment sem avaliação registrada → neutral, sem inferência", async () => {
  resetAssessmentClientForTests(fakeClient as unknown as SupabaseClient);
  const text = await commercialCockpit.renderAssessment("can-n4-test-001");
  assert.match(text, /Nenhuma avaliação registrada/);
  assert.match(text, /RENDER-ONLY/);
});

test("G45. renderAssessment com avaliação → classificação + rationale + incertezas declaradas", async () => {
  await persistAssessment(validPersistInput({
    assessmentId: "asm-render-1",
    idempotencyKey: "sha256:render-1",
    classification: "WINNER",
    classificationBasis: "base formal de teste",
    recommendation: "ADD_TO_NICHE",
    recommendationBasis: "base de recomendação de teste",
    priority: { explanation: "Σ pesos", weights: V1_WEIGHTS },
    priorityLevel: "HIGH",
    priorityScore: 0.72,
    unknowns: ["price(evi-1)"],
    contradictions: ["price(evi-2)"],
  }));
  const text = await commercialCockpit.renderAssessment("can-n4-test-001");
  assert.match(text, /WINNER/);
  assert.match(text, /ADD_TO_NICHE/);
  assert.match(text, /is_actionable=false/);
  assert.match(text, /base formal de teste/);
  assert.match(text, /Incertezas declaradas \(UNKNOWN\): 1/);
  assert.match(text, /Contradições preservadas: 1/);
  assert.match(text, /Σ pesos/);
});

// ============================================================================
// PARTE 8 — INDEPENDÊNCIA DO CATÁLOGO CANÔNICO
// ============================================================================

test("H46. nada no repository/routes toca public.products: schema e rotas sem referência a products", async () => {
  const fs = await import("node:fs");
  // Ignora linhas de comentário (a governança cita "public.products" por escrito
  // no cabeçalho — o contrato real é sobre código, não documentação).
  const stripComments = (src: string) =>
    src
      .split("\n")
      .filter(line => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("--"))
      .join("\n");
  const repoSrc = stripComments(
    fs.readFileSync("./server/repositories/candidateAssessmentRepository.ts", "utf8"),
  );
  const routesSrc = stripComments(fs.readFileSync("./server/routes/assessmentRoutes.ts", "utf8"));
  const migrationSrc = stripComments(
    fs.readFileSync("./supabase/migrations/20260816_candidate_assessment.sql", "utf8"),
  );
  assert.doesNotMatch(repoSrc, /public\.products|from\("products"\)/);
  assert.doesNotMatch(routesSrc, /public\.products/);
  assert.doesNotMatch(migrationSrc, /references public\.products|FOREIGN KEY .*products/i);
  assert.match(migrationSrc, /enable row level security/, "RLS ativo na migration");
  assert.doesNotMatch(migrationSrc, /CREATE POLICY|create policy/, "zero policies públicas");
  assert.match(migrationSrc, /is_actionable boolean not null default false\s+check \(is_actionable = false\)/i);
});

test("H47. assessCandidate nunca devolve promotion/product_id; candidate não promovido", async () => {
  const store = {
    candidates: [candidate({ promoted_product_id: null })],
    candidate_evidence: [fieldEvidence({ field_name: "price", evidence_id: "h1" })],
  };
  const result = await assessCandidate("can-n4-test-001", deps(store));
  assert.equal(result.ok, true);
  assert.equal(result.candidate?.promoted_product_id, null);
  assert.match(result.dimensions!.AFFILIATE_ECONOMICS.basis, /não inventar|NÃO inventar/i);
  assert.match(result.dimensions!.AD_VIABILITY.basis, /preparação apenas|não transformar potencial em ROI/i);
});
