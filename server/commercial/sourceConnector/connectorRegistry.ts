// ============================================================================
// Bloco N10 — ConnectorRegistry (registro único de Source Connectors)
// -----------------------------------------------------------------------------
// Responsabilidades (e somente estas):
//   1. registrar connectors;
//   2. resolver connector por MarketplaceSource canônico;
//   3. impedir marketplace desconhecido;
//   4. expor somente connectors permitidos;
//   5. manter whitelist centralizada REUTILIZANDO MARKETPLACE_HOSTS do N2
//      (fonte única de hosts — não cria segunda fonte de verdade);
//   6. falhar fechado quando não houver connector para o marketplace.
//
// O N10 NÃO reescreve os connectors do N2 (MercadoLivreConnector /
// ShopeeConnector). Ele apenas os REGISTRA e os EXPÕE por contrato.
// ============================================================================
import {
  MarketplaceSource,
  MarketplaceConnector,
  MARKETPLACE_HOSTS,
} from "../discovery/types";
import { ConnectorRegistryContract } from "./contracts";

export function createConnectorRegistry(): ConnectorRegistryContract {
  const connectors = new Map<MarketplaceSource, MarketplaceConnector>();

  function register(connector: MarketplaceConnector): { ok: boolean; reason?: string } {
    if (!connector || !connector.marketplace) {
      return { ok: false, reason: "connector_invalid" };
    }
    // Somente marketplaces canônicos com whitelist conhecida são permitidos —
    // falha fechada para qualquer connector desconhecido.
    const hosts = (MARKETPLACE_HOSTS as Record<string, ReadonlyArray<string>>)[connector.marketplace];
    if (!hosts) {
      return { ok: false, reason: "connector_marketplace_nao_permitido" };
    }
    connectors.set(connector.marketplace, connector);
    return { ok: true };
  }

  function resolve(marketplace: MarketplaceSource): MarketplaceConnector | null {
    return connectors.get(marketplace) ?? null;
  }

  function listMarketplaces(): ReadonlyArray<MarketplaceSource> {
    return Array.from(connectors.keys());
  }

  function has(marketplace: MarketplaceSource): boolean {
    return connectors.has(marketplace);
  }

  // Whitelist centralizada: a ÚNICA fonte de hosts permitidos é a do N2.
  function getWhitelistHosts(): Readonly<Record<MarketplaceSource, ReadonlyArray<string>>> {
    return {
      ["MERCADOLIVRE" as MarketplaceSource]: MARKETPLACE_HOSTS.MERCADOLIVRE,
      ["SHOPEE" as MarketplaceSource]: MARKETPLACE_HOSTS.SHOPEE,
    } as Record<MarketplaceSource, ReadonlyArray<string>>;
  }

  return { register, resolve, listMarketplaces, has, getWhitelistHosts };
}

// Registry padrão da aplicação (singleton da camada N10). Os connectors N2
// existentes são registrados aqui uma única vez — sem duplicar lógica.
export const sourceConnectorRegistry = createConnectorRegistry();
