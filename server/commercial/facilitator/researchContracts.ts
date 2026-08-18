// ============================================================================
// Bloco N12 — Research Automatizado — Contratos (Fase 1).
//
// O N12 orquestra pesquisa em lote sobre candidatos existentes no funil N1,
// delegando a coleta/evidência ao N3 (startResearch + candidate_evidence)
// e a coleta de rede ao N2, usando a identidade/marketplace do candidato N1.
//
// Governança (inalterável nesta fase):
//   - CANDIDATE != FACT CANÔNICO — o N12 pesquisa; NUNCA promove.
//   - OBSERVATION != FACT CANÔNICO — evidência persiste como candidata.
//   - RESEARCH != PUBLICATION / PROMOTION — nenhuma rota de promoção é
//     habilitada nem tocada por este bloco.
//   - Falha fechada: erros determinísticos NUNCA são retentáveis.
//   - Não-subversão: o N12 não grava em products, candidates,
//     affiliate_links, publications, job_queue; não habilita agentes;
//     não altera scheduler.
//
// Autoridades preservadas:
//   - N1 (candidatesRepository): existência/leitura do candidato;
//     listing_key imutável — N12 é read-only em candidates.
//   - N3 (research.ts / candidateEvidenceRepository): sessão e evidências;
//     idempotência por field_hash; CONTRADICTED preserva ambas as evidências.
//   - N2 (fetchShared): timeout de rede 15s, retry 1, circuit breaker —
//     o timeout de coordenação do N12 (40s) garante que o N2 dispare antes.
//
// Este arquivo contém SOMENTE contratos (tipos + constantes). O runtime
// (automatedResearch.ts) vem na Fase 2 e DEVE respeitar estes contratos
// sem alteração semântica.
// ============================================================================

import type { FieldState } from "../../repositories/candidateEvidenceRepository";

// ============================================================================
// Identificadores
// ============================================================================

/** Prefixo de identificação de batch do N12. */
export const AUTOMATED_RESEARCH_PREFIX = "rsb" as const;

/** Sufixo correlacional: proof run vinculado ao lote. */
export const AUTOMATED_RESEARCH_PROOF_PREFIX = "N12_PROOF" as const;

// ============================================================================
// Catálogos fechados
// ============================================================================

/** Status definitivo de um item de pesquisa automatizada. */
export const AUTOMATED_RESEARCH_ITEM_STATUSES = [
  "completed", // pesquisa executada com ao menos um campo avaliado
  "duplicate", // pesquisa executada e TODOS os campos foram idempotentes
  "no_fields", // nenhum campo válido restou para pesquisar (entrada vazia)
  "failed", // falha definitiva (sem retry restante ou erro determinístico)
  "timed_out", // item expirado no timeout de coordenação do N12
  "cancelled", // item não iniciado por cancelamento do lote
] as const;
export type AutomatedResearchItemStatus =
  (typeof AUTOMATED_RESEARCH_ITEM_STATUSES)[number];

export function isAutomatedResearchItemStatus(
  value: unknown,
): value is AutomatedResearchItemStatus {
  return (
    typeof value === "string" &&
    (AUTOMATED_RESEARCH_ITEM_STATUSES as readonly string[]).includes(value)
  );
}

/** Status agregado do lote de pesquisa automatizada. */
export const AUTOMATED_RESEARCH_BATCH_STATUSES = [
  "success", // todos os itens com desfecho definitivo (completed/duplicate/no_fields)
  "partial", // ao menos um item failed/timed_out, lote continuou
  "failed", // nenhum item processado com desfecho
  "cancelled", // lote cancelado antes de concluir
] as const;
export type AutomatedResearchBatchStatus =
  (typeof AUTOMATED_RESEARCH_BATCH_STATUSES)[number];

/** Razões governadas de falha/rejeição por item (única fonte de truth). */
export const AUTOMATED_RESEARCH_FAILURE_REASONS = [
  "candidate_inexistente", // candidate_id não existe no N1 (read-only)
  "candidate_id_ausente", // entrada sem candidate_id válido
  "lote_vazio", // request sem candidatos
  "lote_excedido", // batch acima de RESEARCH_LIMITS.MAX_BATCH_CANDIDATES
  "candidate_repetido_intra_batch", // mesmo candidate_id duas vezes no lote
  "campos_invalidos", // requested_fields sem interseção com FIELD_NAMES
  "timeout", // expirou o timeout de coordenação do N12
  "lote_cancelado", // lote cancelado antes do item iniciar
  "erro_transiente_esgotado", // todos os retries transitórios esgotados
  "session_registration_failed", // o N3 não registrou a sessão de pesquisa
  "erro_deterministico", // erro não retentável (fail-closed)
  "generic_error", // erro não categorizável (nunca mascarado como sucesso)
] as const;
export type AutomatedResearchFailureReason =
  (typeof AUTOMATED_RESEARCH_FAILURE_REASONS)[number];

/** Erros transitórios (únicos retentáveis) vs determinísticos (fail-closed). */
export const AUTOMATED_RESEARCH_TRANSIENT_ERRORS: ReadonlyArray<string> = [
  "fetch_failed", // o N3 reportou que a coleta da página falhou
  "session_registration_failed",
] as const;

// ============================================================================
// Limites operacionais
// ============================================================================

/**
 * Limites do Research Automatizado (constantes, conservadoras).
 *
 * Racional:
 * - MAX_BATCH_CANDIDATES=15: menor que o do Facilitator (20) porque cada
 *   item pesquisa 8 campos (8 evidências por item) — lote pequeno controlado.
 * - DEFAULT_CONCURRENCY_LIMIT=2: mesmo rationale do N11; protege o circuit
 *   breaker do N2 (3 falhas/60s).
 * - DEFAULT_ITEM_TIMEOUT_MS=40_000: folga sobre o ciclo de coordenação do
 *   N11 (30s) + timeout de rede do N2 (15s) para um item com retry (15s+0,5s
 *   + re-tentativa). Garante que o timeout de rede do N2 dispare antes do
 *   timeout de coordenação — guards de rede do N2 permanecem a autoridade.
 * - MAX_COORDINATION_RETRIES=2: somente erros TRANSIENTES (transient errors
 *   listados acima). Erros determinísticos (candidate_inexistente,
 *   campos_invalidos, lote_vazio...) NUNCA são retentáveis.
 */
export const RESEARCH_LIMITS = {
  MAX_BATCH_CANDIDATES: 15,
  DEFAULT_CONCURRENCY_LIMIT: 2,
  DEFAULT_ITEM_TIMEOUT_MS: 40_000,
  MAX_COORDINATION_RETRIES: 2,
  RETRY_BACKOFF_MS: [1_000, 3_000] as const, // backoff por tentativa
} as const;

/** Campos pesquisáveis por padrão (espelho dos FIELD_NAMES do N3). */
export const RESEARCH_DEFAULT_FIELDS = [
  "title",
  "price",
  "images",
  "seller",
  "rating",
  "review_count",
  "availability",
  "category",
] as const;

// ============================================================================
// Tipos do request
// ============================================================================

/** Um candidato a pesquisar dentro do lote. */
export interface AutomatedResearchCandidate {
  readonly candidate_id: string;
  /** Campos a pesquisar (subset de RESEARCH_DEFAULT_FIELDS). Vazio → defaults. */
  readonly requested_fields?: ReadonlyArray<string>;
  /** correlation: vincula o candidato ao proof run da prova controlada. */
  readonly proof_run_id?: string | null;
}

/** Coordenação do lote (injeção opcional de comportamento). */
export interface AutomatedResearchCoordination {
  /** Cancelamento do lote inteiro (propagado aos itens em execução). */
  readonly signal?: AbortSignal;
  /** Concorrência máxima de itens em paralelo (default: LIMITS). */
  readonly concurrency?: number;
  /** Timeout de coordenação por item em ms (default: LIMITS). */
  readonly item_timeout_ms?: number;
  /** Retentativas de coordenação (default: LIMITS; transitório apenas). */
  readonly max_retries?: number;
}

/** Request do lote de pesquisa automatizada. */
export interface AutomatedResearchRequest {
  readonly candidates: ReadonlyArray<AutomatedResearchCandidate>;
  readonly coordination?: AutomatedResearchCoordination;
  readonly proof_run_id?: string | null;
}

// ============================================================================
// Tipos de item e resultado
// ============================================================================

/** Resultado por campo avaliado (espelho do N3 ResearchItemResult). */
export interface AutomatedResearchFieldResult {
  readonly field: string;
  readonly state: FieldState | "SESSION" | "FAILED";
  readonly source: string;
  readonly quality: string;
  readonly evidence_id: string | null;
  readonly outcome: "created" | "identical_duplicate" | "rejected";
}

/** Resultado de um item de pesquisa automatizada. */
export interface AutomatedResearchItemResult {
  readonly candidate_id: string;
  readonly research_id: string | null;
  readonly status: AutomatedResearchItemStatus;
  readonly fields: ReadonlyArray<AutomatedResearchFieldResult>;
  readonly contradictions: number;
  readonly unknowns: number;
  readonly attempts: number; // 0 na primeira tentativa
  readonly duration_ms: number | null;
  readonly failure_reason: AutomatedResearchFailureReason | null;
  /** correlation: vincula o item ao batch_id. */
  readonly batch_id: string;
  /** correlation: proof_run_id do request, se fornecido. */
  readonly proof_run_id: string | null;
}

/** Resultado agregado do lote. */
export interface AutomatedResearchBatchResult {
  readonly batch_id: string;
  readonly status: AutomatedResearchBatchStatus;
  readonly proof_run_id: string | null;
  /** Ordem de entrada preservada: resultados alinhados aos índices. */
  readonly items: ReadonlyArray<AutomatedResearchItemResult>;
  readonly metrics: AutomatedResearchMetrics;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number | null;
}

/** Contadores que respondem às perguntas operacionais sem mascarar erros. */
export interface AutomatedResearchMetrics {
  readonly received: number; // candidatos recebidos
  readonly processed: number; // candidatos que chegaram a um desfecho definitivo
  readonly completed: number; // pesquisas concluídas com campos avaliados
  readonly duplicates: number; // pesquisas 100% idempotentes (todos os campos duplicados)
  readonly no_fields: number; // entradas sem campo válido para pesquisar
  readonly failed: number; // falha definitiva (sem retry restante)
  readonly timed_out: number; // itens expirados no timeout de coordenação
  readonly cancelled: number; // itens não iniciados por cancelamento
  readonly retried: number; // itens que sofreram retentativa de coordenação
}

// ============================================================================
// Contrato mínimo da camada de pesquisa automatizada
// ============================================================================

/**
 * AutomatedResearchContract — contrato mínimo da camada de coordenação
 * de pesquisa (análogo ao DiscoveryFacilitatorContract do N11).
 *
 * - executeBatch: coordena um lote de candidatos; NUNCA faz coleta,
 *   normalização ou mutação; delega a execução de cada candidato a uma
 *   função injetável (por padrão, uma thin wrapper sobre startResearch
 *   do N3 na Fase 2).
 * - A injeção mantém o N12 isolado do N3 e permite testes puros em memória.
 */
export interface AutomatedResearchContract {
  executeBatch(
    request: AutomatedResearchRequest,
  ): Promise<AutomatedResearchBatchResult>;
}

/** Função injetável de pesquisa por candidato (interface com o N3). */
export type ResearchExecutor = (
  candidate_id: string,
  requested_fields: ReadonlyArray<string>,
  context: AutomatedResearchItemContext,
) => Promise<ResearchExecutorResult>;

/** Interface comum de retorno da pesquisa por candidato (subset do N3). */
export interface ResearchExecutorResult {
  readonly ok: boolean;
  readonly research_id: string | null;
  readonly error?: string;
  readonly fetch_failed?: boolean;
  readonly fetch_reason?: string;
  readonly fields: ReadonlyArray<{
    readonly field: string;
    readonly state: FieldState | "SESSION" | "FAILED";
    readonly source: string;
    readonly quality: string;
    readonly evidence_id: string | null;
    readonly outcome: "created" | "identical_duplicate" | "rejected";
  }>;
  readonly contradictions: number;
  readonly unknowns: number;
}

/** Contexto de execução de um candidato dentro do lote. */
export interface AutomatedResearchItemContext {
  readonly batch_id: string;
  readonly proof_run_id: string | null;
  readonly attempt: number; // 0 na primeira tentativa
  readonly signal: AbortSignal;
  readonly timeout_ms: number; // timeout de coordenação (não substitui o do N2)
}

// ============================================================================
// Validação de request
// ============================================================================

/** Valida um request de lote antes da execução (fail-closed). */
export function validateAutomatedResearchRequest(
  request: AutomatedResearchRequest,
): { ok: true } | { ok: false; reason: AutomatedResearchFailureReason; index?: number } {
  if (!Array.isArray(request.candidates) || request.candidates.length === 0) {
    return { ok: false, reason: "lote_vazio" };
  }
  if (request.candidates.length > RESEARCH_LIMITS.MAX_BATCH_CANDIDATES) {
    return { ok: false, reason: "lote_excedido" };
  }
  const seen = new Set<string>();
  for (let index = 0; index < request.candidates.length; index += 1) {
    const candidate = request.candidates[index];
    if (!candidate || typeof candidate.candidate_id !== "string" || candidate.candidate_id.trim() === "") {
      return { ok: false, reason: "candidate_id_ausente", index };
    }
    if (seen.has(candidate.candidate_id)) {
      return { ok: false, reason: "candidate_repetido_intra_batch", index };
    }
    seen.add(candidate.candidate_id);
    if (candidate.requested_fields && candidate.requested_fields.length > 0) {
      const valid = candidate.requested_fields.every(
        f => typeof f === "string" && RESEARCH_DEFAULT_FIELDS.includes(f as never),
      );
      if (!valid) {
        return { ok: false, reason: "campos_invalidos", index };
      }
    }
  }
  return { ok: true };
}

/** Interseção de campos: explicitados × defaults (fail-closed se vazio). */
export function resolveFields(
  requested: ReadonlyArray<string> | undefined,
): { ok: true; fields: ReadonlyArray<string> } | { ok: false; reason: AutomatedResearchFailureReason } {
  if (!requested || requested.length === 0) {
    return { ok: true, fields: [...RESEARCH_DEFAULT_FIELDS] };
  }
  const fields = RESEARCH_DEFAULT_FIELDS.filter(f =>
    (requested as readonly string[]).includes(f),
  );
  if (fields.length === 0) {
    return { ok: false, reason: "campos_invalidos" };
  }
  return { ok: true, fields };
}
