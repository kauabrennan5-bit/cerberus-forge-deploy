// ============================================================================
// Bloco N10 — ExternalIdentity (identidade externa determinística)
// -----------------------------------------------------------------------------
// Extração de identidade do produto no marketplace de origem, específica por
// marketplace e determinística a partir da URL observada.
//
// MERCADO LIVRE: ITEM_ID   → item ID extraído (ML[A-Z][\d]+)
// SHOPEE:        SHOP_ITEM → tupla (shop_id, item_id)
//
// REGRAS ABSOLUTAS (fail-closed):
//   - Nunca inventar identidade. URL ≠ identidade confirmada por heurística.
//   - Título ≠ identidade confirmada.
//   - Se a extração não puder confirmar, o status é UNKNOWN com rationale
//     obrigatório — e UNKNOWN permanece UNKNOWN.
//   - Os padrões aqui são os MESMOS usados pelos connectors N2 (mercadoLivre,
//     shopee) — compartilhados via N2, não inventados aqui.
// ============================================================================
import { MarketplaceSource } from "../discovery/types";
import { ExternalIdentity, EXTERNAL_IDENTITY_TYPE } from "./contracts";

// Item ID do Mercado Livre (mesmo padrão da página de resultados N2).
const ML_ITEM_ID_PATTERN = /ML[A-Z][-]?[\d]+/i;

// Tupla Shopee shopid/itemid (mesmo padrão da página de resultados N2).
const SHOPEE_SHOP_ITEM_PATTERN = /\/(\d{5,})\/(\d{5,})/;

export interface IdentityExtraction {
  readonly identity: ExternalIdentity;
}

function parseSafeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Extrai o item ID do Mercado Livre do caminho da URL.
function mlItemIdOf(url: URL): string | null {
  const match = ML_ITEM_ID_PATTERN.exec(url.pathname);
  if (!match) return null;
  return match[0];
}

// Extrai a tupla (shop_id, item_id) da Shopee do caminho da URL.
function shopeeShopItemOf(url: URL): { shop_id: string; item_id: string } | null {
  const match = SHOPEE_SHOP_ITEM_PATTERN.exec(url.pathname);
  if (!match) return null;
  const [shop_id, item_id] = [match[1], match[2]];
  if (!/^\d+$/.test(shop_id) || !/^\d+$/.test(item_id)) return null;
  return { shop_id, item_id };
}

/**
 * Extrai a identidade externa de uma URL observada, específica por marketplace.
 *
 * - URL válida com ID confirmável → identidade conhecida (ITEM_ID/SHOP_ITEM).
 * - Qualquer falha (URL malformada, ID ausente, marketplace sem extrator
 *   registrado) → status UNKNOWN com rationale explícito.
 */
export function extractExternalIdentity(
  marketplace: MarketplaceSource,
  source_url: string,
): IdentityExtraction {
  if (!source_url || typeof source_url !== "string") {
    return {
      identity: {
        status: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
        marketplace,
        type: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
        rationale: "source_url ausente ou inválida",
      },
    };
  }
  const url = parseSafeUrl(source_url);
  if (!url) {
    return {
      identity: {
        status: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
        marketplace,
        type: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
        rationale: "URL malformada — extração impossível",
      },
    };
  }
  if (marketplace === "MERCADOLIVRE") {
    const item_id = mlItemIdOf(url);
    if (!item_id) {
      return {
        identity: {
          status: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
          marketplace,
          type: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
          rationale: "item ID do Mercado Livre não encontrado na URL",
        },
      };
    }
    return {
      identity: {
        status: EXTERNAL_IDENTITY_TYPE.ITEM_ID,
        marketplace,
        type: EXTERNAL_IDENTITY_TYPE.ITEM_ID,
        value: item_id,
        source: "url",
        raw_source: source_url,
      },
    };
  }
  if (marketplace === "SHOPEE") {
    const tuple = shopeeShopItemOf(url);
    if (!tuple) {
      return {
        identity: {
          status: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
          marketplace,
          type: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
          rationale: "tupla (shop_id, item_id) da Shopee não encontrada na URL",
        },
      };
    }
    return {
      identity: {
        status: EXTERNAL_IDENTITY_TYPE.SHOP_ITEM,
        marketplace,
        type: EXTERNAL_IDENTITY_TYPE.SHOP_ITEM,
        shop_id: tuple.shop_id,
        item_id: tuple.item_id,
        source: "url",
        raw_source: source_url,
      },
    };
  }
  // Marketplace sem extrator registrado → UNKNOWN (fail-closed, sem inferir).
  return {
    identity: {
      status: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
      marketplace,
      type: EXTERNAL_IDENTITY_TYPE.UNKNOWN,
      rationale: `nenhum extrator de identidade registrado para ${String(marketplace)}`,
    },
  };
}
