// ============================================================================
// Bloco N10 — Source Connector Layer (Contratos versionados)
// -----------------------------------------------------------------------------
// N10 é uma camada aditiva de facilitação do Discovery. N10 NÃO é a autoridade
// de Discovery (o N2 continua sendo), NÃO cria candidates (o N1 continua
// sendo), NÃO executa acquisition (N8/N6 continuam sendo) e NÃO publica.
//
// MEMORY != AUTHORITY
// OBSERVATION != FACT CANÔNICO
// CANDIDATE != FACT CANÔNICO
// Discovery encontra produto; Acquisition obtém link de afiliado.
// RawListing/Observation != Canonical Product.
// ============================================================================
import {
  MarketplaceSource,
  MarketplaceConnector,
  RawListing,
  DiscoverResult,
  DiscoverResultItem,
} from "../discovery/types";

// Versão do contrato da camada de Source Connectors (N10).
export const SOURCE_CONNECTOR_CONTRACT_VERSION = "n10-source-connector-v1" as const;

// =============================================================================
// ExternalIdentity — contrato estruturado da identidade externa do produto
// no marketplace de origem. Específico por marketplace e determinístico.
// -----------------------------------------------------------------------------
// Regras obrigatórias:
//   - Nunca inventar identidade: sem valor confirmado → status UNKNOWN.
//   - URL ≠ identidade confirmada (heurística sozinha não confirma).
//   - Título ≠ identidade confirmada.
//   - UNKNOWN permanece UNKNOWN — jamais promovido para confirmado.
// =============================================================================
export const EXTERNAL_IDENTITY_TYPE = {
  // Mercado Livre: item ID (ex: ML[A-Z][\d]+)
  ITEM_ID: "ITEM_ID",
  // Shopee: tupla (shop_id, item_id)
  SHOP_ITEM: "SHOP_ITEM",
  // Nenhuma identidade pôde ser extraída com confiança
  UNKNOWN: "UNKNOWN",
} as const;
export type ExternalIdentityType = (typeof EXTERNAL_IDENTITY_TYPE)[keyof typeof EXTERNAL_IDENTITY_TYPE];

export type ExternalIdentity =
  | {
      readonly status: Extract<ExternalIdentityType, "ITEM_ID">;
      readonly marketplace: MarketplaceSource;
      readonly type: Extract<ExternalIdentityType, "ITEM_ID">;
      readonly value: string;
      readonly source: "url" | "page";
      readonly raw_source: string; // URL de onde o valor foi extraído
    }
  | {
      readonly status: Extract<ExternalIdentityType, "SHOP_ITEM">;
      readonly marketplace: MarketplaceSource;
      readonly type: Extract<ExternalIdentityType, "SHOP_ITEM">;
      readonly shop_id: string;
      readonly item_id: string;
      readonly source: "url" | "page";
      readonly raw_source: string;
    }
  | {
      readonly status: Extract<ExternalIdentityType, "UNKNOWN">;
      // Marketplace NULO quando a normalização nem concluiu (entrada inválida /
      // marketplace desconhecido) — sem inventar um marketplace específico.
      readonly marketplace: MarketplaceSource | null;
      readonly type: Extract<ExternalIdentityType, "UNKNOWN">;
      readonly rationale: string; // motivo pelo qual a identidade não foi extraída
    };

export function isExternalIdentityKnown(identity: ExternalIdentity): boolean {
  return identity.status !== "UNKNOWN";
}

// =============================================================================
// SourceConnectorInput — entrada padronizada do Source Connector N10
// -----------------------------------------------------------------------------
// O N10 aceita marketplace em QUALQUER dialeto conhecido (snake, human,
// UPPER) e o traduz para o MarketplaceSource canônico exigido pelo N2.
// Valores de marketplace desconhecidos falham fechado.
// =============================================================================
export interface SourceConnectorInput {
  readonly marketplace: string; // qualquer dialeto conhecido; normalizado pelo N10
  readonly source_url: string;
}

// =============================================================================
// ConnectorResult — resultado de uma chamada de discovery via N10
// -----------------------------------------------------------------------------
// O N10 DELEGA o discovery ao N2 (executeDiscover) e PRESERVA:
//   - candidate_id (N1 é a única autoridade de candidates)
//   - collectionFailed (falha de coleta identificável, nunca mascarada)
//   - provenance (evidenceDigest/rawEvidence propagados)
//   - external_identity (quando disponível)
// O N10 NÃO cria candidates, NÃO cria affiliate URLs, NÃO grava em products.
// =============================================================================
export interface ConnectorResult {
  readonly ok: boolean;
  readonly marketplace: MarketplaceSource; // sempre canônico UPPER
  readonly source_url: string;
  readonly external_identity: ExternalIdentity;
  // Delegação ao N2 (autoridade de discovery):
  readonly discover_result: DiscoverResult | null; // null quando a delegação não ocorreu
  readonly candidate_id: string | null;
  readonly collection_failed: boolean;
  readonly failure_reason: string | null; // reason governado, nunca mascarado
  readonly error: string | null;
}

// Resultado de uma operação governada que não pôde delegar ao discovery
// (ex.: marketplace desconhecido, URL inválida) — falha fechada sem
// inventar discover_result.
export interface ConnectorErrorResult {
  readonly ok: false;
  readonly marketplace: MarketplaceSource | null; // null se nem a normalização concluiu
  readonly source_url: string;
  readonly external_identity: ExternalIdentity;
  readonly discover_result: null;
  readonly candidate_id: null;
  readonly collection_failed: false;
  readonly failure_reason: string;
  readonly error: string;
}

// =============================================================================
// ConnectorRegistryContract — contrato do registro de connectors
// -----------------------------------------------------------------------------
// Responsabilidades únicas do registry:
//   1. registrar connectors (ML/Shopee existentes do N2, sem reescrevê-los);
//   2. resolver connector por MarketplaceSource canônico;
//   3. impedir marketplace desconhecido (falha fechada);
//   4. expor somente connectors permitidos;
//   5. manter whitelist centralizada REUTILIZANDO MARKETPLACE_HOSTS do N2
//      (fonte única — sem segunda fonte de verdade);
//   6. falhar fechado quando não houver connector para o marketplace.
// =============================================================================
export interface ConnectorRegistryContract {
  register(connector: MarketplaceConnector): { ok: boolean; reason?: string };
  resolve(marketplace: MarketplaceSource): MarketplaceConnector | null;
  listMarketplaces(): ReadonlyArray<MarketplaceSource>;
  has(marketplace: MarketplaceSource): boolean;
  getWhitelistHosts(): Readonly<Record<MarketplaceSource, ReadonlyArray<string>>>;
}

// Reexporta contratos do N2 que o N10 utiliza sem alteração.
export type { MarketplaceSource, MarketplaceConnector, RawListing, DiscoverResult, DiscoverResultItem };
