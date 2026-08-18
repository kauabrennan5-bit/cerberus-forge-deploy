// ============================================================================
// Bloco N11 — Discovery Facilitator / Porta de execução de lote
// -----------------------------------------------------------------------------
// Entrypoint interno controlado para executar DiscoveryBatch:
//   - recebe DiscoveryRequest;
//   - instancia o DiscoveryExecutor real (adapter N11 -> N10);
//   - chama DiscoveryFacilitator.executeBatch();
//   - retorna DiscoveryBatchResult.
//
// NÃO há integração com scheduler/worker nesta fase (pendência Fase 4).
// O entrypoint não faz fetch, não valida SSRF e não cria candidates —
// todas essas responsabilidades permanecem no N2/N10/N1.
// ============================================================================
import {
  DiscoveryRequest,
  DiscoveryBatchResult,
  DiscoveryExecutor,
  FACILITATOR_LIMITS,
} from "./contracts";
import { DiscoveryFacilitator } from "./facilitator";
import { createDiscoveryExecutor } from "./discoveryExecutor";

/**
 * Injeção determinística para testes (nunca usada em produção).
 */
export interface RunDiscoveryBatchOverrides {
  readonly executorFn?: DiscoveryExecutor;
  readonly facilitator?: {
    executeBatch(request: DiscoveryRequest): Promise<DiscoveryBatchResult>;
  };
}

/**
 * Executa um lote de discovery controlado pelo Facilitator.
 *
 * Fluxo (autoridades preservadas):
 *   DiscoveryRequest -> Facilitator (coordenação) -> Executor adapter
 *   -> discoverFromSource (N10) -> executeDiscover (N2) -> N1 candidate
 *
 * A validação de contrato acontece dentro do Facilitator (BATCH_EMPTY,
 * BATCH_EXCEEDED, coordination inválida) — o entrypoint não re-implementa
 * nem mascara essas rejeições.
 */
export async function runDiscoveryBatch(
  request: DiscoveryRequest,
  overrides?: RunDiscoveryBatchOverrides,
): Promise<DiscoveryBatchResult> {
  const executor = overrides?.executorFn ?? createDiscoveryExecutor();
  const facilitator = overrides?.facilitator ?? new DiscoveryFacilitator(executor);
  return await facilitator.executeBatch(request);
}

/**
 * Limite público do lote (para a porta /discover-batch validar contagem
 * de argumentos antes de construir o request).
 */
export const BATCH_MAX_ITEMS = FACILITATOR_LIMITS.MAX_BATCH_ITEMS;
