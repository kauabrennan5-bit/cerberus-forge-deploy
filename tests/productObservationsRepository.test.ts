import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  getProductObservations,
  recordAvailabilityObservation,
  recordImageObservation,
  recordPriceObservation,
  recordSourceObservation,
  setProductObservationsClientForTests,
} from "../server/repositories/productObservationsRepository";

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private sorts: Array<[string, boolean]> = [];
  private maxRows?: number;
  private mode: "select" | "insert" = "select";
  private selected = false;
  private input?: Record<string, unknown>;

  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}

  select(_columns?: string): this {
    this.selected = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.sorts.push([column, options.ascending]);
    return this;
  }

  limit(value: number): this {
    this.maxRows = value;
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }

  private rows(): Record<string, unknown>[] {
    return this.client.store.get(this.table) || [];
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return [...rows].sort((a, b) => {
      for (const [column, ascending] of this.sorts) {
        const av = String(a[column] ?? "");
        const bv = String(b[column] ?? "");
        const comparison = av.localeCompare(bv);
        if (comparison !== 0) return ascending ? comparison : -comparison;
      }
      return 0;
    });
  }

  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const row = { ...(this.input || {}) };
      const rows = this.rows();
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    const matched = this.sorted(this.rows().filter(row => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched[0] || null, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const matched = this.sorted(this.rows().filter(row => this.matches(row))).slice(0, this.maxRows);
    return Promise.resolve({ data: matched, error: null }).then(onfulfilled as never, onrejected as never);
  }
}

class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();

  constructor() {
    this.store.set("products", [{ id: "prod-test-1", produto: "Produto artificial de teste" }]);
    for (const table of [
      "product_price_observed",
      "product_availability_observed",
      "product_source_observed",
      "product_image_observed",
    ]) this.store.set(table, []);
  }

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }
}

const context = {
  productId: "prod-test-1",
  sourceName: "Mercado Livre",
  sourceUrl: "https://example.test/listing/123?access_token=should-not-persist",
  marketplace: "mercado_livre",
  merchant: "Loja Teste",
  externalListingId: "MLB123",
  observedAt: "2026-08-15T16:42:00-03:00",
  collectionMethod: "controlled_test",
  confidence: "HIGH" as const,
  correlationId: "bloco13-test",
};

let client: FakeSupabaseClient;

test.beforeEach(() => {
  client = new FakeSupabaseClient();
  setProductObservationsClientForTests(client as unknown as SupabaseClient);
});

test.after(() => {
  setProductObservationsClientForTests(undefined);
});

test("cria preço válido, preserva tempo/proveniência e sanitiza metadata", async () => {
  const result = await recordPriceObservation({
    ...context,
    idempotencyKey: "price-1",
    observedPrice: 69.99,
    metadata: {
      collector: "test",
      rawContent: "[URL FINAL] conteúdo externo",
      api_key: "secret-value",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value?.productId, "prod-test-1");
  assert.equal(result.value?.observedPrice, 69.99);
  assert.equal(result.value?.observedAt, "2026-08-15T19:42:00.000Z");
  assert.equal(result.value?.sourceUrl, "https://example.test/listing/123");
  assert.equal(result.value?.metadata?.rawContent, "[REDACTED_UNTRUSTED_PAYLOAD]");
  assert.equal(result.value?.metadata?.api_key, "[REDACTED_SENSITIVE_FIELD]");
});

test("associa corretamente ao produto e distingue fontes diferentes", async () => {
  const first = await recordSourceObservation({
    ...context,
    sourceKind: "MARKETPLACE_LISTING",
    idempotencyKey: "source-ml",
  });
  const second = await recordSourceObservation({
    ...context,
    sourceName: "Shopee",
    marketplace: "shopee",
    sourceKind: "MARKETPLACE_LISTING",
    sourceUrl: "https://shopee.test/product/1/2",
    idempotencyKey: "source-shopee",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.value?.sourceName, second.value?.sourceName);
  assert.equal(client.store.get("products")?.length, 1);
  assert.equal(client.store.get("product_source_observed")?.length, 2);
});

test("idempotência devolve a mesma observação sem criar uma segunda linha", async () => {
  const first = await recordPriceObservation({ ...context, idempotencyKey: "same-price", observedPrice: 10 });
  const second = await recordPriceObservation({ ...context, idempotencyKey: "same-price", observedPrice: 10 });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(first.value?.observationId, second.value?.observationId);
  assert.equal(client.store.get("product_price_observed")?.length, 1);
});

test("colisão de idempotência com conteúdo diferente é rejeitada", async () => {
  await recordPriceObservation({ ...context, idempotencyKey: "collision-price", observedPrice: 10 });
  const result = await recordPriceObservation({ ...context, idempotencyKey: "collision-price", observedPrice: 11 });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /Colisão de observação/);
  assert.equal(client.store.get("product_price_observed")?.length, 1);
});

test("preserva disponibilidade e imagem como observações distintas", async () => {
  const availability = await recordAvailabilityObservation({ ...context, idempotencyKey: "availability-1", observedAvailability: "IN_STOCK" });
  const image = await recordImageObservation({ ...context, idempotencyKey: "image-1", imageUrl: "https://cdn.example.test/image.jpg", imageHash: "sha256:test" });

  assert.equal(availability.value?.observedAvailability, "IN_STOCK");
  assert.equal(image.value?.imageUrl, "https://cdn.example.test/image.jpg");
  assert.equal(image.value?.imageHash, "sha256:test");
});

test("rejeita produto inexistente e URLs não HTTP", async () => {
  await assert.rejects(
    () => recordPriceObservation({ ...context, productId: "prod-missing", idempotencyKey: "missing", observedPrice: 20 }),
    /não encontrado/,
  );
  await assert.rejects(
    () => recordImageObservation({ ...context, idempotencyKey: "bad-image", imageUrl: "data:image/png;base64,AAA" }),
    /INVALID_PRODUCT_OBSERVATION_IMAGE_URL_PROTOCOL/,
  );
});

test("leitura retorna coleções vazias quando não há observações", async () => {
  const result = await getProductObservations("prod-test-1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { prices: [], availabilities: [], sources: [], images: [] });
});

test("leitura agrega as quatro famílias somente pelo product_id", async () => {
  await recordPriceObservation({ ...context, idempotencyKey: "read-price", observedPrice: 12.5 });
  await recordAvailabilityObservation({ ...context, idempotencyKey: "read-availability", observedAvailability: "UNKNOWN" });
  await recordSourceObservation({ ...context, idempotencyKey: "read-source", sourceKind: "DIRECT" });
  await recordImageObservation({ ...context, idempotencyKey: "read-image", imageUrl: "https://cdn.example.test/read.jpg" });

  const result = await getProductObservations("prod-test-1");
  assert.equal(result.ok, true);
  assert.equal(result.value?.prices.length, 1);
  assert.equal(result.value?.availabilities.length, 1);
  assert.equal(result.value?.sources.length, 1);
  assert.equal(result.value?.images.length, 1);
  assert.equal(client.store.get("products")?.length, 1);
});

test("cliente indisponível falha explicitamente sem fallback em memória", async () => {
  setProductObservationsClientForTests(null);
  const write = await recordPriceObservation({ ...context, idempotencyKey: "unavailable", observedPrice: 1 });
  const read = await getProductObservations("prod-test-1");
  assert.equal(write.ok, false);
  assert.match(write.reason || "", /não configurado/);
  assert.equal(read.ok, false);
  assert.match(read.reason || "", /não configurado/);
});
