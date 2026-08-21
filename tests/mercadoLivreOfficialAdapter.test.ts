import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMercadoLivreOfficialAdapter,
  mercadoLivreResponseDigest,
} from "../server/commercial/sources/mercadoLivre/adapter";
import {
  FIX_01_COMPLETE_ITEM,
  FIX_02_OPTIONAL_FIELDS_ABSENT,
  FIX_03_REFERENCE_QUANTITY_ITEM,
  FIX_10_UNEXPECTED_SCHEMA,
  FIX_11_EXTRA_FIELDS,
  FIX_12_PROPERTY_ORDER_A,
  FIX_13_PROPERTY_ORDER_B,
  FIX_14_VALID_PRICE,
  FIX_15_PRICE_ABSENT,
  FIXTURE_ITEM_ID,
  verboseFixture,
} from "../server/commercial/sources/mercadoLivre/fixtures";
import type {
  MercadoLivreHttpTransport,
  MercadoLivreHttpTransportInit,
} from "../server/commercial/sources/mercadoLivre/contracts";

const SECRET = "fixture-access-token-not-production";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function invalidJsonResponse(status = 200): Response {
  return new Response("MOCK invalid JSON — NOT PRODUCTION", {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapterFor(transport: MercadoLivreHttpTransport, extra: Partial<{
  accessToken: string;
  timeoutMs: number;
  clock: () => number;
}> = {}) {
  return createMercadoLivreOfficialAdapter({
    accessToken: extra.accessToken ?? SECRET,
    timeoutMs: extra.timeoutMs ?? 100,
    clock: extra.clock ?? (() => Date.parse("2026-08-19T22:00:00.000Z")),
    transport,
  });
}

function captureTransport(response: Response | (() => Promise<Response>)): {
  transport: MercadoLivreHttpTransport;
  calls: Array<{ url: string; init: MercadoLivreHttpTransportInit }>;
} {
  const calls: Array<{ url: string; init: MercadoLivreHttpTransportInit }> = [];
  return {
    calls,
    transport: async (url, init) => {
      calls.push({ url, init });
      return typeof response === "function" ? response() : response;
    },
  };
}

test("A/D/P/R/S/T/Y/AA/AB — ITEM_ID válido, HTTP 200, normalização e provenance", async () => {
  const captured = captureTransport(jsonResponse(verboseFixture(FIX_01_COMPLETE_ITEM)));
  const result = await adapterFor(captured.transport).lookup({
    itemId: "MLB-1456580521",
    sourceUrl: "https://produto.mercadolivre.com.br/MLB-1456580521",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(captured.calls.length, 1);
  assert.equal(new URL(captured.calls[0].url).pathname, "/items");
  assert.equal(new URL(captured.calls[0].url).searchParams.get("ids"), FIXTURE_ITEM_ID);
  assert.match(new URL(captured.calls[0].url).searchParams.get("attributes") ?? "", /price/);
  assert.equal(captured.calls[0].init.method, "GET");
  assert.equal(captured.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(result.observation.kind, "REAL_API_OBSERVATION");
  assert.equal(result.observation.item.item_id, FIXTURE_ITEM_ID);
  assert.equal(result.observation.item.price, 71);
  assert.equal(result.observation.item.currency_id, "BRL");
  assert.equal(result.observation.item.seller_id, "123456789");
  assert.equal(result.observation.item.category_id, "MLB1234");
  assert.equal(result.observation.provenance.source_type, "api");
  assert.equal(result.observation.provenance.collection_method, "API");
  assert.equal(result.observation.provenance.external_listing_id, FIXTURE_ITEM_ID);
  assert.equal(result.observation.provenance.http_status, 200);
  assert.equal(result.observation.provenance.field_state, "KNOWN");
  assert.match(result.observation.provenance.observed_at, /Z$/);
  assert.ok(result.observation.provenance.response_digest?.startsWith("sha256:"));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("B/C — ITEM_ID inválido falha fechado e não realiza request", async () => {
  let calls = 0;
  const adapter = adapterFor(async () => {
    calls += 1;
    return jsonResponse(verboseFixture(FIX_01_COMPLETE_ITEM));
  });
  const result = await adapter.lookup({ itemId: "not-an-item" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "INVALID_ITEM_ID");
  assert.equal(result.provenance.field_state, "COLLECTION_FAILED");
  assert.equal(calls, 0);
});

test("AUTH_REQUIRED — token ausente não realiza request", async () => {
  let calls = 0;
  const adapter = adapterFor(async () => {
    calls += 1;
    return jsonResponse(verboseFixture(FIX_01_COMPLETE_ITEM));
  }, { accessToken: "" });
  const result = await adapter.lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "AUTH_REQUIRED");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

for (const [label, status, kind] of [
  ["E", 401, "AUTH_ERROR"],
  ["F", 403, "FORBIDDEN"],
  ["G", 404, "NOT_FOUND"],
  ["H", 429, "RATE_LIMITED"],
  ["I", 500, "HTTP_ERROR"],
] as const) {
  test(`${label} — HTTP ${status} é fail-closed`, async () => {
    const result = await adapterFor(async () => jsonResponse({ error: `MOCK ${status} — NOT PRODUCTION` }, status))
      .lookup({ itemId: FIXTURE_ITEM_ID });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, kind);
    assert.equal(result.error.httpStatus, status);
    assert.equal(result.provenance.http_status, status);
    assert.equal(result.provenance.field_state, "COLLECTION_FAILED");
  });
}

test("J — timeout é classificado como TIMEOUT", async () => {
  const result = await adapterFor(async (_url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init.signal.aborted) throw new Error("aborted");
    return jsonResponse(verboseFixture(FIX_01_COMPLETE_ITEM));
  }, { timeoutMs: 1 }).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "TIMEOUT");
});

test("K — falha de conexão é NETWORK_ERROR", async () => {
  const result = await adapterFor(async () => {
    throw new Error("MOCK connection failure — NOT PRODUCTION");
  }).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "NETWORK_ERROR");
});

test("L — JSON inválido é INVALID_JSON", async () => {
  const result = await adapterFor(async () => invalidJsonResponse()).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "INVALID_JSON");
  assert.equal(result.error.httpStatus, 200);
});

test("M — schema inválido é INVALID_SCHEMA", async () => {
  const result = await adapterFor(async () => jsonResponse(FIX_10_UNEXPECTED_SCHEMA)).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "INVALID_SCHEMA");
});

test("N/Q/AD — campos opcionais ausentes permanecem UNKNOWN", async () => {
  const result = await adapterFor(async () => jsonResponse(verboseFixture(FIX_02_OPTIONAL_FIELDS_ABSENT)))
    .lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observation.item.price, null);
  assert.equal(result.observation.item.currency_id, null);
  assert.equal(result.observation.provenance.field_states.price, "UNKNOWN");
  assert.equal(result.observation.provenance.field_states.seller_name, "UNKNOWN");
  assert.equal(result.observation.provenance.field_states.category_name, "UNKNOWN");
});

test("O — campos extras são ignorados e não viram fatos", async () => {
  const result = await adapterFor(async () => jsonResponse(verboseFixture(FIX_11_EXTRA_FIELDS)))
    .lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.prototype.hasOwnProperty.call(result.observation.item, "unsupported_extra"), false);
});

test("T — available_quantity mantém semântica REFERENCE_OR_RANGE", async () => {
  const result = await adapterFor(async () => jsonResponse(verboseFixture(FIX_03_REFERENCE_QUANTITY_ITEM)))
    .lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observation.item.available_quantity_observed, 50);
  assert.equal(result.observation.item.availability_semantics, "REFERENCE_OR_RANGE");
});

test("U/V/W — response_digest é determinístico, muda com conteúdo e não inclui secrets", () => {
  const first = mercadoLivreResponseDigest(FIX_12_PROPERTY_ORDER_A);
  const sameContentDifferentOrder = mercadoLivreResponseDigest(FIX_13_PROPERTY_ORDER_B);
  const changed = mercadoLivreResponseDigest({ ...FIX_12_PROPERTY_ORDER_A, price: 72 });
  assert.equal(first, sameContentDifferentOrder);
  assert.notEqual(first, changed);
  assert.equal(first.includes(SECRET), false);
  assert.equal(mercadoLivreResponseDigest({ ...FIX_14_VALID_PRICE, access_token: SECRET }).includes(SECRET), false);
});

test("X — credenciais não aparecem em erro, output ou provenance", async () => {
  const result = await adapterFor(async () => jsonResponse({ error: "MOCK 403 — NOT PRODUCTION" }, 403)).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.provenance.response_digest, null);
});

test("Z — external_listing_id só é confirmado quando o body retorna o mesmo ITEM_ID", async () => {
  const result = await adapterFor(async () => jsonResponse(verboseFixture({ ...FIX_01_COMPLETE_ITEM, id: "MLB-999999999" })))
    .lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, "IDENTITY_MISMATCH");
  assert.equal(result.provenance.external_listing_id, null);
});

test("AE — o adaptador não inventa CONTRADICTED sem evidência conflitante", async () => {
  const result = await adapterFor(async () => jsonResponse(verboseFixture(FIX_15_PRICE_ABSENT)))
    .lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.observation.provenance.field_states.price, "CONTRADICTED");
  assert.equal(result.observation.provenance.field_states.price, "UNKNOWN");
});

test("AF/AG/AH/AI/AJ/AK/AL/AM/AN/AO/AP/AQ/AR — isolamento sem efeitos colaterais", async () => {
  const captured = captureTransport(jsonResponse(verboseFixture(FIX_14_VALID_PRICE)));
  const result = await adapterFor(captured.transport).lookup({ itemId: FIXTURE_ITEM_ID });
  assert.equal(result.ok, true);
  assert.equal(captured.calls.length, 1);
  assert.equal(JSON.stringify(result).includes("candidate"), false);
  assert.equal(JSON.stringify(result).includes("publication"), false);
  assert.equal(JSON.stringify(result).includes("affiliate"), false);
  assert.equal(JSON.stringify(result).includes("telegram"), false);
  assert.equal(JSON.stringify(result).includes("scheduler"), false);
  assert.equal(JSON.stringify(result).includes("agent"), false);
});
