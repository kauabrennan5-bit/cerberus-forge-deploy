import type {
  ShopeeClientError,
  ShopeeProductLookupResult,
} from "../../affiliate/shopeeClientContracts";

/** FIXTURE ONLY — NOT PRODUCTION — nenhum valor abaixo é credencial real. */
export const SHOPEE_FIXTURE_ITEM_ID = "23794344926";
export const SHOPEE_FIXTURE_SHOP_ID = "715084914";
export const SHOPEE_FIXTURE_SOURCE_URL = `https://shopee.com.br/Produto-i.${SHOPEE_FIXTURE_SHOP_ID}.${SHOPEE_FIXTURE_ITEM_ID}`;

export function officialShopeeOfferBody(
  nodes: ReadonlyArray<Record<string, unknown>> = [
    {
      itemId: SHOPEE_FIXTURE_ITEM_ID,
      shopId: SHOPEE_FIXTURE_SHOP_ID,
      productName: "Produto Shopee Fixture",
      productLink: SHOPEE_FIXTURE_SOURCE_URL,
      offerLink: "https://s.shopee.com.br/fixture-offer-link",
    },
  ],
): Record<string, unknown> {
  return {
    data: {
      productOfferV2: { nodes },
    },
  };
}

export function foundLookup(
  overrides: Partial<Omit<ShopeeProductLookupResult, "status">> = {},
): ShopeeProductLookupResult & { status: "found" } {
  return {
    status: "found",
    shopId: SHOPEE_FIXTURE_SHOP_ID,
    itemId: SHOPEE_FIXTURE_ITEM_ID,
    name: "Produto Shopee Fixture",
    priceMinorUnits: 9900,
    productLink: SHOPEE_FIXTURE_SOURCE_URL,
    httpStatus: 200,
    raw: officialShopeeOfferBody(),
    error: null,
    ...overrides,
  };
}

export function notFoundLookup(
  httpStatus = 200,
): ShopeeProductLookupResult & { status: "not_found" } {
  return {
    status: "not_found",
    shopId: null,
    itemId: null,
    name: null,
    priceMinorUnits: null,
    productLink: null,
    httpStatus,
    raw: officialShopeeOfferBody([]),
    error: null,
  };
}

export function errorLookup(
  error: ShopeeClientError,
): ShopeeProductLookupResult & { status: "error" } {
  return {
    status: "error",
    shopId: null,
    itemId: null,
    name: null,
    priceMinorUnits: null,
    productLink: null,
    httpStatus: error.httpStatus,
    raw: null,
    error,
  };
}
