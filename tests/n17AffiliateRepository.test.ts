import test from "node:test";
import assert from "node:assert/strict";
import { buildN17ResponseDigest } from "../server/commercial/affiliate/n17Service";
import type { N17AcquisitionRecord } from "../server/commercial/affiliate/n17Contract";
import {
  findN17ByIdempotencyKey,
  persistN17Acquisition,
  setAffiliateClient,
  setAffiliateClientForTests,
} from "../server/commercial/affiliate/affiliateRepository";

// Fake Supabase client: this suite never opens a network connection or writes a
// real database. It simulates the N17-specific unique key and digest behavior.
type Row = Record<string, unknown>;

type QueryResult = {
  data: Row | Row[] | null;
  error: { message: string; code?: string } | null;
};

class FakeQueryBuilder {
  private mode: "select" | "insert" = "select";
  private input: Row | null = null;
  private filters: Array<[string, unknown]> = [];

  constructor(private readonly client: FakeSupabaseClient) {}

  select(_columns?: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  insert(row: Row): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }

  single(): Promise<QueryResult> {
    if (this.mode === "insert") {
      const row = { ...(this.input ?? {}) };
      const uniqueColumns = ["link_id", "digest", "idempotency_key_n17"];
      if (uniqueColumns.some((column) => row[column] !== null && row[column] !== undefined && this.client.rows.some((existing) => existing[column] === row[column]))) {
        return Promise.resolve({
          data: null,
          error: { message: "duplicate key value violates unique constraint", code: "23505" },
        });
      }
      this.client.rows.push(row);
      return Promise.resolve({ data: row, error: null });
    }

    const row = this.client.rows.find((candidate) => this.filters.every(([column, value]) => candidate[column] === value));
    return Promise.resolve({
      data: row ?? null,
      error: row ? null : { message: "not found", code: "PGRST116" },
    });
  }
}

class FakeSupabaseClient {
  readonly rows: Row[] = [];

  from(table: string): FakeQueryBuilder {
    assert.equal(table, "affiliate_links");
    return new FakeQueryBuilder(this);
  }
}

const FIXED_NOW = "2026-08-20T07:00:00.000Z";
const PROVIDER_ID = "affprv-shopee";
const CANDIDATE_ID = "can-n17-repository-0001";
const LISTING_ID = "23794344926";
const SELLER_ID = "1530442944";
const AFFILIATE_URL = "https://shopee.com.br/universal-link/n17-repository-proof";
const CANONICAL_URL = `https://shopee.com.br/product/${SELLER_ID}/${LISTING_ID}`;

function makeRecord(overrides: Partial<N17AcquisitionRecord> = {}): N17AcquisitionRecord {
  const identity = {
    listing_id: LISTING_ID,
    seller_id: SELLER_ID,
    title_snapshot: "Produto de teste do adapter N17",
    canonical_url: CANONICAL_URL,
    ...overrides.identity,
  };
  const acquisitionRef = overrides.acquisition_ref ?? "acq-n17-repository-proof";
  return {
    affiliate_link_id: "n17-link:repository-proof",
    candidate_id: CANDIDATE_ID,
    product_id: null,
    marketplace: "Shopee",
    provider_id: PROVIDER_ID,
    affiliate_url: AFFILIATE_URL,
    short_url: null,
    acquisition_ref: acquisitionRef,
    authorization_ref: "auth-n17-repository-proof",
    assessment_id: "assessment-n15-repository-proof",
    idempotency_key: "n17-idem:repository-proof-key",
    method: "API",
    acquired_at: FIXED_NOW,
    observed_at: FIXED_NOW,
    response_digest: buildN17ResponseDigest({
      providerId: PROVIDER_ID,
      marketplace: "Shopee",
      affiliateUrl: AFFILIATE_URL,
      identity,
      method: "API",
      acquisitionRef,
    }),
    provenance: {
      provider: PROVIDER_ID,
      marketplace: "Shopee",
      method: "API",
      source_operation: "productOfferV2",
      source_url_origin: "official_provider",
    },
    ...overrides,
    identity,
  };
}

test("adapter N17 de affiliateRepository persiste e resolve idempotência de forma fail-closed", async () => {
  const fakeClient = new FakeSupabaseClient();
  setAffiliateClientForTests(fakeClient as never);

  try {
    const input = makeRecord();
    const created = await persistN17Acquisition(input);
    assert.equal(created.outcome, "created");
    assert.deepEqual(created.record, input);
    assert.equal(fakeClient.rows.length, 1);
    assert.equal(fakeClient.rows[0].provenance, "n17:api");
    assert.equal(fakeClient.rows[0].method, "API");
    assert.equal(fakeClient.rows[0].idempotency_key_n17, input.idempotency_key);
    assert.equal(fakeClient.rows[0].response_digest_n17, input.response_digest);
    assert.equal(fakeClient.rows[0].listing_id, LISTING_ID);
    assert.equal(fakeClient.rows[0].seller_id, SELLER_ID);
    assert.equal(fakeClient.rows[0].canonical_url, CANONICAL_URL);
    assert.equal(fakeClient.rows[0].raw_response, undefined);

    const found = await findN17ByIdempotencyKey(input.idempotency_key);
    assert.deepEqual(found, input);

    const replay = await persistN17Acquisition(input);
    assert.equal(replay.outcome, "identical_duplicate");
    assert.deepEqual(replay.record, input);
    assert.equal(fakeClient.rows.length, 1);

    fakeClient.rows.length = 0;
    await persistN17Acquisition(input);
    const conflicting = makeRecord({
      affiliate_link_id: "n17-link:repository-conflict",
      affiliate_url: "https://shopee.com.br/universal-link/n17-repository-conflict",
    });
    const conflict = await persistN17Acquisition(conflicting);
    assert.equal(conflict.outcome, "conflict");
    assert.equal(conflict.record, null);
    assert.equal(conflict.reason, "idempotency_key_conflict");
    assert.equal(fakeClient.rows.length, 1);

    fakeClient.rows.length = 0;
    const incomplete = makeRecord({ identity: { ...makeRecord().identity, seller_id: "" } });
    const rejected = await persistN17Acquisition(incomplete);
    assert.equal(rejected.outcome, "failed");
    assert.equal(rejected.reason, "seller_id_missing");
    assert.equal(fakeClient.rows.length, 0);
  } finally {
    setAffiliateClient(null);
  }
});
