// ============================================================================
// Bloco N9 — Repository do Ciclo Comercial + Decisões.
// Padrão do projeto (N1–N8): client Supabase injetável (production wire-up
// via server.ts; testes via setCycleClientForTests). Fail-closed sob erro:
// qualquer falha de persistência/leitura retorna { ok: false } com motivo —
// jamais exceção silenciosa nem dado inventado.
// NUNCA cria FK para public.products (fronteira CYCLE != PRODUCT FACT).
// ============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export const CYCLES_TABLE = "commercial_cycles" as const;
export const DECISIONS_TABLE = "commercial_decisions" as const;
export const STEPS_TABLE = "commercial_cycle_steps" as const;

let client: SupabaseClient | null = null;

export function setCycleClient(c: SupabaseClient | null): void {
  client = c;
}

/** Hook TEST-ONLY: injeta/limpa o client (mesmo padrão dos repositórios N1–N8). */
export function setCycleClientForTests(c: SupabaseClient | null): void {
  client = c;
}

function requireClient(): SupabaseClient {
  if (!client) throw new Error("cycle_repository_missing_supabase");
  return client;
}

function safeString(value: string, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, Math.max(0, max));
}

export interface CycleRecord {
  cycle_id: string;
  status: string;
  source_type: string;
  marketplace: string;
  source_url: string;
  candidate_id: string | null;
  research_id: string | null;
  assessment_id: string | null;
  acquisition_ref: string | null;
  affiliate_link_id: string | null;
  resolution_status: string | null;
  decision_id: string | null;
  execution_id: string | null;
  product_id: string | null;
  idempotency_key: string;
  constraint_version: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface DecisionRecord {
  decision_id: string;
  cycle_id: string;
  candidate_id: string;
  decision: string;
  decision_version: string;
  blocking_rules: string[];
  passed_rules: string[];
  assessment_id: string | null;
  classification: string | null;
  recommendation: string | null;
  priority: string | null;
  unknowns_count: number;
  contradictions_count: number;
  collection_failed: boolean;
  identity_confidence: string | null;
  resolution_status: string | null;
  price_state: string | null;
  affiliate_state: string | null;
  require_affiliate_link: boolean;
  rationale: string;
  input_digest: string;
  created_at: string;
  created_by: string;
}

export interface StepRecord {
  step_id: string;
  cycle_id: string;
  stage: string;
  result: string;
  blocking_code: string | null;
  rationale: string;
  evidence_ref: string;
  idempotency_key: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------
export async function persistCycle(params: {
  cycleId: string;
  status: string;
  sourceType: "URL" | "QUERY";
  marketplace: string;
  sourceUrl: string;
  idempotencyKey: string;
  createdBy?: string;
}): Promise<{ ok: boolean; cycle?: CycleRecord; outcome?: "created" | "identical_duplicate"; reason?: string }> {
  const db = requireClient();
  const now = new Date().toISOString();
  const record = {
    cycle_id: params.cycleId,
    status: params.status,
    source_type: params.sourceType,
    marketplace: params.marketplace,
    source_url: safeString(params.sourceUrl, 2048),
    idempotency_key: params.idempotencyKey,
    constraint_version: "n9-cycle-v1",
    created_by: safeString(params.createdBy ?? "operator-admin", 120),
  } as const;
  try {
    const { data, error } = await db
      .from(CYCLES_TABLE)
      .insert(record)
      .select()
      .single();
    if (error) {
      const duplicate = String(error.code ?? "") === "23505" || String(error.message ?? "").includes("duplicate");
      if (duplicate) {
        return { ok: true, outcome: "identical_duplicate" };
      }
      return { ok: false, reason: error.message ?? "persist_cycle_failed" };
    }
    return { ok: true, cycle: data as CycleRecord, outcome: "created" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "persist_cycle_error" };
  }
}

export async function getCycle(cycleId: string): Promise<{ ok: boolean; cycle: CycleRecord | null; reason?: string }> {
  const db = requireClient();
  try {
    const { data, error } = await db.from(CYCLES_TABLE).select("*").eq("cycle_id", cycleId).maybeSingle();
    if (error) return { ok: false, cycle: null, reason: error.message ?? "get_cycle_failed" };
    return { ok: true, cycle: (data as CycleRecord | null) ?? null };
  } catch (err) {
    return { ok: false, cycle: null, reason: err instanceof Error ? err.message : "get_cycle_error" };
  }
}

export async function updateCycle(params: {
  cycleId: string;
  patch: Partial<Record<string, unknown>>;
}): Promise<{ ok: boolean; reason?: string }> {
  const db = requireClient();
  try {
    const { error } = await db
      .from(CYCLES_TABLE)
      .update({ ...params.patch, updated_at: new Date().toISOString() })
      .eq("cycle_id", params.cycleId);
    if (error) return { ok: false, reason: error.message ?? "update_cycle_failed" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "update_cycle_error" };
  }
}

export async function listCycles(params: { limit?: number }): Promise<{ ok: boolean; cycles: CycleRecord[]; reason?: string }> {
  const db = requireClient();
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 20)), 200);
  try {
    const { data, error } = await db.from(CYCLES_TABLE).select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) return { ok: false, cycles: [], reason: error.message ?? "list_cycles_failed" };
    return { ok: true, cycles: (data ?? []) as CycleRecord[] };
  } catch (err) {
    return { ok: false, cycles: [], reason: err instanceof Error ? err.message : "list_cycles_error" };
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
export async function persistDecision(params: {
  decisionId: string;
  cycleId: string;
  candidateId: string;
  decision: string;
  blockingRules: ReadonlyArray<string>;
  passedRules: ReadonlyArray<string>;
  assessmentId: string | null;
  classification: string | null;
  recommendation: string | null;
  priority: string | null;
  unknownsCount: number;
  contradictionsCount: number;
  collectionFailed: boolean;
  identityConfidence: string | null;
  resolutionStatus: string | null;
  priceState: string | null;
  affiliateState: string | null;
  requireAffiliateLink: boolean;
  rationale: string;
  inputDigest: string;
  createdBy?: string;
}): Promise<{ ok: boolean; decision?: DecisionRecord; outcome?: "created" | "identical_duplicate"; reason?: string }> {
  const db = requireClient();
  const record = {
    decision_id: params.decisionId,
    cycle_id: params.cycleId,
    candidate_id: params.candidateId,
    decision: params.decision,
    decision_version: "commercial_decision_v1",
    blocking_rules: params.blockingRules,
    passed_rules: params.passedRules,
    assessment_id: params.assessmentId,
    classification: params.classification,
    recommendation: params.recommendation,
    priority: params.priority,
    unknowns_count: params.unknownsCount,
    contradictions_count: params.contradictionsCount,
    collection_failed: params.collectionFailed,
    identity_confidence: params.identityConfidence,
    resolution_status: params.resolutionStatus,
    price_state: params.priceState,
    affiliate_state: params.affiliateState,
    require_affiliate_link: params.requireAffiliateLink,
    rationale: safeString(params.rationale, 6000),
    input_digest: params.inputDigest,
    created_by: safeString(params.createdBy ?? "operator-admin", 120),
  } as const;
  try {
    const { data, error } = await db.from(DECISIONS_TABLE).insert(record).select().single();
    if (error) {
      const duplicate = String(error.code ?? "") === "23505" || String(error.message ?? "").includes("duplicate");
      if (duplicate) {
        return { ok: true, outcome: "identical_duplicate" };
      }
      return { ok: false, reason: error.message ?? "persist_decision_failed" };
    }
    return { ok: true, decision: data as DecisionRecord, outcome: "created" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "persist_decision_error" };
  }
}

export async function getDecision(decisionId: string): Promise<{ ok: boolean; decision: DecisionRecord | null; reason?: string }> {
  const db = requireClient();
  try {
    const { data, error } = await db.from(DECISIONS_TABLE).select("*").eq("decision_id", decisionId).maybeSingle();
    if (error) return { ok: false, decision: null, reason: error.message ?? "get_decision_failed" };
    return { ok: true, decision: (data as DecisionRecord | null) ?? null };
  } catch (err) {
    return { ok: false, decision: null, reason: err instanceof Error ? err.message : "get_decision_error" };
  }
}

export async function getDecisionByCycle(cycleId: string): Promise<{ ok: boolean; decision: DecisionRecord | null; reason?: string }> {
  const db = requireClient();
  try {
    const { data, error } = await db.from(DECISIONS_TABLE).select("*").eq("cycle_id", cycleId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return { ok: false, decision: null, reason: error.message ?? "get_decision_by_cycle_failed" };
    return { ok: true, decision: (data as DecisionRecord | null) ?? null };
  } catch (err) {
    return { ok: false, decision: null, reason: err instanceof Error ? err.message : "get_decision_by_cycle_error" };
  }
}

// ---------------------------------------------------------------------------
// Steps (registro auditável de cada transição — máquina de estados)
// ---------------------------------------------------------------------------
export async function persistStep(params: {
  stepId: string;
  cycleId: string;
  stage: string;
  result: string;
  blockingCode: string | null;
  rationale: string;
  evidenceRef: string;
  idempotencyKey: string;
}): Promise<{ ok: boolean; outcome?: "created" | "identical_duplicate"; reason?: string }> {
  const db = requireClient();
  const record = {
    step_id: params.stepId,
    cycle_id: params.cycleId,
    stage: params.stage,
    result: params.result,
    blocking_code: params.blockingCode,
    rationale: safeString(params.rationale, 6000),
    evidence_ref: safeString(params.evidenceRef, 2048),
    idempotency_key: params.idempotencyKey,
  } as const;
  try {
    const { error } = await db.from(STEPS_TABLE).insert(record);
    if (error) {
      const duplicate = String(error.code ?? "") === "23505" || String(error.message ?? "").includes("duplicate");
      if (duplicate) {
        return { ok: true, outcome: "identical_duplicate" };
      }
      return { ok: false, reason: error.message ?? "persist_step_failed" };
    }
    return { ok: true, outcome: "created" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "persist_step_error" };
  }
}

export async function listSteps(cycleId: string): Promise<{ ok: boolean; steps: StepRecord[]; reason?: string }> {
  const db = requireClient();
  try {
    const { data, error } = await db.from(STEPS_TABLE).select("*").eq("cycle_id", cycleId).order("created_at", { ascending: true });
    if (error) return { ok: false, steps: [], reason: error.message ?? "list_steps_failed" };
    return { ok: true, steps: (data ?? []) as StepRecord[] };
  } catch (err) {
    return { ok: false, steps: [], reason: err instanceof Error ? err.message : "list_steps_error" };
  }
}

/** Limpeza integral de PROVA: apaga steps → decisions → cycle (ordem FK).
 *  Somente para cleanup de dados artificiais em provas controladas; uso
 *  produtivo exige autorização separada (nunca usado pelo ciclo em si). */
export async function deleteCycleProof(params: {
  cycleId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const db = requireClient();
  try {
    const { error: stepsError } = await db.from(STEPS_TABLE).delete().eq("cycle_id", params.cycleId);
    if (stepsError) return { ok: false, reason: stepsError.message ?? "delete_steps_failed" };
    const { error: decisionsError } = await db.from(DECISIONS_TABLE).delete().eq("cycle_id", params.cycleId);
    if (decisionsError) return { ok: false, reason: decisionsError.message ?? "delete_decisions_failed" };
    const { error: cycleError } = await db.from(CYCLES_TABLE).delete().eq("cycle_id", params.cycleId);
    if (cycleError) return { ok: false, reason: cycleError.message ?? "delete_cycle_failed" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "delete_cycle_proof_error" };
  }
}
