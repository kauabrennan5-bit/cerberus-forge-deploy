// ============================================================================
// Bloco N11 — Discovery Facilitator / Adapter de produção para o N10
// -----------------------------------------------------------------------------
// Adapter explícito entre DiscoveryExecutor (contrato N11) e
// discoverFromSource (N10). Única responsabilidade: converter item/contexto
// do lote em uma chamada delegada ao Source Connector real, preservando
// integralmente candidate_id, external_identity, failure_reason e rationale.
//
// O adapter NÃO:
//   - executa HTTP;
//   - valida SSRF por conta própria (autoridade N2 via discoverFromSource);
//   - resolve identidade (autoridade N10);
//   - cria listing_key nem candidate (autoridade N1);
//   - promove produto, cria affiliate link, chama scheduler/worker,
//     acquisition ou publication.
//
// DIVERGÊNCIA REGISTRADA (Fase 3 — Tarefa 3):
//   A API pública de discoverFromSource NÃO aceita AbortSignal/timeout
//   (nem DiscoverInput do N2). O signal do N11, portanto, NÃO chega ao
//   fetch do N2. O timeout de coordenação do N11 aborta a PROMISE do
//   adapter (o fetch N2 continua até o timeout dele próprio — não se
//   mascara timeout como sucesso: o item termina timed_out/failed).
//   Propagar signal até o fetch exigiria alteração estrutural de N10/N2
//   fora do contrato aprovado — registrado como pendência para a Fase 4.
// ============================================================================
import { discoverFromSource } from "../sourceConnector/sourceConnector";
import {
  DiscoveryExecutor,
  DiscoveryItem,
  DiscoveryItemContext,
} from "./contracts";
import type {
  ConnectorResult,
  ConnectorErrorResult,
} from "../sourceConnector/contracts";

/**
 * Injeção determinística para testes (nunca usada em produção).
 * Permite executar o adapter sem realizar a delegação real ao N2.
 */
export interface DiscoveryExecutorOverrides {
  readonly discoverFn?: typeof discoverFromSource;
}

let fetchExecuted = false;

/**
 * O adapter nunca executa fetch diretamente — o contador é exposto
 * somente para os testes de não-subversão (N11-RT-10). Em produção este
 * módulo não importa fetch nem http.
 */
export function __getFetchExecutedCountForTests(): number {
  return fetchExecuted ? 1 : 0;
}
export function __resetFetchExecutedCountForTests(): void {
  fetchExecuted = false;
}

/**
 * Converte a URL observada em uma chamada ao Source Connector N10.
 * marketplace/dialeto: o dialeto informado no item é repassado ao N10,
 * que é a autoridade de normalização (não se normaliza aqui por conta
 * própria — o adapter não assume o comportamento do N10).
 */
export function createDiscoveryExecutor(
  overrides?: DiscoveryExecutorOverrides,
): DiscoveryExecutor {
  const source = (overrides?.discoverFn ?? discoverFromSource) as
    | typeof discoverFromSource
    | ((
        input: { marketplace: unknown; source_url: string },
      ) => Promise<ConnectorResult | ConnectorErrorResult>);
  return async function discoveryExecutorAdapter(
    item: DiscoveryItem,
    context: DiscoveryItemContext,
  ): Promise<ConnectorResult | ConnectorErrorResult> {
    // Fail-closed: cancelado antes da delegação não executa trabalho.
    if (context.signal.aborted) {
      return {
        ok: false,
        marketplace: null,
        source_url: item.source_url,
        external_identity: {
          status: "UNKNOWN",
          marketplace: null,
          type: "UNKNOWN",
          rationale: "lote cancelado antes da execução",
        },
        discover_result: null,
        candidate_id: null,
        collection_failed: false,
        failure_reason: "ITEM_CANCELLED",
        error: "ITEM_CANCELLED",
      } as ConnectorErrorResult;
    }
    // Sem inventar campos: repassa marketplace/source_url exatamente como
    // recebidos; a normalização é autoridade do N10.
    try {
      return await source({ marketplace: item.marketplace, source_url: item.source_url });
    } catch (error) {
      // Falha operacional explícita — nunca sucesso.
      return {
        ok: false,
        marketplace: null,
        source_url: item.source_url,
        external_identity: {
          status: "UNKNOWN",
          marketplace: null,
          type: "UNKNOWN",
          rationale: "falha operacional do executor",
        },
        discover_result: null,
        candidate_id: null,
        collection_failed: false,
        failure_reason: "EXECUTOR_OPERATIONAL_FAILED",
        error:
          error instanceof Error ? error.message : "EXECUTOR_OPERATIONAL_FAILED",
      } as ConnectorErrorResult;
    }
  };
}
