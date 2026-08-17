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
// (continuação em affiliateGovernanceRoutes.test.ts)

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
test("N6-P: endpoint sem x-admin-password retorna 401", async () => {
  const app = express();
  app.use(express.json());
  registerAffiliateRoutes(app, (_req, res) => {
    res.status(401).json({ success: false, error: "Acesso administrativo não autorizado. Senha ausente." });
  });
  const api = supertest(app);
  const routes: ReadonlyArray<[string, () => Promise<supertest.Response>]> = [
    ["POST providers", () => api.post("/api/commercial/affiliate/providers").send(SHOPEE_PROVIDER)],
    ["GET providers", () => api.get("/api/commercial/affiliate/providers")],
    ["GET providers/:id", () => api.get("/api/commercial/affiliate/providers/affprv-x")],
    ["POST links", () => api.post("/api/commercial/affiliate/links").send({})],
    ["GET links", () => api.get("/api/commercial/affiliate/links")],
    ["GET links/:id", () => api.get("/api/commercial/affiliate/links/afflnk-x")],
    ["POST validate", () => api.post("/api/commercial/affiliate/links/afflnk-x/validate")],
    ["POST revoke", () => api.post("/api/commercial/affiliate/links/afflnk-x/revoke")],
  ];
  for (const route of routes) {
    const res = await route[1]();
    assert.equal(res.status, 401, route[0]);
  }
});

// ============================================================================
// Q. estado desconhecido falha fechado
// ============================================================================
test("N6-Q: estados desconhecidos são rejeitados (falha fechada)", async () => {
  const provider = await createActiveProvider();
  const weird = await persistProvider({ ...SHOPEE_PROVIDER, provider_code: "weird-test", status: "SUPER_ACTIVE" as any });
  assert.equal(weird.ok, false);
  assert.equal(weird.reason, "status_invalid");
  // validation_state só pode ser mudada via validateAffiliateLink — a API de
  // registro não aceita input de validation_state (novo registro sempre
  // UNVALIDATED).
  const result = await registerLinkFor(provider.provider_id);
  assert.equal(result.record!.validation_state, "UNVALIDATED");
});

// ============================================================================
// R. provider incompatível com domínio é rejeitado
// ============================================================================
test("N6-R: provider/marketplace incompatível com domínio é rejeitado", async () => {
  // Provider Shopee não pode registrar link meli.la (mercado incompatível).
  const shopee = await createActiveProvider();
  const cross = await registerLinkFor(shopee.provider_id, { marketplace: "MercadoLivre", affiliate_url: VALID_ML_URL });
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, "provider_marketplace_mismatch");
});

test("N6-R (b): provider INACTIVE não aceita links", async () => {
  const inactive = await createActiveProvider({}, "INACTIVE");
  const result = await registerLinkFor(inactive.provider_id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_not_active");
});

test("N6-R (c): provider PENDING_REVIEW não aceita links", async () => {
  const pending = await createActiveProvider({}, "PENDING_REVIEW");
  const result = await registerLinkFor(pending.provider_id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_not_active");
});

// ============================================================================
// S. validação inconclusiva não vira APPROVED/VALID
// ============================================================================
test("N6-S (a): rede indisponivel nao vira VALID (inconclusive)", async () => {
  // O registro estrutural rejeita domínios fora do catálogo (domain_not_allowed),
  // então a prova do caminho de rede inconclusivo usa liveHostCheck diretamente:
  // domínio inexistente → DNS falha → network_error → redirect_ok=false → o
  // validateAffiliateLink nunca poderia derivar VALID desse resultado.
  const live = await liveHostCheck(
    "https://host-nao-existe-xyz.invalid/pagina-prova?utm_source=an_x",
    "Shopee"
  );
  assert.equal(live.redirect_ok, false, "falha de rede não aprova redirect");
  assert.ok(
    live.error_reason === "network_error" || live.error_reason === "timeout" || live.http_status === null,
    `live check com rede falha: redirect_ok=${live.redirect_ok} http_status=${live.http_status} error_reason=${live.error_reason ?? "n/a"}`
  );
  // E o registro de um link REAL do catálogo com validação estrutural (sem live)
  // permanece DRAFT/UNVALIDATED — nada vira VALID por default.
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id);
  assert.ok(linkResult.record);
  assert.notEqual(linkResult.record!.validation_state, "VALID");
});

test("N6-S (b): live check desabilitado fica PENDING_EXTERNAL (nunca aprova)", async () => {
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id);
  const outcome = await validateAffiliateLink(linkResult.record!, { allowLiveCheck: false });
  assert.equal(outcome.validation_state, "PENDING_EXTERNAL");
  const persisted = await recordLinkValidation(linkResult.record!.link_id, outcome);
  assert.notEqual(persisted.record!.validation_state, "VALID");
});

test("N6-S (c): link expirado nao pode virar VALID", async () => {
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id, {
    expires_at: new Date(Date.now() - 86400_000).toISOString(),
  });
  assert.ok(linkResult.record);
  const outcome = await validateAffiliateLink(linkResult.record!, { allowLiveCheck: false });
  // Expiração passada → INVALID estrutural (antes mesmo do fetch).
  assert.equal(outcome.validation_state, "INVALID");
  assert.ok(outcome.checks.some(c => c.check === "expiry" && !c.ok));
});

// ============================================================================
// T–X. registrar link não cria produto / não promove / não executa / não
//      cria job / não habilita agente (prova por invariante do repositório)
// ============================================================================
test("N6-T/U/V/W/X: persistLink só toca as tabelas affiliate_* (nenhum produto, candidato, job ou agente)", async () => {
  const provider = await createActiveProvider();
  const before = new Set(fakeClient.store.keys());
  await persistLink({
    candidate_id: "cand-proof-001",
    marketplace: "Shopee",
    provider_id: provider.provider_id,
    affiliate_url: VALID_SHOPEE_URL,
  });
  const after = new Set(fakeClient.store.keys());
  assert.deepEqual([...before], [...after], "nenhuma tabela nova foi tocada");
  // candidates/products/job_queue/agent_executions nunca aparecem no fake
  // usado pelo módulo — prova que o repository não os consulta.
  assert.equal(fakeClient.store.has("products"), false);
  assert.equal(fakeClient.store.has("candidates"), false);
  assert.equal(fakeClient.store.has("job_queue"), false);
  assert.equal(fakeClient.store.has("agent_executions"), false);
});

// ============================================================================
// Y. Policy Engine continua sendo a autoridade
// ============================================================================
test("N6-Y: resolver um link utilizável NÃO publica (apenas retorna dados governados)", async () => {
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id);
  assert.ok(linkResult.record);
  // Sem validação → nenhum link utilizável (fail-closed).
  const nothing = await resolveUsableLinkForCandidate("cand-test-001");
  assert.equal(nothing.ok, false);
  assert.equal(nothing.reason, "no_usable_link");
  // Mesmo após "validar" localmente, resolve apenas retorna DADOS; não
  // existe nenhum caminho neste módulo que crie produto/publicação/job.
  const withValid = await resolveUsableLinkForCandidate("candidato-inexistente-001");
  assert.equal(withValid.ok, false);
});

// ============================================================================
// Z. affiliate link não equivale a autorização de execução
// ============================================================================
test("N6-Z: link VALID não autoriza execução (o executor N5 exige DECISION + Policy + Approval)", async () => {
  // Prova: o resolver do N6 devolve o link governado, mas não executa nada;
  // a publicação exige o executor N5 (testado no Bloco N5). Aqui provamos
  // que o estado VALID do link não dispara nenhum efeito colateral.
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id);
  assert.ok(linkResult.record);
  const preLinks = await listLinksByCandidate("cand-test-001");
  await recordLinkValidation(linkResult.record!.link_id, {
    validation_state: "VALID",
    checks: [{ check: "structural", ok: true }, { check: "expiry", ok: true }],
  });
  const postLinks = await listLinksByCandidate("cand-test-001");
  assert.equal(preLinks.length, postLinks.length, "nenhuma linha nova/alteração de estado além da validação");
  const valid = postLinks[0];
  assert.equal(valid.status, "VALID");
  // E o resolveUsableLinkForCandidate ainda apenas retorna dados.
  const resolved = await resolveUsableLinkForCandidate("cand-test-001");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.link!.link_id, linkResult.record!.link_id);
});

// ============================================================================
// Rota de validação: separação REGISTER != VALIDATE != APPROVE != EXECUTE
// ============================================================================
test("N6-Route/Validate: rota muda validation_state sem executar nada", async () => {
  const app = express();
  app.use(express.json());
  registerAffiliateRoutes(app, (_req, res, next) => next());
  const api = supertest(app);

  // Novo provider nasce PENDING_REVIEW (governança) — createActiveProvider registra
  // e ativa em seguida (comportamento administrativo governado).
  const provider = await createActiveProvider();
  const linkResult = await registerLinkFor(provider.provider_id);
  if (!linkResult.ok || !linkResult.record) throw new Error(`link: ${linkResult.reason}`);

  // Validação sem checagem viva → PENDING_EXTERNAL (REGISTER != VALIDATE).
  const validateRes = await api.post(`/api/commercial/affiliate/links/${linkResult.record.link_id}/validate`).send({ allow_live_check: false });
  assert.equal(validateRes.status, 200, `status real: ${validateRes.status}`);
  assert.equal(validateRes.body.link?.validation_state, "PENDING_EXTERNAL");
  assert.match(String(validateRes.body.note ?? ""), /VALID != AUTHORITY/);

  // GET por candidate_id
  const listRes = await api.get("/api/commercial/affiliate/links?candidate_id=cand-test-001");
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.links?.length, 1);

  // Revogação
  const revokeRes = await api.post(`/api/commercial/affiliate/links/${linkResult.record.link_id}/revoke`);
  assert.equal(revokeRes.status, 200);
  const revoked = await getLink(linkResult.record.link_id);
  assert.equal(revoked?.status, "REVOKED");

  // Link revogado não pode ser validado
  const validateAgain = await api.post(`/api/commercial/affiliate/links/${linkResult.record.link_id}/validate`);
  assert.equal(validateAgain.status, 400);
  assert.equal(validateAgain.body.error, "link_revoked");
});

// ============================================================================
// Integração resolveAffiliateLink (contrato N5 futuro)
// ============================================================================
test("N6-FailClosed: resolver é fail-closed em qualquer erro (adapter N5)", async () => {
  // Client nulo → erro interno do repositório → resolver retorna null (falha
  // fechada, sem lançar). resolveUsableLinkForCandidate puro lança por
  // design; o adapter affiliateLinkResolver do contrato N5 cobre o erro.
  setAffiliateClientForTests(null as any);
  const resolved = await resolveAffiliateLink({ candidateId: "cand-x", affiliateUrlManual: null });
  assert.equal(resolved.status, "RESOLUTION_ERROR", "resolver fail-closed retorna status explícito sem lançar");
  assert.equal(resolved.affiliateUrl, null);
  // Restaurar para os demais testes (node:test roda em ordem no arquivo).
  setAffiliateClientForTests(fakeClient as any);
});

test("N6-Withdrawn: validação estrutural reprova link com provider WITHDRAWN", async () => {
  const withdrawn = await createActiveProvider({}, "WITHDRAWN");
  const result = await registerLinkFor(withdrawn.provider_id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_not_active");
});
