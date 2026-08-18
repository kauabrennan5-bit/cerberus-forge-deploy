/**
 * ============================================================================
 * BLOCO N11 — DISCOVERY FACILITATOR
 * FASE 1 — CONTRATOS DE DESIGN (arquivo PROVA DE CONTRATO, não-runtime)
 * ----------------------------------------------------------------------------
 * DATA: 18/08/2026
 *
 * Este arquivo define os contratos TypeScript do DiscoveryFacilitator para
 * revisão de arquitetura. É código real e compilável (tsc), mas a CLASSE
 * DiscoveryFacilitator ainda NÃO existe: ela será implementada na Fase 2,
 * somente após autorização explícita.
 *
 * GOVERNANÇA (inalterável):
 *   - N10 continua sendo a autoridade de IDENTIDADE (normalização +
 *     external identity + UNKNOWN + rationale).
 *   - N2 continua sendo a autoridade de EXECUÇÃO/REDE (fetch, SSRF,
 *     whitelist, redirects, timeout de rede, retry de rede, circuit breaker).
 *   - N1 continua sendo a autoridade de CANDIDATE (listing_key,
 *     idempotência canônica, deduplicação).
 *   - N11 NÃO faz fetch HTTP, NÃO resolve URLs, NÃO cria whitelist paralela,
 *     NÃO acessa secrets/APIs de afiliados e NÃO cria candidates.
 *
 * Posição na arquitetura:
 *   ENTRADA/LOTE → N11 (coordenação) → N10 (identidade) → N2 (execução)
 *   → N1 (candidate/idempotência)
 * ============================================================================
 */

import type {
  ConnectorErrorResult,
  ConnectorResult,
  ExternalIdentity,
} from "../sourceConnector/contracts";

/**
 * DiscoveryItem — unidade mínima de discovery.
 * Uma URL é a única unidade suportada inicialmente (N10 mode="url").
 * Search permanece fora do escopo; o campo é opcional e reservado para uma
 * representação neutra FUTURA, nunca implementado nesta fase.
 */
export interface DiscoveryItem {
  readonly marketplace: string; // dialeto conhecido; normalizado pelo N10
  readonly source_url: string; // URL absoluta; validada pelo N10/N2
  /** Campo reservado p/ futura representação neutra (search) — não usar. */
  readonly mode_hint?: never;
}

/**
 * DiscoveryBatch — lote de discovery submetido ao Facilitator.
 */
export interface DiscoveryBatch {
  readonly items: ReadonlyArray<DiscoveryItem>;
  /**
   * Opcional. Quando fornecido, vincula toda a execução a uma trilha de
   * auditoria (ex.: N10_RUNTIME_20260818). Persistido nos logs/métricas.
   */
  readonly proof_run_id?: string;
}

/**
 * DiscoveryRequest — requisição completa ao Facilitator.
 */
export interface DiscoveryRequest {
  readonly batch: DiscoveryBatch;
  /** Configuração de coordenação. Ausente → defaults conservadores. */
  readonly coordination?: DiscoveryCoordination;
  /** Sinal de cancelamento. Padrão do projeto: AbortController. */
  readonly signal?: AbortSignal;
}

/**
 * DiscoveryCoordination — alavancas de coordenação do N11.
 * Valores defaults são CONSERVADORES e correspondentes aos limites já
 * auditados do N2 (TIMEOUT_MS=15s, MAX_RETRIES=1). O timeout de coordenação
 * do N11 NÃO substitui o timeout de rede do N2.
 */
export interface DiscoveryCoordination {
  /** Concorrência máxima de itens em execução simultânea. Default: 2. */
  readonly concurrency_limit?: number;
  /** Timeout de coordenação por item (ms). Default: 30_000 (>= timeout rede N2). */
  readonly item_timeout_ms?: number;
  /**
   * Máximo de RETENTATIVAS DE COORDENAÇÃO por item (tentativas adicionais
   * da coordenação, NÃO retries de rede do N2). Default: 0.
   */
  readonly max_retries?: number;
  /**
   * Backoff entre retentativas de coordenação (ms). Default: 1_000.
   */
  readonly retry_backoff_ms?: number;
}

/**
 * DiscoveryItemStatus — estado final de um item dentro do lote.
 */
export type DiscoveryItemStatus =
  | "created"
  | "duplicate"
  | "conflict"
  | "unknown_identity"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * DiscoveryItemResult — resultado individual de um item.
 * Nunca mascara erro: cada item carrega status + evidência da fonte.
 */
export interface DiscoveryItemResult {
  /** Índice de ordem de entrada (0-based) — preserva a ordem da solicitação. */
  readonly index: number;
  readonly item: DiscoveryItem;
  readonly status: DiscoveryItemStatus;
  /** candidate_id quando a delegação ao N2/N1 produziu registro. */
  readonly candidate_id: string | null;
  /** Identidade externa decidida pelo N10 (inclui UNKNOWN + rationale). */
  readonly external_identity: ExternalIdentity | null;
  /** Tentativas de coordenação executadas (0 = primeira tentativa). */
  readonly attempts: number;
  /** Duração em ms (do início ao fim do item). */
  readonly duration_ms: number | null;
  /** Razão governada quando o item falhou/timing/foi cancelado. */
  readonly failure_reason: string | null;
  /** correlation: vincula o item ao batch_id. */
  readonly batch_id: string;
  /** correlation: proof_run_id do request, se fornecido. */
  readonly proof_run_id: string | null;
}

/**
 * DiscoveryBatchResult — resultado agregado do lote.
 * NÃO mascara erros individuais: summary + per-item results + metrics.
 */
export interface DiscoveryBatchResult {
  readonly batch_id: string;
  readonly status: DiscoveryBatchStatus;
  readonly proof_run_id: string | null;
  /** Ordem de entrada preservada: resultados alinhados aos índices. */
  readonly items: ReadonlyArray<DiscoveryItemResult>;
  readonly metrics: DiscoveryBatchMetrics;
  /** correlation: início/fim da execução. */
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number | null;
}

/**
 * DiscoveryBatchStatus — estado agregado do lote.
 */
export type DiscoveryBatchStatus =
  | "success" // todos os itens com desfecho definitivo (created/duplicate/conflict/unknown)
  | "partial" // ao menos um item failed/timed_out, lote continuou
  | "failed" // nenhum item processado com desfecho (ex.: cancelamento antes do início)
  | "cancelled";

/**
 * DiscoveryBatchMetrics — contadores que respondem às perguntas operacionais
 * sem mascarar os erros individuais.
 */
export interface DiscoveryBatchMetrics {
  readonly received: number; // itens recebidos
  readonly processed: number; // itens que chegaram a um desfecho definitivo
  readonly created: number; // items com candidate criado
  readonly duplicates: number; // duplicates idempotentes (N1)
  readonly conflicts: number; // colisões rejeitadas (N1)
  readonly unknown_identity: number; // itens com identidade UNKNOWN (não promovível)
  readonly failed: number; // itens com falha definitiva (sem retry restante)
  readonly timed_out: number; // itens expirados no timeout de coordenação
  readonly cancelled: number; // itens não iniciados por cancelamento
  readonly retried: number; // itens que sofreram retentativa de coordenação
}

/**
 * FacilitatorItemOutcome — o que o Facilitator produz por item interno.
 * O Facilitator NÃO cria candidates; produz desfecho + referência ao
 * candidate quando o N1 o registra via delegação.
 */
export interface FacilitatorItemOutcome {
  readonly status: DiscoveryItemStatus;
  readonly candidate_id: string | null;
  readonly failure_reason: string | null;
}

/**
 * DiscoveryFacilitatorContract — contrato mínimo da camada de coordenação.
 *
 * - executeBatch: coordena um lote; NUNCA faz fetch/resolve/guards;
 *   delega a execução de cada item a uma função injetada (por padrão,
 *   discoverFromSource do N10 na Fase 2).
 * - A injeção mantém o N11 isolado do N10/N2 e permite testes puros.
 */
export interface DiscoveryFacilitatorContract {
  executeBatch(
    request: DiscoveryRequest,
  ): Promise<DiscoveryBatchResult>;
}

/**
 * DiscoveryExecutor — função injetável de execução por item.
 * O contrato aceita uma interface comum com o retorno do N10
 * (ConnectorResult | ConnectorErrorResult) para que discoverFromSource
 * seja o executor padrão na Fase 2.
 */
export type DiscoveryExecutor = (
  item: DiscoveryItem,
  context: DiscoveryItemContext,
) => Promise<ConnectorResult | ConnectorErrorResult>;

/**
 * DiscoveryItemContext — contexto de execução de um item dentro do lote.
 */
export interface DiscoveryItemContext {
  readonly batch_id: string;
  readonly proof_run_id: string | null;
  readonly attempt: number; // 0 na primeira tentativa
  readonly signal: AbortSignal;
  readonly timeout_ms: number; // timeout de coordenação (não substitui o do N2)
}

/**
 * Limites operacionais (constantes, conservadoras, configuráveis apenas via
 * DiscoveryCoordination — sem configuração global nova).
 *
 * Racional:
 * - MAX_BATCH_ITEMS=20: lote pequeno controlado; acima disso a requisição é
 *   rejeitada com failure_reason "lote_excedido" por item (sem processar).
 * - DEFAULT_CONCURRENCY_LIMIT=2: protege o N2 (circuit breaker 3 falhas/60s).
 * - DEFAULT_ITEM_TIMEOUT_MS=30_000: 2x o timeout de rede do N2 (15s),
 *   garantindo que o timeout do N2 dispare antes (guards de rede do N2
 *   permanecem a autoridade).
 * - MAX_COORDINATION_RETRIES=2: retentativa de coordenação limitada a
 *   erros TRANSIENTES (network/timeout do N2). Erros determinísticos
 *   (SSRF, host inválido, marketplace inválido, identidade, fail-closed)
 *   NUNCA são retentáveis — qualquer retry de condição fail-closed é
 *   proibido por contrato.
 */
export const FACILITATOR_LIMITS = {
  MAX_BATCH_ITEMS: 20,
  DEFAULT_CONCURRENCY_LIMIT: 2,
  DEFAULT_ITEM_TIMEOUT_MS: 30_000,
  MAX_COORDINATION_RETRIES: 2,
  DEFAULT_RETRY_BACKOFF_MS: 1_000,
} as const;

/**
 * Erros de coordenação governados (failure_reason) — sempre determinísticos
 * e SEM retry quando originados de condição fail-closed.
 */
export const FACILITATOR_FAILURE_REASONS = {
  /** Lote vazio rejeitado (não processa; status do batch = failed). */
  BATCH_EMPTY: "batch_empty",
  /** Lote excede MAX_BATCH_ITEMS. */
  BATCH_EXCEEDED: "batch_exceeded",
  /** Item duplicado dentro do mesmo lote (eficiência intra-lote). */
  INTRA_BATCH_DUPLICATE: "intra_batch_duplicate",
  /** Timeout de coordenação expirado (item não concluiu). */
  ITEM_TIMED_OUT: "item_timed_out",
  /** Lote cancelado antes/durante a execução. */
  BATCH_CANCELLED: "batch_cancelled",
  /** Item não iniciado por cancelamento. */
  ITEM_CANCELLED: "item_cancelled",
  /** Retentativas de coordenação esgotadas (após retries TRANSIENTES). */
  RETRIES_EXHAUSTED: "retries_exhausted",
  /** Falha governada propagada do N10/N2 (ex.: connector_ausente). */
  DELEGATION_FAILED: "delegation_failed",
  /** Erro transitente que permitiu retentativa (não é estado final). */
  TRANSIENT_RETRY: "transient_retry",
} as const;
