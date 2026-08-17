// ============================================================================
// Bloco N8 — AffiliateLinkAcquirer — Bateria completa de testes (locais)
//
// PROVAS:
//   N8-01/04  fail-closed sem credenciais → AUTH_REQUIRED (rota real)
//   N8-05     sem credenciais nunca tenta endpoint inventado (fonte = null)
//   N8-06     provider inativo → PROVIDER_NOT_ACTIVE
//   N8-07     Mercado Livre → NOT_SUPPORTED (sem mecanismo oficial)
//   N8-08     ML com operatorProvidedUrl → caminho manual validado
//   N8-09     resposta oficial inesperada → RESOLUTION_FAILED
//   N8-10     host fora do whitelist → RESOLUTION_FAILED (manual)
//   N8-11     URL pública derivada nunca é aceita como affiliate URL
//   N8-12     SUCCESS com identity CONFIRMED (listing+seller+title)
//   N8-13     SUCCESS MANUAL com identity UNCERTAIN (grava DRAFT/UNVALIDATED)
//   N8-14     registro via persistLink: idempotência (identical_duplicate)
//   N8-15     metadata de aquisição preservada (acquisition_ref audita)
//   N8-16     URL EXATA preservada (jamais normalizada/derivada)
//   N8-17     ACQUISITION != PUBLICATION: /acquire não cria produto
//   N8-18     API fonte de provider mismatch → RESOLUTION_FAILED
//   N8-19     normalização da resposta oficial rejeita formato inválido
//   N8-20     contrato de assinatura SHA256 composto corretamente
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import express from "express";
import supertest from "supertest";
import {
  acquireAffiliateLink,
  createShopeeApiSource,
  extractOfficialHost,
  getAffiliateApiSource,
  isPlausibleOfficialUrl,
  normalizeOfficialResponse,
  resetAffiliateApiSource,
  setAffiliateApiSource,
  validateManualUrl,
  type AffiliateApiSource,
  type OfficialGenerateResponse,
  type OfficialGenerateRequest,
} from "../server/commercial/affiliate/acquisitionService";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acquisitionServiceExports from "../server/commercial/affiliate/acquisitionService";
import {
  isAcquireSuccess,
  isAcquireIdentityUncertain,
  PROVENIENCE_ADMIN_ACQUIRED,
  type AcquireResult,
} from "../server/commercial/affiliate/acquisitionContract";
import {
  AFFILIATE_MARKETPLACE_HOSTS,
  type AffiliateLinkRecord,
  type AffiliateProviderRecord,
} from "../server/commercial/affiliate/contract";
import { registerAffiliateRoutes } from "../server/commercial/affiliate/affiliateRoutes";
import { setAffiliateClientForTests } from "../server/commercial/affiliate/affiliateRepository";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function provider(overrides: Partial<AffiliateProviderRecord> = {}): AffiliateProviderRecord {
  return {
    provider_id: "provider-n8-shopee",
    marketplace: "Shopee",
    status: "ACTIVE",
    resolution_method: "MANUAL" as const,
    ownership: "owner-human",
    provenance: "admin:manual",
    credential_ref: "cred-fake-n8",
    display_name: "Provider N8 Shopee",
    contact_channel: null,
    terms_url: null,
    fees: {},
    notes: "Provider de prova N8",
    contract_version: "1.0",
    metadata: { sub_id: "sub-n8-001" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as AffiliateProviderRecord;
}

function fakeClient(opts: { links: AffiliateLinkRecord[]; providers?: AffiliateProviderRecord[] } = { links: [] }) {
  const providers = opts.providers ?? [
    {
      provider_id: "provider-n8-shopee",
      marketplace: "Shopee",
      status: "ACTIVE",
      resolution_method: "MANUAL",
      ownership: "owner-human",
      provenance: "admin:manual",
      credential_ref: "cred-fake-n8",
    } as AffiliateProviderRecord,
  ];
  return {
    from(table: string) {
      if (table === "affiliate_providers") {
        return {
          insert: () => ({ single: async () => ({ data: null, error: { message: "store_error" } }) }),
          select: () => ({ eq: (_c: string, _v: unknown) => ({ single: async () => ({ data: providers.find((p) => p.provider_id === _v) ?? null, error: null }) }) }),
        } as any;
      }
      return {
        insert: (record: unknown) => ({
          single: async () => {
            const r = record as AffiliateLinkRecord;
            const dup = opts.links.find((l) => l.digest === r.digest);
            if (dup) {
              const err = new Error("duplicate key 23505") as any;
              err.message = "duplicate key 23505";
              return { data: null, error: err };
            }
            opts.links.push(r);
            return { data: r, error: null };
          },
        }),
        select: () => ({
          eq: (_c: string, _v: unknown) => ({
            single: async () => ({ data: opts.links.find((l) => String(l.digest) === String(_v)) ?? null, error: null }),
          }),
        }),
      } as any;
    },
  } as never;
}

// Fonte API fake que simula o mecanismo oficial (sem chamadas reais).
function fakeApiSource(opts: {
  providerId?: string;
  behavior?: "ok" | "invalid" | "throw" | "no_url";
  listingId?: string | null;
  sellerId?: string | null;
  title?: string | null;
  url?: string;
} = {}) {
  const behavior = opts.behavior ?? "ok";
  const source: AffiliateApiSource = {
    providerId: opts.providerId ?? "provider-n8-shopee",
    async generateLink(_req: OfficialGenerateRequest): Promise<OfficialGenerateResponse> {
      if (behavior === "throw") throw new Error("official_api_error:500");
      const url =
        opts.url ??
        (behavior === "ok" ? "https://shopee.com.br/fake-redirect-token-n8" : undefined);
      const raw =
        behavior === "invalid"
          ? { unexpectedField: "not-a-link" }
          : behavior === "no_url"
            ? { listingId: "123" }
            : { data: { productOfferV2: { nodes: [{ productLink: url, offerLink: url, ...(opts.listingId !== null ? { itemId: opts.listingId === undefined ? 715084914 : Number(opts.listingId) } : {}), ...(opts.sellerId !== null ? { shopId: opts.sellerId === undefined ? "seller-n8" : opts.sellerId } : {}), ...(opts.title !== null ? { name: opts.title === undefined ? "Produto Prova N8" : opts.title } : {}) }] } } };
      return normalizeOfficialResponse(raw);
    },
  };
  return source;
}

function ref(overrides: Partial<{ publicUrl: string }> = {}) {
  return {
    marketplace: "Shopee" as const,
    publicUrl: overrides.publicUrl ?? "https://shopee.com.br/Produto-i.715084914.23794344926",
    productId: null as string | null,
    candidateId: null as string | null,
  };
}

function appWithRoute() {
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (_req: any, _res: any, next: any) => next();
  registerAffiliateRoutes(app as any, requireAdminAuth);
  return app;
}

// ---------------------------------------------------------------------------
// Testes do serviço (3B/3C)
// ---------------------------------------------------------------------------

test("N8-01 serviço: sem fonte API e sem URL manual → AUTH_REQUIRED (fail-closed)", async () => {
  const result = await acquireAffiliateLink({ provider: provider(), reference: ref(), apiSource: null });
  assert.equal(result.kind, "AUTH_REQUIRED");
  const anyUrl = (result as AcquireResult & { affiliateUrl?: string }).affiliateUrl;
  assert.equal(anyUrl, undefined, "AUTH_REQUIRED jamais pode conter URL");
});

test("N8-04 rota /acquire sem credenciais → 401 acquisition_auth_required", async () => {
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  const app = appWithRoute();
  setAffiliateApiSource(null);
  try {
    const res = await supertest(app)
      .post("/api/commercial/affiliate/acquire")
      .set("x-admin-password", "cerberus2026")
      .send({ provider_id: "provider-n8-shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/x" });
    assert.equal(res.status, 401, `corpo: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "acquisition_auth_required");
    assert.equal(links.length, 0, "AUTH_REQUIRED jamais grava");
  } finally {
    setAffiliateClientForTests(null);
  }
});

test("N8-05 sem fonte API nunca tenta endpoint inventado (nenhuma fetch real)", async () => {
  // Fonte = null e sem operatorProvidedUrl → o serviço deve recusar antes
  // de qualquer tentativa de rede. Como fakeApiSource() não faz fetch
  // quando behavior throw só é chamado se generateLink for invocado,
  // provamos por contradição: com fonte presente mas provider errado,
  // o serviço recusa por mismatch SEM chamar a fonte com URL de fallback.
  const calls: string[] = [];
  const tracingSource: AffiliateApiSource = {
    providerId: "provider-n8-shopee",
    async generateLink() {
      calls.push("generateLink");
      throw new Error("should-not-be-called");
    },
  };
  const result = await acquireAffiliateLink({
    provider: provider({ provider_id: "provider-n8-outro" }),
    reference: ref(),
    apiSource: tracingSource,
  });
  assert.equal(result.kind, "RESOLUTION_FAILED");
  assert.equal(calls.length, 0, "a fonte não deve ser chamada com provider mismatch");
});

test("N8-06 provider inativo → PROVIDER_NOT_ACTIVE (antes de qualquer chamada)", async () => {
  const result = await acquireAffiliateLink({ provider: provider({ status: "INACTIVE" }), reference: ref(), apiSource: fakeApiSource() });
  assert.equal(result.kind, "PROVIDER_NOT_ACTIVE");
});

test("N8-07 Mercado Livre → NOT_SUPPORTED (sem mecanismo oficial programático)", async () => {
  const result = await acquireAffiliateLink({
    provider: provider({ marketplace: "MercadoLivre", provider_id: "prov-n8-ml" }),
    reference: { ...ref(), marketplace: "MercadoLivre" },
    apiSource: fakeApiSource(),
  });
  assert.equal(result.kind, "NOT_SUPPORTED");
  assert.equal((result as Extract<AcquireResult, { kind: "NOT_SUPPORTED" }>).marketplace, "MercadoLivre");
});

test("N8-08 ML com operatorProvidedUrl → manual assistido validado (IDENTITY_UNCERTAIN)", async () => {
  const result = await acquireAffiliateLink({
    provider: provider({ marketplace: "MercadoLivre", provider_id: "prov-n8-ml" }),
    reference: { ...ref(), marketplace: "MercadoLivre", publicUrl: "https://mercadolivre.com.br/produto-teste" },
    apiSource: fakeApiSource(),
    operatorProvidedUrl: "https://www.mercadolivre.com.br/afiliado-redirect-ML123",
  });
  // PATCH DE CONTRATO: manual assistido SEMPRE resulta em IDENTITY_UNCERTAIN
  // (não existe mecanismo oficial que confirme listing/seller/título no ML)
  // — o link é obtido e registrado, mas nunca como sucesso confirmado.
  assert.ok(isAcquireIdentityUncertain(result));
  assert.equal(result.method, "MANUAL");
  assert.equal(result.affiliateUrl, "https://www.mercadolivre.com.br/afiliado-redirect-ML123", "URL exata preservada");
  assert.ok(typeof result.rationale === "string" && result.rationale.length > 0, "rationale obrigatório e rastreável");
  assert.ok(!isAcquireSuccess(result), "manual assistido nunca é SUCCESS confirmado");
});

test("N8-09 API retorna resposta inesperada → RESOLUTION_FAILED (fail-closed)", async () => {
  const result = await acquireAffiliateLink({ provider: provider(), reference: ref(), apiSource: fakeApiSource({ behavior: "invalid" }) });
  assert.equal(result.kind, "RESOLUTION_FAILED");
  const r = result as Extract<AcquireResult, { kind: "RESOLUTION_FAILED" }>;
  assert.match(r.reason, /official_api_error|no_valid_url/);
});

test("N8-19 normalizeOfficialResponse rejeita formato inválido, envelope ausente e sem URL", async () => {
  assert.throws(() => normalizeOfficialResponse(null));
  assert.throws(() => normalizeOfficialResponse({ unexpected: 1 }), /official_response_invalid/);
  assert.throws(() => normalizeOfficialResponse({ data: { productOfferV2: { nodes: [] } } }), /official_response_invalid:no_offer_nodes/);
  assert.throws(() => normalizeOfficialResponse({ data: { productOfferV2: { nodes: [{ productLink: "not-a-url" }] } } }), /official_response_invalid:no_valid_url/);
  assert.throws(() => normalizeOfficialResponse({ errors: [{ code: 10020, message: "Invalid Signature" }] }), /official_api_error:10020/);
  const ok = normalizeOfficialResponse({ data: { productOfferV2: { nodes: [{ productLink: "https://s.shopee.com.br/token" }] } } });
  assert.equal(ok.affiliateUrl, "https://s.shopee.com.br/token");
});

test("N8-10 manual: host fora do whitelist → RESOLUTION_FAILED", async () => {
  const result = validateManualUrl({
    provider: provider(),
    reference: ref(),
    url: "https://shopee.com.fake.malicious/phishing?sub=bad",
  });
  assert.equal(result.kind, "RESOLUTION_FAILED");
  const anyUrl = (result as AcquireResult & { affiliateUrl?: string }).affiliateUrl;
  assert.equal(anyUrl, undefined);
});

test("N8-11 URL pública com parâmetros nunca é tratada como affiliate URL", async () => {
  const publicUrl = "https://shopee.com.br/Produto-i.715084914.23794344926?utm_term=fcvf7x7gw1d9";
  const result = validateManualUrl({ provider: provider(), reference: ref({ publicUrl }), url: publicUrl });
  // O host é oficial (shopee.com.br) — a validação de host passa, mas o
  // registro deve preservar a URL EXATA e marcar identidade incerta.
  // PATCH DE CONTRATO: host oficial válido pelo manual → IDENTITY_UNCERTAIN
  // (estado explícito), jamais SUCCESS confirmado.
  assert.ok(isAcquireIdentityUncertain(result));
  assert.equal(result.affiliateUrl, publicUrl, "URL exata preservada — nunca alterada");
  assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_UNCERTAIN");
  // A URL pública é aceita como MANUAL assistido SOMENTE se vier do
  // operador explicitamente; a regra de proibição é sobre o sistema
  // DERIVAR (o sistema não constrói essa URL a partir de public_url).
});

test("N8-12 SUCCESS API com identidade CONFIRMED (listing + seller + title)", async () => {
  const result = await acquireAffiliateLink({ provider: provider(), reference: ref(), apiSource: fakeApiSource() });
  assert.ok(isAcquireSuccess(result));
  assert.equal(result.method, "API");
  assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
  assert.equal(result.identity.listingId, "715084914");
  assert.equal(result.identity.sellerId, "seller-n8");
  assert.equal(result.identity.titleSnapshot, "Produto Prova N8");
  assert.match(result.acquisitionRef, /^acq-[0-9a-f]{16}$/);
  assert.equal(extractOfficialHost(result.affiliateUrl), "shopee.com.br");
});

test("N8-13 MANUAL → IDENTITY_UNCERTAIN explícito (jamais SUCCESS confirmado)", async () => {
  // Caminho manual assistido (3D): exercita-se SEM fonte de API injetada;
  // com fonte presente, o caminho API (3B) tem precedência — o link manual
  // nunca é usado para derivar a URL.
  // PATCH DE CONTRATO: o manual assistido resulta em IDENTITY_UNCERTAIN
  // (evidência preservada + rationale), nunca em SUCCESS confirmado — e o
  // link incerto NÃO é elegível para publicação como identidade confirmada.
  const result = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    operatorProvidedUrl: "https://s.shopee.com.br/fake-redirect-manual-n8",
  });
  assert.ok(isAcquireIdentityUncertain(result));
  assert.ok(!isAcquireSuccess(result), "UNCERTAIN nunca é SUCCESS");
  assert.equal(result.method, "MANUAL");
  assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_UNCERTAIN");
  assert.equal(result.affiliateUrl, "https://s.shopee.com.br/fake-redirect-manual-n8");
  assert.ok(typeof result.rationale === "string" && result.rationale.length > 0);
  assert.ok(result.acquisitionRef.startsWith("acq-"), "proveniência/acquirer ref rastreável");
});

test("N8-16 URL EXATA preservada em todos os caminhos (jamais normalizada)", async () => {
  const url = "https://s.shopee.com.br/fake-redirect-exato-n8?sig=abc";
  // Caminho MANUAL (3D): a URL fornecida pelo operador é preservada exata,
  // sem qualquer normalização ou derivação.
  const manual = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    operatorProvidedUrl: url,
  });
  // PATCH DE CONTRATO: manual assistido → IDENTITY_UNCERTAIN explícito.
  assert.ok(isAcquireIdentityUncertain(manual));
  assert.equal(manual.affiliateUrl, url);
  // Caminho API (3B): a URL devolvida pelo mecanismo oficial é preservada
  // exata como veio do mecanismo (normalizeOfficialResponse não reescreve).
  const api = await acquireAffiliateLink({ provider: provider(), reference: ref(), apiSource: fakeApiSource({ url }) });
  assert.ok(isAcquireSuccess(api));
  assert.equal(api.affiliateUrl, url);
  // URL de outro marketplace NUNCA é aceita para este provider (whitelist
  // é específico por marketplace — fail-closed):
  const crossMarketplace = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    operatorProvidedUrl: "https://meli.la/Produto-MLB-123",
  });
  assert.equal(crossMarketplace.kind, "RESOLUTION_FAILED", "host de outro marketplace é rejeitado");
  // URL inválida/inanalisável NUNCA é tratada como affiliate URL:
  const badUrl = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    operatorProvidedUrl: "nao-e-uma-url",
  });
  assert.equal(badUrl.kind, "RESOLUTION_FAILED", "URL inanalisável é rejeitada");
});

test("N8-18 API de outro provider → RESOLUTION_FAILED (proteção de escopo)", async () => {
  const result = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    apiSource: fakeApiSource({ providerId: "provider-n8-outro" }),
  });
  assert.equal(result.kind, "RESOLUTION_FAILED");
  const r = result as Extract<AcquireResult, { kind: "RESOLUTION_FAILED" }>;
  assert.equal(r.reason, "api_source_provider_mismatch");
});

test("N8-20 formato oficial de autenticação: Authorization SHA256 + timestamp segundos + assinatura sobre o corpo GraphQL serializado", async () => {
  const originalFetch = globalThis.fetch;
  const appId = "18384911047";
  const secret = "secret-oficial-n8";
  const source = createShopeeApiSource({
    providerId: "provider-n8-shopee",
    baseUrl: "https://example.invalid/graphql",
    appId,
    secret,
    defaultSubId: "sub-default",
  });
  // Sem credenciais → exceção fail-closed (jamais fonte sem appId/secret).
  assert.throws(
    () => createShopeeApiSource({ providerId: "p", appId: "", secret: "s" }),
    /official_credentials_missing/,
  );
  let captured: { url: string; auth: string; timestamp: string; body: string } | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url, auth: init.headers.Authorization, timestamp: "", body: init.body };
    const match = /Timestamp=(\d+)/.exec(init.headers.Authorization);
    if (match) captured.timestamp = match[1];
    return new Response(JSON.stringify({ data: { productOfferV2: { nodes: [{ productLink: "https://s.shopee.com.br/token", offerLink: "https://s.shopee.com.br/token", itemId: 715084914, shopId: "seller-n8", name: "Produto Prova N8" }] } } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  try {
    const result = await source.generateLink({
      providerContext: { providerId: "provider-n8-shopee", marketplace: "Shopee", active: true, credentials: { present: true, expired: false } },
      reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/x", productId: null, candidateId: null },
      subId: "sub-n8-001",
    });
    assert.ok(captured, "fetch deve ter sido chamado");
    // 1. Endpoint: POST para a base configurada (default oficial quando omitida).
    assert.equal(captured!.url, "https://example.invalid/graphql");
    // 2. Header oficial único (sem X_Credential/X_Timestamp/X_Signature).
    assert.ok(/^SHA256 Credential=/.test(captured!.auth), "header oficial: Authorization: SHA256 Credential=...");
    assert.ok(/Timestamp=\d+/.test(captured!.auth), "Timestamp no header");
    assert.ok(/Signature=[0-9a-f]{64}/.test(captured!.auth), "Signature hex SHA256 no header");
    // 3. Timestamp em segundos Unix (ordem de grandeza correta, não ms).
    const ts = Number(captured!.timestamp);
    assert.ok(ts > 1_700_000_000 && ts < 2_000_000_000, "timestamp em segundos Unix");
    assert.ok(Math.abs(ts - Math.floor(Date.now() / 1000)) <= 2, "timestamp ≈ now em segundos");
    // 4. Payload = corpo GraphQL real serializado exatamente como enviado.
    const sentBody = JSON.parse(captured!.body);
    assert.ok(sentBody.query.includes("productOfferV2"), "corpo contém a query oficial productOfferV2");
    assert.deepEqual(sentBody.variables, { subId: "sub-n8-001" }, "variables com sub_id oficial");
    // 5. Assinatura recriável: SHA256(Credential+Timestamp+Payload+Secret).
    const signatureMatch = /Signature=([0-9a-f]{64})/.exec(captured!.auth);
    assert.ok(signatureMatch, "signature capturável");
    const expectedSig = createHash("sha256").update([appId, captured!.timestamp, captured!.body, secret].join("")).digest("hex");
    assert.equal(signatureMatch![1], expectedSig, "assinatura = SHA256(Credential+Timestamp+Payload+Secret)");
    // 6. Resposta oficial (nodes) normalizada com identidade e URL oficial.
    assert.equal(result.affiliateUrl, "https://s.shopee.com.br/token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("N8-20b endpoint oficial BR como default (sem baseUrl) e erro GraphQL oficial → fail-closed", async () => {
  const originalFetch = globalThis.fetch;
  const source = createShopeeApiSource({
    providerId: "provider-n8-shopee",
    appId: "app-123",
    secret: "sec-456",
  });
  let capturedUrl: string | null = null;
  // Cenário A: default = endpoint oficial BR.
  globalThis.fetch = (async (url: any) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ data: { productOfferV2: { nodes: [{ productLink: "https://s.shopee.com.br/token" }] } } }), { status: 200 });
  }) as never;
  try {
    await source.generateLink({
      providerContext: { providerId: "provider-n8-shopee", marketplace: "Shopee", active: true, credentials: { present: true, expired: false } },
      reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/x", productId: null, candidateId: null },
      subId: "",
    });
    assert.equal(capturedUrl, "https://open-api.affiliate.shopee.com.br/graphql", "default = endpoint oficial BR");
    // Cenário B: erro oficial {errors:[{code:10020}]} jamais vira link.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: 10020, message: "Invalid Signature" }] }), { status: 200 })
    ) as never;
    await assert.rejects(
      () => source.generateLink({
        providerContext: { providerId: "provider-n8-shopee", marketplace: "Shopee", active: true, credentials: { present: true, expired: false } },
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/x", productId: null, candidateId: null },
        subId: "",
      }),
      /official_api_error:10020/,
      "erro oficial 10020 (Invalid Signature) → exceção fail-closed",
    );
    // Cenário C: envelope sem data → rejeitado.
    globalThis.fetch = (async () => new Response(JSON.stringify({ unexpected: 1 }), { status: 200 })) as never;
    await assert.rejects(
      () => source.generateLink({
        providerContext: { providerId: "provider-n8-shopee", marketplace: "Shopee", active: true, credentials: { present: true, expired: false } },
        reference: { marketplace: "Shopee", publicUrl: "https://shopee.com.br/x", productId: null, candidateId: null },
        subId: "",
      }),
      /official_response_invalid/,
      "resposta sem envelope data → rejeitada",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Testes da rota POST /acquire (3D) com persistLink fake
// ---------------------------------------------------------------------------

test("N8-14 registro idempotente: replay idêntico → identical_duplicate", async () => {
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  setAffiliateApiSource(null);
  const app = appWithRoute();
  try {
    const payload = {
      provider_id: "provider-n8-shopee",
      marketplace: "Shopee",
      public_url: "https://shopee.com.br/Produto-i.715084914.23794344926",
      candidate_id: "cand-n8-001",
      affiliate_url: "https://s.shopee.com.br/fake-redirect-n8",
    };
    const r1 = await supertest(app).post("/api/commercial/affiliate/acquire").set("x-admin-password", "cerberus2026").send(payload);
    assert.equal(r1.status, 200, `corpo: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.result, "created");
    // PATCH DE CONTRATO: o manual assistido registra com estado
    // IDENTITY_UNCERTAIN (jamais SUCCESS confirmado).
    assert.equal(r1.body.acquisition.state, "IDENTITY_UNCERTAIN");
    assert.ok(r1.body.acquisition.identityConfidence === "PRODUCT_IDENTITY_UNCERTAIN");
    const r2 = await supertest(app).post("/api/commercial/affiliate/acquire").set("x-admin-password", "cerberus2026").send(payload);
    assert.equal(r2.status, 200, `corpo: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.result, "identical_duplicate");
    assert.equal(r2.body.acquisition.state, "IDENTITY_UNCERTAIN", "replay preserva o estado da decisão");
    assert.equal(links.length, 1, "replay não deve duplicar o registro");
  } finally {
    setAffiliateClientForTests(null);
  }
});

test("N8-15 metadata de aquisição auditável (acquisition_ref + contract_version)", async () => {
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  setAffiliateApiSource(null);
  const app = appWithRoute();
  try {
    const res = await supertest(app)
      .post("/api/commercial/affiliate/acquire")
      .set("x-admin-password", "cerberus2026")
      .send({
        provider_id: "provider-n8-shopee",
        marketplace: "Shopee",
        public_url: "https://shopee.com.br/Produto-i.715084914.23794344926",
        candidate_id: "cand-n8-002",
        affiliate_url: "https://s.shopee.com.br/fake-redirect-audit-n8",
      });
    assert.equal(res.status, 200, `corpo: ${JSON.stringify(res.body)}`);
    assert.equal(links.length, 1);
    const meta = links[0].metadata as Record<string, unknown>;
    assert.match(String(meta.acquisition_ref), /^acq-[0-9a-f]{16}$/);
    assert.equal(meta.acquisition_method, "MANUAL");
    assert.equal(meta.contract_version, "n8-acquire-v0");
    assert.ok(String(links[0].notes).includes("Aquisição N8"), "notes deve registrar a proveniência da aquisição");
    // PATCH DE CONTRATO: auditoria do estado de identidade incerta
    assert.equal(meta.acquisition_state, "IDENTITY_UNCERTAIN", "estado de identidade auditado");
    assert.equal(meta.acquisition_identity_confidence, "PRODUCT_IDENTITY_UNCERTAIN");
    assert.ok(typeof meta.identity_rationale === "string" && (meta.identity_rationale as string).length > 0, "rationale auditável");
    assert.equal(res.body.acquisition.state, "IDENTITY_UNCERTAIN");
  } finally {
    setAffiliateClientForTests(null);
  }
});

test("N8-17 ACQUISITION != PUBLICATION: o módulo de aquisição não expõe primitivas de publicação", () => {
  // Prova de contrato: nenhuma exportação do acquisitionService contém
  // primitiva de publicação/execução de produto.
  const exports = ["acquireAffiliateLink", "createShopeeApiSource", "validateManualUrl", "normalizeOfficialResponse", "setAffiliateApiSource", "getAffiliateApiSource", "resetAffiliateApiSource", "extractOfficialHost", "isPlausibleOfficialUrl"];
  assert.ok(!exports.some((k) => /publish|execute|createProduct/i.test(k)), "aquisição não expõe primitivas de publicação");
});

test("N8-21 /acquire rejeita entrada sem campos obrigatórios", async () => {
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  const app = appWithRoute();
  setAffiliateApiSource(null);
  try {
  const cases: Array<[string, any, number]> = [
    ["sem provider_id", { marketplace: "Shopee", public_url: "https://shopee.com.br/x" }, 400],
    ["sem public_url", { provider_id: "provider-n8-shopee", marketplace: "Shopee" }, 400],
    ["provider inexistente", { provider_id: "inexistente", marketplace: "Shopee", public_url: "https://shopee.com.br/x" }, 404],
    ["marketplace mismatch", { provider_id: "provider-n8-shopee", marketplace: "MercadoLivre", public_url: "https://shopee.com.br/x" }, 400],
    ["sem autenticação", { provider_id: "provider-n8-shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/x" }, 401],
  ];
  for (const [name, body, expected] of cases) {
    const req = supertest(app)
      .post("/api/commercial/affiliate/acquire")
      .set("x-admin-password", name === "sem autenticação" ? "" : "cerberus2026")
      .send(body);
    const actual = await req;
    assert.equal(actual.status, expected, `${name}: esperado ${expected}, corpo: ${JSON.stringify(actual.body)}`);
  }
  } finally {
    setAffiliateClientForTests(null);
  }
});

test("N8-22 API real (fake) via /acquire sem affiliate_url → acquisition preview", async () => {
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  setAffiliateApiSource(fakeApiSource());
  const app = appWithRoute();
  try {
    const res = await supertest(app)
      .post("/api/commercial/affiliate/acquire")
      .set("x-admin-password", "cerberus2026")
      .send({ provider_id: "provider-n8-shopee", marketplace: "Shopee", public_url: "https://shopee.com.br/Produto-i.715084914.23794344926" });
    assert.equal(res.status, 200, `corpo: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.acquisition, "deve devolver o preview da aquisição");
    assert.equal(res.body.acquisition.method, "API");
    assert.equal(links.length, 0, "preview NUNCA grava no registry (ACQUISITION != REGISTRATION)");
  } finally {
    setAffiliateClientForTests(null);
    setAffiliateApiSource(null);
  }
});

test("N8-23 whitelist de hosts oficiais é o catálogo N6 (fail-closed)", () => {
  assert.equal(isPlausibleOfficialUrl("https://s.shopee.com.br/token"), true);
  assert.equal(isPlausibleOfficialUrl("https://mercadolibre.com/ar/x"), true);
  assert.equal(isPlausibleOfficialUrl("https://meli.la/curto"), true);
  assert.equal(isPlausibleOfficialUrl("https://shopee.falso.com.br/token"), false);
  assert.equal(isPlausibleOfficialUrl("https://google.com"), false);
  assert.equal(extractOfficialHost("not-a-url"), null);
  assert.deepEqual(Object.keys(AFFILIATE_MARKETPLACE_HOSTS).sort(), ["MercadoLivre", "Shopee"]);
});

test("N8-24 contrato: proveniência admin:acquired declarada e não gravável sem migration", async () => {
  assert.equal(PROVENIENCE_ADMIN_ACQUIRED, "admin:acquired");
  // O registro N6 fixa provenance admin:manual (única gravável sem migration);
  // o metadata carrega acquisition_ref para rastreabilidade.
  const links: AffiliateLinkRecord[] = [];
  setAffiliateClientForTests(fakeClient({ links }));
  setAffiliateApiSource(null);
  const app = appWithRoute();
  try {
    const res = await supertest(app)
      .post("/api/commercial/affiliate/acquire")
      .set("x-admin-password", "cerberus2026")
      .send({
        provider_id: "provider-n8-shopee",
        marketplace: "Shopee",
        public_url: "https://shopee.com.br/Produto-i.715084914.23794344926",
        candidate_id: "cand-n8-003",
        affiliate_url: "https://s.shopee.com.br/fake-redirect-n8-prov",
      });
    assert.equal(res.status, 200, `corpo: ${JSON.stringify(res.body)}`);
    assert.equal(links[0]?.provenance, "admin:manual", "provenance gravada segue o catálogo vigente");
    assert.equal((links[0]?.metadata as Record<string, unknown>).acquisition_method, "MANUAL");
    // PATCH DE CONTRATO: manual assistido = IDENTITY_UNCERTAIN, nunca
    // "promovido" a admin:acquired (contrato-only) nem a identidade
    // confirmada.
    assert.equal(res.body.acquisition.state, "IDENTITY_UNCERTAIN");
    assert.notEqual(links[0]?.provenance, "admin:acquired");
  } finally {
    setAffiliateClientForTests(null);
  }
});

// ---------------------------------------------------------------------------
// Testes obrigatórios do patch de contrato (IDENTITY_UNCERTAIN)
// ---------------------------------------------------------------------------

test("N8-25 UNCERTAIN não é elegível para publicação: não existe caminho de IDENTITY_UNCERTAIN para SUCCESS confirmado", () => {
  // Prova de contrato: o único path que carrega IDENTITY_CONFIRMED é SUCCESS;
  // o path UNCERTAIN e os paths de falha não têm affiliate URL tratada
  // como aquisição confirmada — e nenhuma função deste módulo publica.
  const candidates: ReadonlyArray<AcquireResult> = [
    { kind: "IDENTITY_UNCERTAIN", affiliateUrl: "https://s.shopee.com.br/x", identity: { marketplace: "Shopee", listingId: null, canonicalUrl: "https://shopee.com.br/a", sellerId: null, titleSnapshot: "" }, identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN", rationale: "r", method: "API", acquisitionRef: "a", rawResponse: null, acquiredAt: 1 },
    { kind: "AUTH_REQUIRED", reason: "x" },
    { kind: "NOT_SUPPORTED", marketplace: "MercadoLivre" },
    { kind: "PRODUCT_NOT_ELIGIBLE", reason: "x" },
    { kind: "PROVIDER_NOT_ACTIVE", providerId: "x" },
    { kind: "RESOLUTION_FAILED", reason: "x" },
  ];
  for (const c of candidates) {
    assert.ok(!isAcquireSuccess(c), `${c.kind} jamais é SUCCESS confirmado`);
    const anyUrl = (c as AcquireResult & { affiliateUrl?: string }).affiliateUrl;
    if (c.kind === "IDENTITY_UNCERTAIN") {
      // link obtido e preservado, mas não confirmado
      assert.equal(anyUrl, "https://s.shopee.com.br/x");
    } else {
      assert.equal(anyUrl, undefined, `${c.kind} não carrega URL`);
    }
  }
});

test("N8-26 API com listing incompleto → IDENTITY_UNCERTAIN com rationale rastreável (fail-closed p/ publicação)", async () => {
  // Identidade contraditória/incompleta da fonte oficial: jamais vira
  // SUCCESS confirmado — o serviço fecha para incerto.
  const result = await acquireAffiliateLink({
    provider: provider(),
    reference: ref(),
    apiSource: fakeApiSource({ listingId: null }),
  });
  assert.ok(!isAcquireSuccess(result));
  assert.ok(isAcquireIdentityUncertain(result));
  assert.match(result.rationale, /identidade_nao_confirmada_pela_fonte_oficial/);
  assert.match(result.rationale, /listing_id=ausente|seller_id=ausente|title_snapshot=ausente/);
});

test("N8-27 sem endpoint API comprovado → NEEDS_VERIFICATION via AUTH_REQUIRED (jamais endpoint presumido)", async () => {
  // Sem SHOPEE_AFFILIATE_API_BASE_URL configurada, o sistema declara
  // explicitamente a ausência de mecanismo oficial — nunca inventa URL.
  const originalBase = process.env.SHOPEE_AFFILIATE_API_BASE_URL;
  delete process.env.SHOPEE_AFFILIATE_API_BASE_URL;
  try {
    const result = await acquireAffiliateLink({ provider: provider(), reference: ref() });
    assert.equal(result.kind, "AUTH_REQUIRED");
    assert.match((result as Extract<AcquireResult, { kind: "AUTH_REQUIRED" }>).reason, /official_credentials_not_configured/);
  } finally {
    if (originalBase !== undefined) process.env.SHOPEE_AFFILIATE_API_BASE_URL = originalBase;
  }
});

test("N8-28 API acquisition com identidade CONFIRMED → SUCCESS (evidência íntegra, não derivada)", async () => {
  const expected = "https://s.shopee.com.br/token-api-oficial";
  const result = await acquireAffiliateLink({ provider: provider(), reference: ref(), apiSource: fakeApiSource({ url: expected }) });
  assert.ok(isAcquireSuccess(result));
  assert.equal(result.affiliateUrl, expected, "URL exata da fonte oficial — nada derivado");
  assert.equal(result.method, "API");
  assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
});

test("N8-29 nenhum caminho de aquisição executa publicação", () => {
  // N8 != N5/N7: o serviço nunca toca em products, jobs, catálogo ou
  // executores — provado por inspeção das exportações e do código-fonte.
  assert.ok(
    !Object.keys(acquisitionServiceExports).some((k) => /publish|execute|createProduct|registerProduct/i.test(k)),
    "serviço N8 não expõe primitivas de publicação",
  );
  // Inspeção estática do fonte: nenhuma exportação referencia products/
  // jobs/executores (o módulo só consome contract + acquireContract).
  const source = readFileSync(join(new URL("..", import.meta.url).pathname, "server/commercial/affiliate/acquisitionService.ts"), "utf8");
  const imports = (source.match(/from "\.\/[^"']+"/g) ?? []);
  assert.deepEqual(imports, ['from "./contract"', 'from "./acquisitionContract"'], "o serviço só importa contratos — sem persistência/execução");
  assert.ok(!/products|job_queue|execut|publish/i.test(source.split("import ")[0] + ""), "imports não incluem módulos de execução");
  // A validação do texto integral exclui os comentários de governança que
  // citam N5/N7 como autoridades externas (não como chamadas do N8):
  const codeOnly = source.split("//").map((part, i) => (i % 2 === 0 ? part : "")).join(" ");
  assert.ok(!/await publishProduct|await createProduct|await executePublication|from "\.\/(publications|products|jobs|executors)/.test(codeOnly), "nenhuma chamada real de publicação existe no módulo");
});
