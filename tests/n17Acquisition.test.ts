import assert from "node:assert/strict";
import test from "node:test";
import type { AcquireResult } from "../server/commercial/affiliate/acquisitionContract";
import type {
  AffiliateProviderRecord,
} from "../server/commercial/affiliate/contract";
import {
  acquireN17,
  buildN17IdempotencyKey,
} from "../server/commercial/affiliate/n17Service";
import type {
  N17AcquireRequest,
  N17AcquisitionRecord,
  N17AuthorizationSnapshot,
  N17Dependencies,
  N17Repository,
} from "../server/commercial/affiliate/n17Contract";

const FIXED_NOW = "2026-08-20T07:00:00.000Z";
const PROVIDER_ID = "affprv-shopee";
const CANDIDATE_ID = "can-n17-test-0001";
const PRODUCT_ID = "23794344926";
const SHOP_ID = "1530442944";

const provider: AffiliateProviderRecord = {
  provider_id: PROVIDER_ID,
  provider_code: "shopee",
  name: "Shopee Affiliate BR",
  marketplace: "Shopee",
  program_name: "Shopee Affiliate",
  status: "ACTIVE",
  resolution_method: "API",
  ownership: "owner-human",
  provenance: "admin:manual",
  credential_ref: "env:shopee",
  terms_url: "https://affiliate.shopee.com.br/",
  notes: "fixture",
  contract_version: "n6-provider-v1",
  idempotency_key: "provider-shopee",
  metadata: {},
  created_by: "test",
  created_at: FIXED_NOW,
  updated_at: FIXED_NOW,
};

function makeRequest(overrides: Partial<N17AcquireRequest> = {}): N17AcquireRequest {
  const base: N17AcquireRequest = {
    candidate_id: CANDIDATE_ID,
    product_id: null,
    marketplace: "Shopee",
    provider_id: PROVIDER_ID,
    public_product_url: `https://shopee.com.br/product/${SHOP_ID}/${PRODUCT_ID}`,
    source_product_id: PRODUCT_ID,
    source_shop_id: SHOP_ID,
    authorization_ref: "auth-n17-0001",
    assessment_id: "assessment-n15-0001",
    action: "ACQUIRE_AFFILIATE",
    idempotency_key: "",
    provenance: {
      provider: PROVIDER_ID,
      marketplace: "Shopee",
      method: "API",
      source_operation: "productOfferV2",
      source_url_origin: "official_provider",
    },
    tracking_context: { test: true },
    requested_at: FIXED_NOW,
  };
  const request = { ...base, ...overrides };
  return {
    ...request,
    idempotency_key: overrides.idempotency_key ?? buildN17IdempotencyKey(request),
  };
}

function makeAuthorization(overrides: Partial<N17AuthorizationSnapshot> = {}) {
  return {
    authorization_ref: "auth-n17-0001",
    candidate_id: CANDIDATE_ID,
    action: "ACQUIRE_AFFILIATE" as const,
    status: "APPROVED" as const,
    assessment_id: "assessment-n15-0001",
    expires_at: null,
    ...overrides,
  };
}

function makeSuccess(overrides: Partial<Extract<AcquireResult, { kind: "SUCCESS" }>> = {}): Extract<AcquireResult, { kind: "SUCCESS" }> {
  return {
    kind: "SUCCESS",
    affiliateUrl: "https://shopee.com.br/universal-link/n17-proof",
    identity: {
      marketplace: "Shopee",
      listingId: PRODUCT_ID,
      canonicalUrl: `https://shopee.com.br/product/${SHOP_ID}/${PRODUCT_ID}`,
      sellerId: SHOP_ID,
      titleSnapshot: "Produto de teste N17",
    },
    identityConfidence: "PRODUCT_IDENTITY_CONFIRMED",
    method: "API",
    acquisitionRef: "acq-n17-realistic-ref",
    rawResponse: { safe: true },
    acquiredAt: Date.parse(FIXED_NOW),
    ...overrides,
  };
}

function makeRepository(existing: N17AcquisitionRecord | null = null, outcome: "created" | "identical_duplicate" | "conflict" | "failed" = "created") {
  let stored = existing;
  let persistCalls = 0;
  const repository: N17Repository = {
    async findByIdempotencyKey() {
      return stored;
    },
    async persist(record) {
      persistCalls += 1;
      if (outcome === "created") {
        stored = record;
        return { outcome, record };
      }
      if (outcome === "identical_duplicate") return { outcome, record: stored ?? record };
      if (outcome === "conflict") return { outcome, record: null, reason: "digest_conflict" };
      return { outcome, record: null, reason: "storage_unavailable" };
    },
    get persistCalls() {
      return persistCalls;
    },
  } as N17Repository & { readonly persistCalls: number };
  return repository as N17Repository & { readonly persistCalls: number };
}

function makeDeps(params: {
  acquireResult?: AcquireResult;
  authorization?: ReturnType<typeof makeAuthorization> | null;
  providerRecord?: AffiliateProviderRecord | null;
  repository?: ReturnType<typeof makeRepository>;
    onAcquire?: () => void;
    acquireError?: Error;
  } = {}): N17Dependencies & { readonly acquireCalls: () => number } {
  let acquireCalls = 0;
  const repository = params.repository ?? makeRepository();
  const deps: N17Dependencies = {
    providerStore: {
      async getById() {
        return params.providerRecord === undefined ? provider : params.providerRecord;
      },
    },
    authorizationStore: {
      async getByRef() {
        return params.authorization === undefined ? makeAuthorization() : params.authorization;
      },
    },
    repository,
    async acquire() {
      acquireCalls += 1;
      params.onAcquire?.();
      if (params.acquireError) throw params.acquireError;
      return params.acquireResult ?? makeSuccess();
    },
    now: () => new Date(FIXED_NOW),
  };
  return Object.assign(deps, { acquireCalls: () => acquireCalls });
}

test("N17 bloqueia request sem autorização e não chama N8", async () => {
  const deps = makeDeps({ authorization: null });
  const result = await acquireN17(makeRequest(), deps);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.error_kind, "AUTHORIZATION_INVALID");
  assert.equal(deps.acquireCalls(), 0);
});

test("N17 bloqueia autorização não APPROVED, candidate divergente e expirada", async (t) => {
  await t.test("não APPROVED", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ authorization: makeAuthorization({ status: "REVIEW" as never }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason_sanitized, "authorization_not_approved");
  });
  await t.test("candidate divergente", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ authorization: makeAuthorization({ candidate_id: "can-other" }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason_sanitized, "authorization_candidate_mismatch");
  });
  await t.test("expirada", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ authorization: makeAuthorization({ expires_at: "2026-08-19T23:59:59.000Z" }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason_sanitized, "authorization_expired");
  });
});

test("N17 bloqueia action, provenance, URL e ids Shopee inválidos", async (t) => {
  await t.test("action inválida", async () => {
    const request = makeRequest({ action: "PUBLISH" as never });
    const result = await acquireN17(request, makeDeps());
    assert.equal(result.reason_sanitized, "action_not_allowed");
  });
  await t.test("provenance divergente", async () => {
    const result = await acquireN17(makeRequest({ provenance: { ...makeRequest().provenance, provider: "other-provider" } }), makeDeps());
    assert.equal(result.reason_sanitized, "provenance_provider_mismatch");
  });
  await t.test("URL não oficial", async () => {
    const result = await acquireN17(makeRequest({ public_product_url: "https://example.com/product" }), makeDeps());
    assert.equal(result.reason_sanitized, "public_product_url_not_official");
  });
  await t.test("source product ausente", async () => {
    const request = makeRequest({ source_product_id: null });
    const result = await acquireN17(request, makeDeps());
    assert.equal(result.reason_sanitized, "source_product_id_missing");
  });
  await t.test("source shop ausente", async () => {
    const request = makeRequest({ source_shop_id: null });
    const result = await acquireN17(request, makeDeps());
    assert.equal(result.reason_sanitized, "source_shop_id_missing");
  });
  await t.test("idempotency inválida", async () => {
    const result = await acquireN17(makeRequest({ idempotency_key: "not-deterministic" }), makeDeps());
    assert.equal(result.error_kind, "IDEMPOTENCY_INVALID");
  });
});

test("N17 valida provider ativo e marketplace antes de chamar N8", async (t) => {
  await t.test("provider ausente", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ providerRecord: null }));
    assert.equal(result.error_kind, "PROVIDER_NOT_FOUND");
  });
  await t.test("provider inativo", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ providerRecord: { ...provider, status: "INACTIVE" } }));
    assert.equal(result.error_kind, "PROVIDER_NOT_ACTIVE");
  });
  await t.test("marketplace divergente", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ providerRecord: { ...provider, marketplace: "MercadoLivre" } }));
    assert.equal(result.error_kind, "PROVIDER_MARKETPLACE_MISMATCH");
  });
});

test("N17 produz ACQUIRED com identidade confirmada, provenance e digest seguro", async () => {
  let calls = 0;
  const repository = makeRepository();
  const result = await acquireN17(makeRequest(), makeDeps({ repository, onAcquire: () => { calls += 1; } }));
  assert.equal(result.status, "ACQUIRED");
  assert.equal(result.listing_id, PRODUCT_ID);
  assert.equal(result.seller_id, SHOP_ID);
  assert.equal(result.title_snapshot, "Produto de teste N17");
  assert.equal(result.provenance?.source_operation, "productOfferV2");
  assert.equal(result.provenance?.method, "API");
  assert.match(result.response_digest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls, 1);
  assert.equal(repository.persistCalls, 1);
  assert.equal(result.affiliate_url, "https://shopee.com.br/universal-link/n17-proof");
});

test("N17 replay é ALREADY_ACQUIRED e não chama N8 novamente", async () => {
  const request = makeRequest();
  const firstRepository = makeRepository();
  const firstDeps = makeDeps({ repository: firstRepository });
  const first = await acquireN17(request, firstDeps);
  assert.equal(first.status, "ACQUIRED");
  const stored = await firstRepository.findByIdempotencyKey(request.idempotency_key);
  assert.ok(stored);
  const replayDeps = makeDeps({ repository: makeRepository(stored), onAcquire: () => { throw new Error("N8 must not be called on replay"); } });
  const replay = await acquireN17(request, replayDeps);
  assert.equal(replay.status, "ALREADY_ACQUIRED");
  assert.equal(replay.response_digest, first.response_digest);
  assert.equal(replay.acquisition_ref, first.acquisition_ref);
  assert.equal(replayDeps.acquireCalls(), 0);
});

test("N17 bloqueia replay com conflito de identidade", async () => {
  const request = makeRequest();
  const repository = makeRepository();
  const first = await acquireN17(request, makeDeps({ repository }));
  assert.equal(first.status, "ACQUIRED");
  const stored = await repository.findByIdempotencyKey(request.idempotency_key);
  assert.ok(stored);
  const result = await acquireN17(request, makeDeps({ repository: makeRepository({ ...stored, identity: { ...stored.identity, listing_id: "other-item" } }) }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.error_kind, "IDEMPOTENCY_CONFLICT");
});

test("N17 mapeia falhas N8 de forma fechada e nunca persiste link", async (t) => {
  const cases: Array<[string, AcquireResult, string, string]> = [
    ["identity incerta", { kind: "IDENTITY_UNCERTAIN", affiliateUrl: null, identity: null, identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN", rationale: "identity_missing", method: "API", acquisitionRef: null, rawResponse: null, acquiredAt: Date.parse(FIXED_NOW) } as never, "BLOCKED", "IDENTITY_UNCERTAIN"],
    ["resolution failed", { kind: "RESOLUTION_FAILED", reason: "official_resolution_failed" }, "FAILED", "RESOLUTION_FAILED"],
    ["auth required", { kind: "AUTH_REQUIRED", reason: "credentials_missing" }, "BLOCKED", "AUTH_REQUIRED"],
    ["not supported", { kind: "NOT_SUPPORTED", marketplace: "MercadoLivre" }, "BLOCKED", "NOT_SUPPORTED"],
    ["manual required", { kind: "MANUAL_REQUIRED", reason: "manual_required" }, "BLOCKED", "MANUAL_REQUIRED"],
    ["provider inactive", { kind: "PROVIDER_NOT_ACTIVE", providerId: PROVIDER_ID }, "BLOCKED", "PROVIDER_NOT_ACTIVE"],
    ["not eligible", { kind: "PRODUCT_NOT_ELIGIBLE", reason: "not_eligible" }, "NOT_ELIGIBLE", "PRODUCT_NOT_ELIGIBLE"],
  ];
  for (const [name, n8, expectedStatus, expectedKind] of cases) {
    await t.test(name, async () => {
      const repository = makeRepository();
      const result = await acquireN17(makeRequest(), makeDeps({ acquireResult: n8, repository }));
      assert.equal(result.status, expectedStatus);
      assert.equal(result.error_kind, expectedKind);
      assert.equal(repository.persistCalls, 0);
    });
  }
});

test("N17 rejeita SUCCESS do N8 sem identidade, URL oficial ou método compatível", async (t) => {
  await t.test("identidade ausente", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ acquireResult: makeSuccess({ identity: { marketplace: "Shopee", listingId: null, canonicalUrl: "https://shopee.com.br/product/x/y", sellerId: null, titleSnapshot: "" } }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.error_kind, "N8_CONTRACT_INVALID");
  });
  await t.test("affiliate URL não oficial", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ acquireResult: makeSuccess({ affiliateUrl: "https://evil.example/link" }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.error_kind, "N8_CONTRACT_INVALID");
  });
  await t.test("método divergente", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ acquireResult: makeSuccess({ method: "MANUAL" }) }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.error_kind, "N8_CONTRACT_INVALID");
  });
});

test("N17 converte conflito e falha de persistência em estados explícitos", async (t) => {
  await t.test("conflito", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ repository: makeRepository(null, "conflict") }));
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.error_kind, "PERSISTENCE_CONFLICT");
  });
  await t.test("falha", async () => {
    const result = await acquireN17(makeRequest(), makeDeps({ repository: makeRepository(null, "failed") }));
    assert.equal(result.status, "FAILED");
    assert.equal(result.error_kind, "PERSISTENCE_FAILED");
  });
});

test("N17 converte exceção do N8 em FAILED sem vazar detalhes", async () => {
  const deps = makeDeps({ acquireError: new Error("request failed token=super-secret") });
  const result = await acquireN17(makeRequest(), deps);
  assert.equal(result.status, "FAILED");
  assert.equal(result.error_kind, "N8_EXCEPTION");
  assert.equal(result.reason_sanitized, "request failed token=[REDACTED]");
});
