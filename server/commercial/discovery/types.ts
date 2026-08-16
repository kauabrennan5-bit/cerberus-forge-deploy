// ============================================================================
// Bloco N2 — Contratos de Descoberta (Marketplace Connectors)
// -----------------------------------------------------------------------------
// N2 é infraestrutura READ-ONLY de ingestão. CANDIDATE != FACT CANÔNICO.
// OBSERVATION != FACT CANÔNICO. Este módulo NÃO publica, NÃO promove,
// NÃO altera produtos canônicos, catálogo, Telegram, job queue ou agentes.
// ============================================================================

// Identidades formais dos marketplaces suportados.
// Não criar um conector genérico que esconda diferenças entre marketplaces.
export const MARKETPLACE_SOURCE = {
  MERCADOLIVRE: "MERCADOLIVRE",
  SHOPEE: "SHOPEE",
} as const;

export type MarketplaceSource = (typeof MARKETPLACE_SOURCE)[keyof typeof MARKETPLACE_SOURCE];

export const MARKETPLACE_SOURCES: ReadonlyArray<MarketplaceSource> = [
  MARKETPLACE_SOURCE.MERCADOLIVRE,
  MARKETPLACE_SOURCE.SHOPEE,
];

export function isMarketplaceSource(value: unknown): value is MarketplaceSource {
  return typeof value === "string" && MARKETPLACE_SOURCES.includes(value as MarketplaceSource);
}

// Métodos de coleta permitidos. "PUBLIC_PAGE" é o único disponível neste
// bloco (sem API oficial: sem credenciais e sem APIs pagas).
export const COLLECTION_METHOD = {
  PUBLIC_PAGE: "PUBLIC_PAGE",
} as const;

export type CollectionMethod = (typeof COLLECTION_METHOD)[keyof typeof COLLECTION_METHOD];

// -----------------------------------------------------------------------------
// RawListing — dado bruto observado em uma página/listagem pública.
// Ausência de dado = UNKNOWN (nunca 0 / false / "sem X" inventados).
// -----------------------------------------------------------------------------
export const UNKNOWN_TOKEN = "UNKNOWN";

export interface RawListingField<T> {
  value: T | null; // null = não observado / não disponível
  unknown: boolean; // true = a fonte não forneceu este dado (UNKNOWN)
  derived?: boolean; // true = valor derivado (ex: título extraído da URL),
  // NUNCA confirmado como dado do marketplace; usar com cautela como evidência
}

export interface RawListing {
  marketplace: MarketplaceSource;
  // URL original solicitada (antes de resolução)
  source_url: string;
  // URL final efetiva (após redirects permitidos na whitelist)
  final_url: string;
  // Identificador estável do anúncio quando extraível da URL/página
  external_listing_id: string | null;
  title: RawListingField<string>;
  price: RawListingField<number>;
  currency: string; // BRL (observado no conteúdo; padrão de mercado BR)
  images: RawListingField<string[]>;
  seller: RawListingField<string>;
  rating: RawListingField<number>;
  review_count: RawListingField<number>;
  availability: RawListingField<string>;
  category: RawListingField<string>;
  // Evidência bruta para auditoria: digest do conteúdo observado (sem o HTML
  // completo, que pode ser grande; o digest garante reprodutibilidade).
  evidence_digest: string; // sha256 do snapshot textual observado
  evidence_note: string; // descrição curta do que foi usado (jsonLd/og/selectors)
  observed_at: string; // ISO 8601
  collection_method: CollectionMethod;
  // Snapshot textual resumido do conteúdo observado (usado para hashing e
  // auditoria posterior). Preserva o dado original em forma auditável.
  content_digest_input: string;
  // HTTP status da página (evidência operacional)
  http_status: number | null;
  // Proveniência da coleta: true = o fetch da página FALHOU (network error,
  // bloqueio, timeout); neste caso, NENHUM campo é observação real — qualquer
  // valor presente foi derivado da URL e deve ser tratado como NÃO confirmado.
  // UNKNOWN continua sendo o estado dos dados não obtidos.
  fetch_failed: boolean;
  // Motivo operacional da falha de coleta, quando fetch_failed = true.
  fetch_error?: string;
}

export function rawField<T>(value: T | null): RawListingField<T> {
  return { value, unknown: value === null };
}

// Marca um campo como derivado (não confirmado pelo marketplace). Usado
// exclusivamente quando a página não pôde ser lida e o valor vem da URL.
export function derivedField<T>(value: T): RawListingField<T> {
  return { value, unknown: false, derived: true };
}

// -----------------------------------------------------------------------------
// CandidateDiscoveryPayload — payload normalizado compatível com o Registry
// N1 (CandidateIntakeInput). Cada campo mantém sua origem/proveniência.
// -----------------------------------------------------------------------------
export interface NormalizedField<T> {
  value: T | null;
  unknown: boolean;
  source: string; // ex: "marketplace_page", "derived", "unknown"
  observed_at: string;
}

export interface CandidateDiscoveryPayload {
  marketplace: MarketplaceSource;
  source_url: string;
  external_listing_id: string;
  merchant: string | null;
  title: NormalizedField<string>;
  price: NormalizedField<number>;
  images: NormalizedField<string[]>;
  seller: NormalizedField<string>;
  rating: NormalizedField<number>;
  review_count: NormalizedField<number>;
  availability: NormalizedField<string>;
  category: NormalizedField<string>;
  observed_at: string;
  collection_method: CollectionMethod;
  evidence_hash: string;
  evidence_note: string;
  raw_evidence: {
    digest: string;
    http_status: number | null;
    final_url: string;
  };
}

// -----------------------------------------------------------------------------
// Resultado de uma operação de descoberta (endpoint /discover)
// -----------------------------------------------------------------------------
export interface DiscoverResultItem {
  outcome: "created" | "identical_duplicate" | "conflict_rejected";
  candidate_id: string | null;
  marketplace: MarketplaceSource;
  source_url: string;
  title: string | null;
  unknown_fields: string[];
}

export interface DiscoverResult {
  ok: boolean;
  marketplace: MarketplaceSource;
  mode: "url" | "search";
  found: number; // quantidade de anúncios lidos/extraídos
  created: number; // candidatos novos criados no N1
  duplicates: number; // replays idempotentes
  conflicts: number; // colisões rejeitadas
  items: DiscoverResultItem[];
  error?: string;
}

// -----------------------------------------------------------------------------
// Contrato do conector
// -----------------------------------------------------------------------------
export interface MarketplaceConnector {
  readonly marketplace: MarketplaceSource;
  // Busca controlada na página pública de resultados do marketplace.
  // limit é truncado no servidor (máx. 5); nunca é crawler.
  search(params: { query: string; limit?: number }): Promise<{
    ok: boolean;
    reason?: string;
    listings: RawListing[];
  }>;
  // Leitura de uma página de anúncio específica.
  fetchListing(url: string): Promise<{
    ok: boolean;
    reason?: string;
    listing: RawListing | null;
  }>;
}

// -----------------------------------------------------------------------------
// Limites de segurança do N2 (aplicados no servidor)
// -----------------------------------------------------------------------------
export const DISCOVERY_LIMITS = {
  // Limite máximo de resultados por chamada de discover/search
  MAX_RESULTS: 5,
  // Timeout de rede por requisição (ms)
  TIMEOUT_MS: 15_000,
  // Retry máximo: 1 tentativa adicional (nunca mais)
  MAX_RETRIES: 1,
  // Janela de circuit breaker (ms)
  CIRCUIT_WINDOW_MS: 60_000,
  // Falhas na janela que disparam o circuit breaker
  CIRCUIT_FAILURE_THRESHOLD: 3,
  // Limite do snapshot textual por página (bytes)
  MAX_CONTENT_SNAPSHOT_BYTES: 8_000,
} as const;

// Whitelists por marketplace (além da whitelist global de hosts do projeto).
export const MARKETPLACE_HOSTS: Record<MarketplaceSource, ReadonlyArray<string>> = {
  [MARKETPLACE_SOURCE.MERCADOLIVRE]: ["mercadolivre.com.br", "mercadolibre.com", "meli.la"],
  [MARKETPLACE_SOURCE.SHOPEE]: ["shopee.com.br", "shopee.com", "shope.ee"],
} as const;
