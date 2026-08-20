// ============================================================================
// ELO EVIDENCE BRIDGE → N14 (FASE 20 — leitura estrita, fail-closed).
//
// Transporte SOMENTE de evidências comerciais reais já persistidas pelo
// N3 (candidate_evidence) para os sinais do Commercial Brain/N14.
//
// Fronteiras obrigatórias:
//   EVIDENCE != FACT CANÔNICO · SIGNAL ≠ FACT
// Este módulo NUNCA:
//   - altera candidate_evidence, candidates, contract.ts, engine.ts,
//     weights, thresholds, policy N15, N13/N15/N16/N17/N8/N6;
//   - cria novos sinais (title NÃO é dimensão comercial do N14);
//   - promove UNKNOWN para KNOWN (evidência NÃO elegível → nada);
//   - assume moeda (currency=UNKNOWN) nem escala (price permanece
//     string_price_unscaled / scale UNVERIFIED);
//   - inventa sinal quando a leitura falha (fail-closed: N14 continua
//     com o comportamento atual — UNKNOWN/INSUFFICIENT).
// Identidade: somente evidências do candidate_id avaliado (a consulta do
// repositório filtra por candidate_id — nenhuma evidência de outro
// candidato é aceita nem cross-market identity matching).
// Duplicatas: múltiplas evidências KNOWN para o mesmo campo → nenhum
// sinal transportado e a ambiguidade é registrada (sem regra nova de
// precedência).
// ============================================================================
import type { CommercialSignalsInput } from "./contract";

export const EVIDENCE_SIGNAL_SOURCE_PREFIX = "evidence" as const;
export const EVIDENCE_SIGNAL_PROVENANCE =
  "n14:evidence:affiliate:shopee:productOfferV2" as const;

/** Campos de evidência transportáveis para sinais comerciais do N14. */
const TRANSPORTABLE_FIELDS = ["price", "seller", "availability"] as const;

/** Registro de evidência mínimo consumido pelo transporte (injeção
 *  para testes — em produção usa listCandidateEvidence do repositório). */
export interface EvidenceRow {
  evidence_id: string;
  candidate_id: string;
  field_name: string | null;
  field_value: Record<string, unknown> | null;
  field_state: string;
  quality: string;
  unit: string | null;
  evidence_note: string;
  observed_at: string;
  metadata: Record<string, unknown>;
}

/** EvidenceRecord mínimo consumido (injeção para testes). */
export type EvidenceListReader = (
  candidateId: string,
) => Promise<{
  ok: boolean;
  reason?: string;
  evidence: ReadonlyArray<EvidenceRow>;
}>;

export interface EvidenceSignalsResult {
  /** Sinais transportados das evidências elegíveis. */
  signals: CommercialSignalsInput;
  /** Evidências usadas na decisão (auditoria da origem do sinal). */
  evidenceIds: ReadonlyArray<string>;
  /** Campos com múltiplas evidências KNOWN: ambiguidade registrada,
   *  nenhum sinal transportado (sem regra nova de precedência). */
  ambiguousFields: ReadonlyArray<string>;
  /** Falha de leitura do repositório: nenhum sinal é inventado; o N14
   *  permanece com o comportamento atual (UNKNOWN/INSUFFICIENT). */
  readFailure: boolean;
}

function extractFieldValue(field: EvidenceRow): unknown {
  const raw = field.field_value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return (raw as { value?: unknown }).value;
}

function knownEvidenceFor(
  candidateId: string,
  fieldName: string,
  all: ReadonlyArray<EvidenceRow>,
): ReadonlyArray<EvidenceRow> {
  return all.filter(
    e =>
      e.candidate_id === candidateId &&
      e.field_name === fieldName &&
      e.field_state === "KNOWN",
  // quality (HIGH/UNKNOWN) NÃO é critério de elegibilidade: o price
  // oficial vem com quality=UNKNOWN (escala UNVERIFIED) e AINDA assim é
  // transportável — a regra 4 da Fase 20 preserva unit/quality/note no
  // sinal. Valores semanticamente inválidos são filtrados depois
  // (extractFieldValue: value number finito).
  );
}

function firstKnownEvidence(
  candidateId: string,
  fieldName: string,
  all: ReadonlyArray<EvidenceRow>,
): EvidenceRow | null {
  const list = knownEvidenceFor(candidateId, fieldName, all);
  if (list.length === 0) return null;
  if (list.length > 1) return null; // ambiguidade → nenhum sinal
  return list[0];
}

function priceSignalFrom(
  field: EvidenceRow,
): CommercialSignalsInput["price"] {
  const value = extractFieldValue(field);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    // O parser já rejeitou ambíguos (fail-closed); qualquer outro shape
    // não é transportado — permanece UNKNOWN.
    return null;
  }
  // Rastreabilidade da origem preservada no sinal (auditoria):
  // quality=UNKNOWN → escala UNVERIFIED; unit=string_price_unscaled →
  // jamais "minor units"; evidence_id transportado no source.
  return {
    value,
    status: "KNOWN",
    source: `${EVIDENCE_SIGNAL_SOURCE_PREFIX}:${field.evidence_id}`,
    observedAt: field.observed_at,
    provenance: EVIDENCE_SIGNAL_PROVENANCE,
    currency: "UNKNOWN",
    note:
      `unit=${field.unit ?? "null"};quality=${field.quality ?? "null"};${
        field.evidence_note ?? "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED"
      }`,
  };
}

function sellerSignalFrom(
  field: EvidenceRow,
): CommercialSignalsInput["seller"] {
  const value = extractFieldValue(field);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return {
    value,
    status: "KNOWN",
    source: `${EVIDENCE_SIGNAL_SOURCE_PREFIX}:${field.evidence_id}`,
    observedAt: field.observed_at,
    provenance: EVIDENCE_SIGNAL_PROVENANCE,
    note: `unit=${field.unit ?? "null"};quality=${field.quality ?? "null"};${
      field.evidence_note ?? "OBSERVED_SELLER_RATING_FROM_OFFICIAL_EVIDENCE"
    }`,
  };
}

function availabilitySignalFrom(
  field: EvidenceRow,
): CommercialSignalsInput["availability"] {
  const unit = typeof field.unit === "string" ? field.unit : null;
  let value: number | null = null;
  if (unit === "IN_STOCK") value = 1;
  else if (unit === "OUT_OF_STOCK") value = 0;
  else return null; // sem semântica comprovada → não transportar
  return {
    value,
    status: "KNOWN",
    source: `${EVIDENCE_SIGNAL_SOURCE_PREFIX}:${field.evidence_id}`,
    observedAt: field.observed_at,
    provenance: EVIDENCE_SIGNAL_PROVENANCE,
    note: `unit=${field.unit ?? "null"};quality=${field.quality ?? "null"};${
      field.evidence_note ?? "OBSERVED_AVAILABILITY_FROM_OFFICIAL_EVIDENCE"
    }`,
  };
}

/**
 * Lê SOMENTE candidate_evidence do candidato avaliado e transforma as
 * evidências elegíveis em sinais consumíveis pelo N14.
 * - Sem criação/modificação de evidências/candidates (read-only).
 * - Sem promoção UNKNOWN→KNOWN: field_state KNOWN + value válido.
 * - Title (dimensão não comercial do N14) NÃO é transportado.
 * - commission/competition/market permanecem ausentes (sem evidência
 *   elegível persistida → UNKNOWN, sem proxies).
 */
export async function resolveEvidenceSignals(
  candidateId: string,
  reader: EvidenceListReader,
): Promise<EvidenceSignalsResult> {
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
    return {
      signals: {},
      evidenceIds: [],
      ambiguousFields: [],
      readFailure: true,
    };
  }
  const result = await reader(candidateId);
  if (!result.ok) {
    // Falha de leitura: N14 permanece com o comportamento atual
    // (UNKNOWN/INSUFFICIENT) — nada é inventado.
    return {
      signals: {},
      evidenceIds: [],
      ambiguousFields: [],
      readFailure: true,
    };
  }
  const all = result.evidence;
  const ambiguousFields: string[] = [];
  const usedIds: string[] = [];
  const signals: CommercialSignalsInput = {};

  const price = firstKnownEvidence(candidateId, "price", all);
  if (price === null && knownEvidenceFor(candidateId, "price", all).length > 1) {
    ambiguousFields.push("price");
  } else if (price !== null) {
    const signal = priceSignalFrom(price);
    if (signal) {
      signals.price = signal;
      usedIds.push(price.evidence_id);
    }
  }

  const seller = firstKnownEvidence(candidateId, "seller", all);
  if (seller === null && knownEvidenceFor(candidateId, "seller", all).length > 1) {
    ambiguousFields.push("seller");
  } else if (seller !== null) {
    const signal = sellerSignalFrom(seller);
    if (signal) {
      signals.seller = signal;
      usedIds.push(seller.evidence_id);
    }
  }

  const availability = firstKnownEvidence(candidateId, "availability", all);
  if (
    availability === null &&
    knownEvidenceFor(candidateId, "availability", all).length > 1
  ) {
    ambiguousFields.push("availability");
  } else if (availability !== null) {
    const signal = availabilitySignalFrom(availability);
    if (signal) {
      signals.availability = signal;
      usedIds.push(availability.evidence_id);
    }
  }

  return {
    signals,
    evidenceIds: usedIds,
    ambiguousFields,
    readFailure: false,
  };
}

