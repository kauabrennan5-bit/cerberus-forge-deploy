// ============================================================================
// Bloco N4 — Repository de avaliações de candidatos (candidate_assessment).
//
// CONTRATO (governança):
// - CANDIDATE != FACT CANÔNICO: nenhuma coluna referencia public.products.
// - RECOMMENDATION != ACTION: is_actionable=false sempre; nada aqui publica.
// - Histórico é preservado: persistir uma nova avaliação NUNCA apaga a anterior.
// - Replay idêntico é idempotente: mesmo idempotency_key → retorna a linha
//   existente com outcome "identical_duplicate" (nada duplicado).
// - Mudança legítima de evidências/regras → nova linha (histórico cresce).
// - RLS ON, zero políticas públicas; backend usa service role.
// ============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

// "cerberus_filter_v1" = classificação comercial (Bloco N4).
// "n13:curator_v1" = filtro de curadoria estrutural (Bloco N13 Fase 1):
// verdade = PASS/FAIL/BLOCKED; não comercial; is_actionable=false sempre.
// "n14:commercial_brain_v1" = score comercial de CANDIDATES (Bloco N14):
// verdade = band (HIGH/MEDIUM/LOW/INSUFFICIENT) + score; NÃO é aprovação;
// is_actionable=false sempre.
export const ASSESSMENT_KINDS = [
  "cerberus_filter_v1",
  "n13:curator_v1",
  "n14:commercial_brain_v1",
] as const;
export type AssessmentVersion = (typeof ASSESSMENT_KINDS)[number];

export const CLASSIFICATIONS = [
  "WINNER",
  "HIDDEN_GEM",
  "NICHE_DROP",
  "INSUFFICIENT",
  "NOT_RECOMMENDED",
  "COMMERCIAL_HIGH",
  "COMMERCIAL_MEDIUM",
  "COMMERCIAL_LOW",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const RECOMMENDATIONS = [
  "NONE",
  "INVESTIGATE_FURTHER",
  "ADD_TO_NICHE",
  "PARK",
  "REJECT",
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const PRIORITY_LEVELS = ["HIGH", "MEDIUM", "LOW", "NO_ACTION"] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export interface PersistAssessmentInput {
  assessmentId: string;
  candidateId: string;
  filterVersion: AssessmentVersion;
  dimensions: Record<string, unknown>;
  classification?: Classification | null;
  classificationBasis: string;
  recommendation?: Recommendation | null;
  recommendationBasis: string;
  priority: Record<string, unknown>;
  priorityLevel?: PriorityLevel | null;
  priorityScore?: number | null;
  unknowns?: unknown[];
  contradictions?: unknown[];
  collectionFailures?: unknown[];
  evidenceRefs?: unknown[];
  inputSnapshot: Record<string, unknown>;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PersistAssessmentResult {
  ok: boolean;
  assessment?: Record<string, unknown> | null;
  outcome: "created" | "identical_duplicate";
  error?: string;
}

export interface ListAssessmentsResult {
  ok: boolean;
  assessments: Record<string, unknown>[];
  error?: string;
}

// -----------------------------------------------------------------------------
// Internos
// -----------------------------------------------------------------------------

function validateClassification(value: unknown): value is Classification {
  return typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);
}

function validateRecommendation(value: unknown): value is Recommendation {
  return typeof value === "string" && (RECOMMENDATIONS as readonly string[]).includes(value);
}

function validatePriorityLevel(value: unknown): value is PriorityLevel {
  return typeof value === "string" && (PRIORITY_LEVELS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.includes("secret") || lower.includes("token") || lower.includes("password") || lower.includes("api_key")) {
      sanitized[key] = "REDACTED";
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

// Digest determinístico para idempotency_key (padrão Decision Journal).
export function buildAssessmentDigest(params: {
  candidateId: string;
  filterVersion: string;
  snapshot: Record<string, unknown>;
}): string {
  const { candidateId, filterVersion, snapshot } = params;
  const serialized = JSON.stringify({
    candidateId,
    filterVersion,
    snapshot,
  });
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

// -----------------------------------------------------------------------------
// Cliente
// -----------------------------------------------------------------------------
let client: SupabaseClient | null = null;
let fallbackClient: SupabaseClient | null = null;

export function setCandidateAssessmentClient(next: SupabaseClient | null): void {
  client = next;
}

export function setCandidateAssessmentFallbackClient(next: SupabaseClient | null): void {
  fallbackClient = next;
}

export function getCandidateAssessmentClient(): SupabaseClient | null {
  return client ?? fallbackClient;
}

// -----------------------------------------------------------------------------
// Repository
// -----------------------------------------------------------------------------

export async function persistAssessment(
  input: PersistAssessmentInput,
): Promise<PersistAssessmentResult> {
  const supabase = getCandidateAssessmentClient();
  if (!supabase) {
    return { ok: false, outcome: "created", error: "missing_supabase" };
  }

  const validationError = validateInput(input);
  if (validationError) {
    return { ok: false, outcome: "created", error: validationError };
  }

  const row = {
    assessment_id: input.assessmentId,
    candidate_id: input.candidateId,
    filter_version: input.filterVersion,
    dimensions: input.dimensions,
    classification: input.classification ?? null,
    classification_basis: input.classificationBasis,
    recommendation: input.recommendation ?? null,
    recommendation_basis: input.recommendationBasis,
    is_actionable: false,
    priority: input.priority,
    priority_level: input.priorityLevel ?? null,
    priority_score: input.priorityScore ?? null,
    scoring_version: "cerberus_priority_v1",
    unknowns: input.unknowns ?? [],
    contradictions: input.contradictions ?? [],
    collection_failures: input.collectionFailures ?? [],
    evidence_refs: input.evidenceRefs ?? [],
    input_snapshot: input.inputSnapshot,
    correlation_id: input.correlationId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    metadata: input.metadata ? sanitizeMetadata(input.metadata) : {},
    schema_version: "1.0",
  };

  const result = await supabase
    .from("candidate_assessment")
    .insert(row)
    .select()
    .single();

  if (result.error) {
    if (isPostgrestDuplicate(result.error)) {
      return resolveReplay(supabase, input.idempotencyKey);
    }
    return {
      ok: false,
      outcome: "created",
      error: result.error.message || "persist_error",
    };
  }

  return { ok: true, outcome: "created", assessment: (result.data ?? null) as Record<string, unknown> | null };
}

async function resolveReplay(
  supabase: SupabaseClient,
  idempotencyKey: string | null | undefined,
): Promise<PersistAssessmentResult> {
  if (!idempotencyKey) {
    return { ok: false, outcome: "identical_duplicate", error: "idempotency_key_required" };
  }
  const result = await supabase
    .from("candidate_assessment")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error || !result.data) {
    return { ok: false, outcome: "identical_duplicate", error: "replay_lookup_failed" };
  }
  return { ok: true, outcome: "identical_duplicate", assessment: result.data as Record<string, unknown> };
}

function isPostgrestDuplicate(error: { code?: string; message?: string }): boolean {
  if (error?.code === "23505") return true;
  if (typeof error?.message === "string" && /unique|duplicate key/i.test(error.message)) return true;
  return false;
}

function validateInput(input: PersistAssessmentInput): string | null {
  if (!input.assessmentId || typeof input.assessmentId !== "string") {
    return "invalid_assessment_id";
  }
  if (!input.candidateId || typeof input.candidateId !== "string") {
    return "invalid_candidate_id";
  }
  if (!ASSESSMENT_KINDS.includes(input.filterVersion)) {
    return "invalid_filter_version";
  }
  if (!isPlainObject(input.dimensions) || Object.keys(input.dimensions).length === 0) {
    return "invalid_dimensions";
  }
  if (input.classification !== null && input.classification !== undefined && !validateClassification(input.classification)) {
    return "invalid_classification";
  }
  if (input.recommendation !== null && input.recommendation !== undefined && !validateRecommendation(input.recommendation)) {
    return "invalid_recommendation";
  }
  if (input.priorityLevel !== null && input.priorityLevel !== undefined && !validatePriorityLevel(input.priorityLevel)) {
    return "invalid_priority_level";
  }
  if (!isPlainObject(input.priority)) {
    return "invalid_priority";
  }
  if (!isPlainObject(input.inputSnapshot)) {
    return "invalid_input_snapshot";
  }
  // is_actionable NUNCA é true: a coluna é fixa false no insert.
  if (typeof input.priorityScore === "number" && (Number.isNaN(input.priorityScore) || input.priorityScore < 0 || input.priorityScore > 1)) {
    return "invalid_priority_score";
  }
  return null;
}

export async function getAssessment(assessmentId: string): Promise<{
  ok: boolean;
  assessment?: Record<string, unknown> | null;
  error?: string;
}> {
  const supabase = getCandidateAssessmentClient();
  if (!supabase) {
    return { ok: false, error: "missing_supabase" };
  }
  const result = await supabase
    .from("candidate_assessment")
    .select("*")
    .eq("assessment_id", assessmentId)
    .limit(1)
    .maybeSingle();
  if (result.error) {
    return { ok: false, error: result.error.message || "lookup_error" };
  }
  return { ok: true, assessment: (result.data ?? null) as Record<string, unknown> | null };
}

export async function listCandidateAssessments(params: {
  candidateId?: string;
  limit?: number;
}): Promise<ListAssessmentsResult> {
  const supabase = getCandidateAssessmentClient();
  if (!supabase) {
    return { ok: false, assessments: [], error: "missing_supabase" };
  }
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  let query = supabase.from("candidate_assessment").select("*");
  if (params.candidateId) {
    query = query.eq("candidate_id", params.candidateId);
  }
  const result = await query.order("created_at", { ascending: false }).limit(limit);
  if (result.error) {
    return { ok: false, assessments: [], error: result.error.message || "list_error" };
  }
  return { ok: true, assessments: (result.data ?? []) as Record<string, unknown>[] };
}

// -----------------------------------------------------------------------------
// Test helpers (somente em ambiente de teste)
// -----------------------------------------------------------------------------

export async function deleteAssessmentForProof(assessmentId: string): Promise<{
  ok: boolean;
  deletedCount: number;
  error?: string;
}> {
  const supabase = getCandidateAssessmentClient();
  if (!supabase) {
    return { ok: false, deletedCount: 0, error: "missing_supabase" };
  }
  const result = await supabase
    .from("candidate_assessment")
    .delete()
    .in("assessment_id", [assessmentId]);
  if (result.error) {
    return { ok: false, deletedCount: 0, error: result.error.message || "delete_error" };
  }
  return { ok: true, deletedCount: (result.data ?? []).length };
}

export function resetAssessmentClientForTests(next: SupabaseClient | null): void {
  client = next;
  fallbackClient = null;
}
