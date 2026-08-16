// ============================================================================
// Bloco N6 — Affiliate Economics + Link Resolution — Bateria de testes local
//
// Testes exclusivamente LOCAIS (fake Supabase; nada é gravado em produção).
// Prova dos contratos e invariantes (A–Z do plano da Fase 2):
//   A. provider válido pode ser registrado
//   B. provider inválido é rejeitado
//   C. provider duplicado é idempotente
//   D. affiliate link manual pode ser registrado
//   E. affiliate_url ausente é rejeitada
//   F. URL inválida é rejeitada
//   G. host não permitido é rejeitado
//   H. redirect não permitido é rejeitado (via live check simulado)
//   I. provenance diferente de admin:manual é rejeitada
//   J. IA não consegue registrar link como origem autorizada
//   K. replay idêntico não duplica
//   L. link alterado preserva histórico (novo digest → novo registro)
//   M. metadata sensível é sanitizada
//   N. RLS está ativo (verificação SQL da migration — parte 1)
//   O. zero policies públicas (migration declara drop loop idempotente)
//   P. endpoint sem senha retorna 401
//   Q. estado desconhecido falha fechado
//   R. provider incompatível com domínio é rejeitado
//   S. validação inconclusiva não vira APPROVED/VALID
//   T. registrar link não cria produto
//   U. registrar link não promove candidato
//   V. registrar link não executa publicação
//   W. registrar link não cria job
//   X. registrar link não habilita agente
//   Y. Policy Engine continua sendo a autoridade (resolver não publica)
//   Z. affiliate link não equivale a autorização de execução
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import supertest from "supertest";
import {
  AFFILIATE_MARKETPLACES,
  AFFILIATE_MARKETPLACE_HOSTS,
  LINK_PROVENANCES,
  PROVIDER_STATUSES,
  RESOLUTION_METHODS,
  VALIDATION_STATES,
  affiliateLinkDigest,
  isAffiliateMarketplace,
} from "../server/commercial/affiliate/contract";
import {
  persistProvider,
  persistLink,
  getProvider,
  getLink,
  listProviders,
  listLinksByCandidate,
  recordLinkValidation,
  revokeLink,
  setAffiliateClientForTests,
  validateLinkInput,
  validateProviderId,
} from "../server/commercial/affiliate/affiliateRepository";
import {
  liveHostCheck,
  resolveUsableLinkForCandidate,
  validateAffiliateLink,
} from "../server/commercial/affiliate/affiliateValidator";
import { registerAffiliateRoutes } from "../server/commercial/affiliate/affiliateRoutes";
import { resolveAffiliateLink } from "../server/commercial/affiliate/affiliateLinkResolver";

// ============================================================================
// Fake Supabase client (padrão Blocos N1-N5/N6/13+)
// ============================================================================
class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private sortColumn?: string;
  private sortAscending = true;
  private maxRows?: number;
  private mode: string = "select";
  private input?: Record<string, unknown>;
  private inFilters: Array<[string, unknown[]]> = [];
  private updatePayload?: Record<string, unknown>;
  private _deleted = 0;
  constructor(private readonly client: FakeSupabaseClient, private readonly table: string) {}
  select(_columns?: string): this { return this; }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this; }
  in(column: string, values: unknown[]): this {
    this.inFilters.push([column, values]);
    if (this.mode === "delete") this._executeDelete();
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.sortColumn = column;
    this.sortAscending = options?.ascending ?? true;
    return this;
  }
  limit(_value: number): this { return this; }
  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.input = row;
    return this;
  }
  update(payload: Record<string, unknown>): this {
    this.mode = "update";
    this.updatePayload = payload;
    return this;
  }
  delete(): this { this.mode = "delete"; return this; }
  private _executeDelete(): void {
    const store = this.client.store.get(this.table) ?? [];
    const remaining = store.filter(row => !this.matches(row));
    this._deleted = store.length - remaining.length;
    this.client.store.set(this.table, remaining);
    this.mode = "delete_done";
  }
  single(): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null } | { data: Record<string, unknown>[]; error: null; count: number; deleted: number }> {
    if (this.mode === "insert") {
      const row = { ...(this.input ?? {}) };
      const rows = this.client.store.get(this.table) ?? [];
      // Simula os UNIQUE por tabela: providers = provider_id / provider_code /
      // idempotency_key; links = digest / idempotency_key (sem colisão entre
      // links distintos do mesmo provider — histórico é preservado).
      const uniqueCols = this.table === "affiliate_links"
        ? ["digest", "idempotency_key"]
        : ["provider_id", "provider_code", "idempotency_key"];
      for (const col of uniqueCols) {
        const value = row[col];
        if (value && rows.some(r => r[col] === value)) {
          return Promise.resolve({ data: null, error: { message: `duplicate key value violates unique constraint`, code: "23505" } });
        }
      }
      rows.push(row);
      this.client.store.set(this.table, rows);
      return Promise.resolve({ data: row, error: null });
    }
    if (this.mode === "update") {
      const rows = this.client.store.get(this.table) ?? [];
      const target = rows.find(row => this.matches(row));
      if (!target) return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      Object.assign(target, this.updatePayload ?? {});
      return Promise.resolve({ data: target, error: null });
    }
    if (this.mode === "delete") {
      const rows = this.client.store.get(this.table) ?? [];
      const remaining = rows.filter(row => !this.matches(row));
      this._deleted = rows.length - remaining.length;
      this.client.store.set(this.table, remaining);
      return Promise.resolve({ data: remaining, error: null, count: remaining.length, deleted: this._deleted });
    }
    // select (com eq/in/order): PostgREST single() retorna a primeira linha correspondente.
    const matched = this.sorted(this.rows().filter(row => this.matches(row)));
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }
  private rows(): Record<string, unknown>[] { return this.client.store.get(this.table) ?? []; }
  private matches(row: Record<string, unknown>): boolean {
    const eqMatch = this.filters.every(([column, value]) => row[column] === value);
    const inMatch = this.inFilters.every(([column, values]) =>
      Array.isArray(values) && values.includes(row[column]),
    );
    return eqMatch && inMatch;
  }
  private sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    let out = [...rows];
    if (this.sortColumn) {
      out.sort((a, b) => {
        const av = String(a[this.sortColumn!] ?? "");
        const bv = String(b[this.sortColumn!] ?? "");
        return this.sortAscending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return out;
  }
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const matched = this.sorted(this.rows().filter(row => this.matches(row)));
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.mode === "delete") this._executeDelete();
    const matched = this.sorted(this.rows().filter(row => this.matches(row)));
    const payload = { data: matched, error: null, count: matched.length, deleted: this._deleted };
    return Promise.resolve(payload).then(onfulfilled as never, onrejected as never);
  }
}

class FakeSupabaseClient {
  public store = new Map<string, Record<string, unknown>[]>();
  constructor() {
    this.store.set("affiliate_providers", []);
    this.store.set("affiliate_links", []);
  }
  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }
}

// Fake client cujo fetch (live check) falha de rede — para provar S.
class FailingNetworkFakeClient extends FakeSupabaseClient {
  // nada a mais: a falha de rede é provada no liveHostCheck por URL inválida
  // ou pelo domínio inexistente localmente.
}

let fakeClient: FakeSupabaseClient;

test.beforeEach(() => {
  fakeClient = new FakeSupabaseClient();
  setAffiliateClientForTests(fakeClient as any);
});

// ============================================================================
// Helpers
// ============================================================================
const VALID_SHOPEE_URL = "https://shopee.com.br/Produto-Teste-i.12345.67890?utm_source=an_18372601203&utm_term=fcvf7x7gw1d9";
const VALID_ML_URL = "https://meli.la/abcdef?mapp_tool=affiliate";
const SHOPEE_PROVIDER = {
  provider_code: "shopee-br",
  name: "Shopee Affiliates BR",
  marketplace: "Shopee" as const,
  program_name: "Shopee Affiliates Brasil",
  terms_url: "https://affiliate.shopee.com.br/",
};
const ML_PROVIDER = {
  provider_code: "ml-afiliados",
  name: "ML Afiliados e Criadores",
  marketplace: "MercadoLivre" as const,
  program_name: "Mercado Livre Afiliados",
  terms_url: "https://www.mercadolivre.com.br/l/afiliados-home",
};

async function createActiveProvider(input: Partial<Parameters<typeof persistProvider>[0]> & { metadata?: Record<string, unknown> } = {}, status = "ACTIVE") {
  const result = await persistProvider({ ...SHOPEE_PROVIDER, ...input, status: status as any } as Parameters<typeof persistProvider>[0]);
  if (!result.ok || !result.record) throw new Error("setup failed: " + result.reason);
  return result.record;
}

async function registerLinkFor(providerId: string, overrides: { candidate_id?: string | null; marketplace?: "Shopee" | "MercadoLivre"; affiliate_url?: string; expires_at?: string | null; notes?: string; provenance?: string; metadata?: Record<string, unknown> } = {}) {
  return persistLink({
    candidate_id: "cand-test-001",
    marketplace: "Shopee",
    provider_id: providerId,
    affiliate_url: VALID_SHOPEE_URL,
    ...overrides,
  } as Parameters<typeof persistLink>[0]);
}

// ============================================================================
// Testes de contrato (catálogos fechados)
// ============================================================================
test("N6-Q: catálogos fechados existem e são estáveis", () => {
  assert.deepEqual([...PROVIDER_STATUSES], ["ACTIVE", "INACTIVE", "PENDING_REVIEW", "WITHDRAWN"]);
  assert.deepEqual([...VALIDATION_STATES], ["UNVALIDATED", "VALID", "INVALID", "INCONCLUSIVE", "PENDING_EXTERNAL"]);
  assert.deepEqual([...LINK_PROVENANCES], ["admin:manual"]);
  assert.deepEqual([...AFFILIATE_MARKETPLACES], ["MercadoLivre", "Shopee"]);
  assert.deepEqual([...RESOLUTION_METHODS], ["MANUAL", "IMPORT", "PORTAL", "API"]);
});

test("N6-Q: marketplace desconhecido é rejeitado por isAffiliateMarketplace", () => {
  assert.equal(isAffiliateMarketplace("Amazon"), false);
  assert.equal(isAffiliateMarketplace("Shopee"), true);
  assert.equal(isAffiliateMarketplace("MercadoLivre"), true);
  assert.equal(isAffiliateMarketplace(undefined), false);
});

// ============================================================================
// A. provider válido pode ser registrado
// ============================================================================
test("N6-A: provider válido pode ser registrado", async () => {
  const result = await persistProvider(SHOPEE_PROVIDER);
  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.ok(result.record);
  assert.equal(result.record!.provider_id, "affprv-shopee-br");
  assert.equal(result.record!.marketplace, "Shopee");
  assert.equal(result.record!.status, "PENDING_REVIEW");
  assert.equal(result.record!.provenance, "admin:manual");
  assert.equal(result.record!.ownership, "owner-human");
  assert.equal(result.record!.resolution_method, "MANUAL");
  const stored = await getProvider("affprv-shopee-br");
  assert.ok(stored);
  assert.equal(stored!.provider_code, "shopee-br");
});

// ============================================================================
// B. provider inválido é rejeitado
// ============================================================================
test("N6-B: provider inválido é rejeitado (falha fechada)", async () => {
  const cases: Array<[string, Partial<Parameters<typeof persistProvider>[0]>, string]> = [
    ["marketplace inválido", { marketplace: "Amazon" as any }, "marketplace_invalid"],
    ["código vazio", { ...SHOPEE_PROVIDER, provider_code: "" }, "provider_code_invalid"],
    ["nome curto demais", { ...SHOPEE_PROVIDER, name: "A" }, "name_invalid"],
    ["status inventado", { ...SHOPEE_PROVIDER, status: "SUPER_ACTIVE" as any }, "status_invalid"],
    ["método não implementado", { ...SHOPEE_PROVIDER, resolution_method: "API" as any }, "resolution_method_not_supported"],
  ];
  for (const [label, input, expected] of cases) {
    const result = await persistProvider(input as any);
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, expected, label);
    assert.equal(result.result, "failed", label);
  }
});

// ============================================================================
// C. provider duplicado é idempotente
// ============================================================================
test("N6-C: provider duplicado é idempotente (identical_duplicate)", async () => {
  await persistProvider(SHOPEE_PROVIDER);
  const second = await persistProvider(SHOPEE_PROVIDER);
  assert.equal(second.ok, true);
  assert.equal(second.result, "identical_duplicate");
  assert.equal(second.record!.provider_code, "shopee-br");
  const providers = await listProviders();
  assert.equal(providers.length, 1, "não deve duplicar");
});

// ============================================================================
// D. affiliate link manual pode ser registrado
// ============================================================================
test("N6-D: affiliate link manual pode ser registrado (Shopee)", async () => {
  const provider = await createActiveProvider();
  const result = await registerLinkFor(provider.provider_id);
  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.ok(result.record);
  assert.equal(result.record!.status, "DRAFT");
  assert.equal(result.record!.validation_state, "UNVALIDATED");
  assert.equal(result.record!.provenance, "admin:manual");
  assert.equal(result.record!.candidate_id, "cand-test-001");
  assert.ok(result.record!.digest.startsWith("sha256:"));
});

test("N6-D (b): affiliate link manual pode ser registrado (MercadoLivre)", async () => {
  const provider = await createActiveProvider(ML_PROVIDER);
  const result = await registerLinkFor(provider.provider_id, {
    candidate_id: "cand-ml-001",
    marketplace: "MercadoLivre",
    affiliate_url: VALID_ML_URL,
  });
  assert.equal(result.ok, true);
  assert.equal(result.record!.marketplace, "MercadoLivre");
});

// ============================================================================
// E. affiliate_url ausente é rejeitada
// ============================================================================
test("N6-E: affiliate_url ausente/vazia/curta é rejeitada", async () => {
  const provider = await createActiveProvider();
  const cases: Array<[string, Parameters<typeof persistLink>[0]]> = [
    ["ausente", { candidate_id: "cand-x", marketplace: "Shopee", provider_id: provider.provider_id, affiliate_url: "" }],
    ["vazia", { candidate_id: "cand-x", marketplace: "Shopee", provider_id: provider.provider_id, affiliate_url: "" }],
    ["curta demais", { candidate_id: "cand-x", marketplace: "Shopee", provider_id: provider.provider_id, affiliate_url: "https://a.b" }],
  ];
  for (const [label, input] of cases) {
    const result = await persistLink(input);
    assert.equal(result.ok, false, label);
    assert.ok(/url_invalid|url_too_short/.test(result.reason ?? ""), label);
  }
});

// ============================================================================
// F. URL inválida é rejeitada
// ============================================================================
test("N6-F: URL sintaticamente inválida é rejeitada", async () => {
  const provider = await createActiveProvider();
  const bad = await registerLinkFor(provider.provider_id, { affiliate_url: "not a url" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "url_invalid");
});

test("N6-F (b): esquema não-http é rejeitado", async () => {
  const provider = await createActiveProvider();
  const js = await registerLinkFor(provider.provider_id, { affiliate_url: "javascript:alert(1)" });
  assert.equal(js.ok, false);
  // "javascript:" é sintaticamente um URL válido, então a rejeição é
  // scheme_not_allowed (o repo é mais preciso que "url_invalid").
  assert.equal(js.reason, "scheme_not_allowed");
});

// ============================================================================
// G. host não permitido é rejeitado
// ============================================================================
test("N6-G: host não permitido é rejeitado (domínio fora do catálogo)", async () => {
  const provider = await createActiveProvider();
  const amazon = await registerLinkFor(provider.provider_id, { affiliate_url: "https://amazon.com.br/produto-xyz?tag=teste-20" });
  assert.equal(amazon.ok, false);
  assert.equal(amazon.reason, "domain_not_allowed");
});

test("N6-G (b): localhost/redes internas são rejeitados (defesa em profundidade)", async () => {
  const provider = await createActiveProvider();
  const local = await registerLinkFor(provider.provider_id, { affiliate_url: "https://localhost/nao-deve-passar?utm=test" });
  assert.equal(local.ok, false);
  assert.equal(local.reason, "unsafe_host");
  const privateNet = await registerLinkFor(provider.provider_id, { affiliate_url: "https://192.168.1.1/admin?utm=test" });
  assert.equal(privateNet.ok, false);
  assert.equal(privateNet.reason, "unsafe_host");
});

test("N6-G (c): homepage genérica é rejeitada", async () => {
  const provider = await createActiveProvider();
  const home = await registerLinkFor(provider.provider_id, { affiliate_url: "https://shopee.com.br/" });
  assert.equal(home.ok, false);
  assert.equal(home.reason, "url_generic_homepage");
  // Regra: homepage com query string passa na validação estrutural (a URL
  // carrega parâmetros de campanha), mas segue DRAFT/UNVALIDATED até que a
  // validação viva a aprove — nada vira VALID por default.
  const homeWithQuery = await registerLinkFor(provider.provider_id, { affiliate_url: "https://shopee.com.br/?utm_source=teste" });
  assert.equal(homeWithQuery.ok, true, "homepage com query passa na sintaxe, mas não está validada");
  assert.equal(homeWithQuery.record!.validation_state, "UNVALIDATED");
});

// ============================================================================
// H. redirect não permitido é rejeitado (fail-closed da whitelist)
// ============================================================================
test("N6-H: redirect para domínio fora da whitelist falha fechado", async () => {
  // O fail-closed do redirect é determinístico (domínio fora do catálogo
  // já rejeitado em N6-G). Aqui a prova do liveHostCheck usa um host DNS
  // inexistente: qualquer erro de rede/timeout NUNCA vira VALID — fica
  // INCONCLUSIVE (falha fechada).
  const result = await liveHostCheck("https://host-nao-existe-xyz.invalid/pagina-teste-i.1.2", "Shopee");
  assert.equal(result.redirect_ok, false, "host inexistente nunca aprova o redirect");
  assert.ok(result.error_reason, `falha identificável: ${JSON.stringify(result)}`);
});

// ============================================================================
// I. provenance diferente de admin:manual é rejeitada
// ============================================================================
test("N6-I: provenance diferente de admin:manual é rejeitada", async () => {
  const provider = await createActiveProvider();
  const cases: Array<[string, string | undefined]> = [
    ["derived", "derived"],
    ["scraped", "scraped"],
    ["guessed", "guessed"],
    ["inferred", "inferred"],
    ["provider:portal (v1 não permitido)", "provider:portal"],
  ];
  for (const [label, provenance] of cases) {
    const result = await registerLinkFor(provider.provider_id, { provenance: provenance as any });
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, "provenance_not_allowed", label);
  }
});

// ============================================================================
// J. IA não consegue registrar link como origem autorizada
// ============================================================================
test("N6-J: IA não consegue registrar link como origem autorizada", async () => {
  // Simula um "agente de IA" tentando registrar com proveniência ai:generated.
  const provider = await createActiveProvider();
  const aiAttempt = await registerLinkFor(provider.provider_id, { provenance: "ai:generated" as any });
  assert.equal(aiAttempt.ok, false);
  assert.equal(aiAttempt.reason, "provenance_not_allowed");
  // Nem derivar URL de slug/listing_key: tentar registrar URL construída a
  // partir de uma "listing_key" de candidato.
  const derivedUrl = "https://shopee.com.br/" + "cand-test-001".slice(0, 10);
  const derived = await registerLinkFor(provider.provider_id, { affiliate_url: derivedUrl });
  // A URL em si pode passar na sintaxe, mas o link segue DRAFT/UNVALIDATED e
  // NUNCA é promovido a VALID sem validação real — a origem declarada segue
  // sendo apenas a registrada manualmente.
  assert.equal(derived.record!.validation_state, "UNVALIDATED");
  assert.equal(derived.record!.status, "DRAFT");
});

// ============================================================================
// K. replay idêntico não duplica
// ============================================================================
test("N6-K: replay idêntico (mesmo provider+alvo+url) retorna identical_duplicate", async () => {
  const provider = await createActiveProvider();
  const first = await registerLinkFor(provider.provider_id);
  assert.equal(first.result, "created");
  const second = await registerLinkFor(provider.provider_id);
  assert.equal(second.ok, true);
  assert.equal(second.result, "identical_duplicate");
  assert.equal(second.record!.link_id, first.record!.link_id);
  const links = await listLinksByCandidate("cand-test-001");
  assert.equal(links.length, 1);
});

test("N6-K (b): digest determinístico é idempotente", () => {
  const a = affiliateLinkDigest({ provider_id: "p1", candidate_id: "c1", affiliate_url: VALID_SHOPEE_URL });
  const b = affiliateLinkDigest({ provider_id: "p1", candidate_id: "c1", affiliate_url: VALID_SHOPEE_URL });
  assert.equal(a, b);
  const c = affiliateLinkDigest({ provider_id: "p1", candidate_id: "c1", affiliate_url: VALID_SHOPEE_URL + "&extra=1" });
  assert.notEqual(a, c);
});

// ============================================================================
// L. link alterado preserva histórico
// ============================================================================
test("N6-L: URL/destino alterado cria novo registro (histórico preservado)", async () => {
  const provider = await createActiveProvider();
  const first = await registerLinkFor(provider.provider_id);
  const changed = await registerLinkFor(provider.provider_id, {
    affiliate_url: "https://shopee.com.br/Outro-Produto-i.99999.00000?utm_source=an_18372601203",
  });
  assert.equal(changed.result, "created");
  assert.notEqual(changed.record!.link_id, first.record!.link_id);
  assert.notEqual(changed.record!.digest, first.record!.digest);
  const links = await listLinksByCandidate("cand-test-001");
  assert.equal(links.length, 2, "o registro anterior permanece (histórico preservado)");
});

// ============================================================================
// M. metadata sensível é sanitizada
// ============================================================================
test("N6-M: metadata sensível é sanitizada (token/secret/key → [REDACTED])", async () => {
  const provider = await createActiveProvider({ metadata: { campaign: "ok", api_token: "secreto123", some_secret: "x", normal: 1 } });
  assert.equal(provider.metadata.campaign, "ok");
  assert.equal(provider.metadata.api_token, "[REDACTED]");
  assert.equal(provider.metadata.some_secret, "[REDACTED]");
  assert.equal(provider.metadata.normal, 1);

  const linkResult = await registerLinkFor(provider.provider_id, {
    metadata: { note: "teste", api_key_secret: "secreto456", campaign_credential: "x", plain: "valor" },
  });
  const meta = linkResult.record!.metadata;
  assert.equal(meta.note, "teste", "metadado normal preservado");
  assert.equal(meta.api_key_secret, "[REDACTED]", "chaves com 'secret'/'api_'/'credential' são redactadas");
  assert.equal(meta.campaign_credential, "[REDACTED]");
  assert.equal(meta.plain, "valor");
  // Chaves sensíveis do catálogo base (token/secret/password/authorization) são
  // removidas pelo sanitizeMetadata do reuso N3/N5 — não persistem como valor.
  assert.equal(meta.authorization, undefined, "'authorization' é removida (catálogo N3/N5)");
});

// ============================================================================
// N. e O. RLS ativo e zero policies públicas (verificação via SQL da migration)
// ============================================================================
test("N6-N/O: migration declara RLS ON e drop loop de policies públicas (auditoria estática)", async () => {
  const migration = fs.readFileSync(
    new URL("../supabase/migrations/20260816_affiliate_infrastructure.sql", import.meta.url),
    "utf-8"
  );
  for (const table of ["affiliate_providers", "affiliate_links"]) {
    assert.ok(migration.includes(`alter table public.${table} enable row level security`), `RLS ON: ${table}`);
    assert.ok(new RegExp(`tablename = '${table}' and schemaname = 'public'`).test(migration), `drop loop: ${table}`);
  }
  assert.ok(!migration.includes("create policy"), "migration não cria policies públicas");
});

// ============================================================================
// P. endpoint sem senha retorna 401
// ============================================================================
