/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Repositório de persistência dos artefatos analíticos (FASE B).
 *
 * Fronteiras: MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO
 *             SIGNAL != REVENUE · RECOMMENDATION != ACTION
 *
 * Persiste SOMENTE os artefatos analíticos produzidos pelo contrato da
 * Fase A. Não contém métodos de mutação de products, não publica, não
 * executa recomendações e não concede autoridade. Delete destrutivo
 * não existe como mecanismo normal de operação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisWindow } from "../commercialBrain/types";

export type ArtifactType = "opportunity" | "risk" | "recommendation";
export type ArtifactStatus = "ACTIVE" | "PARKED" | "RETIRED" | "ACKNOWLEDGED";
export type StoredConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_EVIDENCE";
export type StoredPriorityLevel = "HIGH" | "MEDIUM" | "LOW" | "NO_ACTION";
export type StoredSignalCategory = "price" | "availability" | "source" | "interest" | "freshness";

export const SIGNAL_TABLE = "commercial_signals" as const;
export const ARTIFACT_TABLE = "commercial_artifacts" as const;

export interface StoredSignal {
  signal_id: string;
  product_id: string | null;
  signal_type: string;
  signal_category: StoredSignalCategory;
  metric: string;
  current_value: string;
  baseline_value: string;
  delta: string;
  analysis_window: AnalysisWindow;
  baseline_window: AnalysisWindow | null;
  evidence_refs: unknown[];
  confidence: StoredConfidence;
  confidence_basis: string;
  analysis_version: string;
  input_snapshot: Record<string, unknown>;
  detected_at: string;
  correlation_id: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  schema_version: string;
  created_at: string;
}

export interface StoredArtifact {
  artifact_id: string;
  product_id: string | null;
  artifact_type: ArtifactType;
  subject: string;
  subject_ref: string;
  signal_type: string;
  signal_id: string | null;
  suggested_action: string;
  confidence: StoredConfidence;
  confidence_basis: string;
  priority: Record<string, unknown>;
  priority_level: StoredPriorityLevel | null;
  priority_score: number | null;
  impact: string | null;
  cost: string | null;
  risk: string | null;
  status: ArtifactStatus;
  baseline_statement: string | null;
  review_deadline: string | null;
  evidence: unknown[];
  scoring_version: string;
  confidence_version: string;
  analysis_version: string;
  created_at: string;
  correlation_id: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  schema_version: string;
}

export type InsertConflict = "upserted_identical" | "rejected_incompatible" | "inserted";

export interface WriteOutcome<T> {
  outcome: "inserted" | "identical_duplicate" | "conflict_rejected" | "missing_supabase" | "database_error";
  error?: string;
  record?: T;
}

// ============================================================================
// Cliente injetável (padrão do repositório de observações do Bloco 13)
// ============================================================================
let client: SupabaseClient | null = null;

export function setCommercialBrainClientForTests(
  testClient: SupabaseClient | null | undefined,
): void {
  client = testClient ?? null;
}

export function setCommercialBrainClient(productionClient: SupabaseClient): void {
  client = productionClient;
}

function requireClient(): SupabaseClient | null {
  return client;
}

// ============================================================================
// Sinais
// ============================================================================
export interface SignalInsertInput {
  signalId: string;
  productId: string | null;
  signalType: string;
  signalCategory: StoredSignalCategory;
  metric: string;
  currentValue: string;
  baselineValue: string;
  delta: string;
  window: AnalysisWindow;
  baselineWindow?: AnalysisWindow | null;
  evidenceRefs: unknown[];
  confidence: StoredConfidence;
  confidenceBasis: string;
  analysisVersion: string;
  inputSnapshot: Record<string, unknown>;
  detectedAt: string;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Persiste um sinal com idempotência real (sem fallback em memória):
 * - mesma idempotency_key + conteúdo idêntico → identical_duplicate;
 * - mesma idempotency_key + conteúdo incompatível → conflict_rejected;
 * - Supabase indisponível → missing_supabase (nunca falha silenciosa).
 */
export async function insertSignal(
  input: SignalInsertInput,
): Promise<WriteOutcome<StoredSignal>> {
  const supabase = requireClient();
  if (!supabase) {
    return { outcome: "missing_supabase", error: "cliente Supabase indisponível" };
  }

  const row: Record<string, unknown> = {
    signal_id: input.signalId,
    product_id: input.productId,
    signal_type: input.signalType,
    signal_category: input.signalCategory,
    metric: input.metric,
    current_value: input.currentValue,
    baseline_value: input.baselineValue,
    delta: input.delta,
    analysis_window: input.window,
    baseline_window: input.baselineWindow ?? null,
    evidence_refs: JSON.parse(JSON.stringify(input.evidenceRefs)),
    confidence: input.confidence,
    confidence_basis: input.confidenceBasis,
    analysis_version: input.analysisVersion,
    input_snapshot: sanitizeMetadata(input.inputSnapshot),
    detected_at: input.detectedAt,
    correlation_id: input.correlationId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
    schema_version: "1.0",
  };

  const { data, error } = await supabase.from(SIGNAL_TABLE).insert(row).select();
  if (error) {
    if (isIdempotencyViolation(error)) {
      const existing = await getSignalByIdempotencyKey(input.idempotencyKey ?? "");
      if (
        existing &&
        isContentCompatibleSignal(existing, row)
      ) {
        return { outcome: "identical_duplicate", record: existing as StoredSignal };
      }
      return { outcome: "conflict_rejected", error: `conteúdo incompatível para idempotency_key "${input.idempotencyKey}"` };
    }
    return { outcome: "database_error", error: error.message };
  }

  return { outcome: "inserted", record: (data ?? [])[0] as StoredSignal };
}

export async function getSignal(signalId: string): Promise<WriteOutcome<StoredSignal>> {
  const supabase = requireClient();
  if (!supabase) return { outcome: "missing_supabase", error: "cliente Supabase indisponível" };

  const { data, error } = await supabase
    .from(SIGNAL_TABLE)
    .select("*")
    .eq("signal_id", signalId)
    .limit(1)
    .maybeSingle();
  if (error) return { outcome: "database_error", error: error.message };
  if (!data) return { outcome: "missing_supabase", error: `sinal não encontrado: ${signalId}` };
  return { outcome: "inserted", record: data as StoredSignal };
}

export async function getSignalsByProduct(
  productId: string,
  limit = 100,
): Promise<WriteOutcome<StoredSignal[]>> {
  return queryTable<StoredSignal>(SIGNAL_TABLE, supabase =>
    supabase.from(SIGNAL_TABLE).select("*").eq("product_id", productId).order("detected_at", { ascending: false }).limit(limit),
  );
}

export async function getSignalsByPeriod(params: {
  from: string;
  to: string;
  limit?: number;
}): Promise<WriteOutcome<StoredSignal[]>> {
  return queryTable<StoredSignal>(SIGNAL_TABLE, supabase =>
    supabase
      .from(SIGNAL_TABLE)
      .select("*")
      .gte("detected_at", params.from)
      .lte("detected_at", params.to)
      .order("detected_at", { ascending: false })
      .limit(params.limit ?? 100),
  );
}

export async function getSignalsByType(
  signalType: string,
  limit = 100,
): Promise<WriteOutcome<StoredSignal[]>> {
  return queryTable<StoredSignal>(SIGNAL_TABLE, supabase =>
    supabase.from(SIGNAL_TABLE).select("*").eq("signal_type", signalType).order("detected_at", { ascending: false }).limit(limit),
  );
}

export async function getSignalsByAnalysisVersion(
  analysisVersion: string,
  limit = 100,
): Promise<WriteOutcome<StoredSignal[]>> {
  return queryTable<StoredSignal>(SIGNAL_TABLE, supabase =>
    supabase.from(SIGNAL_TABLE).select("*").eq("analysis_version", analysisVersion).order("detected_at", { ascending: false }).limit(limit),
  );
}

// ============================================================================
// Artefatos (oportunidades, riscos, recomendações)
// ============================================================================
export interface ArtifactInsertInput {
  artifactId: string;
  productId: string | null;
  artifactType: ArtifactType;
  subject: string;
  subjectRef: string;
  signalType: string;
  signalId?: string | null;
  suggestedAction: string;
  confidence: StoredConfidence;
  confidenceBasis: string;
  priority: Record<string, unknown>;
  priorityLevel: StoredPriorityLevel | null;
  priorityScore: number | null;
  impact?: string | null;
  cost?: string | null;
  risk?: string | null;
  status?: ArtifactStatus;
  baselineStatement?: string | null;
  reviewDeadline?: string | null;
  evidence?: unknown[];
  scoringVersion: string;
  confidenceVersion: string;
  analysisVersion: string;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertArtifact(
  input: ArtifactInsertInput,
): Promise<WriteOutcome<StoredArtifact>> {
  const supabase = requireClient();
  if (!supabase) return { outcome: "missing_supabase", error: "cliente Supabase indisponível" };

  const row: Record<string, unknown> = {
    artifact_id: input.artifactId,
    product_id: input.productId,
    artifact_type: input.artifactType,
    subject: input.subject,
    subject_ref: input.subjectRef,
    signal_type: input.signalType,
    signal_id: input.signalId ?? null,
    suggested_action: sanitizeText(input.suggestedAction),
    confidence: input.confidence,
    confidence_basis: sanitizeText(input.confidenceBasis),
    priority: sanitizeMetadata(input.priority),
    priority_level: input.priorityLevel,
    priority_score: input.priorityScore,
    impact: input.impact ?? null,
    cost: input.cost ?? null,
    risk: input.risk ?? null,
    status: input.status ?? "ACTIVE",
    baseline_statement: input.baselineStatement ?? null,
    review_deadline: input.reviewDeadline ?? null,
    evidence: JSON.parse(JSON.stringify(input.evidence ?? [])),
    scoring_version: input.scoringVersion,
    confidence_version: input.confidenceVersion,
    analysis_version: input.analysisVersion,
    correlation_id: input.correlationId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    metadata: sanitizeMetadata(input.metadata ?? {}),
    schema_version: "1.0",
  };

  const { data, error } = await supabase.from(ARTIFACT_TABLE).insert(row).select();
  if (error) {
    if (isIdempotencyViolation(error)) {
      const existing = await getArtifactByIdempotencyKey(input.idempotencyKey ?? "");
      if (existing && isContentCompatibleArtifact(existing, row)) {
        return { outcome: "identical_duplicate", record: existing as StoredArtifact };
      }
      return { outcome: "conflict_rejected", error: `conteúdo incompatível para idempotency_key "${input.idempotencyKey}"` };
    }
    return { outcome: "database_error", error: error.message };
  }

  return { outcome: "inserted", record: (data ?? [])[0] as StoredArtifact };
}

export async function getArtifact(artifactId: string): Promise<WriteOutcome<StoredArtifact>> {
  const supabase = requireClient();
  if (!supabase) return { outcome: "missing_supabase", error: "cliente Supabase indisponível" };

  const { data, error } = await supabase
    .from(ARTIFACT_TABLE)
    .select("*")
    .eq("artifact_id", artifactId)
    .limit(1)
    .maybeSingle();
  if (error) return { outcome: "database_error", error: error.message };
  if (!data) return { outcome: "missing_supabase", error: `artefato não encontrado: ${artifactId}` };
  return { outcome: "inserted", record: data as StoredArtifact };
}

export async function getArtifactsByProduct(
  productId: string,
  limit = 100,
): Promise<WriteOutcome<StoredArtifact[]>> {
  return queryTable<StoredArtifact>(ARTIFACT_TABLE, supabase =>
    supabase.from(ARTIFACT_TABLE).select("*").eq("product_id", productId).order("created_at", { ascending: false }).limit(limit),
  );
}

export async function getArtifactsByPeriod(params: {
  from: string;
  to: string;
  limit?: number;
}): Promise<WriteOutcome<StoredArtifact[]>> {
  return queryTable<StoredArtifact>(ARTIFACT_TABLE, supabase =>
    supabase
      .from(ARTIFACT_TABLE)
      .select("*")
      .gte("created_at", params.from)
      .lte("created_at", params.to)
      .order("created_at", { ascending: false })
      .limit(params.limit ?? 100),
  );
}

export async function getArtifactsByType(
  artifactType: ArtifactType,
  limit = 100,
): Promise<WriteOutcome<StoredArtifact[]>> {
  return queryTable<StoredArtifact>(ARTIFACT_TABLE, supabase =>
    supabase.from(ARTIFACT_TABLE).select("*").eq("artifact_type", artifactType).order("created_at", { ascending: false }).limit(limit),
  );
}

export async function getArtifactsByScoringVersion(
  scoringVersion: string,
  limit = 100,
): Promise<WriteOutcome<StoredArtifact[]>> {
  return queryTable<StoredArtifact>(ARTIFACT_TABLE, supabase =>
    supabase.from(ARTIFACT_TABLE).select("*").eq("scoring_version", scoringVersion).order("created_at", { ascending: false }).limit(limit),
  );
}

// ============================================================================
// Helpers internos
// ============================================================================
async function queryTable<T>(
  _tableName: string,
  queryFn: (client: SupabaseClient) => unknown,
): Promise<WriteOutcome<T[]>> {
  const supabase = requireClient();
  if (!supabase) return { outcome: "missing_supabase", error: "cliente Supabase indisponível" };

  const { data, error } = (await queryFn(supabase)) as {
    data: T[] | null;
    error: { message: string } | null;
  };
  if (error) return { outcome: "database_error", error: error.message };
  return { outcome: "inserted", record: data ?? [] };
}

async function getSignalByIdempotencyKey(key: string): Promise<StoredSignal | null> {
  const supabase = requireClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from(SIGNAL_TABLE)
    .select("*")
    .eq("idempotency_key", key)
    .limit(1)
    .maybeSingle();
  return (data as StoredSignal | null) ?? null;
}

async function getArtifactByIdempotencyKey(key: string): Promise<StoredArtifact | null> {
  const supabase = requireClient();
  if (!supabase) return null;
  const { data } = await supabase
    .from(ARTIFACT_TABLE)
    .select("*")
    .eq("idempotency_key", key)
    .limit(1)
    .maybeSingle();
  return (data as StoredArtifact | null) ?? null;
}

/**
 * Compara o conteúdo essencial (sem timestamps de sistema) para decidir se
 * uma repetição é duplicação idêntica ou colisão incompatível.
 */
function isContentCompatibleSignal(
  existing: StoredSignal,
  candidate: Record<string, unknown>,
): boolean {
  const keys = [
    "signal_id", "product_id", "signal_type", "signal_category", "metric",
    "current_value", "baseline_value", "delta", "analysis_window",
    "baseline_window", "confidence", "confidence_basis", "analysis_version",
  ];
  return keys.every(key => JSON.stringify(existing[key as keyof StoredSignal]) === JSON.stringify(candidate[key]));
}

function isContentCompatibleArtifact(
  existing: StoredArtifact,
  candidate: Record<string, unknown>,
): boolean {
  const keys = [
    "artifact_id", "product_id", "artifact_type", "subject", "subject_ref",
    "signal_type", "signal_id", "suggested_action", "confidence",
    "confidence_basis", "priority", "priority_level", "priority_score",
    "scoring_version", "confidence_version", "analysis_version",
  ];
  return keys.every(key => JSON.stringify(existing[key as keyof StoredArtifact]) === JSON.stringify(candidate[key]));
}

function isIdempotencyViolation(error: { message?: string; code?: string | number }): boolean {
  const code = String(error.code ?? "");
  return code === "23505" || (error.message ?? "").toLowerCase().includes("idempotency_key");
}

/**
 * Sanitiza texto livre: nunca permite tokens, secrets, authorization,
 * service_role, prompts nem rawContent externo.
 */
export function sanitizeText(text: string): string {
  const blocked = [
    "Authorization:", "Bearer ", "sk-", "x-admin-password",
    "SUPABASE", "service_role", "TELEGRAM_BOT_TOKEN", "apikey",
  ];
  let sanitized = text;
  for (const pattern of blocked) {
    if (sanitized.toLowerCase().includes(pattern.toLowerCase())) {
      sanitized = sanitized.replace(new RegExp(pattern, "gi"), "[SANITIZED]");
    }
  }
  return sanitized;
}

/**
 * Sanitiza metadata JSON: remove chaves sensíveis conhecidas antes de gravar.
 */
export function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const blockedKeys = new Set([
    "token", "secret", "password", "authorization", "api_key",
    "service_role", "supabase_secret", "raw_content", "rawcontent",
    "prompt", "system_prompt",
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (blockedKeys.has(key.toLowerCase())) continue;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      sanitized[key] = sanitizeMetadata(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

export { isContentCompatibleSignal as __testIsContentCompatibleSignal };
export { isContentCompatibleArtifact as __testIsContentCompatibleArtifact };
