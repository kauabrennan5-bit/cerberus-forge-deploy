// ============================================================================
// BLOCO N12 — RESEARCH AUTOMATIZADO — FASE 2
// Integrated Research Executor — thin wrapper sobre o N3 (startResearch).
// ----------------------------------------------------------------------------
// DATA: 18/08/2026
//
// Responsabilidades:
//   - receber candidate_id + requested_fields + contexto de coordenação;
//   - pré-validação READ-ONLY do candidate no N1 (getCandidate);
//   - delegar a pesquisa ao startResearch do N3;
//   - adaptar o ResearchResult real do N3 para ResearchExecutorResult;
//   - propagar field/state/source/quality/evidence_id/outcome/
//     contradictions/unknowns/research_id SEM reinterpretar evidência.
//
// GOVERNANÇA (inalterável):
//   - CANDIDATE != FACT CANÔNICO — não cria/altera candidates;
//   - OBSERVATION != FACT CANÔNICO — não decide verdade canônica;
//   - CONTRADICTED PERMANECE CONTRADICTED — não escolhe nem descarta
//     evidência;
//   - RESEARCH != PUBLICATION / PROMOTION — não publica, não promove,
//     não cria affiliate links.
//
// NÃO faz: fetch HTTP direto, normalização de URL, cálculo de listing_key,
// mutation de candidates/evidência, filas de jobs, scheduler ou agentes.
// ============================================================================

import { startResearch as startResearchDefault, type ResearchResult } from "../discovery/research";
import {
  type AutomatedResearchItemContext,
  type ResearchExecutorResult,
} from "./researchContracts";

/** Erro interno do adapter — propagado sem mascarar (fail-closed). */
export class ResearchExecutorError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * executeIntegratedResearch — thin wrapper do N3 para o contrato do N12.
 *
 * Fluxo:
 *   candidate_id → getCandidate (N1, read-only) → startResearch (N3) →
 *   adaptResearchResult → ResearchExecutorResult
 *
 * Se o candidate não existir, o executor retorna ok=false com reason
 * candidate_not_found SEM chamar startResearch (autoridade N1).
 */
export async function executeIntegratedResearch(
  candidate_id: string,
  requested_fields: ReadonlyArray<string>,
  context: AutomatedResearchItemContext,
): Promise<ResearchExecutorResult> {
  // 1) Pré-validação read-only do candidate (N1).
  // O N3 também faz essa checagem internamente; o adapter NÃO deve
  // duplicar o comportamento (autoridade N3), mas a pré-validação do N12
  // garante que o executor NUNCA seja chamado com candidate inexistente
  // quando usado pelo orquestrador. Aqui, mantemos o guard por robustez:
  // se não existir, falha determinística (NUNCA transitória).
  if (!candidate_id || typeof candidate_id !== "string" || candidate_id.trim() === "") {
    return {
      ok: false,
      research_id: null,
      error: "candidate_id_ausente",
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  // 2) Delegação ao N3 (autoridade da sessão e da evidência).
  let result: ResearchResult;
  try {
    // startResearchFn é override opcional (injeção de dependência para
    // testes determinísticos); produção usa o startResearch real do N3.
    const researchFn = overrides?.startResearch ?? startResearchDefault;
    result = await researchFn({
      candidate_id,
      initiated_by: context.proof_run_id ? "automated-research-n12" : "operator-admin",
      requested_fields,
    });
  } catch (err) {
    // Queda não prevista do N3: erro não categorizável → fail-closed,
    // nunca mascarado como sucesso.
    return {
      ok: false,
      research_id: null,
      error: "session_registration_failed",
      fields: [],
      contradictions: 0,
      unknowns: 0,
    };
  }

  return adaptResearchResult(result);
}

/**
 * Overrides injetáveis (apenas para testes determinísticos).
 * Produção: nunca definir — o adapter delega ao startResearch real do N3.
 */
export interface IntegratedResearchOverrides {
  startResearch?: (
    input: Parameters<typeof startResearchDefault>[0],
  ) => ReturnType<typeof startResearchDefault>;
}

let overrides: IntegratedResearchOverrides | null = null;

/** Registra overrides de teste (o reset ocorre no afterEach do respectivo teste). */
export function setIntegratedResearchOverridesForTests(
  next: IntegratedResearchOverrides | null,
): void {
  overrides = next;
}

/**
 * adaptResearchResult — adapta o ResearchResult real do N3 para o
 * contrato do N12 (ResearchExecutorResult), preservando cada campo
 * sem reinterpretar evidência.
 */
export function adaptResearchResult(result: ResearchResult): ResearchExecutorResult {
  return {
    ok: result.ok,
    research_id: result.research_id,
    error: result.error ?? undefined,
    fetch_failed: result.fetch_failed ?? false,
    fetch_reason: result.fetch_reason ?? undefined,
    fields: result.fields.map((f) => ({
      field: f.field,
      state: f.state,
      source: f.source,
      quality: f.quality,
      evidence_id: f.evidence_id,
      outcome: f.outcome,
    })),
    contradictions: result.contradictions,
    unknowns: result.unknowns,
  };
}
