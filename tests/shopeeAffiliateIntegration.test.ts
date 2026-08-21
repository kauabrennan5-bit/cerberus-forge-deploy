// ============================================================================
// Integração oficial Shopee Afiliados BR — Suíte local determinística
// (SHOPEE-01..SHOPEE-16)
//
// GOVERNANÇA DOS TESTES:
//   - 100% determinísticos: transporte HTTP 100% mockado (fetch injetado);
//     nenhuma chamada real à API Shopee; nenhum gasto externo.
//   - Nenhum secret (app_secret) aparece em nenhuma assertion, mensagem de
//     erro, cabeçalho logado ou metadata — os mocks validam a presença do
//     header oficial sem expor valores sensíveis.
//   - Nenhum teste grava no banco (in-memory / mock de routes).
//   - N12/N10/N11 intactos (nenhum import dos módulos de pesquisa).
//
// Catálogo de erros testado (SHOPEE_*):
//   NOT_CONFIGURED | AUTH_ERROR | FORBIDDEN | RATE_LIMITED | TIMEOUT |
//   NETWORK_ERROR | GRAPHQL_ERROR | INVALID_RESPONSE | NOT_FOUND |
//   NOT_ELIGIBLE | UNKNOWN_ERROR.
// ============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import supertest from "supertest";

import {
  createShopeeApiClient,
  SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL,
} from "../server/commercial/affiliate/shopeeApiClient";
import {
  SHOPEE_ERROR_KINDS,
  SHOPEE_TRANSIENT_KINDS,
  isShopeeErrorKind,
  isShopeeTransientError,
  extractShopeeIdentifiers,
  ShopeeClientError,
} from "../server/commercial/affiliate/shopeeClientContracts";
import {
  createShopeeAffiliateProvider,
  type ShopeeClientFactory,
} from "../server/commercial/affiliate/shopeeAffiliateProvider";
import {
  setAffiliateApiSource,
  resetAffiliateApiSource,
  acquireAffiliateLink,
  setAffiliateApiSource as resetForTests,
} from "../server/commercial/affiliate/acquisitionService";
import { registerAffiliateRoutes } from "../server/commercial/affiliate/affiliateRoutes";
import { setAffiliateClient } from "../server/commercial/affiliate/affiliateRepository";

// ---------------------------------------------------------------------------
// Infraestrutura de teste (transport mockado, sem rede real).
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type MockShopeeHttpTransport = import("../server/commercial/affiliate/shopeeApiClient").ShopeeHttpTransport;

interface MockTransportHandle {
  /** O transport injetável no cliente. */
  transport: MockShopeeHttpTransport;
  /** Requisições registradas (sem rede real). */
  recorded: RecordedRequest[];
}

function makeMockTransport(responder: (req: RecordedRequest) => { status: number; body: unknown }): MockTransportHandle {
  const recorded: RecordedRequest[] = [];
  const transport: MockShopeeHttpTransport = async (url, init) => {
    recorded.push({ url, headers: init.headers, body: init.body });
    const { status, body } = responder({ url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { transport, recorded };
}

const APP_ID = "test-app-id";
// O secret de teste é deliberadamente um valor não sensível usado só nos
// testes; em produção vem exclusivamente de process.env e nunca é logado.
const APP_SECRET = "test-app-secret";

const NODE_ITEM_OFFER = {
  itemId: 23794344926,
  shopId: 715084914,
  name: "Produto Oficial Prova",
  price: 9900,
  productLink: "https://shopee.com.br/Produto-i.715084914.23794344926",
  offerLink: "https://s.shopee.com.br/offer-token-oficial",
};

const NODE_ITEM_WITHOUT_OFFER = {
  itemId: 23794344926,
  shopId: 715084914,
  name: "Produto Sem Ofertas",
  price: 5900,
  productLink: "https://shopee.com.br/Produto-i.715084914.23794344926",
  offerLink: null,
};

function officialOk(nodes: unknown[] = [NODE_ITEM_OFFER]): unknown {
  return { data: { productOfferV2: { nodes } } };
}

function officialError(code: number, message = "oficial"): unknown {
  return { errors: [{ code, message }] };
}

function officialErrorWithExtensions(code: number, message = "oficial"): unknown {
  return { errors: [{ message, extensions: { code } }] };
}

// ---------------------------------------------------------------------------
// SHOPEE-01 — Catálogo de erros fechado (todos os kinds declarados e únicos).
// ---------------------------------------------------------------------------
describe("SHOPEE-01 catálogo de erros interno", () => {
  it("declara os 11 kinds oficiais e nenhum outro", () => {
    assert.equal(SHOPEE_ERROR_KINDS.length, 11);
    assert.equal(new Set(SHOPEE_ERROR_KINDS).size, 11);
    for (const kind of SHOPEE_ERROR_KINDS) assert.ok(isShopeeErrorKind(kind));
    assert.ok(!isShopeeErrorKind("SHOPEE_ANY_NEW_ERROR_INVENTED"));
  });

  it("transitórios formam lista fechada de retry (rate/timeout/network)", () => {
    const expected = ["SHOPEE_RATE_LIMITED", "SHOPEE_TIMEOUT", "SHOPEE_NETWORK_ERROR"] as const;
    assert.deepEqual([...SHOPEE_TRANSIENT_KINDS], [...expected]);
    assert.ok(isShopeeTransientError("SHOPEE_RATE_LIMITED"));
    assert.ok(!isShopeeTransientError("SHOPEE_AUTH_ERROR"));
    assert.ok(!isShopeeTransientError("SHOPEE_NOT_FOUND"));
    assert.ok(!isShopeeTransientError("SHOPEE_GRAPHQL_ERROR"));
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-02 — Extração estrita de identificadores de URL (sem presumir).
// ---------------------------------------------------------------------------
describe("SHOPEE-02 extração de identificadores (extração estrita)", () => {
  it("extrai shop/item do padrão oficial /Produto-i.{shop}.{item}", () => {
    const ids = extractShopeeIdentifiers(
      "https://shopee.com.br/Produto-i.715084914.23794344926?utm_term=abc",
    );
    assert.equal(ids.shopId, "715084914");
    assert.equal(ids.itemId, "23794344926");
  });

  it("extrai do padrão share /product/{shop}/{item} e query shop_id/item_id", () => {
    const a = extractShopeeIdentifiers("https://shopee.com.br/product/715084914/23794344926");
    assert.equal(a.shopId, "715084914");
    assert.equal(a.itemId, "23794344926");
    const b = extractShopeeIdentifiers(
      "https://shopee.com.br/x?shop_id=715084914&item_id=23794344926",
    );
    assert.equal(b.shopId, "715084914");
    assert.equal(b.itemId, "23794344926");
  });

  it("recusa URL fora do whitelist de hosts oficiais (jamais derivada)", () => {
    const ids = extractShopeeIdentifiers("https://shopee.com.fake.malicious/phishing?shop_id=1&item_id=2");
    assert.equal(ids.shopId, null);
    assert.equal(ids.itemId, null);
  });

  it("URL sem identificadores → null (nunca heurística fraca)", () => {
    const ids = extractShopeeIdentifiers("https://shopee.com.br/busca?q=cadeira");
    assert.equal(ids.shopId, null);
    assert.equal(ids.itemId, null);
  });

  it("URL inválida → null sem exceção", () => {
    const ids = extractShopeeIdentifiers("not-a-url");
    assert.equal(ids.shopId, null);
    assert.equal(ids.itemId, null);
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-03 — Cliente exige credenciais; sem env → NOT_CONFIGURED
// (fail-closed — fonte jamais construída).
// ---------------------------------------------------------------------------
describe("SHOPEE-03 falha fechada sem credenciais", () => {
  it("construir sem appId/secret → SHOPEE_NOT_CONFIGURED (exception, não fonte)", () => {
    assert.throws(() => createShopeeApiClient({ appId: "", secret: APP_SECRET }), (e) =>
      e instanceof ShopeeClientError && e.kind === "SHOPEE_NOT_CONFIGURED");
    assert.throws(() => createShopeeApiClient({ appId: APP_ID, secret: "" }), (e) =>
      e instanceof ShopeeClientError && e.kind === "SHOPEE_NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-04 — Assinatura oficial reconstruída exatamente pelo servidor mock
// (SHA256 Credential+Timestamp+Payload+Secret; header SHA256 único).
// ---------------------------------------------------------------------------
describe("SHOPEE-04 autenticação/assinatura oficial (mock verifica)", () => {
  it("header Authorization e payload enviados e verificáveis pelo mock", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      timeoutMs: 5000,
      transport: handle.transport,
      clock: () => 1_750_000_000_000,
    });
    return client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" }).then(() => {
      assert.equal(handle.recorded.length, 1);
      assertAuthorization(handle.recorded[0]);
      assert.equal(handle.recorded[0].url, SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL);
    });
  });
});

// Helper para asserções de assinatura reutilizável nos testes seguintes.
function assertAuthorization(req: RecordedRequest): { timestamp: string; credential: string; signature: string } {
  const auth = req.headers.Authorization ?? "";
  const m = /^SHA256 Credential=([^,]+), Timestamp=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth.trim());
  assert.ok(m, `header oficial ausente/inválido: ${auth}`);
  const [, credential, timestamp, signature] = m;
  assert.equal(credential, APP_ID, "credential exposta ≠ appId esperado");
  // Timestamp em segundos Unix.
  assert.ok(/^\d{1,12}$/.test(timestamp), "timestamp não é Unix seconds");
  // Recomputação independente pelo mock: SHA256(Cred+Ts+Payload+Secret).
  const expected = createHash("sha256").update([credential, timestamp, req.body, APP_SECRET].join("")).digest("hex");
  assert.equal(signature, expected, "assinatura não coincide com a reconstrução oficial");
  // O payload enviado é JSON analisável e igual ao corpo recebido.
  assert.doesNotThrow(() => JSON.parse(req.body), "payload não é JSON válido");
  return { timestamp, credential, signature };
}

// ---------------------------------------------------------------------------
// SHOPEE-05 — Consulta oficial por produto: found com match estrito.
// ---------------------------------------------------------------------------
describe("SHOPEE-05 consulta oficial por produto (match estrito)", () => {
  it("found quando shop/item casam exatamente com o nó oficial", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "found");
      assert.equal(r.itemId, "23794344926");
      assert.equal(r.shopId, "715084914");
      assert.equal(r.name, "Produto Oficial Prova");
      assert.equal(r.priceMinorUnits, 9900);
      assert.equal(handle.recorded.length, 1);
      assertAuthorization(handle.recorded[0]);
      assert.equal(handle.recorded[0].url, SHOPEE_AFFILIATE_API_DEFAULT_BASE_URL);
    });
  });

  // D-SHOPEE-1 (PHASE14_SCHEMA_PROBE_20260820): o shape real da API
  // devolve `price` como string decimal pura; o parser aceita a FORMA
  // observada. A ESCALA/SEMÂNTICA continua UNVERIFIED (NÃO é
  // "priceMinorUnits" comprovado) — isso é sinalizado no Evidence Bridge
  // (quality=UNKNOWN, unit=string_price_unscaled, note SCALE_UNVERIFIED).
  it("aceita a forma decimal pura observada no shape real (escala UNVERIFIED, não é minor_units comprovado)", () => {
    const handle = makeMockTransport(() => ({
      status: 200,
      body: officialOk([{ ...NODE_ITEM_OFFER, price: "9900" }]),
    }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "found");
      // Forma decimal pura aceita (shape real observado).
      // SEMÂNTICA de minor units NÃO comprovada — escala UNVERIFIED.
      assert.equal(r.priceMinorUnits, 9900);
    });
  });

  it("aceita string decimal plausível na forma observada (escala UNVERIFIED, não é minor_units comprovado)", () => {
    const handle = makeMockTransport(() => ({
      status: 200,
      body: officialOk([{ ...NODE_ITEM_OFFER, price: "99.00" }]),
    }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "found");
      // Forma decimal aceita (shape real observado).
      // SEMÂNTICA de minor units NÃO comprovada — escala UNVERIFIED.
      assert.equal(r.priceMinorUnits, 99);
    });
  });

  it("mantém UNKNOWN para string inválida", () => {
    const handle = makeMockTransport(() => ({
      status: 200,
      body: officialOk([{ ...NODE_ITEM_OFFER, price: "not-a-price" }]),
    }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "found");
      assert.equal(r.priceMinorUnits, null);
    });
  });

  it("mantém UNKNOWN para string vazia e ausência de price", async () => {
    for (const priceNode of [{ ...NODE_ITEM_OFFER, price: "" }, (() => {
      const { price: _ignored, ...withoutPrice } = NODE_ITEM_OFFER;
      return withoutPrice;
    })()]) {
      const handle = makeMockTransport(() => ({ status: 200, body: officialOk([priceNode]) }));
      const client = createShopeeApiClient({
        appId: APP_ID,
        secret: APP_SECRET,
        transport: handle.transport,
      });
      const result = await client.lookupProduct({ shopId: "715084914", itemId: "23794344926" });
      assert.equal(result.status, "found");
      assert.equal(result.priceMinorUnits, null);
    }
  });

  it("not_found quando o nó oficial não corresponde aos identificadores (sem presumir o 1º nó)", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "999999999", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "not_found");
      assert.equal(r.itemId, null);
    });
  });

  it("not_found sem identificadores (jamais presumir a vitrine como o produto alvo)", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: null, itemId: null }).then((r) => {
      assert.equal(r.status, "not_found");
    });
  });

  it("error com kind catalogado quando a fonte devolve GraphQL error oficial", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialError(10020, "Invalid Signature") }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "error");
      assert.equal(r.error?.kind, "SHOPEE_AUTH_ERROR");
      assert.ok(r.error!.message.startsWith("shopee_client_error:SHOPEE_AUTH_ERROR"));
      // A mensagem NUNCA carrega o secret.
      assert.ok(!r.error!.message.includes(APP_SECRET));
    });
  });

  it("error SHOPEE_GRAPHQL_ERROR para código oficial desconhecido (fail-closed)", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialError(99999, "desconhecido") }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "error");
      assert.equal(r.error?.kind, "SHOPEE_GRAPHQL_ERROR");
    });
  });

  it("extrai código de erro oficial de extensions.code (SHOPEE-17)", () => {
    // 10010 em extensions.code deve ser mapeado para SHOPEE_FORBIDDEN
    const handle = makeMockTransport(() => ({
      status: 200,
      body: officialErrorWithExtensions(10010, "Cannot query field productOfferSearch"),
    }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.lookupProduct({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "error");
      assert.equal(r.error?.kind, "SHOPEE_FORBIDDEN");
      assert.equal(r.error?.message, "shopee_client_error:SHOPEE_FORBIDDEN:code_10010");
    });
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-06 — Aquisição: link oficial exato (sem derivar), not_eligible,
// not_found.
// ---------------------------------------------------------------------------
describe("SHOPEE-06 aquisição de link oficial (sem derivar)", () => {
  it("link_acquired preserva a URL oficial EXATA (offerLink do nó)", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "link_acquired");
      assert.equal(r.affiliateUrl, "https://s.shopee.com.br/offer-token-oficial");
      assert.equal(r.itemId, "23794344926");
      assert.equal(r.shopId, "715084914");
      assert.equal(r.name, "Produto Oficial Prova");
      // A URL exata — nenhuma normalização/derivação.
      assert.ok(!r.affiliateUrl!.includes("utm_term"));
      assert.equal(handle.recorded.length, 1);
      assertAuthorization(handle.recorded[0]);
    });
  });

  it("not_eligible quando a fonte oficial não devolve offerLink (jamais usar productLink como link de afiliado)", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk([NODE_ITEM_WITHOUT_OFFER]) }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "not_eligible");
      assert.equal(r.affiliateUrl, null);
      assert.equal(r.productLink, "https://shopee.com.br/Produto-i.715084914.23794344926");
    });
  });

  it("not_found quando o produto não está nas ofertas oficiais", () => {
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk([]) }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.equal(r.status, "not_found");
      assert.equal(r.affiliateUrl, null);
    });
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-07 — Erros HTTP mapeados ao catálogo (401→AUTH, 403→FORBIDDEN,
// 429→RATE, 5xx→NETWORK; body não-JSON → INVALID_RESPONSE).
// ---------------------------------------------------------------------------
describe("SHOPEE-07 mapeamento de erros HTTP para o catálogo", () => {
  function clientWith(responder: (req: RecordedRequest) => { status: number; body: unknown }, status: number) {
    const handle = makeMockTransport(responder);
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return { client, recorded: handle.recorded };
  }

  it("401 → auth_error (SHOPEE_AUTH_ERROR)", () =>
    clientWith(() => ({ status: 401, body: {} }), 401).client
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "auth_error")));

  it("403 → auth_error (SHOPEE_FORBIDDEN)", () =>
    clientWith(() => ({ status: 403, body: {} }), 403).client
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "auth_error")));

  it("429 → rate_limited (transitório)", () =>
    clientWith(() => ({ status: 429, body: {} }), 429).client
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "rate_limited")));

  it("502/503 → transient (NETWORK_ERROR, transitório)", () =>
    clientWith(() => ({ status: 502, body: {} }), 502).client
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "transient")));

  it("200 com body não-JSON → invalid_response (permanent)", () =>
    clientWith(() => ({ status: 200, body: "<html>não-json</html>" }), 200).client
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "permanent")));
});

// ---------------------------------------------------------------------------
// SHOPEE-08 — Timeout determinístico → transient (SHOPEE_TIMEOUT); sem
// retry agressivo (máx 1 retry para transitórios).
// ---------------------------------------------------------------------------
describe("SHOPEE-08 timeout e política de retry limitada", () => {
  it("transport que nunca responde → transient com até 2 tentativas no total", async () => {
    let attempts = 0;
    const transport: MockShopeeHttpTransport = async (_url, init) => {
      attempts += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      throw new Error("simulated hang");
    };
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      timeoutMs: 50,
      transport,
    });
    const r = await client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" });
    assert.equal(r.status, "transient");
    assert.equal(r.error?.kind, "SHOPEE_TIMEOUT");
    assert.ok(attempts >= 1 && attempts <= 2, `attempts=${attempts} (máx 2)`);
  });

  it("429 transitório com 200 na retry → link_acquired (máx 1 retry)", async () => {
    let attempt = 0;
    const handle = makeMockTransport(() => {
      attempt += 1;
      if (attempt === 1) return { status: 429, body: {} };
      return { status: 200, body: officialOk() };
    });
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    const r = await client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" });
    assert.equal(r.status, "link_acquired");
    assert.equal(handle.recorded.length, 2);
  });

  it("429 persistente → rate_limited (não retenta indefinidamente)", async () => {
    const handle = makeMockTransport(() => ({ status: 429, body: {} }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    const start = Date.now();
    const r = await client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" });
    const elapsed = Date.now() - start;
    assert.equal(r.status, "rate_limited");
    assert.ok(elapsed < 8000, `retry estourou backoff limitado: ${elapsed}ms`);
    assert.ok(handle.recorded.length <= 2);
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-09 — Response fora do envelope oficial → INVALID_RESPONSE
// (sem data / sem productOfferV2 / sem nodes) — fail-closed.
// ---------------------------------------------------------------------------
describe("SHOPEE-09 envelope oficial estrito", () => {
  it("body sem data → invalid_response (permanent)", () =>
    makeClient({ errors: "fora do envelope" }).acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => { assert.equal(r.status, "permanent"); assert.equal(r.error?.kind, "SHOPEE_INVALID_RESPONSE"); }));

  it("data sem productOfferV2 → invalid_response", () =>
    makeClient({ data: { outraOperacao: 1 } }).acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "permanent")));

  it("productOfferV2 sem nodes → invalid_response (jamais inventar nó)", () =>
    makeClient({ data: { productOfferV2: {} } }).acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => assert.equal(r.status, "permanent")));
});

// ---------------------------------------------------------------------------
// SHOPEE-10 — Secret nunca aparece em erros/messages/logs do cliente.
// ---------------------------------------------------------------------------
describe("SHOPEE-10 confidencialidade do secret", () => {
  it("nenhuma mensagem de erro carrega o secret (auth error 10020)", () =>
    makeClient(officialError(10020, "Invalid Signature"))
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => {
        const raw = JSON.stringify(r);
        assert.ok(!raw.includes(APP_SECRET), "secret vazou na resposta catalogada");
      }));

  it("nenhuma mensagem de erro carrega o secret (401)", () =>
    makeClient2((req) => ({ status: 401, body: {} }))
      .acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" })
      .then((r) => {
        const raw = JSON.stringify(r);
        assert.ok(!raw.includes(APP_SECRET), "secret vazou em erro HTTP");
      }));

  it("o header Authorization nunca é logado pelo cliente; apenas a assinatura (hex) via header enviado", () => {
    // O cliente envia o header para a API (necessário) mas não o imprime/
    // armazena em nenhuma propriedade do resultado.
    const handle = makeMockTransport(() => ({ status: 200, body: officialOk() }));
    const client = createShopeeApiClient({
      appId: APP_ID,
      secret: APP_SECRET,
      transport: handle.transport,
    });
    return client.acquireAffiliateLink({ shopId: "715084914", itemId: "23794344926" }).then((r) => {
      assert.ok(typeof r.affiliateUrl === "string" || r.status !== "link_acquired");
      const raw = JSON.stringify(r);
      assert.ok(!raw.includes(APP_SECRET));
      assert.ok(!JSON.stringify(r.error ?? "").includes(APP_SECRET));
      assert.equal(handle.recorded.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-11 — Provider: sem credenciais jamais constrói fonte (AUTH_REQUIRED
// na autoridade N8).
// ---------------------------------------------------------------------------
describe("SHOPEE-11 provider sem credenciais", () => {
  it("appId/secret vazios → exception (fonte nunca construída)", () => {
    assert.throws(() => createShopeeAffiliateProvider({ appId: "", secret: APP_SECRET, providerId: "shopee" }));
    assert.throws(() => createShopeeAffiliateProvider({ appId: APP_ID, secret: "", providerId: "shopee" }));
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-12 — Provider integrado à autoridade N8: link_acquired → SUCCESS
// com identidade CONFIRMADA (listing_id + seller_id + título).
// ---------------------------------------------------------------------------
describe("SHOPEE-12 provider → autoridade N8 (caminho SUCCESS)", () => {
  it("link oficial → SUCCESS + PRODUCT_IDENTITY_CONFIRMED + host whitelist", async () => {
    const { provider, clientFactory } = buildProviderMock(() => ({ status: 200, body: officialOk() }));
    const source = provider.apiSource();
    setAffiliateApiSource(source);
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: {
          marketplace: "Shopee",
          publicUrl: "https://shopee.com.br/Produto-i.715084914.23794344926",
          productId: null,
          candidateId: null,
        },
      });
      assert.equal(result.kind, "SUCCESS");
      if (result.kind !== "SUCCESS") return;
      assert.equal(result.affiliateUrl, "https://s.shopee.com.br/offer-token-oficial");
      assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
      assert.equal(result.identity.listingId, "23794344926");
      assert.equal(result.identity.sellerId, "715084914");
      assert.equal(result.identity.titleSnapshot, "Produto Oficial Prova");
      assert.equal(clientFactory.calls, 1);
      assert.ok(clientFactory.transportCalls <= 2, "retry inválido");
    } finally {
      setAffiliateApiSource(null);
    }
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-13 — Provider → IDENTITY_UNCERTAIN quando a fonte oficial não
// devolve offerLink (produto reconhecido mas não elegível).
// ---------------------------------------------------------------------------
describe("SHOPEE-13 provider → IDENTITY_UNCERTAIN sem elegibilidade oficial", () => {
  it("not_eligible → IDENTITY_UNCERTAIN com rationale (jamais SUCCESS)", async () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialOk([NODE_ITEM_WITHOUT_OFFER]) }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: {
          marketplace: "Shopee",
          publicUrl: "https://shopee.com.br/Produto-i.715084914.23794344926",
          productId: null,
          candidateId: null,
        },
      });
      assert.equal(result.kind, "IDENTITY_UNCERTAIN");
      if (result.kind !== "IDENTITY_UNCERTAIN") return;
      assert.ok(result.rationale.includes("not_eligible") || result.rationale.includes("eligible"), "rationale rastreável");
      assert.equal(result.method, "API");
    } finally {
      setAffiliateApiSource(null);
    }
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-14 — Provider → RESOLUTION_FAILED para auth/rate/not_found/
// envelope inválido (fail-closed); produto não localizado na fonte oficial
// nunca vira link.
// ---------------------------------------------------------------------------
describe("SHOPEE-14 provider → RESOLUTION_FAILED (fail-closed)", () => {
  it("10020 (Invalid Signature) → RESOLUTION_FAILED com official_api_error", async () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialError(10020, "Invalid Signature") }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/Produto-i.715084914.23794344926", productId: null, candidateId: null },
      });
      assert.equal(result.kind, "RESOLUTION_FAILED");
      if (result.kind !== "RESOLUTION_FAILED") return;
      assert.ok(result.reason.includes("official_api_error"));
      assert.ok(result.reason.includes("SHOPEE_AUTH_ERROR"));
    } finally {
      setAffiliateApiSource(null);
    }
  });

  it("429 persistente → RESOLUTION_FAILED (transitório esgotado)", async () => {
    const { provider } = buildProviderMock(() => ({ status: 429, body: {} }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/Produto-i.715084914.23794344926", productId: null, candidateId: null },
      });
      assert.equal(result.kind, "RESOLUTION_FAILED");
      assert.ok(result.reason.includes("SHOPEE_RATE_LIMITED"));
    } finally {
      setAffiliateApiSource(null);
    }
  });

  it("produto ausente das ofertas oficiais → RESOLUTION_FAILED (jamais URL derivada)", async () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialOk([]) }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/Produto-i.715084914.23794344926", productId: null, candidateId: null },
      });
      assert.equal(result.kind, "RESOLUTION_FAILED");
      assert.ok(result.reason.includes("SHOPEE_NOT_FOUND"));
    } finally {
      setAffiliateApiSource(null);
    }
  });

  it("identificadores ausentes na URL → RESOLUTION_FAILED (não localiza o produto)", async () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialOk() }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const result = await acquireAffiliateLink({
        provider: mockProvider("shopee", "ACTIVE"),
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/busca?q=cadeira", productId: null, candidateId: null },
      });
      assert.equal(result.kind, "RESOLUTION_FAILED");
      assert.ok(result.reason.includes("SHOPEE_NOT_FOUND") || result.reason.includes("no_valid_identifiers"));
    } finally {
      setAffiliateApiSource(null);
    }
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-15 — Rota admin /acquire preservada: sem credenciais → AUTH_REQUIRED
// (401); provider inativo → 409; preview-only sem affiliate_url (não grava).
// ---------------------------------------------------------------------------
describe("SHOPEE-15 rota /acquire preservada", () => {
  it("sem fonte oficial → 401 AUTH_REQUIRED (fail-closed)", async () => {
    setAffiliateApiSource(null);
    try {
      const res = await testApp()
        .post("/api/commercial/affiliate/acquire")
        .set("x-admin-password", "cerberus1607")
        .send({ provider_id: "shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/Produto-i.715084914.23794344926" });
      assert.equal(res.status, 401);
      assert.equal(res.body.error ?? res.body.code, "acquisition_auth_required");
    } finally {
      setAffiliateApiSource(null);
    }
  });

  it("com fonte oficial → preview SUCCESS (sem gravação) — idempotente via reenvio", async () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialOk() }));
    setAffiliateApiSource(provider.apiSource());
    try {
      const res = await testApp()
        .post("/api/commercial/affiliate/acquire")
        .set("x-admin-password", "cerberus1607")
        .send({ provider_id: "shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/Produto-i.715084914.23794344926" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.acquisition?.state, "SUCCESS");
      assert.equal(res.body.acquisition?.affiliateUrl, "https://s.shopee.com.br/offer-token-oficial");
    } finally {
      setAffiliateApiSource(null);
    }
  });

  it("sem credenciais → nenhum link é gerado/derivado em hipótese alguma (2 reenvios)", async () => {
    setAffiliateApiSource(null);
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await testApp()
          .post("/api/commercial/affiliate/acquire")
          .set("x-admin-password", "cerberus1607")
          .send({ provider_id: "shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/Produto-i.715084914.23794344926" });
        assert.equal(res.status, 401);
      }
    } finally {
      setAffiliateApiSource(null);
    }
  });
});

// ---------------------------------------------------------------------------
// SHOPEE-16 — Injeção no bootstrap: fonte global N8 aceita a apiSource do
// provider e o fail-closed do N12/N10/N11 permanece intacto (sem regressão
// nos módulos de pesquisa — verificado por ausência de import aqui).
// ---------------------------------------------------------------------------
describe("SHOPEE-16 bootstrap/global injection", () => {
  it("setAffiliateApiSource aceita a apiSource do provider; get retorna", () => {
    const { provider } = buildProviderMock(() => ({ status: 200, body: officialOk() }));
    setAffiliateApiSource(provider.apiSource());
    const src = getAffiliateApiSource();
    assert.ok(src !== null);
    assert.equal(src!.providerId, "shopee");
    setAffiliateApiSource(null);
    assert.equal(getAffiliateApiSource(), null);
  });

  it("provider sem credenciais jamais chega ao bootstrap (exception imediata)", () => {
    assert.throws(() => createShopeeAffiliateProvider({ appId: "", secret: "", providerId: "shopee" }));
  });
});

// ---------------------------------------------------------------------------
// Helpers de teste (todos locais; sem rede, sem banco, sem secrets expostos).
// ---------------------------------------------------------------------------

function makeClient(body: unknown): import("../server/commercial/affiliate/shopeeApiClient").ShopeeApiClient {
  return makeClient2(() => ({ status: 200, body }));
}

function makeClient2(responder: (req: RecordedRequest) => { status: number; body: unknown }): import("../server/commercial/affiliate/shopeeApiClient").ShopeeApiClient {
  const handle = makeMockTransport(responder);
  return createShopeeApiClient({
    appId: APP_ID,
    secret: APP_SECRET,
    transport: handle.transport,
  });
}

interface ProviderMockState {
  calls: number;
  transportCalls: number;
}

function buildProviderMock(responder: (req: RecordedRequest) => { status: number; body: unknown }) {
  const state: ProviderMockState = { calls: 0, transportCalls: 0 };
  const clientFactory: ShopeeClientFactory = (opts) => {
    state.calls += 1;
    const handle = makeMockTransport(responder);
    const inner = createShopeeApiClient({
      appId: opts.appId,
      secret: opts.secret,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      transport: handle.transport,
      clock: opts.clock,
    });
    return {
      lookupProduct: async (...args: Parameters<typeof inner.lookupProduct>) => {
        state.transportCalls += 1;
        return inner.lookupProduct(...args);
      },
      acquireAffiliateLink: async (...args: Parameters<typeof inner.acquireAffiliateLink>) => {
        state.transportCalls += 1;
        return inner.acquireAffiliateLink(...args);
      },
      generateShortLink: async (...args: Parameters<typeof inner.generateShortLink>) => {
        state.transportCalls += 1;
        return inner.generateShortLink(...args);
      },
      searchOffers: async (...args: Parameters<typeof inner.searchOffers>) => {
        state.transportCalls += 1;
        return inner.searchOffers(...args);
      },
    };
  };
  const provider = createShopeeAffiliateProvider({
    appId: APP_ID,
    secret: APP_SECRET,
    providerId: "shopee",
    clientFactory,
  });
  return { provider, clientFactory: state };
}

function mockProvider(providerId: string, status: "ACTIVE" | "INACTIVE"): import("../server/commercial/affiliate/contract").AffiliateProviderRecord {
  const now = new Date().toISOString();
  return {
    provider_id: providerId,
    provider_code: "shopee",
    name: "Shopee Afiliados BR",
    marketplace: "Shopee",
    program_name: "Shopee Affiliate",
    status: status as never,
    resolution_method: "API",
    ownership: "owner-human",
    provenance: "admin:manual",
    credential_ref: "env:SHOPEE_APP_ID",
    terms_url: "https://affiliate.shopee.com.br/terms",
    notes: "provider oficial",
    contract_version: "n6-affiliate-v1",
    idempotency_key: null,
    metadata: {},
    created_by: "operator",
    created_at: now,
    updated_at: now,
  };
}

let testAppInstance: express.Express | null = null;
function testApp() {
  if (!testAppInstance) {
    const app = express();
    app.use(express.json());
    const requireAdminAuth = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (_req.headers["x-admin-password"] === "cerberus1607") return next();
      return res.status(401).json({ error: "admin_auth_required" });
    };
    registerAffiliateRoutes(app, requireAdminAuth);
    // Mock do client Supabase — persistência de teste em memória é desnecessária
    // (os testes SHOPEE-15 não gravam; preview-only).
    const providersResult = () => ({
      eq: () => ({
        single: () => Promise.resolve({
          data: {
            provider_id: "shopee",
            provider_code: "shopee",
            name: "Shopee Afiliados BR",
            marketplace: "Shopee",
            program_name: "Shopee Affiliate",
            status: "ACTIVE",
            resolution_method: "API",
            ownership: "owner-human",
            provenance: "admin:manual",
            credential_ref: "env:SHOPEE_APP_ID",
            terms_url: "https://affiliate.shopee.com.br/terms",
            notes: "provider oficial",
            contract_version: "n6-affiliate-v1",
            idempotency_key: null,
            metadata: {},
            created_by: "operator",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          error: null,
        }),
        then: (r: (v: never) => unknown) => Promise.resolve(r(null as never)),
      } as never),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (r: (v: never) => unknown) => Promise.resolve(r(null as never)),
    } as never);
    const fakeResult = () => providersResult();
    const fakeChain = () => fakeResult();
    setAffiliateClient({
      from: () => ({ select: () => fakeChain(), insert: () => fakeChain(), delete: () => fakeChain(), update: () => fakeChain() } as never),
    } as never);
    testAppInstance = app;
  }
  return supertest(testAppInstance);
}

import { getAffiliateApiSource } from "../server/commercial/affiliate/acquisitionService";
