// ============================================================================
// Bloco N13 — Filtro / Curadoria Cerberus — CONTRATO v1
//
// PRINCÍPIO CENTRAL: CANDIDATE != FACT CANÔNICO.
// O N13 NÃO transforma candidato em produto. O N13 apenas avalia se o
// candidato possui condições suficientes para continuar no pipeline.
//
// DETERMINISMO: a mesma entrada (candidate + evidências + versão do
// contrato) SEMPRE produz a mesma decisão. Sem horário na decisão,
// sem random, sem chamadas externas, sem heurísticas não documentadas.
//
// FAIL-CLOSED: dúvida, ausência ou inconsistência → BLOCKED (ou FAIL).
// Nunca PASS por fallback. Nunca valores estimados. Nunca inventar dados.
//
// ESTADOS DA VERDADE (verdict):
//   PASS    = evidências suficientes para TODOS os critérios avaliados.
//   FAIL    = evidência suficiente de que o candidato NÃO atende.
//   BLOCKED = informação insuficiente, contraditória ou inválida.
// Não existe estado intermediário que permita interpretar dúvida como
// aprovação. Somente PASS permite prosseguir às fases seguintes.
// ============================================================================

/** Versão do contrato de curadoria — muda quando critérios/decisões mudam. */
export const CURATOR_CONTRACT_VERSION = "curator_v1" as const;
export type CuratorContractVersion = typeof CURATOR_CONTRACT_VERSION;

/** Verdade da avaliação de curadoria (não é classificação comercial). */
export const CURATOR_VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const;
export type CuratorVerdict = (typeof CURATOR_VERDICTS)[number];

export function isValidVerdict(value: unknown): value is CuratorVerdict {
  return typeof value === "string" && (CURATOR_VERDICTS as ReadonlyArray<string>).includes(value);
}

/**
 * Identificador estável de um critério estrutural avaliado.
 * Prefixo c- para separar de outros namespaces do sistema.
 */
export const CURATOR_CRITERIA = [
  "c_candidate_identity_present",
  "c_marketplace_recognized",
  "c_url_valid",
  "c_evidence_present",
  "c_evidence_coherent",
  "c_provenance_valid",
  "c_entry_state_valid",
  "c_identity_fields_complete",
] as const;
export type CuratorCriterion = (typeof CURATOR_CRITERIA)[number];

export function isValidCriterion(value: unknown): value is CuratorCriterion {
  return typeof value === "string" && (CURATOR_CRITERIA as ReadonlyArray<string>).includes(value);
}

/**
 * Resultado de um critério individual.
 *   checked  = critério avaliado e atendido.
 *   failed   = critério avaliado e NÃO atendido (contribui para FAIL).
 *   blocked  = critério avaliado e sem informação para decidir (contribui
 *              para BLOCKED).
 * Nota: "checked=false && blocked=false" é impossível — toda avaliação
 * termina em checked, failed ou blocked.
 */
export type CriterionResult = "checked" | "failed" | "blocked";

export interface CriterionEvaluation {
  criterion: CuratorCriterion;
  result: CriterionResult;
  /** Mensagem determinística e documentada do motivo. */
  rationale: string;
}

/**
 * Avaliação de curadoria Cerberus (contrato v1).
 *
 * - verdict: PASS | FAIL | BLOCKED (estado final, sem ambiguidade).
 * - confidence: proporção de critérios com decisão efetiva (checked|failed)
 *   sobre o total; usado APENAS para auditoria — NÃO altera o verdict.
 * - reason (verdade global): primeiro failed → FAIL; qualquer blocked →
 *   BLOCKED; caso contrário → PASS. Regra aplicada sempre nesta ordem
 *   para garantir determinismo.
 * - evaluatedAt: NÃO participa da decisão (metadado de auditoria).
 */
export interface CuratorDecision {
  contractVersion: CuratorContractVersion;
  candidateId: string;
  verdict: CuratorVerdict;
  confidence: number;
  criteria: CriterionEvaluation[];
  rationale: string;
  /** Digest determinístico (mesmo input → mesmo digest). */
  digest: string;
  /** Idempotency key derivada do digest (mesma avaliação não duplica). */
  idempotencyKey: string;
  evaluatedAt: string;
}

export interface CuratorDecisionInput {
  candidateId: string;
  marketplace: string | null;
  sourceUrl: string | null;
  externalListingId: string | null;
  status: string | null;
  funnelStage: string | null;
  provenance: string | null;
  evidence: CuratorEvidenceInput[];
}

export interface CuratorEvidenceInput {
  evidenceId: string;
  fieldName: string | null;
  fieldState: string | null;
  isContradicted: boolean;
  kind: string | null;
}

export const CURATOR_PROVENANCE = "n13:admin:manual" as const;
