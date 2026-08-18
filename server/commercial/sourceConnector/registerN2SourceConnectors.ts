// ============================================================================
// Bloco N10 — Registro dos Source Connectors N2 no registry único
// ---------------------------------------------------------------------------
// O registry do N10 (sourceConnectorRegistry) é a ÚNICA porta de entrada do
// Source Connector em runtime. Ele nasce VAZIO — os connectors do N2
// (MercadoLivreConnector/ShopeeConnector) precisam ser registrados uma única
// vez no boot do servidor, sem reescrever a lógica de coleta do N2.
//
// Este módulo é INTENCIONAMENTE mínimo: apenas registra os connectors
// existentes do N2 no registry do N10. É idempotente (double register
// retorna ok=false sem efeitos colaterais — Map.set já existente mantém o
// mesmo connector) e não altera products, agents, scheduler, job queue,
// Telegram, lifecycle ou qualquer outra autoridade.
//
// Chamado UMA VEZ no boot (server.ts). Testes unitários do N10 já registram
// manualmente via createConnectorRegistry (isolamento de teste) e NÃO devem
// depender deste módulo.
// ============================================================================
import {
  mercadoLivreConnector,
} from "../discovery/connectors/mercadoLivre";
import { shopeeConnector } from "../discovery/connectors/shopee";
import { sourceConnectorRegistry } from "./connectorRegistry";

let registered = false;

/**
 * Registra os Source Connectors N2 no registry único do N10.
 * Idempotente: chamadas adicionais não alteram o estado (registrados uma vez).
 * Retorna true se o registro foi concluído (primeira ou repetição segura).
 */
export function registerN2SourceConnectors(): boolean {
  if (registered) return true;
  const ml = sourceConnectorRegistry.register(mercadoLivreConnector);
  const sh = sourceConnectorRegistry.register(shopeeConnector);
  if (!ml.ok || !sh.ok) {
    // Falha fechada: sem connectors registrados, o discovery por URL não
    // opera (connector_ausente / marketplace_desconhecido) — nunca opera
    // com registry parcial.
    return false;
  }
  registered = true;
  return true;
}

/** Somente para testes — permite resetar o estado idempotente. */
export function __resetRegistrationStateForTests(): void {
  registered = false;
}
