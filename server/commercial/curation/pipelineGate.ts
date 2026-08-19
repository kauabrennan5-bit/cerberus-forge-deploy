// ============================================================================
// Bloco N13 — Gate de pipeline (integração do filtro de curadoria ao fluxo
// real de candidates).
//
// GOVERNANÇA (contratos):
// - Filter de entrada do pipeline: N13 é invocado DEPOIS que o candidato
//   existe e as evidências foram registradas (funil N1 → N2/N10/N12).
// - Persistência governada: a avaliação SEMPRE é persistida pelo contrato
//   existente (candidate_assessment) com filter_version "n13:curator_v1".
// - Idempotência: replay idêntico devolve a MESMA decisão, o MESMO
//   assessment_id e o MESMO digest, SEM registro duplicado
//   (outcome identical_duplicate do contrato N4).
// - N13 NÃO modifica products, preço/categoria canônicos, affiliate_links,
//   links, job_queue; NÃO publica, NÃO cria link, NÃO dispara N14.
//
// PORTARIA DE SAÍDA (gates do pipeline):
// - verdict "FAIL"        → gate "reject"  → pipeline PARA no N13.
// - verdict "BLOCKED"     → gate "review"  → pipeline PARA no N13.
// - verdict "PASS"        → gate "pass"    → candidato marcado como
//   elegível para avaliação pelo N14 (APENAS elegibilidade; N14 NÃO é
//   executado automaticamente por este módulo).
//
// REGRA DE OURO: PASS ≠ aprovação comercial. PASS = elegível para N14.
// ============================================================================
import {
  mapVerdictToAssessment,
  evaluateCandidateById,
  type CuratorServiceResult,
} from "./service";
import {
  CURATOR_CONTRACT_VERSION,
  CURATOR_PROVENANCE,
} from "./contract";

export type PipelineGateName = "reject" | "review" | "pass";

export type PipelineOutcome =
  | "evaluated"
  | "identical_duplicate";

export interface PipelineGateResult {
  gate: PipelineGateName;
  outcome: PipelineOutcome;
  verdict: "PASS" | "FAIL" | "BLOCKED";
  candidateId: string;
  assessmentId: string;
  digest: string;
  eligibleForN14: boolean;
  contractVersion: string;
  rationale: string;
  /** Rationale por critério estrutural. */
  criteria: ReadonlyArray<{ criterion: string; result: string; rationale: string }>;
  service: CuratorServiceResult;
}

/**
 * runCurationGate — ponto de integração do N13 no pipeline real.
 *
 * - Usa SOMENTE o contrato de persistência existente (service N13).
 * - Determinístico no sentido comercial: mesma entrada → mesmo verdict/
 *   assessment_id/digest/gate (o único metadado dependente de tempo é
 *   evaluatedAt, fora do digest).
 * - Sem efeitos comerciais: nenhuma chamada a products, affiliate,
 *   publication, jobs ou N14.
 */
export async function runCurationGate(
  candidateId: string,
): Promise<PipelineGateResult | { gate: PipelineGateName; error: string }> {
  const serviceResult: CuratorServiceResult = await evaluateCandidateById(candidateId);
  if (!serviceResult.ok || !serviceResult.decision) {
    // Falha de leitura/persistência → pipeline para (fail-closed).
    return {
      gate: "review",
      error: `curadoria_indisponivel:${serviceResult.outcome}`,
    } as PipelineGateResult & { error: string };
  }

  const decision = serviceResult.decision;
  const mapped = mapVerdictToAssessment(decision);
  const assessmentId = `cur-${candidateId.slice(4)}`;

  const gate: PipelineGateName =
    decision.verdict === "FAIL"
      ? "reject"
      : decision.verdict === "BLOCKED"
        ? "review"
        : "pass";

  return {
    gate,
    outcome: serviceResult.outcome === "identical_duplicate" ? "identical_duplicate" : "evaluated",
    verdict: decision.verdict,
    candidateId,
    assessmentId,
    digest: decision.digest,
    eligibleForN14: decision.verdict === "PASS",
    contractVersion: CURATOR_CONTRACT_VERSION,
    rationale: decision.rationale,
    criteria: decision.criteria.map((criterion) => ({
      criterion: criterion.criterion,
      result: criterion.result,
      rationale: criterion.rationale,
    })),
    service: serviceResult,
  };
}

export const PIPELINE_GATE_METADATA = {
  provenance: CURATOR_PROVENANCE,
  filterVersion: mapVerdictToAssessment({
    contractVersion: CURATOR_CONTRACT_VERSION,
    candidateId: "",
    verdict: "PASS",
    confidence: 1,
    criteria: [],
    rationale: "",
    digest: "",
    idempotencyKey: "",
    evaluatedAt: "",
  } as never).filterVersion,
  note: "N13 Fase 3 — gate de pipeline. PASS = elegível para N14; N14 NÃO é executado automaticamente.",
} as const;
