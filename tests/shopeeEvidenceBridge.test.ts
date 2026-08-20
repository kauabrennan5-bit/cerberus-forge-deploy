import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createOfficialShopeeEvidenceAdapter,
} from "../server/commercial/sources/shopee/adapter";
import {
  OFFICIAL_SHOPEE_COLLECTION_METHOD,
  OFFICIAL_SHOPEE_MARKETPLACE,
  OFFICIAL_SHOPEE_SOURCE_TYPE,
  type OfficialShopeeEvidenceRequest,
} from "../server/commercial/sources/shopee/contracts";
import {
  errorLookup,
  foundLookup,
  officialShopeeOfferBody,
  notFoundLookup,
  SHOPEE_FIXTURE_ITEM_ID,
  SHOPEE_FIXTURE_SHOP_ID,
  SHOPEE_FIXTURE_SOURCE_URL,
} from "../server/commercial/sources/shopee/fixtures";
import { ShopeeClientError } from "../server/commercial/affiliate/shopeeClientContracts";
import { createShopeeApiClient } from "../server/commercial/affiliate/shopeeApiClient";

const OBSERVED_AT = "2026-08-19T23:30:00.000Z";

function request(overrides: Partial<OfficialShopeeEvidenceRequest> = {}): OfficialShopeeEvidenceRequest {
  return {
    candidate_id: "can-infra03-fixture",
    research_id: "res-infra03-fixture",
    item_id: SHOPEE_FIXTURE_ITEM_ID,
    shop_id: SHOPEE_FIXTURE_SHOP_ID,
    source_url: SHOPEE_FIXTURE_SOURCE_URL,
    observed_at: OBSERVED_AT,
    ...overrides,
  };
}

describe("INFRA-03 Shopee evidence bridge — fixtures only", () => {
  it("produces API provenance and only promotes observed title/price", async () => {
    let calls = 0;
    const adapter = createOfficialShopeeEvidenceAdapter({
      lookupProduct: async () => {
        calls += 1;
        return foundLookup();
      },
    });

    const result = await adapter.collect(request());

    assert.equal(result.state, "SUCCESS");
    if (result.state !== "SUCCESS") return;
    assert.equal(calls, 1);
    assert.equal(result.provenance.source_type, OFFICIAL_SHOPEE_SOURCE_TYPE);
    assert.equal(result.provenance.collection_method, OFFICIAL_SHOPEE_COLLECTION_METHOD);
    assert.equal(result.provenance.marketplace, OFFICIAL_SHOPEE_MARKETPLACE);
    assert.equal(result.provenance.external_listing_id, SHOPEE_FIXTURE_ITEM_ID);
    assert.equal(result.provenance.shop_id, SHOPEE_FIXTURE_SHOP_ID);
    assert.equal(result.provenance.http_status, 200);
    assert.equal(result.provenance.field_state, "KNOWN");
    assert.equal(result.evidence.observed_fields.title, "Produto Shopee Fixture");
    assert.equal(result.evidence.observed_fields.price, 9900);
    assert.equal(result.evidence.observed_fields.images, null);
    assert.equal(result.evidence.observed_fields.seller, null);
    assert.equal(result.evidence.observed_fields.rating, null);
    assert.equal(result.evidence.observed_fields.review_count, null);
    assert.equal(result.evidence.observed_fields.availability, null);
    assert.equal(result.evidence.observed_fields.category, null);
    assert.equal(result.evidence.fields.filter((field) => field.field_state === "KNOWN").length, 2);
    assert.equal(result.evidence.fields.filter((field) => field.field_state === "UNKNOWN").length, 6);
    assert.ok(result.response_digest.startsWith("sha256:"));
    assert.equal("verdict" in result, false);
    assert.equal("assessment" in result, false);
    assert.equal("authorization" in result, false);
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  });

  it("keeps the response digest deterministic for an identical observed response", async () => {
    const adapter = createOfficialShopeeEvidenceAdapter({ lookupProduct: async () => foundLookup() });
    const first = await adapter.collect(request());
    const second = await adapter.collect(request());
    assert.equal(first.state, "SUCCESS");
    assert.equal(second.state, "SUCCESS");
    if (first.state !== "SUCCESS" || second.state !== "SUCCESS") return;
    assert.equal(first.response_digest, second.response_digest);
    assert.deepEqual(first.provenance, second.provenance);
  });

  it("blocks a returned item mismatch and never creates evidence", async () => {
    const adapter = createOfficialShopeeEvidenceAdapter({
      lookupProduct: async () => foundLookup({ itemId: "99999999999" }),
    });
    const result = await adapter.collect(request());
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.evidence, null);
    assert.equal(result.response_digest, null);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(result.provenance.field_state, "COLLECTION_FAILED");
    assert.equal(result.provenance.http_status, 200);
  });

  it("blocks when the official directed lookup returns no exact node", async () => {
    const adapter = createOfficialShopeeEvidenceAdapter({ lookupProduct: async () => notFoundLookup(200) });
    const result = await adapter.collect(request());
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.reason, "identity_unresolved_or_not_found");
    assert.equal(result.evidence, null);
    assert.equal(result.provenance.http_status, 200);
  });

  it("classifies official auth failure as collection failure with status and no evidence", async () => {
    const adapter = createOfficialShopeeEvidenceAdapter({
      lookupProduct: async () => errorLookup(new ShopeeClientError("SHOPEE_AUTH_ERROR", "http_401", 401)),
    });
    const result = await adapter.collect(request());
    assert.equal(result.state, "COLLECTION_FAILED");
    assert.equal(result.reason, "official_api_error");
    assert.equal(result.error_kind, "SHOPEE_AUTH_ERROR");
    assert.equal(result.evidence, null);
    assert.equal(result.provenance.http_status, 401);
    assert.equal(result.provenance.response_digest, null);
  });

  it("blocks invalid source identity before calling the client", async () => {
    let calls = 0;
    const adapter = createOfficialShopeeEvidenceAdapter({
      lookupProduct: async () => {
        calls += 1;
        return foundLookup();
      },
    });
    const result = await adapter.collect(request({ source_url: "https://example.com/item" }));
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.reason, "invalid_official_source_url");
    assert.equal(calls, 0);
    assert.equal(result.evidence, null);
  });

  it("fails closed when the reused client throws unexpectedly", async () => {
    const adapter = createOfficialShopeeEvidenceAdapter({
      lookupProduct: async () => {
        throw new Error("fixture transport failure");
      },
    });
    const result = await adapter.collect(request());
    assert.equal(result.state, "COLLECTION_FAILED");
    assert.equal(result.reason, "client_exception");
    assert.equal(result.evidence, null);
    assert.equal(result.provenance.http_status, null);
    assert.equal(result.provenance.response_digest, null);
  });
});


describe("INFRA-03 Shopee client status transport — fixture HTTP", () => {
  it("preserves the observed 200 status from the reused official client", async () => {
    const client = createShopeeApiClient({
      appId: "fixture-app-id",
      secret: "fixture-app-secret",
      clock: () => 1_700_000_000_000,
      transport: async (_url, init) => {
        assert.equal(init.method, "POST");
        assert.match(init.headers.Authorization, /^SHA256 Credential=fixture-app-id, Timestamp=1700000000, Signature=[a-f0-9]{64}$/);
        return new Response(JSON.stringify(officialShopeeOfferBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.lookupProduct({ shopId: SHOPEE_FIXTURE_SHOP_ID, itemId: SHOPEE_FIXTURE_ITEM_ID });
    assert.equal(result.status, "found");
    assert.equal(result.httpStatus, 200);
  });

  it("preserves an observed 401 without turning it into a product result", async () => {
    const client = createShopeeApiClient({
      appId: "fixture-app-id",
      secret: "fixture-app-secret",
      transport: async () => new Response(JSON.stringify({ errors: [{ code: 10020 }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    });

    const result = await client.lookupProduct({ shopId: SHOPEE_FIXTURE_SHOP_ID, itemId: SHOPEE_FIXTURE_ITEM_ID });
    assert.equal(result.status, "error");
    assert.equal(result.httpStatus, 401);
    assert.equal(result.error?.kind, "SHOPEE_AUTH_ERROR");
  });
});
