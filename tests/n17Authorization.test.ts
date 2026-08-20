import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AcquireResult } from "../server/commercial/affiliate/acquisitionContract";
import type {
  AffiliateProviderRecord,
} from "../server/commercial/affiliate/contract";
import {
  createN17AuthorizationStore,
} from "../server/commercial/affiliate/n17AuthorizationStore";
import {
  createN17RuntimeDeps,
} from "../server/commercial/affiliate/n17Runtime";
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
import { setCandidateAssessmentClient } from "../server/repositories/candidateAssessmentRepository";

const NOW = "2026-08-20T07:00:00.000Z";
const CANDIDATE_ID = "can-n17-auth-test";
const OTHER_CANDIDATE_ID = "can-n17-other";
const ASSESSMENT_ID = "assessment-n15-auth-001";
const AUTHORIZATION_REF = "decision-n15-auth-001";
const PROVIDER_ID = "affprv-shopee";
const ITEM_ID = "23794344926";
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
  notes: "local fixture",
  contract_version: "n6-provider-v1",
  idempotency_key: "provider-shopee",
  metadata: {},
  created_by: "test",
  created_at: NOW,
  updated_at: NOW,
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessment_id: ASSESSMENT_ID,
    candidate_id: CANDIDATE_ID,
    filter_version: "n15:governance_v1",
    dimensions: {
      action: "ACQUIRE_AFFILIATE",
      status: "APPROVED",
    },
    input_snapshot: {
      governance: {
        decision_id: AUTHORIZATION_REF,
        action: "ACQUIRE_AFFILIATE",
        status: "APPROVED",
        expires_at: null,
      },
      candidate_snapshot: {
        candidate_id: CANDIDATE_ID,
        marketplace: "Shopee",
        external_listing_id: ITEM_ID,
      },
    },
    created_at: "2026-08-20T06:00:00.000Z",
    ...overrides,
  };
}

function fakeAssessmentClient(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, "candidate_assessment");
      let selected = rows;
      const chain = {
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          if (column === "candidate_id") {
            selected = selected.filter((item) => item.candidate_id === value);
          }
          return chain;
        },
        order() {
          selected = [...selected].sort(
            (left, right) =>
              new Date(String(right.created_at)).getTime() -
              new Date(String(left.created_at)).getTime(),
          );
          return chain;
        },
        limit(limit: number) {
          return Promise.resolve({ data: selected.slice(0, limit), error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function makeRequest(overrides: Partial<N17AcquireRequest> = {}): N17AcquireRequest {
  const base: N17AcquireRequest = {
    candidate_id: CANDIDATE_ID,
    product_id: null,
    marketplace: "Shopee",
    provider_id: PROVIDER_ID,
    public_product_url: `https://shopee.com.br/product/${SHOP_ID}/${ITEM_ID}`,
    source_product_id: ITEM_ID,
    source_shop_id: SHOP_ID,
    authorization_ref: AUTHORIZATION_REF,
    assessment_id: ASSESSMENT_ID,
    action: "ACQUIRE_AFFILIATE",
    idempotency_key: "",
    provenance: {
      provider: PROVIDER_ID,
      marketplace: "Shopee",
      method: "API",
      source_operation: "productOfferV2",
      source_url_origin: "official_provider",
    },
    requested_at: NOW,
  };
  const request = { ...base, ...overrides };
  return {
    ...request,
    idempotency_key: overrides.idempotency_key ?? buildN17IdempotencyKey(request),
  };
}

function authorization(overrides: Partial<N17AuthorizationSnapshot> = {}): N17AuthorizationSnapshot {
  return {
    authorization_ref: AUTHORIZATION_REF,
    candidate_id: CANDIDATE_ID,
    action: "ACQUIRE_AFFILIATE",
    status: "APPROVED",
    assessment_id: ASSESSMENT_ID,
    expires_at: null,
    ...overrides,
  };
}

function success(): Extract<AcquireResult, { kind: "SUCCESS" }> {
  return {
    kind: "SUCCESS",
    affiliateUrl: "https://shopee.com.br/universal-link/n17-auth-test",
    identity: {
      marketplace: "Shopee",
      listingId: ITEM_ID,
      canonicalUrl: `https://shopee.com.br/product/${SHOP_ID}/${ITEM_ID}`,
      sellerId: SHOP_ID,
      titleSnapshot: "Produto N17 local",
    },
    identityConfidence: "PRODUCT_IDENTITY_CONFIRMED",
    method: "API",
    acquisitionRef: "acq-n17-auth-test",
    rawResponse: { safe: true },
    acquiredAt: Date.parse(NOW),
  };
}

function repository(log: string[]): N17Repository {
  return {
    async findByIdempotencyKey() {
      return null;
    },
    async persist(record: N17AcquisitionRecord) {
      log.push("N6.persistN17Acquisition");
      return { outcome: "created", record };
    },
  };
}

function depsWithAuthorization(
  auth: N17AuthorizationSnapshot | null,
  log: string[],
): N17Dependencies {
  return {
    authorizationStore: {
      async getByRef(ref, candidateId) {
        log.push(`N15.getByRef:${ref}:${candidateId}`);
        return auth;
      },
    },
    providerStore: {
      async getById(providerId) {
        log.push(`N6.getProvider:${providerId}`);
        return provider;
      },
    },
    repository: repository(log),
    async acquire() {
      log.push("N8.acquireAffiliateLink");
      return success();
    },
    now: () => new Date(NOW),
  };
}

test("N17 authorization store retorna null quando a autorização está ausente", async () => {
  const store = createN17AuthorizationStore(
    fakeAssessmentClient([]),
    () => new Date(NOW),
  );
  assert.equal(await store.getByRef(AUTHORIZATION_REF, CANDIDATE_ID), null);
});

test("N17 bloqueia autorização N15 inválida por action divergente", async () => {
  const store = createN17AuthorizationStore(
    fakeAssessmentClient([
      row({ dimensions: { action: "PUBLISH", status: "APPROVED" } }),
    ]),
    () => new Date(NOW),
  );
  assert.equal(await store.getByRef(AUTHORIZATION_REF, CANDIDATE_ID), null);

  const result = await acquireN17(
    makeRequest(),
    depsWithAuthorization(null, []),
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.error_kind, "AUTHORIZATION_INVALID");
});

test("N17 bloqueia autorização N15 divergente para outro candidate_id", async () => {
  const store = createN17AuthorizationStore(
    fakeAssessmentClient([row({ candidate_id: OTHER_CANDIDATE_ID })]),
    () => new Date(NOW),
  );
  assert.equal(await store.getByRef(AUTHORIZATION_REF, CANDIDATE_ID), null);
});

test("N17 authorization store rejeita decisão N15 expirada", async () => {
  const store = createN17AuthorizationStore(
    fakeAssessmentClient([
      row({
        input_snapshot: {
          governance: {
            decision_id: AUTHORIZATION_REF,
            action: "ACQUIRE_AFFILIATE",
            status: "APPROVED",
            expires_at: "2026-08-20T06:59:59.000Z",
          },
        },
      }),
    ]),
    () => new Date(NOW),
  );
  assert.equal(await store.getByRef(AUTHORIZATION_REF, CANDIDATE_ID), null);
});

test("N17 authorization store projeta a decisão N15 válida por decision_id", async () => {
  const store = createN17AuthorizationStore(
    fakeAssessmentClient([row()]),
    () => new Date(NOW),
  );
  assert.deepEqual(
    await store.getByRef(AUTHORIZATION_REF, CANDIDATE_ID),
    authorization(),
  );
});

test("wiring N15→N17→N8→N6 é sequencial e fail-closed", async () => {
  const log: string[] = [];
  const result = await acquireN17(
    makeRequest(),
    depsWithAuthorization(authorization(), log),
  );
  assert.equal(result.status, "ACQUIRED");
  assert.deepEqual(log, [
    `N15.getByRef:${AUTHORIZATION_REF}:${CANDIDATE_ID}`,
    `N6.getProvider:${PROVIDER_ID}`,
    "N8.acquireAffiliateLink",
    "N6.persistN17Acquisition",
  ]);
});

test("createN17RuntimeDeps somente compõe dependências e não executa aquisição", () => {
  let calls = 0;
  const client = {
    from() {
      calls += 1;
      throw new Error("runtime factory must not read during construction");
    },
  } as unknown as SupabaseClient;
  const apiSource = {
    providerId: PROVIDER_ID,
    async generateLink() {
      calls += 1;
      throw new Error("runtime factory must not call provider during construction");
    },
  };

  const deps = createN17RuntimeDeps(client, apiSource, () => new Date(NOW));
  assert.equal(calls, 0);
  assert.equal(typeof deps.authorizationStore.getByRef, "function");
  assert.equal(typeof deps.providerStore.getById, "function");
  assert.equal(typeof deps.repository.persist, "function");
  assert.equal(typeof deps.acquire, "function");
});

afterEach(() => {
  setCandidateAssessmentClient(null);
});
