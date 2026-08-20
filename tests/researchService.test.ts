import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseClient } from "@supabase/supabase-js";
import { startResearch } from "../server/commercial/discovery/research";
import {
  getCandidateEvidenceClient,
  setCandidateEvidenceClientForTests,
} from "../server/repositories/candidateEvidenceRepository";
import * as candidatesRepo from "../server/repositories/candidatesRepository";
import { setCandidatesClientForTests } from "../server/repositories/candidatesRepository";

// ============================================================================
// Fake Supabase client (padrão dos Blocos N1/N2/N3)
// ============================================================================

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private maxRows?: number;
  private sortColumn?: string;
  private sortAscending = true;
  private mode: "select" | "insert" | "delete" = "select";
  private input?: Record<string, unknown>;

  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}

  select(_c?: unknown, _o?: unknown): this { return this; }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]): this { this.inFilters.push([col, vals]); return this; }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.sortColumn = col;
    this.sortAscending = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this { this.maxRows = n; return this; }
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    return Promise.resolve({ data: this.rows().filter(r => this.matches(r))[0] ?? null, error: null });
  }
  delete(): this { this.mode = "delete"; return this; }
  insert(rows: unknown): this {
    this.mode = "insert";
    this.input = Array.isArray(rows) ? rows[0] : rows;
    return this;
  }
  single(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }> {
    if (this.mode === "insert") {
      const row = { ...((this.input as Record<string, unknown>) ?? {}) };
      const rows = this.client.store.get(this.table) ?? [];
      const keyField = row.listing_key !== undefined ? "listing_key" : (row.field_hash ? "field_hash" : null);
      if (keyField && rows.some(r => r[keyField] === row[keyField])) {
        return Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint field_hash", code: "23505" } });
      }
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
  then(resolve?: (v: unknown) => unknown): Promise<unknown> {
    const rows = this.rows().filter(r => this.matches(r));
    const sorted = [...rows].sort((a, b) => {
      if (!this.sortColumn) return 0;
      const av = String(a[this.sortColumn] ?? "");
      const bv = String(b[this.sortColumn] ?? "");
      return this.sortAscending ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return Promise.resolve({ data: sorted.slice(0, this.maxRows), error: null, count: sorted.length }).then(resolve as never);
  }
  private rows(): Record<string, unknown>[] { return this.client.store.get(this.table) ?? []; }
  private matches(r: Record<string, unknown>): boolean {
    return this.filters.every(([c, v]) => r[c] === v) &&
      this.inFilters.every(([c, vs]) => Array.isArray(vs) && vs.includes(r[c]));
  }
}

class FakeSupabaseClient {
  store = new Map<string, Record<string, unknown>[]>([["candidate_evidence", []]]);
  from(t: string) { return new FakeQueryBuilder(this, t); }
}

// ============================================================================
// Injeções de fetch (produção) e getCandidate (N1)
// ============================================================================

function successFetch(priceValue = 149.9) {
  return async (params: { marketplace: string; source_url: string }) => ({
    ok: true,
    listing: {
      marketplace: params.marketplace,
      source_url: params.source_url,
      external_listing_id: { value: "MLB-12345", unknown: false },
      title: { value: "Luminária LED 40W", unknown: false },
      price: { value: priceValue, unknown: false },
      images: { value: ["https://img1.jpg"], unknown: false },
      seller: { value: "Loja Teste", unknown: false },
      rating: { value: 4.5, unknown: false },
      review_count: { value: 120, unknown: false },
      availability: { value: "available", unknown: false },
      category: { value: "Iluminação", unknown: false },
      observed_at: "2026-08-16T12:00:00Z",
      evidence_digest: "sha256:digest",
      evidence_note: "coleta real",
      http_status: 200,
      final_url: params.source_url,
    },
    httpStatus: 200,
  });
}

const failureFetch = async (_params: { marketplace: string; source_url: string }) => ({
  ok: false as const,
  reason: "network_timeout",
  httpStatus: null,
  listing: null,
});

const candidateInput = {
  marketplace: "Mercado Livre" as const,
  source_url: "https://produto.mercadolivre.com.br/MLB-12345",
  external_listing_id: "MLB-12345",
  merchant: "Loja Teste",
  title: "Luminária LED 40W",
  observed_price: 149.9,
  observed_at: "2026-08-16T12:00:00Z",
  evidence_hash: "sha256:evidence",
  collection_method: "SCRAPE",
  metadata: { discovery_block: "N1" },
};

const shopeeCandidateInput = {
  marketplace: "Shopee" as const,
  source_url: "https://shopee.com.br/porta-talher-i.1530442944.23794344926",
  external_listing_id: "shopee-1530442944-23794344926",
  merchant: null,
  title: null,
  observed_price: null,
  observed_at: "2026-08-16T12:00:00Z",
  evidence_hash: "sha256:shopee-evidence",
  collection_method: "SCRAPE",
  metadata: { discovery_block: "N1" },
};

let fakeClient: FakeSupabaseClient;

test.beforeEach(() => {
  fakeClient = new FakeSupabaseClient();
  // Cliente compartilhado entre N1 (candidates) e N3 (evidence): mesma base
  setCandidatesClientForTests(fakeClient as unknown as SupabaseClient);
  setCandidateEvidenceClientForTests(fakeClient as unknown as SupabaseClient);
});

test.after(async () => {
  setCandidateEvidenceClientForTests(null);
  candidatesRepo.setCandidatesClientForTests(null);
  // Limpeza: remover candidato artificial registrado para os testes válidos
  try {
    const list = await candidatesRepo.listCandidates({ marketplace: "Mercado Livre", limit: 100 });
    if (list.candidates?.length) {
      const ids = list.candidates.map(c => c.candidate_id);
      for (const id of ids) {
        await candidatesRepo.deleteCandidateForProof(id);
      }
    }
  } catch {
    // limpeza best-effort
  }
});

async function ensureCandidate(): Promise<string> {
  const result = await candidatesRepo.registerCandidate(candidateInput);
  if (!result.ok || !result.candidate_id) {
    throw new Error(`registro de candidato falhou: ${result.reason ?? "unknown"}`);
  }
  return result.candidate_id;
}

async function ensureShopeeCandidate(input: Partial<typeof shopeeCandidateInput> = {}): Promise<string> {
  const result = await candidatesRepo.registerCandidate({ ...shopeeCandidateInput, ...input });
  if (!result.ok || !result.candidate_id) {
    throw new Error(`registro de candidato Shopee falhou: ${result.reason ?? "unknown"}`);
  }
  return result.candidate_id;
}

const evidenceCount = () =>
  getCandidatesEvidenceStore().length;

function getCandidatesEvidenceStore(): Record<string, unknown>[] {
  const client = getCandidateEvidenceClient();
  if (!client) return [];
  const fake = client as unknown as { store: Map<string, Record<string, unknown>[]> };
  return fake?.store?.get("candidate_evidence") ?? [];
}

test("startResearch — candidate ausente → erro candidate_not_found SEM criar nenhuma evidência", async () => {
  const result = await startResearch({ candidate_id: "can-missing" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "candidate_not_found");
  assert.equal(result.research_id, null);
  assert.equal(evidenceCount(), 0);
});

test("startResearch — candidato válido → sessão + evidências KNOWN por campo, sem produto canônico", async () => {
  const candidateId = await ensureCandidate();
  const result = await startResearch({ candidate_id: candidateId, fetchPage: successFetch() as never });
  assert.equal(result.ok, true);
  assert.ok(result.research_id?.startsWith("rs-"));
  assert.equal(result.candidate_id, candidateId);
  assert.equal(result.fields.length, 8); // todos os 8 campos RESEARCH_FIELDS
  assert.equal(result.unknowns, 0);
  assert.equal(result.contradictions, 0);

  const rows = evidenceCount();
  assert.equal(rows, 9); // 1 sessão + 8 campos

  const sessions = getCandidatesEvidenceStore().filter(r => r.kind === "RESEARCH_SESSION");
  assert.equal(sessions.length, 1);

  const price = getCandidatesEvidenceStore().find(r => r.field_name === "price");
  assert.equal(price?.field_state, "KNOWN");
  assert.equal(price?.source_type, "marketplace_page");
  assert.equal(price?.quality, "HIGH");
  const md = price?.metadata as Record<string, unknown> | undefined;
  assert.equal(!!md?.quality_rationale && String(md.quality_rationale).includes("200"), true);
  assert.equal((price?.field_value as Record<string, unknown>)?.value, 149.9);
});

test("startResearch — fetch falho → sessão FAILED + todos os campos COLLECTION_FAILED", async () => {
  const candidateId = await ensureCandidate();
  const result = await startResearch({ candidate_id: candidateId, fetchPage: failureFetch });
  assert.equal(result.ok, true);
  assert.equal(result.fetch_failed, true);
  assert.equal(result.fetch_reason, "network_timeout");
  assert.equal(result.fields.length, 8);
  assert.equal(result.unknowns, 8);
  assert.deepEqual(
    result.fields.map(f => f.state),
    Array(8).fill("FAILED"),
  );

  const rows = getCandidatesEvidenceStore();
  assert.equal(rows.length, 9);
  const failed = rows.filter(r => r.field_state === "COLLECTION_FAILED");
  assert.equal(failed.length, 8);
  // Falha identificável com motivo explícito
  for (const r of failed) {
    assert.equal((r.metadata as Record<string, unknown>)?.fetch_failed, true);
    assert.match(String(r.evidence_note), /COLLECTION_FAILED/);
    assert.match(String(r.evidence_note), /network_timeout/);
    assert.equal((r.field_value as Record<string, unknown>)?.unknown, true);
  }
  // Título derivado da URL NUNCA aparece como confirmado quando a coleta falha
  const derived = rows.find(r => String(r.source_type) === "url_slug");
  assert.equal(derived, undefined);
});

test("startResearch — idempotência de evidência (replay com mesmo conteúdo → identical_duplicate)", async () => {
  const candidateId = await ensureCandidate();
  const first = await startResearch({ candidate_id: candidateId, fetchPage: successFetch() as never });
  assert.equal(first.ok, true);
  const countAfterFirst = evidenceCount();

  const second = await startResearch({ candidate_id: candidateId, fetchPage: successFetch() as never });
  assert.equal(second.ok, true);
  // Cada campo replay é identical_duplicate: total de linhas não dobra
  assert.equal(evidenceCount(), countAfterFirst + 1); // apenas a nova sessão
  assert.deepEqual(
    second.fields.map(f => f.outcome),
    Array(8).fill("identical_duplicate"),
  );
});

test("startResearch — contradição entre coletas → nova evidência CONTRADICTED, anterior preservada", async () => {
  const candidateId = await ensureCandidate();
  // Primeira coleta: preço 149.9
  const first = await startResearch({ candidate_id: candidateId, fetchPage: successFetch(149.9) as never });
  assert.equal(first.ok, true);
  const priceFirst = getCandidatesEvidenceStore().find(r => r.field_name === "price");
  assert.equal(priceFirst?.field_state, "KNOWN");
  assert.equal((priceFirst?.field_value as Record<string, unknown>)?.value, 149.9);

  // Segunda coleta: preço 99.9
  const second = await startResearch({ candidate_id: candidateId, fetchPage: successFetch(99.9) as never });
  assert.equal(second.ok, true);
  assert.equal(second.contradictions, 1);
  // Ordena pela ordem real de inserção no store (created_at tem resolução de ms
  // e duas corridas no mesmo milissegundo gerariam empates); a última inserida
  // é o mais recente.
  const priceSecond = [...getCandidatesEvidenceStore()]
    .filter(r => r.field_name === "price")
    .reverse()[0];
  assert.equal(priceSecond?.field_state, "CONTRADICTED");
  assert.equal((priceSecond?.field_value as Record<string, unknown>)?.value, 99.9);
  const md2 = priceSecond?.metadata as Record<string, unknown> | undefined;
  assert.equal((md2?.contradiction_with as unknown[])?.length, 1);

  // Evidência anterior PERMANECE INTACTA (preservação de contradição)
  const still = getCandidatesEvidenceStore().find(
    r => r.evidence_id === (priceFirst as Record<string, unknown>)?.evidence_id,
  );
  assert.ok(still);
  assert.equal(still?.field_state, "KNOWN");
  assert.equal((still?.field_value as Record<string, unknown>)?.value, 149.9);
});

test("startResearch — candidate_id ausente → rejeição imediata sem criar nada", async () => {
  const result = await startResearch({ candidate_id: "" });
  assert.equal(result.ok, false);
  assert.equal(result.research_id, null);
  assert.equal(evidenceCount(), 0);
});

test("startResearch — Shopee SUCCESS usa API oficial e persiste proveniência API", async () => {
  const candidateId = await ensureShopeeCandidate();
  let lookupCalls = 0;
  const result = await startResearch({
    candidate_id: candidateId,
    shopeeClient: {
      lookupProduct: async params => {
        lookupCalls += 1;
        assert.deepEqual(params, { shopId: "1530442944", itemId: "23794344926" });
        return {
          status: "found" as const,
          shopId: "1530442944",
          itemId: "23794344926",
          name: "Porta Talher Madeira Nobre",
          priceMinorUnits: 3590,
          productLink: "https://shopee.com.br/porta-talher-i.1530442944.23794344926",
          httpStatus: 200,
          raw: null,
          error: null,
        };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(lookupCalls, 1);
  assert.equal(result.fields.length, 8);
  assert.equal(result.unknowns, 6);
  assert.equal(evidenceCount(), 9);
  const price = getCandidatesEvidenceStore().find(r => r.field_name === "price");
  assert.equal(price?.source_type, "api");
  assert.equal(price?.collection_method, "API");
  assert.equal(price?.field_state, "KNOWN");
  assert.equal((price?.field_value as Record<string, unknown>)?.value, 3590);
  assert.equal(price?.quality, "HIGH");
});

test("startResearch — Shopee COLLECTION_FAILED persiste todos os campos como falha", async () => {
  const candidateId = await ensureShopeeCandidate();
  const result = await startResearch({
    candidate_id: candidateId,
    shopeeClient: {
      lookupProduct: async () => ({
        status: "error" as const,
        shopId: null,
        itemId: null,
        name: null,
        priceMinorUnits: null,
        productLink: null,
        httpStatus: 503,
        raw: null,
        error: null,
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fetch_failed, true);
  assert.equal(result.fetch_reason, "official_api_error");
  assert.deepEqual(result.fields.map(f => f.state), Array(8).fill("FAILED"));
  const failed = getCandidatesEvidenceStore().filter(r => r.field_state === "COLLECTION_FAILED");
  assert.equal(failed.length, 8);
  assert.ok(failed.every(r => r.source_type === "api" && r.collection_method === "API"));
  assert.ok(failed.every(r => (r.metadata as Record<string, unknown>)?.api_state === "COLLECTION_FAILED"));
});

test("startResearch — Shopee BLOCKED por anúncio não encontrado é fail-closed", async () => {
  const candidateId = await ensureShopeeCandidate();
  const result = await startResearch({
    candidate_id: candidateId,
    shopeeClient: {
      lookupProduct: async () => ({
        status: "not_found" as const,
        shopId: null,
        itemId: null,
        name: null,
        priceMinorUnits: null,
        productLink: null,
        httpStatus: 200,
        raw: null,
        error: null,
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fetch_failed, true);
  assert.equal(result.fetch_reason, "identity_unresolved_or_not_found");
  assert.equal(result.unknowns, 8);
  assert.equal(getCandidatesEvidenceStore().filter(r => r.field_state === "COLLECTION_FAILED").length, 8);
});

test("startResearch — Shopee sem item_id não chama API e registra BLOCKED", async () => {
  const candidateId = await ensureShopeeCandidate({
    source_url: "https://shopee.com.br/produto-sem-identidade",
    external_listing_id: "UNKNOWN",
  });
  let lookupCalls = 0;
  const result = await startResearch({
    candidate_id: candidateId,
    shopeeClient: {
      lookupProduct: async () => {
        lookupCalls += 1;
        throw new Error("não deveria chamar");
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fetch_failed, true);
  assert.equal(result.fetch_reason, "identity_missing_item_id");
  assert.equal(lookupCalls, 0);
  assert.equal(getCandidatesEvidenceStore().filter(r => r.field_state === "COLLECTION_FAILED").length, 8);
});
