// ============================================================================
// D-SHOPEE-1 — Resolução direcionada oficial Shopee BR (provas locais)
//
// Base: introspection + chamadas reais da API oficial BR (2026-08-18),
// PROOF_RUN_ID SHOPEE_D1_PROVA_20260818. O schema oficial confirmou:
//   * productOfferV2(itemId: Int64, shopId: Int64, limit: Int, ...)
//   * generateShortLink(input: { originUrl: String!, subIds: [String] })
// As provas locais abaixo cobrem o contrato interno com transport mock —
// SEM rede, SEM banco, SEM secrets reais (valores de teste não sensíveis).
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createShopeeApiClient,
  type ShopeeHttpTransport,
} from "../server/commercial/affiliate/shopeeApiClient";

const APP_ID = "test-app-id";
const APP_SECRET = "test-app-secret";

interface RecordedRequest { url: string; headers: Record<string, string>; body: string }

function makeMockTransport(responder: (req: RecordedRequest) => { status: number; body: unknown }) {
  const recorded: RecordedRequest[] = [];
  const transport: ShopeeHttpTransport = async (url, init) => {
    recorded.push({ url, headers: init.headers, body: init.body });
    return {
      status: responder({ url, headers: init.headers, body: init.body }).status,
      ok: responder({ url, headers: init.headers, body: init.body }).status < 400,
      json: async () => responder({ url, headers: init.headers, body: init.body }).body,
    } as unknown as Response;
  };
  return { transport, recorded };
}

function makeClient(responder: (req: RecordedRequest) => { status: number; body: unknown }) {
  const handle = makeMockTransport(responder);
  const client = createShopeeApiClient({ appId: APP_ID, secret: APP_SECRET, transport: handle.transport });
  return { client, handle };
}

function officialNodes(nodes: unknown[]) {
  return { data: { productOfferV2: { nodes } } };
}

function sigOf(payload: string, ts: string) {
  return createHash("sha256").update(APP_ID + ts + payload + APP_SECRET).digest("hex");
}

// ----------------------------------------------------------------------------
// SHOPEE-D1-01 — Resolução direcionada: match exato de identificadores
// oficiais (prova A da Fase 1: tupla real retornada com IDs idênticos).
// ----------------------------------------------------------------------------
test("SHOPEE-D1-01 directed: match exato itemId+shopId oficiais → found/link_acquired", async () => {
  const { client, handle } = makeClient(() => ({
    status: 200,
    body: officialNodes([{
      itemId: 22394976954,
      shopId: 1370479894,
      productName: "Bermuda Oficial",
      price: 4900,
      productLink: "https://shopee.com.br/product/1370479894/22394976954",
      offerLink: "https://s.shopee.com.br/8Kop07WdVf",
    }]),
  }));
  const res = await client.acquireAffiliateLink({ shopId: "1370479894", itemId: "22394976954" });
  assert.equal(res.status, "link_acquired");
  assert.equal(res.itemId, "22394976954");
  assert.equal(res.shopId, "1370479894");
  assert.equal(res.affiliateUrl, "https://s.shopee.com.br/8Kop07WdVf");
  // A query enviou os identificadores como ARGUMENTOS oficiais.
  const sentBody = JSON.parse(handle.recorded[0].body);
  assert.match(sentBody.query, /productOfferV2\(itemId: 22394976954, shopId: 1370479894, limit: 1\)/);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-02 — Tupla invertida não casa: returned != requested → fail-closed.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-02 directed: tupla invertida → not_found (jamais presumir)", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: officialNodes([{
      itemId: 1370479894,
      shopId: 22394976954,
      productName: "Nó com IDs trocados",
      price: 100,
      productLink: "https://shopee.com.br/product/22394976954/1370479894",
      offerLink: "https://s.shopee.com.br/xyz",
    }]),
  }));
  const res = await client.acquireAffiliateLink({ shopId: "1370479894", itemId: "22394976954" });
  assert.equal(res.status, "not_found");
  assert.equal(res.affiliateUrl, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-03 — Tupla inexistente → nodes vazio → not_found (provas B/C).
// ----------------------------------------------------------------------------
test("SHOPEE-D1-03 directed: tupla inexistente (nodes vazio) → not_found", async () => {
  const { client } = makeClient(() => ({ status: 200, body: officialNodes([]) }));
  const res = await client.acquireAffiliateLink({ shopId: "999999999", itemId: "999999999" });
  assert.equal(res.status, "not_found");
  assert.equal(res.affiliateUrl, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-04 — Offer sem offerLink (não elegível a afiliado) → never infer.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-04 directed: sem offerLink oficial → not_eligible (jamais derivar)", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: officialNodes([{
      itemId: 22394976954,
      shopId: 1370479894,
      productName: "Sem elegibilidade",
      price: 100,
      productLink: "https://shopee.com.br/product/1370479894/22394976954",
      offerLink: null,
    }]),
  }));
  const res = await client.acquireAffiliateLink({ shopId: "1370479894", itemId: "22394976954" });
  assert.equal(res.status, "not_eligible");
  assert.equal(res.affiliateUrl, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-05 — Assinatura oficial cobre o payload EXATO com os argumentos.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-05 signature: SHA256(Credential+Timestamp+Payload+Secret) cobre payload com args", async () => {
  const { client, handle } = makeClient(() => ({ status: 200, body: officialNodes([]) }));
  await client.acquireAffiliateLink({ shopId: "7", itemId: "11" });
  const req = handle.recorded[0];
  const auth = req.headers["Authorization"];
  const m = /SHA256 Credential=([^,]+), Timestamp=(\d+), Signature=([0-9a-f]{64})/.exec(auth ?? "");
  assert.ok(m);
  const expected = createHash("sha256").update(APP_ID + m[2] + req.body + APP_SECRET).digest("hex");
  assert.equal(m[3], expected);
  assert.match(req.body, /itemId: 11, shopId: 7, limit: 1/);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-06 — Sem credenciais → NÃO é possível construir o cliente.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-06 config: sem credenciais jamais constrói o cliente", () => {
  assert.throws(() => createShopeeApiClient({ appId: "", secret: "" }));
  assert.throws(() => createShopeeApiClient({ appId: APP_ID, secret: "" }));
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-07 — generateShortLink: link oficial obtido (prova E).
// ----------------------------------------------------------------------------
test("SHOPEE-D1-07 shortlink: mutation oficial → link_acquired", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: { data: { generateShortLink: { shortLink: "https://s.shopee.com.br/1qbLGL4ocO", longLink: "https://shopee.com.br/universal-link/product/1/2" } } },
  }));
  const res = await client.generateShortLink({
    originUrl: "https://shopee.com.br/product/1/2",
    subIds: ["D1"],
  });
  assert.equal(res.status, "link_acquired");
  assert.equal(res.shortLink, "https://s.shopee.com.br/1qbLGL4ocO");
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-08 — generateShortLink: subId fora do formato oficial → erro.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-08 shortlink: subId inválido (hífen) NUNCA chega à API (filtro local)", async () => {
  const { client, handle } = makeClient(() => ({
    status: 200,
    body: { data: { generateShortLink: { shortLink: "https://s.shopee.com.br/x", longLink: null } } },
  }));
  // "ds-shopee-1" contém hífen → fora do formato oficial (erro 11001 da API).
  await client.generateShortLink({
    originUrl: "https://shopee.com.br/product/1/2",
    subIds: ["ds-shopee-1"],
  });
  // O contrato exige que subIds fora do formato oficial NUNCA sejam
  // enviados à API: o body GraphQL registrado não deve conter o hífen.
  assert.equal(handle.recorded.length, 1);
  assert.equal(handle.recorded[0].body.includes("ds-shopee-1"), false);
  assert.match(handle.recorded[0].body, /subIds: \[\]/);
  // Máx 40 chars também é validado; subId com 41 chars é filtrado.
  const longSub = "a".repeat(41);
  await client.generateShortLink({ originUrl: "https://shopee.com.br/product/1/2", subIds: [longSub] });
  assert.equal(handle.recorded[1].body.includes(longSub), false);
  // SubId vazio é filtrado.
  await client.generateShortLink({ originUrl: "https://shopee.com.br/product/1/2", subIds: [""] });
  assert.equal(handle.recorded[2].body.includes('""'), false);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-09 — generateShortLink: URL não-https → invalid_url (sem chamada).
// ----------------------------------------------------------------------------
test("SHOPEE-D1-09 shortlink: URL não-https → invalid_url sem chamar a API", async () => {
  const { client, handle } = makeClient(() => ({ status: 200, body: {} }));
  const res = await client.generateShortLink({ originUrl: "http://shopee.com.br/product/1/2", subIds: [] });
  assert.equal(res.status, "invalid_url");
  assert.equal(handle.recorded.length, 0);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-10 — generateShortLink: erro GraphQL 11001 (invalid sub id)
// catalogado como permanent (fail-closed, jamais URL derivada).
// ----------------------------------------------------------------------------
test("SHOPEE-D1-10 shortlink: erro oficial 11001 invalid sub id → permanent", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: { errors: [{ code: 11001, message: "Params Error : invalid sub id" }] },
  }));
  const res = await client.generateShortLink({ originUrl: "https://shopee.com.br/product/1/2", subIds: ["D1"] });
  assert.equal(res.status, "permanent");
  assert.equal(res.shortLink, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-11 — generateShortLink: sem shortLink oficial → não confirmado.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-11 shortlink: sem shortLink no envelope → não confirmado (jamais derivar)", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: { data: { generateShortLink: { shortLink: null, longLink: "https://shopee.com.br/product/1/2" } } },
  }));
  const res = await client.generateShortLink({ originUrl: "https://shopee.com.br/product/1/2", subIds: [] });
  assert.equal(res.status, "permanent");
  assert.equal(res.shortLink, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-12 — generateShortLink: falha de transporte → transient.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-12 shortlink: falha de transporte → transient", async () => {
  const transport: ShopeeHttpTransport = async () => {
    throw new Error("network failure");
  };
  const client = createShopeeApiClient({ appId: APP_ID, secret: APP_SECRET, transport });
  const res = await client.generateShortLink({ originUrl: "https://shopee.com.br/product/1/2", subIds: [] });
  assert.equal(res.status, "transient");
  assert.equal(res.shortLink, null);
});

// ----------------------------------------------------------------------------
// SHOPEE-D1-13 — Falha de autenticação oficial (10020) no caminho dirigido.
// ----------------------------------------------------------------------------
test("SHOPEE-D1-13 directed: 10020 Invalid Signature → auth_error (fail-closed)", async () => {
  const { client } = makeClient(() => ({
    status: 200,
    body: { errors: [{ code: 10020, message: "Invalid Signature" }] },
  }));
  const res = await client.acquireAffiliateLink({ shopId: "1370479894", itemId: "22394976954" });
  assert.equal(res.status, "auth_error");
  assert.equal(res.affiliateUrl, null);
});
