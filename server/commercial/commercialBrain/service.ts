// ============================================================================
// Bloco N14 — Serviço de Commercial Brain (orquestração read-only).
//
// GOVERNANÇA:
// - GATE N13 OBRIGATÓRIO: só executa para candidate_id com assessment N13
//   existente, filter_version='n13:curator_v1' E verdict='PASS'.
//   Ausente/BLOCKED/REVIEW/FAIL/inconsistente → fail-closed: N14 NÃO
//   calcula score e NENHUM assessment N14 é criado (sem bypass, nem
//   em testes).
// - REUTILIZA candidate_assessment (N4): filter_version
//   "n14:commercial_brain_v1".
// - READ-ONLY: getCandidate e listCandidateAssessments apenas; nada
//   é alterado, criado (fora candidate_assessment), publicado,
//   afiliado, agendado ou divulgado.
// - Sinais ausentes → UNKNOWN persistente (nunca 0).
// - Determinismo: snapshot sem horário no digest; now apenas como
//   evaluatedAt (metadado).
// - Fail-closed: erro inesperado → gateReason internal_error, nenhum
//   score aprovado.
// ============================================================================
import {
  CANDIDATE_ID_PATTERN,
  N13_REQUIRED_FILTER_VERSION,
  N13_REQUIRED_VERDICT,
  COMMERCIAL_BRAIN_PROVENANCE,
  type CommercialServiceResult,
  type CommercialSignalsInput,
} from "./contract";
import { normalizeSignalsInput, type NormalizedSignal } from "./normalizers";
import {
  resolveEvidenceSignals,
  EVIDENCE_SIGNAL_PROVENANCE,
} from "./evidenceSignals";
import { listCandidateEvidence } from "../../repositories/candidateEvidenceRepository";
import { getPriceRanges, lookupPriceRange, validatePriceRangesRegistry } from "./priceRanges";
import { evaluateCommercialSignals, type NormalizedSignals } from "./engine";
import {
  buildAssessmentDigest,
  persistAssessment,
  listCandidateAssessments,
  type PersistAssessmentResult,
} from "../../repositories/candidateAssessmentRepository";
import {
  getCandidate,
  type CandidateRecord,
} from "../../repositories/candidatesRepository";

let nowIsoProvider = (): string => new Date().toISOString();

export function setCommercialBrainNowProvider(provider: () => string): void {
  nowIsoProvider = provider;
}
export function resetCommercialBrainNowProvider(): void {
  nowIsoProvider = () => new Date().toISOString();
}

export const COMMERCIAL_BRAIN_GATE_REASONS = [
  "invalid_candidate_id",
  "candidate_not_found",
  "n13_assessment_missing",
  "n13_verdict_not_pass",
  "n13_assessment_inconsistent",
  "internal_error",
] as const;
export type CommercialBrainGateReason = (typeof COMMERCIAL_BRAIN_GATE_REASONS)[number];

function extractN13Verdict(assessment: Record<string, unknown>): string | null {
  const dimensions = assessment.dimensions as Record<string, unknown> | null | undefined;
  const verdictDim = dimensions && typeof dimensions?.verdict === "string" ? dimensions.verdict : null;
  const metadata = assessment.metadata as Record<string, unknown> | null | undefined;
  const verdictMeta = metadata && typeof metadata?.verdict === "string" ? metadata.verdict : null;
  return verdictDim ?? verdictMeta ?? null;
}

function extractN13FilterVersion(assessment: Record<string, unknown>): string | null {
  return typeof assessment.filter_version === "string" ? assessment.filter_version : null;
}

/**
 * Encontra o assessment N13 válido (filter_version + verdict PASS) para o
 * candidato. Retorna o assessment mais recente válido ou o motivo da recusa.
 */
async function resolveN13Gate(
  candidateId: string,
): Promise<{ assessment?: Record<string, unknown> | null; gateReason: CommercialBrainGateReason | null }> {
  const listResult = await listCandidateAssessments({ candidateId, limit: 50 });
  if (!listResult.ok) {
    return { gateReason: "internal_error" };
  }
  const assessments = listResult.assessments ?? [];
  let found: Record<string, unknown> | null = null;
  for (const a of assessments) {
    const version = extractN13FilterVersion(a);
    if (version !== N13_REQUIRED_FILTER_VERSION) continue;
    const verdict = extractN13Verdict(a);
    if (verdict !== N13_REQUIRED_VERDICT) continue;
    found = a;
    break;
  }
  if (!found) {
    // Há assessments N13 mas nenhum com verdict PASS → gate reprovado.
    const hasAnyN13 = assessments.some(
      (a) => extractN13FilterVersion(a) === N13_REQUIRED_FILTER_VERSION,
    );
    return { gateReason: hasAnyN13 ? "n13_verdict_not_pass" : "n13_assessment_missing" };
    }
  return { assessment: found, gateReason: null };
}

/**
 * Deriva sinais comerciais iniciais dos campos observados do candidato
 * (dados de descoberta real do funil N1/N10/N12). Sinais derivados são
 * marcados com source "candidate:<campo>" e provenance herdada do
 * metadata.provenance canônico do candidato. O metadata.source é origem
 * de campo e só serve como fallback para candidatos legados sem provenance.
 * Campos ausentes/
 * inválidos permanecem UNKNOWN — nunca viram 0.
 */
export function deriveSignalsFromCandidate(
  candidate: CandidateRecord,
): CommercialSignalsInput {
  const metadata = (candidate.metadata ?? {}) as Record<string, unknown>;
  const sourceProvenance =
    typeof metadata.provenance === "string"
      ? metadata.provenance
      : typeof metadata.source === "string"
        ? metadata.source
        : null;
  const observedAt = typeof candidate.observed_at === "string" && candidate.observed_at.length > 0
    ? candidate.observed_at
    : null;
  // Faixa de preço plausível da categoria (nunca inventada: sem entrada
  // registrada → null e o preço mantém normalização absoluta).
  const categoryRange = lookupPriceRange(candidate.category);
  const signals: CommercialSignalsInput = {
    price: {
      value: typeof candidate.observed_price === "number" ? candidate.observed_price : null,
      status: typeof candidate.observed_price === "number" ? "KNOWN" : "UNKNOWN",
      source: "candidate:observed_price",
      observedAt,
      provenance: sourceProvenance,
      currency: "BRL",
      note: "candidate_derived",
      priceRange: categoryRange === null ? null : { min: categoryRange.min, max: categoryRange.max },
    },
    seller: {
      value: typeof candidate.observed_rating === "number" ? candidate.observed_rating : null,
      reviewCount:
        typeof candidate.observed_rating_count === "number" ? candidate.observed_rating_count : null,
      status: typeof candidate.observed_rating === "number" ? "KNOWN" : "UNKNOWN",
      source: "candidate:observed_rating",
      observedAt,
      provenance: sourceProvenance,
      note: "candidate_derived",
    },
    availability: {
      value:
        candidate.observed_availability === "IN_STOCK"
          ? 1
          : candidate.observed_availability === "OUT_OF_STOCK"
            ? 0
            : null,
      status:
        candidate.observed_availability === "IN_STOCK" || candidate.observed_availability === "OUT_OF_STOCK"
          ? "KNOWN"
          : "UNKNOWN",
      source: "candidate:observed_availability",
      observedAt,
      provenance: sourceProvenance,
      note: "candidate_derived",
    },
  };
  // commission/market/competition exigem evidência comercial real e
  // proveniente (provider afiliado, API oficial). Nunca derivar do
  // candidato (UNKNOWN persistente — sem demanda presumida).
  return signals;
}

export async function evaluateCommercialBrain(
  candidateId: string,
  signalsInput: CommercialSignalsInput | null = null,
  nowIso: string | null = null,
): Promise<CommercialServiceResult> {
  try {
    if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
      return { ok: false, outcome: "gate_failed", gateReason: "invalid_candidate_id" };
    }

    const candidateResult = await getCandidate(candidateId);
    if (!candidateResult.ok || !candidateResult.candidate) {
      return { ok: false, outcome: "gate_failed", gateReason: "candidate_not_found" };
    }
    const candidate = candidateResult.candidate;

    // GATE N13 OBRIGATÓRIO — sem exceções (nem para testes).
    const n13 = await resolveN13Gate(candidateId);
    if (n13.gateReason) {
      return { ok: false, outcome: "gate_failed", gateReason: n13.gateReason };
    }

    // ELO EVIDENCE BRIDGE → N14 (Fase 20): transporte read-only das
    // evidências elegíveis de candidate_evidence para os sinais do N14.
    // Ordem de precedência: derivado do candidato < evidência oficial <
    // override explícito da rota. Falha de leitura → readFailure e nenhum
    // sinal é transportado (N14 permanece UNKNOWN/INSUFFICIENT).
    let evidenceSignals: CommercialSignalsInput = {};
    let evidenceRefs: ReadonlyArray<string> = [];
    let evidenceAmbiguity: ReadonlyArray<string> = [];
    try {
      const resolved = await resolveEvidenceSignals(candidateId, cid =>
        listCandidateEvidence(cid),
      );
      if (!resolved.readFailure) {
        evidenceSignals = resolved.signals;
        evidenceRefs = resolved.evidenceIds;
        evidenceAmbiguity = resolved.ambiguousFields;
      }
    } catch {
      evidenceSignals = {};
      evidenceRefs = [];
    }
    const mergedInput = {
      ...deriveSignalsFromCandidate(candidate),
      ...normalizeOverrides(evidenceSignals),
      ...normalizeOverrides(signalsInput ?? {}),
    };
    const normalized: NormalizedSignals = normalizeSignalsInput(mergedInput);

    // Referência de risco TRUNCADA A DIA UTC: o mesmo snapshot (mesmo
    // candidato + mesmos sinais) produz a mesma referência no mesmo dia
    // UTC, garantindo digest/idempotency_key determinísticos entre
    // replays separados por segundos/minutos/horas. O horário exato
    // continua auditável via evaluatedAt (metadado, fora do digest).
    // null → usa now (fallback); truncamento só se ambos tiverem valor.
    const referenceDateIso = nowIso
      ? nowIso.slice(0, 10)
      : nowIsoProvider().slice(0, 10);
    const additionalFactors: string[] = [];
    if (!normalized.price.signal.provenance && normalized.price.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:price`);
    }
    if (!normalized.commission.signal.provenance && normalized.commission.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:commission`);
    }
    if (!normalized.availability.signal.provenance && normalized.availability.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:availability`);
    }
    if (!normalized.seller.signal.provenance && normalized.seller.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:seller`);
    }
    if (!normalized.market.signal.provenance && normalized.market.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:market`);
    }
    if (!normalized.competition.signal.provenance && normalized.competition.signal.status === "KNOWN") {
      additionalFactors.push(`unprovenanced_dimension:competition`);
    }

    const decision = evaluateCommercialSignals({
      candidateId,
      signals: normalized,
      referenceDateIso,
      additionalRiskFactors: additionalFactors,
      nowIso: referenceDateIso,
    });

    const snapshot = {
      score: decision.score,
      band: decision.band,
      confidence: decision.confidence,
      coverage: decision.coverage,
      conflict: decision.conflict,
      conflictDimensions: decision.conflictDimensions,
      dimensionsUsed: decision.dimensionsUsed,
      dimensionsUnknown: decision.dimensionsUnknown,
      riskPenalty: decision.riskPenalty,
      riskFactors: decision.riskFactors,
      rationale: decision.rationale,
      weightsVersion: decision.weightsVersion,
      contractVersion: decision.contractVersion,
      signals: {
        price: { status: normalized.price.signal.status, source: normalized.price.signal.source, note: normalized.price.signal.note },
        commission: { status: normalized.commission.signal.status, source: normalized.commission.signal.source, note: normalized.commission.signal.note },
        availability: { status: normalized.availability.signal.status, source: normalized.availability.signal.source, note: normalized.availability.signal.note },
        market: { status: normalized.market.signal.status, source: normalized.market.signal.source, note: normalized.market.signal.note },
        seller: { status: normalized.seller.signal.status, source: normalized.seller.signal.source, note: normalized.seller.signal.note },
        competition: { status: normalized.competition.signal.status, source: normalized.competition.signal.source, note: normalized.competition.signal.note },
      },
      n13AssessmentId: n13.assessment?.assessment_id ?? null,
    };

    const dimensions = {
      contractVersion: decision.contractVersion,
      weightsVersion: decision.weightsVersion,
      score: decision.score,
      band: decision.band,
      coverage: decision.coverage,
      conflict: decision.conflict,
    };
    // Mapeamento para o catálogo real da coluna candidate_assessment.classification
    // em produção (CHECK: WINNER | HIDDEN_GEM | NICHE_DROP | INSUFFICIENT |
    // NOT_RECOMMENDED). O band/score comercial reais permanecem auditáveis
    // no metadata (band, score, weightsVersion) — classificação persistida
    // nunca é consumida por fluxos comerciais; a publicação continua fora
    // do escopo N14 (RECOMMENDATION != ACTION). INSUFFICIENT grava NULL
    // (sem classificação comercial) — band INSUFFICIENT nunca gera rótulo.
    const classification:
      | "WINNER"
      | "HIDDEN_GEM"
      | "NICHE_DROP"
      | "INSUFFICIENT"
      | "NOT_RECOMMENDED"
      | null =
      decision.band === "INSUFFICIENT"
        ? null
        : decision.band === "HIGH"
          ? "WINNER"
          : decision.band === "MEDIUM"
            ? "HIDDEN_GEM"
            : "NICHE_DROP";
    const classificationBasis = `commercial_brain_v1; score=${decision.score ?? "NA"}; coverage=${decision.coverage}; conflict=${decision.conflict}`;

    const persistResult: PersistAssessmentResult = await persistAssessment({
      assessmentId: `cb-${candidateId.slice(4)}`,
      candidateId,
      filterVersion: "n14:commercial_brain_v1",
      dimensions,
      classification,
      classificationBasis,
      recommendation: null,
      recommendationBasis: decision.band === "INSUFFICIENT"
        ? "insufficient_known_dimensions; classification blocked; no commercial interpretation"
        : `commercial_attractiveness; classification=${decision.band}; not an approval`,
      priority: {},
      priorityLevel: null,
      priorityScore: null,
      unknowns: decision.dimensionsUnknown.map((d) => `unknown_dimension:${d}`),
      contradictions: decision.conflictDimensions.map((d) => `conflict_dimension:${d}`),
      collectionFailures: [],
      evidenceRefs: [...evidenceRefs],
      inputSnapshot: snapshot,
      correlationId: null,
      idempotencyKey: buildAssessmentDigest({
        candidateId,
        filterVersion: "n14:commercial_brain_v1",
        snapshot,
      }),
      metadata: {
        block: "n14",
        version: "commercial_brain_v1",
        band: decision.band,
        score: decision.score,
        confidence: decision.confidence,
        conflict: decision.conflict,
        rationale: decision.rationale,
        contractVersion: decision.contractVersion,
        weightsVersion: decision.weightsVersion,
        provenance: COMMERCIAL_BRAIN_PROVENANCE,
        n13GateVerdict: N13_REQUIRED_VERDICT,
        n13GateFilterVersion: N13_REQUIRED_FILTER_VERSION,
        n13AssessmentId: n13.assessment?.assessment_id ?? null,
        evidenceSignalsTransported: evidenceRefs.length > 0,
        evidenceRefsUsed: [...evidenceRefs],
        evidenceAmbiguousFields: [...evidenceAmbiguity],
        evidenceSignalProvenance: EVIDENCE_SIGNAL_PROVENANCE,
      },
    });

    if (!persistResult.ok) {
      // Persistência falha → decisão existe mas não é auditável: erro,
      // sem sucesso (fail-closed).
      return { ok: false, outcome: "persist_error", error: persistResult.error ?? "persist_error" };
    }
    return {
      ok: true,
      outcome: persistResult.outcome === "identical_duplicate" ? "identical_duplicate" : "evaluated",
      decision,
    };
  } catch (error) {
    return {
      ok: false,
      outcome: "gate_failed",
      gateReason: "internal_error",
      error: (error as Error)?.message ?? "unknown",
    };
  }
}

/**
 * Sobrescreve/estende os sinais derivados do candidato com valores
 * explícitos (ex.: comissão do provider afiliado). Um sinal explícito
 * com status KNOWN prevalece sobre o derivado; valores inválidos são
 * tratados como ausentes (normalizers preservam UNKNOWN).
 */
function normalizeOverrides(input: CommercialSignalsInput): CommercialSignalsInput {
  const out: CommercialSignalsInput = {};
  for (const key of Object.keys(input) as (keyof CommercialSignalsInput)[]) {
    const raw = input[key];
    if (!raw) continue;
    const statusRaw = typeof raw.status === "string" ? raw.status : raw.value !== null && raw.value !== undefined ? "KNOWN" : "UNKNOWN";
    const status = ["KNOWN", "UNKNOWN", "CONFLICT"].includes(statusRaw) ? (statusRaw as "KNOWN" | "UNKNOWN" | "CONFLICT") : "UNKNOWN";
    out[key] = {
      ...raw,
      status,
      source: typeof raw.source === "string" && raw.source.trim().length > 0 ? raw.source.trim() : `n14:${key}`,
      provenance: typeof raw.provenance === "string" && raw.provenance.trim().length > 0 ? raw.provenance.trim() : null,
      observedAt: typeof raw.observedAt === "string" ? raw.observedAt : null,
    };
  }
  return out;
}
