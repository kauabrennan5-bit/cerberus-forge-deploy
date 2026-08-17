// ============================================================================
// Bloco N9 — Orquestrador do Ciclo Comercial (máquina de estados S1–S8).
//
// O N9 é ORQUESTRADOR: nunca reescreve, duplica nem reinterpreta blocos.
// Cada etapa invoca o serviço/contrato existente (N2→N8) e registra o
// passo em commercial_cycle_steps (máquina de estados auditável).
//
// REGRAS ABSOLUTAS:
//   - NUNCA escreve em products (somente o executor N5 cria produto canônico);
//   - NUNCA chama /promote, promoteToProduct ou funções legadas;
//   - NUNCA transforma recommendation em action (o gate N9 decide e só o
//     executor N5 executa — DECISION != ACTION);
//   - NUNCA inventa valores ausentes (UNKNOWN permanece explícito);
//   - NUNCA registra credenciais, tokens ou secrets (somente IDs/códigos);
//   - erro em qualquer etapa → passo FAILED/RECOVERABLE registrado; o ciclo
//     permanece em estado recuperável (pode retomar pela etapa pendente).
// ============================================================================
import { createHash } from "node:crypto";

// --- Blocos N2–N8 (reuso obrigatório; nenhuma duplicação) ---
import { executeDiscover } from "../discovery/discover";
import type { CandidateRecord } from "../../repositories/candidatesRepository";
import {
  getCandidate,
  recordVerdict,
} from "../../repositories/candidatesRepository";
import { startResearch } from "../discovery/research";
import { assessCandidate } from "../filter/cerberusFilter";
import { persistAssessment } from "../../repositories/candidateAssessmentRepository";
import { listCandidateAssessments } from "../../repositories/candidateAssessmentRepository";
import { FILTER_VERSION } from "../filter/cerberusFilterRules";
import { acquireAffiliateLink } from "../affiliate/acquisitionService";
import type { AcquireResult } from "../affiliate/acquisitionContract";
import type { AffiliateProviderRecord } from "../affiliate/contract";
import type { PublicationDecision } from "../publication/contract";
import { listLinksByCandidate, getProvider } from "../affiliate/affiliateRepository";
import { resolveAffiliateLink } from "../affiliate/affiliateLinkResolver";
import type { AffiliateRegistrySnapshot } from "../affiliate/affiliateLinkResolver";
import {
  preflightPublication,
  executePublication,
  type PublicationRepositoryAdapter,
} from "../publication/publicationExecutor";
import { supabasePublicationAdapter } from "../publication/supabasePublicationAdapter";

// --- N9 (contrato, gate, repositório) ---
import {
  BLOCKING_RULES,
  CYCLE_CONTRACT_VERSION,
  CYCLE_STAGES,
  CYCLE_STATUSES,
  CYCLE_MARKETPLACES,
  type CycleMarketplace,
  type CycleStage,
  type CycleStatus,
  type CycleStateSummary,
  type CycleStepResult,
  type GateInput,
  type StageResult,
} from "./cycleContract";
import { evaluateDecisionGate, buildDecisionInputDigest, buildDecisionId, isCycleMarketplace } from "./decisionGate";
import {
  persistCycle,
  persistDecision,
  persistStep,
  getCycle,
  getDecisionByCycle,
  updateCycle,
  listSteps,
  deleteCycleProof,
  type DecisionRecord,
} from "./cycleRepository";
import { buildAssessmentDigest } from "../../repositories/candidateAssessmentRepository";

// ---------------------------------------------------------------------------
// Configurações e IDs determinísticos
// ---------------------------------------------------------------------------
export type SourceType = "URL" | "QUERY";

export interface StartCycleInput {
  readonly marketplace: CycleMarketplace;
  readonly sourceUrl: string;
  readonly sourceType: SourceType;
  readonly query?: string | null;
  readonly providerId?: string | null;
  readonly createdBy?: string;
}

function cycleIdFrom(marketplace: CycleMarketplace, sourceUrl: string): string {
  const hash = createHash("sha256").update(`${marketplace}:${sourceUrl}`).digest("hex");
  return `ncc-${marketplace}-${hash.slice(0, 16)}`;
}

function stepId(cycleId: string, stage: CycleStage): string {
  return `${cycleId}-${stage.toLowerCase()}`;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\?__mobile__=\d+$/, "").replace(/\?__mobile__=\d+&/, "?").trim();
}

function sanitizeLog(value: unknown): string {
  // Inspeção estática + runtime: NEVER logar credenciais/tokens — valores
  // sensíveis jamais chegam aqui (só IDs, códigos e estados).
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "redacted";
}

// ---------------------------------------------------------------------------
// Injeções TEST-ONLY (mesmo padrão dos repositórios N1–N8)
// ---------------------------------------------------------------------------
export interface CycleTestDeps {
  /** Adapter do executor N5 (padrão: supabasePublicationAdapter). */
  publicationRepo?: PublicationRepositoryAdapter;
  /** Snapshot do registry N6/N7 (padrão: real). */
  affiliateRegistrySnapshot?: AffiliateRegistrySnapshot | null;
  /** Override TEST-ONLY para discovery (N2). */
  discoveryOverride?: (input: unknown) => Promise<unknown>;
}

let publicationRepo: PublicationRepositoryAdapter = supabasePublicationAdapter;
let affiliateRegistrySnapshot: AffiliateRegistrySnapshot | undefined;

// Overrides TEST-ONLY por etapa (padrão N1–N8: injeção de dependência testável
// sem mockar módulos; cada override recai para o serviço real quando null).
type DiscoveryOverride = (input: unknown) => Promise<unknown>;
type ResearchOverride = (input: unknown) => Promise<unknown>;
type AssessmentOverride = (candidateId: string) => Promise<unknown>;
type AcquisitionOverride = (params: unknown) => Promise<unknown>;
type ResolutionOverride = (params: unknown) => Promise<unknown>;
type GetCandidateOverride = (candidateId: string) => Promise<unknown>;
type PersistAssessmentOverride = (input: unknown) => Promise<unknown>;

let discoveryOverride: DiscoveryOverride | null = null;
let researchOverride: ResearchOverride | null = null;
let assessmentOverride: AssessmentOverride | null = null;
let acquisitionOverride: AcquisitionOverride | null = null;
let resolutionOverride: ResolutionOverride | null = null;
let getCandidateOverride: GetCandidateOverride | null = null;
let persistAssessmentOverride: PersistAssessmentOverride | null = null;

export function setCyclePublicationRepoForTests(repo: PublicationRepositoryAdapter | null): void {
  publicationRepo = repo ?? supabasePublicationAdapter;
}

export function setCycleAffiliateRegistrySnapshotForTests(snapshot: AffiliateRegistrySnapshot | null | undefined): void {
  affiliateRegistrySnapshot = snapshot ?? undefined;
}

export function setCycleDiscoveryOverrideForTests(override: DiscoveryOverride | null): void {
  discoveryOverride = override;
}

export function setCycleResearchOverrideForTests(override: ResearchOverride | null): void {
  researchOverride = override;
}

export function setCycleAssessmentOverrideForTests(override: AssessmentOverride | null): void {
  assessmentOverride = override;
}

export function setCycleAcquisitionOverrideForTests(override: AcquisitionOverride | null): void {
  acquisitionOverride = override;
}

export function setCycleResolutionOverrideForTests(override: ResolutionOverride | null): void {
  resolutionOverride = override;
}

export function setCycleGetCandidateOverrideForTests(override: GetCandidateOverride | null): void {
  getCandidateOverride = override;
}

export function setCyclePersistAssessmentOverrideForTests(override: PersistAssessmentOverride | null): void {
  persistAssessmentOverride = override;
}

// ---------------------------------------------------------------------------
// 1) START — abre o ciclo (OPEN) com idempotência por chave determinística
// ---------------------------------------------------------------------------
export async function startCycle(input: StartCycleInput): Promise<{ ok: boolean; cycleId?: string; outcome?: "created" | "identical_duplicate"; reason?: string }> {
  if (!isCycleMarketplace(input.marketplace)) {
    return { ok: false, reason: "invalid_marketplace" };
  }
  const sourceUrl = normalizeUrl(input.sourceUrl ?? "");
  if (sourceUrl.length < 8 || sourceUrl.length > 2048) {
    return { ok: false, reason: "invalid_source_url" };
  }
  try {
    const urlObj = new URL(sourceUrl);
    if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
      return { ok: false, reason: "invalid_source_url_protocol" };
    }
  } catch {
    return { ok: false, reason: "invalid_source_url_parse" };
  }
  const cycleId = cycleIdFrom(input.marketplace, sourceUrl);
  const keyHash = createHash("sha256").update(`${input.sourceType}:${sourceUrl}:${input.query ?? ""}:${input.providerId ?? ""}:${CYCLE_CONTRACT_VERSION}`).digest("hex");
  const idempotencyKey = `nck-${keyHash.slice(0, 48)}`;
  const result = await persistCycle({
    cycleId,
    status: "OPEN",
    sourceType: input.sourceType,
    marketplace: input.marketplace,
    sourceUrl,
    idempotencyKey,
    createdBy: input.createdBy ?? "operator-admin",
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, cycleId, outcome: result.outcome };
}

// ---------------------------------------------------------------------------
// Máquina de etapas — cada etapa registra o passo e atualiza o estado
// ---------------------------------------------------------------------------
async function recordStage(
  cycleId: string,
  stage: CycleStage,
  nextStatus: CycleStatus | null,
  result: StageResult,
): Promise<CycleStepResult> {
  const ok = result.ok;
  const detail = result.ok ? ((result as { detail?: Record<string, unknown> }).detail ?? {}) : {};
  const rationaleStr = result.ok ? (result.rationale ?? null) ?? "" : (result as { rationale: string }).rationale ?? "";
  const blockingCodeStr = result.ok
    ? ((result as { blockingCode?: string | null }).blockingCode ?? null)
    : (result as { blockingCode: string | null }).blockingCode;
  const detailStr = JSON.stringify(detail);
  const idempotencyKey = createHash("sha256").update(`${cycleId}:${stage}:${result.result}:${detailStr.slice(0, 200)}`).digest("hex").slice(0, 48);
  const stepResult = await persistStep({
    stepId: stepId(cycleId, stage),
    cycleId,
    stage,
    result: result.result,
    blockingCode: blockingCodeStr ?? null,
    rationale: rationaleStr,
    evidenceRef: result.evidenceRef,
    idempotencyKey,
  });
  if (!stepResult.ok) {
    return {
      ok: false,
      stage,
      status: "FAILED",
      evidenceRef: result.evidenceRef,
      result: result.result,
      blockingCode: "STEP_PERSIST_FAILED",
      rationale: `falha ao registrar etapa: ${stepResult.reason}`,
    };
  }
  if (nextStatus) {
    const patch = { status: nextStatus, ...stageVincula(stage, result) };
    const updateResult = await updateCycle({ cycleId, patch });
    if (!updateResult.ok) {
      return {
        ok: false,
        stage,
        status: "FAILED",
        result: result.result,
        evidenceRef: result.evidenceRef,
        blockingCode: "CYCLE_UPDATE_FAILED",
        rationale: `falha ao atualizar ciclo: ${updateResult.reason}`,
      };
    }
  }
  return {
    ok,
    stage,
    status: nextStatus ?? "FAILED",
    result: result.result,
    evidenceRef: result.evidenceRef,
    blockingCode: blockingCodeStr,
    rationale: rationaleStr,
    detail: Object.freeze(detail) as CycleStepResult["detail"],
  };
}

/** Vínculos de etapa → ciclo (somente referências a IDs de outros blocos).
 *  identity_confidence é gravado em QUALQUER outcome de aquisição (ok=false
 *  para IDENTITY_UNCERTAIN também) — o gate S7 bloqueia publicação com base
 *  nele (fail-closed: incerteza de identidade NUNCA habilita publicação). */
function stageVincula(stage: CycleStage, result: StageResult): Record<string, unknown> {
  // StageResult é discriminated union: `detail` só existe quando ok=true.
  const detail = (result.ok && result.detail) || (result as { detail?: Record<string, unknown> }).detail || {};
  switch (stage) {
    case "DISCOVERY":
      return { candidate_id: detail.candidateId ?? null, status: "S1_DISCOVERY" };
    case "CANDIDATE":
      return { candidate_id: detail.candidateId ?? null, status: "S2_CANDIDATE" };
    case "RESEARCH":
      return { research_id: detail.researchId ?? null, status: "S3_RESEARCH" };
    case "ASSESSMENT":
      return { assessment_id: detail.assessmentId ?? null, status: "S4_ASSESSMENT" };
    case "ACQUISITION":
      return {
        acquisition_ref: detail.acquisitionRef ?? null,
        identity_confidence: detail.identityConfidence ?? null,
        status: "S5_ACQUISITION",
      };
    case "RESOLUTION":
      return { resolution_status: detail.resolutionStatus ?? null, affiliate_link_id: detail.affiliateLinkId ?? null, status: "S6_RESOLUTION" };
    case "DECISION":
      return { decision_id: detail.decisionId ?? null, status: detail.decision ?? "S7_DECISION" };
    case "PUBLICATION":
      return { execution_id: detail.executionId ?? null, product_id: detail.productId ?? null, status: detail.executed ? "EXECUTED" : detail.failed ? "EXECUTION_FAILED" : "S8_PUBLICATION" };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// S1 — DISCOVERY (N2 executeDiscover) + registro no N1
// ---------------------------------------------------------------------------
export async function runDiscovery(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle) return { ok: false, stage: "DISCOVERY", status: "FAILED", result: "cycle_absent", evidenceRef: "", blockingCode: "CYCLE_NOT_FOUND", rationale: "ciclo não encontrado" };
  // Normaliza o marketplace do ciclo (snake_case, ex: "mercadolivre") para o
  // canônico exigido pelo executor de Discovery (UPPER, ex: "MERCADOLIVRE").
  const discoveryMarketplace =
    cycle.cycle.marketplace === "shopee"
      ? ("SHOPEE" as import("../discovery/types").MarketplaceSource)
      : ("MERCADOLIVRE" as import("../discovery/types").MarketplaceSource);
  const discoverFn = discoveryOverride ?? executeDiscover;
  const result = await (discoverFn as typeof executeDiscover)({
    marketplace: discoveryMarketplace,
    mode: "url",
    url: cycle.cycle.source_url,
  });
  // Falha operacional (rate_limited/invalid_url/circuit_open): sem evidência
  // de tentativa registrada (N2) — erro explícito, recuperável.
  if (!result.ok) {
    const detail: Record<string, unknown> = { error: result.error ?? "discovery_failed" };
    return recordStage(cycleId, "DISCOVERY", null, {
      stage: "DISCOVERY",
      ok: false,
      result: String(result.error ?? "discovery_failed"),
      blockingCode: "DISCOVERY_FAILED",
      rationale: `descoberta não concluída: ${sanitizeLog(result.error)}`,
      evidenceRef: "",
    });
  }
  // Falha de COLETA registrada pelo N2 (COLLECTION_FAILED) — evidência
  // identificável; o ciclo avança citando o candidate com falha aberta.
  const item = (result.items ?? [])[0] as { candidate_id?: string | null; outcome?: string; title?: string | null; error?: string } | undefined;
  const candidateId = item?.candidate_id ?? null;
  const evidenceRef = candidateId ? `candidates:${candidateId}` : "";
  const fail = (result as { error?: string }).error?.startsWith("collection_failed") ?? false;
  return recordStage(cycleId, "DISCOVERY", "S1_DISCOVERY", {
    stage: "DISCOVERY",
    ok: true,
    result: item?.outcome ?? "unknown",
    evidenceRef,
    detail: {
      candidateId,
      outcome: item?.outcome ?? null,
      marketplace: cycle.cycle.marketplace,
      collectionFailed: fail,
    },
  });
}

// ---------------------------------------------------------------------------
// S2 — CANDIDATE (N1): confirma existência; REJEITADO/INCONCLUSIVE bloqueia
// ---------------------------------------------------------------------------
export async function runCandidateCheck(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "CANDIDATE", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  const candidate = getCandidateOverride
    ? await (getCandidateOverride(cycle.cycle.candidate_id) as Promise<{ ok: boolean; candidate: CandidateRecord | null; reason?: string | null }>)
    : await getCandidate(cycle.cycle.candidate_id);
  if (!candidate.ok || !candidate.candidate) {
    return { ok: false, stage: "CANDIDATE", status: "FAILED", result: "candidate_not_found_n1", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "candidate não encontrado no N1" };
  }
  const status = candidate.candidate.status;
  const allowed = status === "APPROVED";
  return recordStage(cycleId, "CANDIDATE", allowed ? "S2_CANDIDATE" : null, {
    stage: "CANDIDATE",
    ok: true,
    result: allowed ? "candidate_verified" : `candidate_status=${status}`,
    evidenceRef: `candidates:${candidate.candidate.candidate_id}`,
    blockingCode: allowed ? null : "RECOVERABLE",
    rationale: allowed ? null : `candidate com status ${status} (não APPROVED) — bloqueio recuperável; nenhuma publicação é habilitada`,
    detail: { candidateId: candidate.candidate.candidate_id, candidateStatus: status, approved: allowed },
  });
}

// ---------------------------------------------------------------------------
// S3 — RESEARCH (N3 startResearch — pesquisa de dados externos)
// ---------------------------------------------------------------------------
export async function runResearch(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "RESEARCH", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  try {
    const researchFn = researchOverride ?? startResearch;
    const research = await (researchFn as typeof startResearch)({
      candidate_id: cycle.cycle.candidate_id,
      initiated_by: "operator-admin",
      requested_fields: undefined,
    });
    if (!research.ok || !research.research_id) {
      return recordStage(cycleId, "RESEARCH", null, {
        stage: "RESEARCH",
        ok: false,
        result: String((research as { error?: string }).error ?? "research_failed"),
        blockingCode: "RESEARCH_FAILED",
        rationale: `pesquisa não iniciada: ${sanitizeLog((research as { error?: string }).error)}`,
        evidenceRef: "",
      });
    }
    return recordStage(cycleId, "RESEARCH", "S3_RESEARCH", {
      stage: "RESEARCH",
      ok: true,
      result: "research_started",
      evidenceRef: `research:${research.research_id}`,
      detail: { researchId: research.research_id },
    });
  } catch (err) {
    return recordStage(cycleId, "RESEARCH", null, {
      stage: "RESEARCH",
      ok: false,
      result: "research_error",
      blockingCode: "RESEARCH_FAILED",
      rationale: `erro de infraestrutura na pesquisa: ${sanitizeLog((err as Error)?.message)}`,
      evidenceRef: "",
    });
  }
}

// ---------------------------------------------------------------------------
// S4 — ASSESSMENT (N4 assessCandidate + persistAssessment — reuso)
// ---------------------------------------------------------------------------
export async function runAssessment(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "ASSESSMENT", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  try {
    const assessmentFn = assessmentOverride ?? assessCandidate;
    const assessment = await (assessmentFn as typeof assessCandidate)(cycle.cycle.candidate_id);
    if (!assessment.ok || !assessment.dimensions) {
      return recordStage(cycleId, "ASSESSMENT", null, {
        stage: "ASSESSMENT",
        ok: false,
        result: String((assessment as { reason?: string }).reason ?? "assessment_failed"),
        blockingCode: "ASSESSMENT_FAILED",
        rationale: `avaliação N4 não concluída: ${sanitizeLog((assessment as { reason?: string }).reason)}`,
        evidenceRef: "",
        recoverable: true,
      });
    }
    const idempotencyKey = buildAssessmentDigest({
      candidateId: cycle.cycle.candidate_id,
      filterVersion: FILTER_VERSION,
      snapshot: assessment.inputSnapshot ?? {},
    });
    const assessmentId = `asm-${cycle.cycle.candidate_id}-${idempotencyKey.slice(-16)}`;
    const persistFn = persistAssessmentOverride ?? persistAssessment;
    const persisted = await (persistFn as typeof persistAssessment)({
      assessmentId,
      candidateId: cycle.cycle.candidate_id,
      filterVersion: FILTER_VERSION,
      dimensions: assessment.dimensions as unknown as Record<string, unknown>,
      classification: assessment.classification?.classification ?? null,
      classificationBasis: assessment.classification?.basis ?? "",
      recommendation: assessment.recommendation?.recommendation ?? null,
      recommendationBasis: assessment.recommendation?.basis ?? "",
      priority: assessment.priority as unknown as Record<string, unknown>,
      priorityLevel: assessment.priority?.priority_level ?? null,
      priorityScore: assessment.priority?.priority_score ?? null,
      unknowns: assessment.unknowns ?? [],
      contradictions: assessment.contradictions ?? [],
      collectionFailures: assessment.collectionFailures ?? [],
      evidenceRefs: assessment.evidenceRefs ?? [],
      inputSnapshot: assessment.inputSnapshot as Record<string, unknown>,
      idempotencyKey,
    } as never);
    if (!persisted.ok) {
      return recordStage(cycleId, "ASSESSMENT", null, {
        stage: "ASSESSMENT",
        ok: false,
        result: "persist_failed",
        blockingCode: "ASSESSMENT_PERSIST_FAILED",
        rationale: `persistência da avaliação N4 falhou: ${persisted.error}`,
        evidenceRef: "",
        recoverable: true,
      });
    }
    return recordStage(cycleId, "ASSESSMENT", "S4_ASSESSMENT", {
      stage: "ASSESSMENT",
      ok: true,
      result: String(persisted.outcome ?? "persisted"),
      evidenceRef: `candidate_assessment:${assessmentId}`,
      detail: {
        assessmentId,
        classification: assessment.classification?.classification ?? null,
        recommendation: assessment.recommendation?.recommendation ?? null,
        priority: assessment.priority?.priority_level ?? null,
      },
    });
  } catch (err) {
    return recordStage(cycleId, "ASSESSMENT", null, {
      stage: "ASSESSMENT",
      ok: false,
      result: "assessment_error",
      blockingCode: "ASSESSMENT_FAILED",
      rationale: `erro de infraestrutura no N4: ${sanitizeLog((err as Error)?.message)}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// S5 — ACQUISITION (N8 acquireAffiliateLink — reuso)
// Sem provider N6 ativo ou sem credenciais → AUTH_REQUIRED/NONE (fail-closed
// pelo próprio N8; o ciclo registra, não inventa link).
// ---------------------------------------------------------------------------
export async function runAcquisition(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "ACQUISITION", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  const marketplaceMap: Record<CycleMarketplace, "MercadoLivre" | "Shopee"> = {
    mercadolivre: "MercadoLivre",
    shopee: "Shopee",
  };
  const marketplace = marketplaceMap[cycle.cycle.marketplace as CycleMarketplace];
  const providerId = cycle.cycle.marketplace === "shopee" ? "shopee" : "mercadolivre";
  const provider = await getProvider(providerId);
  const acquireFn = acquisitionOverride ?? acquireAffiliateLink;
  let acquireResult: AcquireResult;
  try {
    acquireResult = (await (acquireFn as typeof acquireAffiliateLink)({
      provider: provider as AffiliateProviderRecord,
      reference: {
        marketplace,
        candidateId: cycle.cycle.candidate_id,
        publicUrl: cycle.cycle.source_url,
      },
    })) as AcquireResult;
  } catch (err) {
    return recordStage(cycleId, "ACQUISITION", null, {
      stage: "ACQUISITION",
      ok: false,
      result: "acquisition_error",
      blockingCode: "ACQUISITION_FAILED",
      rationale: `erro de infraestrutura na aquisição N8: ${sanitizeLog((err as Error)?.message)}`,
      evidenceRef: "",
    });
  }
  const detail: Record<string, unknown> = {
    kind: acquireResult.kind,
    identityConfidence: (acquireResult as { identityConfidence?: string }).identityConfidence ?? null,
  };
  const ok = acquireResult.kind === "SUCCESS";
  const evidenceRef = acquireResult.kind === "SUCCESS" || acquireResult.kind === "IDENTITY_UNCERTAIN"
    ? `affiliate_links:${(acquireResult as { acquisitionRef?: string }).acquisitionRef ?? ""}`
    : "";
  return recordStage(cycleId, "ACQUISITION", "S5_ACQUISITION", {
    stage: "ACQUISITION",
    ok,
    result: acquireResult.kind,
    blockingCode: ok ? null : acquireResult.kind === "IDENTITY_UNCERTAIN" ? "IDENTITY_UNCERTAIN" : acquireResult.kind,
    rationale: buildAcquisitionRationale(acquireResult),
    evidenceRef,
    detail: Object.freeze(detail),
  });
}

function buildAcquisitionRationale(result: AcquireResult): string {
  switch (result.kind) {
    case "SUCCESS":
      return `link obtido do mecanismo governado N8; identidade=${result.identityConfidence}; nunca é tratado como "produto confirmado" por este módulo`;
    case "IDENTITY_UNCERTAIN":
      return `link obtido mas a identidade NÃO foi confirmada (IDENTITY_UNCERTAIN): jamais habilita publicação; rationale N8: ${sanitizeLog(result.rationale)}`;
    case "AUTH_REQUIRED":
      return `sem credenciais oficiais do provider N6 (AUTH_REQUIRED): caminho API bloqueado pelo próprio N8 — nenhum endpoint foi presumido`;
    case "NOT_SUPPORTED":
      return `provider do marketplace não suportado pelo N8 (NOT_SUPPORTED)`;
    case "MANUAL_REQUIRED":
      return `nenhum mecanismo disponível; exige operação humana via painel do programa (MANUAL_REQUIRED)`;
    case "PRODUCT_NOT_ELIGIBLE":
      return `produto não elegível segundo o N8 (PRODUCT_NOT_ELIGIBLE)`;
    case "PROVIDER_NOT_ACTIVE":
      return `provider N6 não está ativo (PROVIDER_NOT_ACTIVE)`;
    case "RESOLUTION_FAILED":
      return `resolução do N8 falhou: ${sanitizeLog(result.reason)}`;
    default:
      return `aquisição com resultado não mapeado: ${sanitizeLog(result)}`;
  }
}

// ---------------------------------------------------------------------------
// S6 — RESOLUTION (N7 resolveAffiliateLink — reuso)
// ---------------------------------------------------------------------------
export async function runResolution(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "RESOLUTION", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  try {
    const resolveFn = resolutionOverride ?? resolveAffiliateLink;
    const resolution = await (resolveFn as typeof resolveAffiliateLink)(
      { candidateId: cycle.cycle.candidate_id, affiliateUrlManual: null },
      affiliateRegistrySnapshot,
    );
    const isResolutionOk = resolution.status === "RESOLVED" || resolution.status === "MANUAL_PROVIDED";
    return recordStage(cycleId, "RESOLUTION", "S6_RESOLUTION", {
      stage: "RESOLUTION",
      ok: resolution.status === "RESOLVED" || resolution.status === "MANUAL_PROVIDED",
      result: resolution.status,
      blockingCode: resolution.status === "RESOLVED" || resolution.status === "MANUAL_PROVIDED" ? null : resolution.status,
      rationale: `resolução N7: status=${resolution.status}; ${resolution.reason ? `motivo=${sanitizeLog(resolution.reason)}` : "sem motivo"}`,
      evidenceRef: resolution.affiliateLinkId ? `affiliate_links:${resolution.affiliateLinkId}` : "",
      ...(isResolutionOk ? { detail: { resolutionStatus: resolution.status, affiliateUrl: resolution.affiliateUrl, affiliateLinkId: resolution.affiliateLinkId, providerId: resolution.providerId } } : {}),
    });
  } catch (err) {
    return recordStage(cycleId, "RESOLUTION", null, {
      stage: "RESOLUTION",
      ok: false,
      result: "RESOLUTION_ERROR",
      blockingCode: "RESOLUTION_ERROR",
      rationale: `erro de infraestrutura na resolução N7: ${sanitizeLog((err as Error)?.message)}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// S7 — DECISION (gate v1 + persistência do decision document)
// ---------------------------------------------------------------------------
export async function runDecision(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle || !cycle.cycle.candidate_id) {
    return { ok: false, stage: "DECISION", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id" };
  }
  const gateInput = await buildGateInput(cycle.cycle);
  if (!gateInput.ok || !gateInput.input) {
    return recordStage(cycleId, "DECISION", null, {
      stage: "DECISION",
      ok: false,
      result: "resolution_error",
      blockingCode: "BLOCK_RESOLUTION_ERROR",
      rationale: `falha ao consolidar entrada do gate: ${gateInput.reason ?? "entrada incompleta"}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
  const decision = evaluateDecisionGate(gateInput.input);
  const inputDigest = buildDecisionInputDigest(gateInput.input);
  const decisionId = buildDecisionId(cycleId, inputDigest);
  const persisted = await persistDecision({
    decisionId,
    cycleId,
    candidateId: gateInput.input.candidateId,
    decision: decision.outcome,
    blockingRules: [...decision.blockingRules],
    passedRules: [...decision.passedRules],
    assessmentId: (await listCandidateAssessments({ candidateId: gateInput.input.candidateId, limit: 1 })).assessments?.[0]?.assessment_id?.toString() ?? null,
    classification: gateInput.input.classification ?? null,
    recommendation: gateInput.input.recommendation ?? null,
    priority: gateInput.input.priority ?? null,
    unknownsCount: gateInput.input.unknownsCount,
    contradictionsCount: gateInput.input.contradictionsCount,
    collectionFailed: gateInput.input.collectionFailed,
    identityConfidence: gateInput.input.identityConfidence ?? null,
    resolutionStatus: gateInput.input.resolutionStatus ?? null,
    priceState: "UNKNOWN",
    affiliateState: gateInput.input.requireAffiliateLink ? "REQUIRED" : "NOT_REQUIRED",
    requireAffiliateLink: gateInput.input.requireAffiliateLink,
    rationale: decision.rationale,
    inputDigest,
  });
  if (!persisted.ok) {
    return recordStage(cycleId, "DECISION", null, {
      stage: "DECISION",
      ok: false,
      result: "persist_failed",
      blockingCode: "DECISION_PERSIST_FAILED",
      rationale: `persistência do documento de decisão falhou: ${persisted.reason}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
  const finalStatus = decision.outcome === "DECISION_ALLOWED" ? "DECISION_ALLOWED" : "DECISION_BLOCKED";
  return recordStage(cycleId, "DECISION", finalStatus, {
    stage: "DECISION",
    ok: decision.outcome === "DECISION_ALLOWED",
    result: decision.outcome,
    blockingCode: decision.outcome === "DECISION_BLOCKED" ? (decision.blockingRules[0] ?? "BLOCKED") : null,
    rationale: decision.rationale,
    evidenceRef: `commercial_decisions:${decisionId}`,
    ...(decision.outcome === "DECISION_ALLOWED"
      ? { detail: { decisionId, decision: decision.outcome, blockingRules: [...decision.blockingRules], passedRules: [...decision.passedRules] } }
      : {}),
  });
}

/** Consolida a entrada do gate a partir dos dados existentes (N3/N4/N6/N7).
 *  Falha de qualquer consulta → entrada com resolutionError=true
 *  (BLOCK_RESOLUTION_ERROR; nunca permissão silenciosa). */
async function buildGateInput(cycle: {
  cycle_id: string;
  candidate_id: string | null;
  marketplace: string;
  source_url: string;
  resolution_status: string | null;
  identity_confidence?: string | null;
} | null): Promise<{ ok: boolean; input?: GateInput; reason?: string }> {
  if (!cycle || !cycle.candidate_id) return { ok: false, reason: "candidate_absent" };
  // Assessment mais recente do candidato (N4).
  const assessments = await listCandidateAssessments({ candidateId: cycle.candidate_id, limit: 1 });
  if (!assessments.ok) {
    return { ok: false, reason: `assessment_lookup_failed: ${assessments.error}` };
  }
  // O repositório retorna o registro DB (snake_case) como Record<string,unknown>.
  const latest = (assessments.assessments ?? [])[0] ?? null;
  const unknowns = Array.isArray(latest?.unknowns) ? (latest?.unknowns as unknown[]) : [];
  const criticalFields = ["price", "observed_price"];
  const unknownCritical = unknowns.some((u) => criticalFields.includes(String(u ?? "")));
  const unknownCriticalTitle = unknowns.some((u) => String(u ?? "").toLowerCase().includes("title"));
  // Resolução N7 — consultar para registrar status/erro (mesma lógica da etapa S6).
  let resolutionStatus: string | null = null;
  let resolutionError = false;
  try {
    const resolveFn = resolutionOverride ?? resolveAffiliateLink;
    const resolution = await (resolveFn as typeof resolveAffiliateLink)(
      { candidateId: cycle.candidate_id, affiliateUrlManual: null },
      affiliateRegistrySnapshot,
    );
    resolutionStatus = resolution.status;
  } catch {
    resolutionError = true;
  }
  // Link afiliado registrado no N6 — presença de link governado (DRAFT ou
  // VALID; o gate não exige VALID aqui — o executor N5 decide via
  // requireAffiliateLink do N7).
  let links: unknown[] = [];
  try {
    links = await listLinksByCandidate(cycle.candidate_id);
  } catch {
    resolutionError = true;
  }
  const hasAffiliateLink = Array.isArray(links) && links.length > 0;
  // Price state (conhecido via candidate — consulta leve; NÃO é estimativa).
  const candidate = getCandidateOverride
    ? await (getCandidateOverride(cycle.candidate_id) as Promise<{ ok: boolean; candidate: CandidateRecord | null; reason?: string | null }>)
    : await getCandidate(cycle.candidate_id);
  const candidateRecord = candidate.ok ? candidate.candidate : null;
  const priceState = candidateRecord?.observed_price !== null && candidateRecord?.observed_price !== undefined ? "KNOWN" : "UNKNOWN";
  const requireAffiliateLink = hasAffiliateLink;
  const input: GateInput = {
    candidateId: cycle.candidate_id,
    candidateStatus: candidateRecord?.status ?? null,
    recommendation: typeof latest?.recommendation === "string" ? (latest?.recommendation as string) : null,
    classification: typeof latest?.classification === "string" ? (latest?.classification as string) : null,
    priority: typeof latest?.priority_level === "string" ? (latest?.priority_level as string) : null,
    unknownsCount: unknowns.length,
    unknownCriticalPrice: unknownCritical,
    unknownCriticalTitle,
    contradictionsCount: Array.isArray(latest?.contradictions) ? (latest?.contradictions as unknown[]).length : 0,
    collectionFailed: Array.isArray(latest?.collection_failures) && (latest?.collection_failures as unknown[]).length > 0,
    identityConfidence: cycle.identity_confidence === "PRODUCT_IDENTITY_UNCERTAIN" ? "PRODUCT_IDENTITY_UNCERTAIN" : cycle.identity_confidence === "PRODUCT_IDENTITY_CONFIRMED" ? "PRODUCT_IDENTITY_CONFIRMED" : null,
    resolutionStatus,
    requireAffiliateLink,
    resolutionError,
    errorReason: resolutionError ? "consulta ao N7 falhou" : null,
  };
  return { ok: true, input: Object.freeze(input) as GateInput };
}

// ---------------------------------------------------------------------------
// S8 — PUBLICATION (executor N5 — ÚNICO caminho legítimo de publicação)
// Só executa com DECISION_ALLOWED; DECISION_BLOCKED NUNCA chega aqui.
// ---------------------------------------------------------------------------
export async function runPublication(cycleId: string): Promise<CycleStepResult> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle) {
    return { ok: false, stage: "PUBLICATION", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CYCLE_NOT_FOUND", rationale: "ciclo não encontrado" };
  }
  if (!cycle.cycle.candidate_id) {
    return { ok: false, stage: "PUBLICATION", status: "FAILED", result: "candidate_absent", evidenceRef: "", blockingCode: "CANDIDATE_NOT_FOUND", rationale: "ciclo sem candidate_id (execute Discovery/Candidate antes)" };
  }
  // Gate: só DECISION_ALLOWED permite executar.
  const decisionLookup = await getDecisionByCycle(cycleId);
  if (!decisionLookup.ok || !decisionLookup.decision) {
    return { ok: false, stage: "PUBLICATION", status: "FAILED", result: "decision_absent", evidenceRef: "", blockingCode: "DECISION_NOT_FOUND", rationale: "documento de decisão ausente; execute runDecision primeiro" };
  }
  if (decisionLookup.decision.decision !== "DECISION_ALLOWED") {
    return { ok: false, stage: "PUBLICATION", status: "FAILED", result: "decision_blocked", evidenceRef: `commercial_decisions:${decisionLookup.decision.decision_id}`, blockingCode: "DECISION_BLOCKED", rationale: `ciclo com decisão ${decisionLookup.decision.decision}; bloqueios: ${decisionLookup.decision.blocking_rules.join(", ") || "—"}` };
  }
  // Preflight N5 — revalida TODOS os pré-requisitos (nada é confiado).
  const preflight = await preflightPublication(
    { candidateId: cycle.cycle.candidate_id, affiliateUrl: null },
    publicationRepo,
  );
  if (!preflight.ok) {
    return recordStage(cycleId, "PUBLICATION", null, {
      stage: "PUBLICATION",
      ok: false,
      result: String(preflight.failureCode ?? "preflight_failed"),
      blockingCode: String(preflight.failureCode ?? "PREFLIGHT_FAILED"),
      rationale: `preflight do executor N5 falhou: ${sanitizeLog(preflight.reason)}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
  const assessment = preflight.assessment;
  if (!assessment) {
    return recordStage(cycleId, "PUBLICATION", null, {
      stage: "PUBLICATION",
      ok: false,
      result: "assessment_missing",
      blockingCode: "ASSESSMENT_NOT_FOUND",
      rationale: "preflight N5 não encontrou avaliação acionável",
      evidenceRef: "",
      recoverable: true,
    });
  }
  const executionId = `cycex-${cycleId}`;
  const correlationId = `cyccor-${cycleId}`;
  const idempotencyKey = createHash("sha256").update(`${cycleId}:${decisionLookup.decision.decision_id}:${executionId}`).digest("hex");
  const decision: PublicationDecision = {
    decisionId: decisionLookup.decision.decision_id,
    candidateId: cycle.cycle.candidate_id,
    assessmentId: decisionLookup.decision.assessment_id ?? assessment.assessmentId ?? "",
    policyDecision: "ALLOW" as import("../../policyEngine/types").PolicyDecisionValue,
    approvalState: "NOT_REQUIRED" as import("../../agentRuntime/types").ApprovalDecisionState,
    rationale: decisionLookup.decision.rationale,
    decidedBy: "operator-admin",
    decidedAt: new Date().toISOString(),
    correlationId,
  };
  try {
    const execution = await executePublication({
      request: {
        candidateId: cycle.cycle.candidate_id,
        decision,
        correlationId,
      executionId,
      idempotencyKey,
      decidedBy: "operator-admin",
      affiliateSource: null,
    },
      repo: publicationRepo,
      approveLookup: buildApprovalLookup(),
      affiliateRegistrySnapshot,
      requireAffiliateLink: true,
    });
    const executed = execution.ok && (execution.outcome === "PUBLISHED" || execution.outcome === "ALREADY_PUBLISHED" || execution.outcome === "WAITING_APPROVAL");
    return recordStage(cycleId, "PUBLICATION", "S8_PUBLICATION", {
      stage: "PUBLICATION",
      ok: executed,
      result: execution.outcome,
      blockingCode: executed ? null : String(execution.failureCode ?? "EXECUTION_FAILED"),
      rationale: `executor N5: outcome=${execution.outcome}; ${execution.reason ? `motivo=${sanitizeLog(execution.reason)}` : "sem motivo"}`,
      evidenceRef: execution.productId ? `products:${execution.productId}` : "",
      ...(executed ? { detail: { executionId, outcome: execution.outcome, productId: execution.productId, executed, failed: !executed } } : {}),
    });
  } catch (err) {
    return recordStage(cycleId, "PUBLICATION", null, {
      stage: "PUBLICATION",
      ok: false,
      result: "execution_error",
      blockingCode: "EXECUTION_ERROR",
      rationale: `erro de infraestrutura na execução N5: ${sanitizeLog((err as Error)?.message)}`,
      evidenceRef: "",
      recoverable: true,
    });
  }
}

/** Approval lookup: o executor N5 exige um provider de aprovação; o ciclo
 *  registra a decisão N9 como "not_required" (governança: a aprovação
 *  humana real é etapa SEPARADA, futura, autorizada sob outro bloco — o
 *  documento N9 não substitui a aprovação do Agent Runtime). */
function buildApprovalLookup(): import("../publication/publicationExecutor").ApprovalLookup {
  return {
    async findApproval(executionId: string) {
      return {
        approvalId: `cycapp-${executionId}`,
        state: "NOT_REQUIRED" as import("../../agentRuntime/types").ApprovalDecisionState,
        expiresAt: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Run all (sequência S1→S8) — uso administrativo; erros intermediários
// param na etapa e deixam o ciclo recuperável.
// ---------------------------------------------------------------------------
export async function runAllStages(cycleId: string): Promise<{ ok: boolean; steps: CycleStepResult[]; haltedAt?: CycleStage; reason?: string }> {
  const stages: Array<{ stage: CycleStage; run: (id: string) => Promise<CycleStepResult> }> = [
    { stage: "DISCOVERY", run: runDiscovery },
    { stage: "CANDIDATE", run: runCandidateCheck },
    { stage: "RESEARCH", run: runResearch },
    { stage: "ASSESSMENT", run: runAssessment },
    { stage: "ACQUISITION", run: runAcquisition },
    { stage: "RESOLUTION", run: runResolution },
    { stage: "DECISION", run: runDecision },
    { stage: "PUBLICATION", run: runPublication },
  ];
  const steps: CycleStepResult[] = [];
  for (const entry of stages) {
    const step = await entry.run(cycleId);
    steps.push(step);
    if (!step.ok) {
      return { ok: false, steps, haltedAt: entry.stage, reason: step.rationale };
    }
  }
  return { ok: true, steps };
}

// ---------------------------------------------------------------------------
// Consulta render-only (Telegram / painel)
// ---------------------------------------------------------------------------
export async function getCycleState(cycleId: string): Promise<{ ok: boolean; state?: CycleStateSummary; reason?: string }> {
  const cycle = await getCycle(cycleId);
  if (!cycle.ok || !cycle.cycle) return { ok: false, reason: cycle.reason ?? "cycle_not_found" };
  const stepsResult = await listSteps(cycleId);
  if (!stepsResult.ok) return { ok: false, reason: stepsResult.reason };
  const decisionLookup = await getDecisionByCycle(cycleId);
  const decision = decisionLookup.ok ? decisionLookup.decision : null;
  return {
    ok: true,
    state: {
      cycleId: cycle.cycle.cycle_id,
      status: cycle.cycle.status as CycleStatus,
      marketplace: cycle.cycle.marketplace as CycleMarketplace,
      sourceUrl: cycle.cycle.source_url,
      candidateId: cycle.cycle.candidate_id,
      researchId: cycle.cycle.research_id,
      assessmentId: cycle.cycle.assessment_id,
      acquisitionRef: cycle.cycle.acquisition_ref,
      affiliateLinkId: cycle.cycle.affiliate_link_id,
      resolutionStatus: cycle.cycle.resolution_status,
      decisionId: cycle.cycle.decision_id,
      decision: (decision?.decision as CycleStateSummary["decision"]) ?? null,
      blockingRules: Object.freeze(decision ? (decision.blocking_rules as CycleStateSummary["blockingRules"]) : []),
      executionId: cycle.cycle.execution_id,
      productId: cycle.cycle.product_id,
      steps: Object.freeze(stepsResult.steps.map((s) => ({
        stage: s.stage as CycleStage,
        result: s.result,
        blockingCode: s.blocking_code,
        rationale: s.rationale,
        createdAt: s.created_at,
      }))),
      createdAt: cycle.cycle.created_at,
      updatedAt: cycle.cycle.updated_at,
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup de prova (artificial) — uso exclusivo em provas controladas.
// ---------------------------------------------------------------------------
export async function deleteCycleForProof(cycleId: string): Promise<{ ok: boolean; reason?: string }> {
  return deleteCycleProof({ cycleId });
}

export { CYCLE_STATUSES, CYCLE_STAGES, BLOCKING_RULES } from "./cycleContract";
