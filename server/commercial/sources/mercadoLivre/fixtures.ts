/*
 * INFRA-02 FIXTURES — MOCK / FIXTURE / NOT PRODUCTION.
 * Nenhuma constante deste arquivo representa resposta real nem deve ser usada
 * para declarar evidência de produção.
 */

export const FIXTURE_ITEM_ID = "MLB1456580521" as const;

export const FIX_01_COMPLETE_ITEM = {
  id: FIXTURE_ITEM_ID,
  site_id: "MLB",
  title: "MOCK item completo — NOT PRODUCTION",
  seller_id: 123456789,
  category_id: "MLB1234",
  price: 71,
  currency_id: "BRL",
  initial_quantity: 10,
  available_quantity: 7,
  date_created: "2026-08-19T00:00:00.000Z",
  last_updated: "2026-08-19T01:00:00.000Z",
} as const;

export const FIX_02_OPTIONAL_FIELDS_ABSENT = {
  id: FIXTURE_ITEM_ID,
  site_id: "MLB",
  title: "MOCK item parcial — NOT PRODUCTION",
} as const;

export const FIX_03_REFERENCE_QUANTITY_ITEM = {
  ...FIX_01_COMPLETE_ITEM,
  available_quantity: 50,
} as const;

export const FIX_09_INVALID_JSON = "MOCK invalid JSON — NOT PRODUCTION" as const;

export const FIX_10_UNEXPECTED_SCHEMA = { data: { item: FIX_01_COMPLETE_ITEM } } as const;

export const FIX_11_EXTRA_FIELDS = {
  ...FIX_01_COMPLETE_ITEM,
  unsupported_extra: "MOCK extra field — NOT PRODUCTION",
  nested_extra: { ignored: true },
} as const;

export const FIX_12_PROPERTY_ORDER_A = {
  id: FIXTURE_ITEM_ID,
  price: 71,
  title: "MOCK order — NOT PRODUCTION",
  currency_id: "BRL",
} as const;

export const FIX_13_PROPERTY_ORDER_B = {
  currency_id: "BRL",
  title: "MOCK order — NOT PRODUCTION",
  price: 71,
  id: FIXTURE_ITEM_ID,
} as const;

export const FIX_14_VALID_PRICE = {
  id: FIXTURE_ITEM_ID,
  price: 71,
  currency_id: "BRL",
} as const;

export const FIX_15_PRICE_ABSENT = {
  id: FIXTURE_ITEM_ID,
  title: "MOCK sem preço — NOT PRODUCTION",
} as const;

export function verboseFixture(body: unknown, code = 200): Array<{ code: number; body: unknown }> {
  return [{ code, body }];
}

export const HTTP_FIXTURES = {
  unauthorized: { status: 401, body: { error: "MOCK 401 — NOT PRODUCTION" } },
  forbidden: { status: 403, body: { error: "MOCK 403 — NOT PRODUCTION" } },
  notFound: { status: 404, body: { error: "MOCK 404 — NOT PRODUCTION" } },
  rateLimited: { status: 429, body: { error: "MOCK 429 — NOT PRODUCTION" } },
  serverError: { status: 500, body: { error: "MOCK 500 — NOT PRODUCTION" } },
} as const;
