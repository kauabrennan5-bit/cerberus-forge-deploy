/**
 * Cerberus Finds Archive — Bloco 17 — Experiment Registry
 * Repositório de persistência dos experimentos de decisão comercial.
 *
 * Fronteiras: EXPERIMENT != EXECUTION · DECISION != ACTION
 *             SIGNAL != REVENUE · RECOMMENDATION != ACTION
 *
 * Este módulo NÃO executa variantes, NÃO altera produtos, catálogo,
 * job queue, lifecycle, watchdog ou webhook do Telegram. Ele apenas
 * grava e lê o registro formal de experimentos produzidos pelo operator
 * (design declarado ANTES, métrica declarada ANTES, decisão SOMENTE após
 * o gate estatístico).
 *
 * Regras duras:
 *   - hypothesis é imutável após a criação;
 *   - variant_a_label/variant_b_label são imutáveis após o início (RUNNING);
 *   - success_metric e metric_definition são obrigatórios na criação;
 *   - decisão SÓ é permitida quando sample_size >= min_sample_size OU
 *     planned_end_date já passou (INCONCLUSIVE permitido); tentativa
 *     prematura é REJEITADA com explicação detalhada;
 *   - idempotência real via experiment_id (PK) + experiment_key (UNIQUE):
 *     idêntico → identical_duplicate; conflitante → conflict_rejected;
 *   - persistência ausente NUNCA vira sucesso: missing_supabase explícito;
 *   - sanitização: hypothesis/rationale/labels jamais contêm secrets.
 *
 * Padrão injetável dos Blocos 13/14/15/16: cliente Supabase injetado por
 * setExperimentClient em server.ts; testes via setExperimentClientForTests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import {
  sanitizeMetadata,
  sanitizeText,
  TEXT_SENSITIVE_PATTERNS,
} from "./policyJournalRepository";

export const EXPERIMENTS_TABLE = "experiments" as const;
export const EXPERIMENT_SCHEMA_VERSION = "1.0";
export const EXPERIMENT_RIGOR_VERSION = "statistical_rigor_v1";

export const EXPERIMENT_DECISIONS = [
  "SCALE",
  "MAINTAIN",
  "KILL",
  "INCONCLUSIVE",
] as const;
export type ExperimentDecision = (typeof EXPERIMENT_DECISIONS)[number];

export const EXPERIMENT_STATUSES = [
  "DRAFT",
  "RUNNING",
  "ENDED",
  "CANCELLED",
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const DECISION_REJECTION_REASONS = [
  "premature_decision_sample_unmet",
  "premature_decision_period_active",
  "decision_already_recorded",
  "invalid_decision_value",
  "experiment_not_found",
  "period_not_planned",
] as const;
export type DecisionRejectionReason =
  (typeof DECISION_REJECTION_REASONS)[number];

// Catálogo fechado (espelho da migration 20260816_experiments)
const STORED_STATUSES: ReadonlySet<string> = new Set(EXPERIMENT_STATUSES);
const STORED_DECISIONS: ReadonlySet<string> = new Set(EXPERIMENT_DECISIONS);

// ============================================================================
// Digests e sanitização
// ============================================================================

/** Digest determinístico (SHA-256 do JSON canônico, ordenado). */
export function experimentDigest(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Chave de idempotência determinística do experimento. */
export function experimentKeyFromDesign(design: {
  hypothesis: string;
  variant_a_label: string;
  variant_b_label: string;
  target_product_ids: readonly string[];
  success_metric: string;
  schema_version: string;
}): string {
  return experimentDigest({
    hypothesis: design.hypothesis,
    variant_a_label: design.variant_a_label,
    variant_b_label: design.variant_b_label,
    target_product_ids: [...design.target_product_ids].sort(),
    success_metric: design.success_metric,
    schema_version: design.schema_version,
  }).slice(0, 32);
}

/**
 * Sanitização coerente com os Blocos 10/11/13/14/15/16: texto jamais
 * contém patterns de segredo (token, secret, password, authorization,
 * prompt, instruction externa ou credenciais).
 */
export function sanitizeExperimentText(text: string): string {
  let sanitized = sanitizeText(text);
  if (sanitized.length > 2000) {
    sanitized = `${sanitized.slice(0, 2000)}…[truncated]`;
  }
  return sanitized;
}

// ============================================================================
// Contratos
// ============================================================================

export interface ExperimentDesignInput {
  experiment_id?: string;
  experiment_key?: string;
  hypothesis: string;
  rationale?: string;
  variant_a_label: string;
  variant_b_label: string;
  target_population: string;
    target_product_ids: readonly string[];
  success_metric: string;
  metric_definition: string;
  design_alpha?: number;
  design_power?: number;
  design_mde_relative?: number;
  design_baseline_proportion?: number;
  fdr?: number;
  min_sample_size: number;
  planned_duration_days?: number;
  planned_end_date?: string | null;
  created_by?: string;
  schema_version?: string;
}

export interface ExperimentRecord {
  experiment_id: string;
  experiment_key: string;
  schema_version: string;
  statistical_rigor_version: string;
  hypothesis: string;
  rationale: string;
  variant_a_label: string;
  variant_b_label: string;
  target_population: string;
  target_product_ids: string[];
  success_metric: string;
  metric_definition: string;
  design_alpha: number;
  design_power: number;
  design_mde_relative: number;
  design_baseline_proportion: number;
  fdr: number;
  min_sample_size: number;
  planned_duration_days: number;
  start_date: string | null;
  planned_end_date: string | null;
  sample_size: number;
  sample_size_a: number;
  sample_size_b: number;
  clicks_a: number;
  clicks_b: number;
  status: string;
  decision: string | null;
  decision_basis: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateOutcome {
  inserted: boolean;
  identical_duplicate: boolean;
  conflict_rejected: boolean;
  missing_supabase: boolean;
  database_error: boolean;
  error_message: string | null;
  record: ExperimentRecord | null;
}

export interface DecisionOutcome {
  accepted: boolean;
  rejected: boolean;
  rejection_reason: DecisionRejectionReason | null;
  rejection_explanation: string | null;
  missing_supabase: boolean;
  database_error: boolean;
  error_message: string | null;
  sample_current: number;
  sample_minimum: number;
  days_remaining: number | null;
  record: ExperimentRecord | null;
}

export interface ObservationOutcome {
  updated: boolean;
  missing_supabase: boolean;
  database_error: boolean;
  error_message: string | null;
  record: ExperimentRecord | null;
}

export interface ExperimentListResult {
  success: boolean;
  experiments: ExperimentRecord[];
  total: number;
  missing_supabase: boolean;
}

// ============================================================================
// Injeção (padrão Blocos 13/14/15/16)
// ============================================================================

let experimentClient: SupabaseClient | null = null;

export function getExperimentClient(): SupabaseClient | null {
  return experimentClient;
}

export function setExperimentClient(client: SupabaseClient | null): void {
  experimentClient = client;
}

export function setExperimentClientForTests(
  client: SupabaseClient | null,
): void {
  experimentClient = client;
}

function requireClient(): SupabaseClient | null {
  if (!experimentClient) return null;
  return experimentClient;
}

function isPostgrestDuplicate(
  error: { code?: string; message?: string } | null,
): boolean {
  return (
    !!error &&
    error.code === "23505" &&
    /experiments_(pkey|experiment_key_key)/.test(error.message ?? "")
  );
}

function rowToRecord(row: Record<string, unknown>): ExperimentRecord {
  return {
    experiment_id: String(row.experiment_id),
    experiment_key: String(row.experiment_key),
    schema_version: String(row.schema_version),
    statistical_rigor_version: String(row.statistical_rigor_version),
    hypothesis: String(row.hypothesis ?? ""),
    rationale: String(row.rationale ?? ""),
    variant_a_label: String(row.variant_a_label ?? ""),
    variant_b_label: String(row.variant_b_label ?? ""),
    target_population: String(row.target_population ?? ""),
    target_product_ids: Array.isArray(row.target_product_ids)
      ? row.target_product_ids.map(String)
      : [],
    success_metric: String(row.success_metric ?? ""),
    metric_definition: String(row.metric_definition ?? ""),
    design_alpha: Number(row.design_alpha ?? 0),
    design_power: Number(row.design_power ?? 0),
    design_mde_relative: Number(row.design_mde_relative ?? 0),
    design_baseline_proportion: Number(row.design_baseline_proportion ?? 0),
    fdr: Number(row.fdr ?? 0),
    min_sample_size: Number(row.min_sample_size ?? 0),
    planned_duration_days: Number(row.planned_duration_days ?? 0),
    start_date: row.start_date ? String(row.start_date) : null,
    planned_end_date: row.planned_end_date ? String(row.planned_end_date) : null,
    sample_size: Number(row.sample_size ?? 0),
    sample_size_a: Number(row.sample_size_a ?? 0),
    sample_size_b: Number(row.sample_size_b ?? 0),
    clicks_a: Number(row.clicks_a ?? 0),
    clicks_b: Number(row.clicks_b ?? 0),
    status: String(row.status ?? "DRAFT"),
    decision: row.decision ? String(row.decision) : null,
    decision_basis: row.decision_basis ? String(row.decision_basis) : null,
    decided_at: row.decided_at ? String(row.decided_at) : null,
    decided_by: row.decided_by ? String(row.decided_by) : null,
    created_by: String(row.created_by ?? "operator-admin"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

// ============================================================================
// Validação do design (obrigatoriedades antes da persistência)
// ============================================================================

export function validateExperimentDesign(
  input: ExperimentDesignInput,
): { valid: true } | { valid: false; error_code: string; explanation: string } {
  const {
    hypothesis,
    variant_a_label,
    variant_b_label,
    target_product_ids,
    success_metric,
    metric_definition,
    min_sample_size,
  } = input;

  if (!hypothesis || !hypothesis.trim()) {
    return { valid: false, error_code: "HYPOTHESIS_REQUIRED", explanation: "hypothesis é obrigatório e não pode ser vazio." };
  }
  if (!variant_a_label || !variant_a_label.trim()) {
    return { valid: false, error_code: "VARIANT_A_REQUIRED", explanation: "variant_a_label é obrigatório." };
  }
  if (!variant_b_label || !variant_b_label.trim()) {
    return { valid: false, error_code: "VARIANT_B_REQUIRED", explanation: "variant_b_label é obrigatório." };
  }
  if (variant_a_label.trim() === variant_b_label.trim()) {
    return { valid: false, error_code: "VARIANTS_IDENTICAL", explanation: "As variantes não podem ter o mesmo rótulo." };
  }
  if (!Array.isArray(target_product_ids) || target_product_ids.length === 0) {
    return { valid: false, error_code: "TARGET_PRODUCTS_REQUIRED", explanation: "target_product_ids precisa ter ao menos um produto canônico." };
  }
  if (!success_metric || !success_metric.trim()) {
    return { valid: false, error_code: "SUCCESS_METRIC_REQUIRED", explanation: "success_metric é obrigatório e deve ser definido antes do início." };
  }
  if (!metric_definition || !metric_definition.trim()) {
    return { valid: false, error_code: "METRIC_DEFINITION_REQUIRED", explanation: "metric_definition (proveniência da métrica) é obrigatória." };
  }
  if (!Number.isFinite(min_sample_size) || min_sample_size < 1) {
    return { valid: false, error_code: "MIN_SAMPLE_INVALID", explanation: "min_sample_size deve ser um inteiro >= 1, derivado do modelo estatístico." };
  }
  const alpha = input.design_alpha ?? 0.05;
  const power = input.design_power ?? 0.8;
  const fdr = input.fdr ?? 0.1;
  if (alpha <= 0 || alpha >= 1 || power <= 0 || power > 1 || fdr <= 0 || fdr > 1) {
    return { valid: false, error_code: "DESIGN_PARAMS_INVALID", explanation: "design_alpha/design_power/fdr devem estar em (0,1]." };
  }
  if (input.planned_duration_days !== undefined && input.planned_duration_days < 1) {
    return { valid: false, error_code: "DURATION_INVALID", explanation: "planned_duration_days deve ser >= 1." };
  }
  return { valid: true };
}

// ============================================================================
// Criação (idempotência real + sanitização)
// ============================================================================

export async function insertExperiment(
  input: ExperimentDesignInput,
): Promise<CreateOutcome> {
  const client = requireClient();
  if (!client) {
    return {
      inserted: false,
      identical_duplicate: false,
      conflict_rejected: false,
      missing_supabase: true,
      database_error: false,
      error_message: "Supabase client ausente (fail-closed).",
      record: null,
    };
  }

  const validation = validateExperimentDesign(input);
  if (!validation.valid) {
    const err = validation as { error_code: string; explanation: string };
    return {
      inserted: false,
      identical_duplicate: false,
      conflict_rejected: true,
      missing_supabase: false,
      database_error: false,
      error_message: `${err.error_code}: ${err.explanation}`,
      record: null,
    };
  }

  const experiment_id = input.experiment_id ?? `exp-${experimentDigest({ hypothesis: input.hypothesis, created: Date.now() }).slice(0, 24)}`;
  const experiment_key = input.experiment_key ?? experimentKeyFromDesign({
    hypothesis: input.hypothesis,
    variant_a_label: input.variant_a_label,
    variant_b_label: input.variant_b_label,
    target_product_ids: input.target_product_ids,
    success_metric: input.success_metric,
    schema_version: input.schema_version ?? EXPERIMENT_SCHEMA_VERSION,
  });

  const row: Record<string, unknown> = {
    experiment_id,
    experiment_key,
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    statistical_rigor_version: EXPERIMENT_RIGOR_VERSION,
    hypothesis: sanitizeExperimentText(input.hypothesis),
    rationale: sanitizeExperimentText(input.rationale ?? ""),
    variant_a_label: sanitizeExperimentText(input.variant_a_label),
    variant_b_label: sanitizeExperimentText(input.variant_b_label),
    target_population: sanitizeExperimentText(input.target_population),
    target_product_ids: [...input.target_product_ids],
    success_metric: sanitizeExperimentText(input.success_metric),
    metric_definition: sanitizeExperimentText(input.metric_definition),
    design_alpha: input.design_alpha ?? 0.05,
    design_power: input.design_power ?? 0.8,
    design_mde_relative: input.design_mde_relative ?? 0.5,
    design_baseline_proportion: input.design_baseline_proportion ?? 0.02,
    fdr: input.fdr ?? 0.1,
    min_sample_size: Math.floor(input.min_sample_size),
    planned_duration_days: input.planned_duration_days ?? 7,
    status: "DRAFT",
    created_by: input.created_by ?? "operator-admin",
  };

  try {
    // Consulta de duplicidade (mesma intenção declarada).
    const duplicateQuery = client
      .from(EXPERIMENTS_TABLE)
      .select("*")
      .eq("experiment_key", experiment_key)
      .limit(1)
      .maybeSingle();
    const dupRes = await duplicateQuery;
    const dupError = (dupRes as { error?: { code?: string; message?: string } | null }).error ?? null;
    const dupRow = dupRes && "data" in dupRes ? (dupRes as { data: Record<string, unknown> | null }).data : null;

    if (dupRow) {
      const sameId = dupRow.experiment_id === experiment_id;
      if (sameId) {
        return {
          inserted: false,
          identical_duplicate: true,
          conflict_rejected: false,
          missing_supabase: false,
          database_error: false,
          error_message: null,
          record: rowToRecord(dupRow),
        };
      }
      // Mesma intenção declarada, experiment_id divergente = contexto conflitante.
      return {
        inserted: false,
        identical_duplicate: false,
        conflict_rejected: true,
        missing_supabase: false,
        database_error: false,
        error_message: `experiment_key colide com experiment_id divergente (${dupRow.experiment_id}).`,
        record: null,
      };
    }
    if (dupError) {
      if (isPostgrestDuplicate(dupError)) {
        // Concorrência: re-tenta a leitura pela PK.
        const retry = await client
          .from(EXPERIMENTS_TABLE)
          .select("*")
          .eq("experiment_id", experiment_id)
          .limit(1)
          .maybeSingle();
        const retryData = retry && "data" in retry ? (retry as { data: Record<string, unknown> | null }).data : null;
        if (retryData) {
          return {
            inserted: false,
            identical_duplicate: true,
            conflict_rejected: false,
            missing_supabase: false,
            database_error: false,
            error_message: null,
            record: rowToRecord(retryData),
          };
        }
        return {
          inserted: false,
          identical_duplicate: false,
          conflict_rejected: true,
          missing_supabase: false,
          database_error: false,
          error_message: `Duplicidade por concorrência sem resolução: ${dupError.message}`,
          record: null,
        };
      }
      throw dupError;
    }

    const res = await client.from(EXPERIMENTS_TABLE).insert(row).select().single();
    const data = res && "data" in res ? (res as { data: Record<string, unknown> }).data : null;
    const error = (res as { error?: { code?: string; message?: string } | null }).error ?? null;

    if (isPostgrestDuplicate(error)) {
      const retry = await client
        .from(EXPERIMENTS_TABLE)
        .select("*")
        .eq("experiment_key", experiment_key)
        .limit(1)
        .maybeSingle();
      const retryData = retry && "data" in retry ? (retry as { data: Record<string, unknown> | null }).data : null;
      if (retryData) {
        return {
          inserted: false,
          identical_duplicate: true,
          conflict_rejected: false,
          missing_supabase: false,
          database_error: false,
          error_message: null,
          record: rowToRecord(retryData),
        };
      }
      return {
        inserted: false,
        identical_duplicate: false,
        conflict_rejected: true,
        missing_supabase: false,
        database_error: false,
        error_message: "Duplicate na UK sem resolução.",
        record: null,
      };
    }
    if (error) throw error;
    if (!data) {
      return {
        inserted: false,
        identical_duplicate: false,
        conflict_rejected: false,
        missing_supabase: false,
        database_error: true,
        error_message: "Insert não retornou registro.",
        record: null,
      };
    }
    return {
      inserted: true,
      identical_duplicate: false,
      conflict_rejected: false,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      record: rowToRecord(data),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      inserted: false,
      identical_duplicate: false,
      conflict_rejected: false,
      missing_supabase: false,
      database_error: true,
      error_message: e?.message ?? "Erro de banco desconhecido.",
      record: null,
    };
  }
}

// ============================================================================
// Leitura read-only
// ============================================================================

export async function getExperiment(
  experiment_id: string,
): Promise<ExperimentListResult> {
  const client = requireClient();
  if (!client) {
    return { success: false, experiments: [], total: 0, missing_supabase: true };
  }
  try {
    const res = await client
      .from(EXPERIMENTS_TABLE)
      .select("*")
      .eq("experiment_id", experiment_id)
      .limit(1)
      .maybeSingle();
    const data = res && "data" in res ? (res as { data: Record<string, unknown> | null }).data : null;
    if (!data) {
      return { success: true, experiments: [], total: 0, missing_supabase: false };
    }
    return {
      success: true,
      experiments: [rowToRecord(data)],
      total: 1,
      missing_supabase: false,
    };
  } catch {
    return { success: false, experiments: [], total: 0, missing_supabase: false };
  }
}

export async function listExperiments(
  opts?: { status?: ExperimentStatus; limit?: number; offset?: number },
): Promise<ExperimentListResult> {
  const client = requireClient();
  if (!client) {
    return { success: false, experiments: [], total: 0, missing_supabase: true };
  }
  try {
    let query = client.from(EXPERIMENTS_TABLE).select("*", { count: "exact" });
    if (opts?.status) query = query.eq("status", opts.status);
    if (opts?.limit) query = query.limit(opts.limit);
    if (opts?.offset) query = query.range(opts.offset, (opts.offset ?? 0) + (opts?.limit ?? 20) - 1);
    const res = await query;
    const data = res && "data" in res ? (res as { data: Array<Record<string, unknown>> | null }).data : null;
    const count = res && "count" in res ? (res as { count: number | null }).count ?? 0 : 0;
    return {
      success: true,
      experiments: (data ?? []).map(rowToRecord),
      total: count,
      missing_supabase: false,
    };
  } catch {
    return { success: false, experiments: [], total: 0, missing_supabase: false };
  }
}

/** Somente decisões formalmente registradas (nada de opinião como decisão). */
export async function listDecisions(): Promise<ExperimentListResult> {
  const client = requireClient();
  if (!client) {
    return { success: false, experiments: [], total: 0, missing_supabase: true };
  }
  try {
    const res = await client
      .from(EXPERIMENTS_TABLE)
      .select("*", { count: "exact" })
      .not("decision", "is", null)
      .order("decided_at", { ascending: false });
    const data = res && "data" in res ? (res as { data: Array<Record<string, unknown>> | null }).data : null;
    const count = res && "count" in res ? (res as { count: number | null }).count ?? 0 : 0;
    return {
      success: true,
      experiments: (data ?? []).map(rowToRecord),
      total: count,
      missing_supabase: false,
    };
  } catch {
    return { success: false, experiments: [], total: 0, missing_supabase: false };
  }
}

// ============================================================================
// Observação: amostra (sem alterar hypothesis/variantes/métrica)
// ============================================================================

/**
 * Atualiza a observação do experimento (amostra/cliques). NUNCA altera
 * hypothesis, variant labels, success_metric ou métrica definida.
 */
export async function updateExperimentObservation(
  experiment_id: string,
  patch: {
    sample_size_a?: number;
    sample_size_b?: number;
    clicks_a?: number;
    clicks_b?: number;
    sample_size?: number;
    status?: ExperimentStatus;
    start_date?: string | null;
    planned_end_date?: string | null;
  },
): Promise<ObservationOutcome> {
  const client = requireClient();
  if (!client) {
    return {
      updated: false,
      missing_supabase: true,
      database_error: false,
      error_message: "Supabase client ausente (fail-closed).",
      record: null,
    };
  }

  // Somente campos de observação são permitidos no patch (whitelist explícita).
  const allowed = new Set([
    "sample_size_a",
    "sample_size_b",
    "clicks_a",
    "clicks_b",
    "sample_size",
    "status",
    "start_date",
    "planned_end_date",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      return {
        updated: false,
        missing_supabase: false,
        database_error: false,
        error_message: `Campo imutável ou não permitido no patch: ${key}`,
        record: null,
      };
    }
  }
  if (patch.status && !STORED_STATUSES.has(patch.status)) {
    return {
      updated: false,
      missing_supabase: false,
      database_error: false,
      error_message: `status inválido: ${patch.status}`,
      record: null,
    };
  }

  const safePatch: Record<string, unknown> = { ...patch };
  if (safePatch.sample_size_a !== undefined && Number(safePatch.sample_size_a) < 0) return { updated: false, missing_supabase: false, database_error: false, error_message: "sample_size_a negativo", record: null };
  if (safePatch.sample_size_b !== undefined && Number(safePatch.sample_size_b) < 0) return { updated: false, missing_supabase: false, database_error: false, error_message: "sample_size_b negativo", record: null };
  if (safePatch.clicks_a !== undefined && Number(safePatch.clicks_a) < 0) return { updated: false, missing_supabase: false, database_error: false, error_message: "clicks_a negativo", record: null };
  if (safePatch.clicks_b !== undefined && Number(safePatch.clicks_b) < 0) return { updated: false, missing_supabase: false, database_error: false, error_message: "clicks_b negativo", record: null };

  try {
    const res = await client
      .from(EXPERIMENTS_TABLE)
      .update(safePatch)
      .eq("experiment_id", experiment_id)
      .select()
      .single();
    const data = res && "data" in res ? (res as { data: Record<string, unknown> }).data : null;
    const error = (res as { error?: { code?: string; message?: string } | null }).error ?? null;
    if (error) throw error;
    if (!data) {
      return {
        updated: false,
        missing_supabase: false,
        database_error: true,
        error_message: "Update não retornou registro.",
        record: null,
      };
    }
    return {
      updated: true,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      record: rowToRecord(data),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      updated: false,
      missing_supabase: false,
      database_error: true,
      error_message: e?.message ?? "Erro de banco desconhecido.",
      record: null,
    };
  }
}

// ============================================================================
// Gate de decisão (regra dura) + registro
// ============================================================================

function nowIso(): string {
  return new Date().toISOString();
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return null;
  return (end - Date.now()) / 86400000;
}

/**
 * O gate estatístico formal: decisão SÓ é aceita quando
 * sample_size >= min_sample_size OU planned_end_date já passou.
 * INCONCLUSIVE é permitido quando o período terminou sem evidência.
 */
export function evaluateDecisionGate(params: {
  sample_size: number;
  min_sample_size: number;
  planned_end_date: string | null;
  planned_duration_days: number;
  start_date: string | null;
}): {
  gate_passed: boolean;
  missing_requirement: string;
  days_remaining: number | null;
  sample_shortfall: number;
} {
  const {
    sample_size,
    min_sample_size,
    planned_end_date,
    planned_duration_days,
    start_date,
  } = params;

  if (sample_size >= min_sample_size) {
    return {
      gate_passed: true,
      missing_requirement: "",
      days_remaining: null,
      sample_shortfall: 0,
    };
  }

  const remaining = daysUntil(planned_end_date);
  const periodEnded =
    remaining !== null && remaining <= 0;

  // Período encerrado OU período não declarado e duração mínima já
  // decorrida desde o start: permite INCONCLUSIVE (não conclusivo).
  if (periodEnded) {
    return {
      gate_passed: true,
      missing_requirement: "",
      days_remaining: remaining ?? null,
      sample_shortfall: min_sample_size - sample_size,
    };
  }

  // Sem fim planejado: usar planned_duration_days a partir do start.
  if (!planned_end_date && start_date) {
    const elapsedDays = (Date.now() - new Date(start_date).getTime()) / 86400000;
    if (elapsedDays >= planned_duration_days) {
      return {
        gate_passed: true,
        missing_requirement: "",
        days_remaining: 0,
        sample_shortfall: min_sample_size - sample_size,
      };
    }
  }

  return {
    gate_passed: false,
    missing_requirement: periodEnded
      ? ""
      : remaining !== null
        ? `planned_end_date ainda não passou (faltam ${remaining.toFixed(1)} dias)`
        : `período planejado de ${planned_duration_days} dias ainda ativo`,
    days_remaining: remaining ?? null,
    sample_shortfall: min_sample_size - sample_size,
  };
}

/**
 * Registra uma decisão formal. Recusa decisão prematura com explicação
 * completa: por quê, qual requisito faltou, amostra atual vs mínima e
 * tempo restante quando aplicável.
 */
export async function recordExperimentDecision(params: {
  experiment_id: string;
  decision: string;
  decision_basis: string;
  decided_by?: string;
}): Promise<DecisionOutcome> {
  const client = requireClient();
  if (!client) {
    return {
      accepted: false,
      rejected: false,
      rejection_reason: null,
      rejection_explanation: "Supabase client ausente (fail-closed).",
      missing_supabase: true,
      database_error: false,
      error_message: null,
      sample_current: 0,
      sample_minimum: 0,
      days_remaining: null,
      record: null,
    };
  }

  if (!STORED_DECISIONS.has(params.decision)) {
    return {
      accepted: false,
      rejected: true,
      rejection_reason: "invalid_decision_value",
      rejection_explanation: `decision deve ser uma de: ${[...STORED_DECISIONS].join(", ")}.`,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      sample_current: 0,
      sample_minimum: 0,
      days_remaining: null,
      record: null,
    };
  }

  const lookup = await getExperiment(params.experiment_id);
  if (!lookup.success || lookup.total === 0) {
    return {
      accepted: false,
      rejected: true,
      rejection_reason: "experiment_not_found",
      rejection_explanation: `experiment_id ${params.experiment_id} não encontrado.`,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      sample_current: 0,
      sample_minimum: 0,
      days_remaining: null,
      record: null,
    };
  }
  const current = lookup.experiments[0];

  // Uma decisão por experimento (imutável após registro).
  if (current.decision !== null) {
    return {
      accepted: false,
      rejected: true,
      rejection_reason: "decision_already_recorded",
      rejection_explanation: `Decisão já registrada (${current.decision} em ${current.decided_at}). Decisões não são sobrescritas.`,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      sample_current: current.sample_size,
      sample_minimum: current.min_sample_size,
      days_remaining: daysUntil(current.planned_end_date),
      record: current,
    };
  }

  const gate = evaluateDecisionGate({
    sample_size: current.sample_size,
    min_sample_size: current.min_sample_size,
    planned_end_date: current.planned_end_date,
    planned_duration_days: current.planned_duration_days,
    start_date: current.start_date,
  });

  if (!gate.gate_passed) {
    return {
      accepted: false,
      rejected: true,
      rejection_reason: "premature_decision_sample_unmet",
      rejection_explanation: [
        `Decisão prematura REJEITADA. Requisito faltante: ${gate.missing_requirement}.`,
        `Amostra atual: ${current.sample_size}. Amostra mínima exigida: ${current.min_sample_size} (faltam ${gate.sample_shortfall}).`,
        current.planned_end_date
          ? `Tempo restante: ${gate.days_remaining !== null ? gate.days_remaining.toFixed(1) : "indeterminado"} dias.`
          : "Sem planned_end_date declarado.",
        "A decisão pode ser registrada somente após atingir a amostra mínima OU o término do período planejado.",
      ].join(" "),
      missing_supabase: false,
      database_error: false,
      error_message: null,
      sample_current: current.sample_size,
      sample_minimum: current.min_sample_size,
      days_remaining: gate.days_remaining,
      record: current,
    };
  }

  // Decisão aceita pelo gate: grava.
  try {
    const res = await client
      .from(EXPERIMENTS_TABLE)
      .update({
        decision: params.decision,
        decision_basis: sanitizeExperimentText(params.decision_basis),
        decided_at: nowIso(),
        decided_by: params.decided_by ?? "operator-admin",
        updated_at: nowIso(),
      })
      .eq("experiment_id", params.experiment_id)
      .select()
      .single();
    const data = res && "data" in res ? (res as { data: Record<string, unknown> }).data : null;
    const error = (res as { error?: { code?: string; message?: string } | null }).error ?? null;
    if (error) throw error;
    if (!data) {
      return {
        accepted: false,
        rejected: false,
        rejection_reason: null,
        rejection_explanation: null,
        missing_supabase: false,
        database_error: true,
        error_message: "Update não retornou registro.",
        sample_current: current.sample_size,
        sample_minimum: current.min_sample_size,
        days_remaining: null,
        record: null,
      };
    }
    return {
      accepted: true,
      rejected: false,
      rejection_reason: null,
      rejection_explanation: null,
      missing_supabase: false,
      database_error: false,
      error_message: null,
      sample_current: current.sample_size,
      sample_minimum: current.min_sample_size,
      days_remaining: gate.days_remaining,
      record: rowToRecord(data),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      accepted: false,
      rejected: false,
      rejection_reason: null,
      rejection_explanation: null,
      missing_supabase: false,
      database_error: true,
      error_message: e?.message ?? "Erro de banco desconhecido.",
      sample_current: current.sample_size,
      sample_minimum: current.min_sample_size,
      days_remaining: null,
      record: null,
    };
  }
}

/**
 * Cleanup da prova viva (remocao integral do experimento artificial).
 * Uso restrito: somente pelo fluxo de cleanup autorizado.
 */
export async function deleteExperimentForProof(
  experiment_id: string,
): Promise<{
  deleted: boolean;
  missing_supabase: boolean;
  database_error: boolean;
  error_message: string | null;
}> {
  const client = requireClient();
  if (!client) {
    return {
      deleted: false,
      missing_supabase: true,
      database_error: false,
      error_message: "Supabase client ausente.",
    };
  }
  try {
    const res = await client
      .from(EXPERIMENTS_TABLE)
      .delete()
      .eq("experiment_id", experiment_id);
    const error = (res as { error?: { code?: string; message?: string } | null }).error ?? null;
    if (error) throw error;
    return { deleted: true, missing_supabase: false, database_error: false, error_message: null };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      deleted: false,
      missing_supabase: false,
      database_error: true,
      error_message: e?.message ?? "Erro de banco desconhecido.",
    };
  }
}

// Garantir que os helpers usados estão referenciados (TEXT_SENSITIVE_PATTERNS)
export { TEXT_SENSITIVE_PATTERNS };
