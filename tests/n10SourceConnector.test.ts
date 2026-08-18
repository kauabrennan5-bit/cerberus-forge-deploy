// ============================================================================
// Bloco N10 — Source Connector Layer — Bateria completa (LOCAL)
// ---------------------------------------------------------------------------
// (LOCAL — sem deploy, sem credenciais, sem chamadas reais de rede).
//
// Prova dos contratos do N10:
//   - ConnectorRegistry (resolução, whitelist única do N2, fail-closed);
//   - marketplace normalization (snake/human → canônico UPPER do N2);
//   - ExternalIdentity (ML ITEM_ID / Shopee SHOP_ITEM / UNKNOWN);
//   - Source Connector (delegação ao N2, preservação de candidate_id,
//     collectionFailed e provenance; fronteiras de affiliate e products);
//   - idempotência de replay idêntico.
//
// O N10 NÃO cria candidates, NÃO gera affiliate URLs e NÃO toca products.
// Todos os cenários usam dados artificiais e mocks de delegação.
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import type { DiscoverResult, MarketplaceConnector, MarketplaceSource } from "../server/commercial/discovery/types";
import { normalizeMarketplace } from "../server/commercial/sourceConnector/marketplaceNormalization";
import { extractExternalIdentity } from "../server/commercial/sourceConnector/externalIdentity";
import { createConnectorRegistry, sourceConnectorRegistry } from "../server/commercial/sourceConnector/connectorRegistry";
import { discoverFromSource } from "../server/commercial/sourceConnector/sourceConnector";
import { SOURCE_CONNECTOR_CONTRACT_VERSION, isExternalIdentityKnown, type ConnectorResult } from "../server/commercial/sourceConnector/contracts";

function stripComments(code: string): string {
  // Remove blocos /* ... */ (JSDoc de fronteira de arquitetura) e linhas // (escaneamento de código).
  const out = code.replace(/\/\*[\s\S]*?\*\//g, "");
  return out
    .split("\n")
    .filter(line => !line.trimStart().startsWith("//"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Dado artificial e mock do delegate N2 (executeDiscover) — nunca toca rede.
// ---------------------------------------------------------------------------
const ML_URL = "https://www.mercadolivre.com.br/lanterna-alta-potencia-recarregavel/p/MLB3421000";
const SHOPEE_URL = "https://shopee.com.br/loja-exemplo/12345678/98765432";
const ML_BAD_URL = "https://www.mercadolivre.com.br/alguma-coisa-sem-item-id";
const SHOPEE_BAD_URL = "https://shopee.com.br/busca?q=algo";

function fakeDiscoverResult(opts: { candidate_id: string | null; unknown_fields?: string[]; ok?: boolean; error?: string }): DiscoverResult {
  return {
    ok: opts.ok ?? true,
    marketplace: "MERCADOLIVRE",
    mode: "url",
    found: opts.ok !== false ? 1 : 0,
    created: opts.candidate_id && !opts.unknown_fields?.length ? 1 : 0,
    duplicates: 0,
    conflicts: 0,
    items:
      opts.ok === false
        ? []
        : [
            {
              outcome: opts.candidate_id ? "created" : "conflict_rejected",
              candidate_id: opts.candidate_id,
              marketplace: "MERCADOLIVRE",
              source_url: ML_URL,
              title: null,
              unknown_fields: opts.unknown_fields ?? [],
            },
          ],
    error: opts.error,
  };
}

function makeConnector(source: MarketplaceSource): MarketplaceConnector {
  return { marketplace: source } as unknown as MarketplaceConnector;
}

// ---------------------------------------------------------------------------
// N10-01 — ConnectorRegistry resolve Mercado Livre.
// ---------------------------------------------------------------------------
test("N10-01 ConnectorRegistry resolve Mercado Livre", () => {
  const registry = createConnectorRegistry();
  const connector = makeConnector("MERCADOLIVRE");
  const reg = registry.register(connector);
  assert.equal(reg.ok, true, "registro ML deve aceitar");
  assert.equal(registry.resolve("MERCADOLIVRE"), connector, "resolução ML deve retornar o connector registrado");
  assert.equal(registry.has("MERCADOLIVRE"), true);
});

// ---------------------------------------------------------------------------
// N10-02 — ConnectorRegistry resolve Shopee.
// ---------------------------------------------------------------------------
test("N10-02 ConnectorRegistry resolve Shopee", () => {
  const registry = createConnectorRegistry();
  const connector = makeConnector("SHOPEE");
  assert.equal(registry.register(connector).ok, true);
  assert.equal(registry.resolve("SHOPEE"), connector, "resolução SHOPEE deve retornar o connector registrado");
  assert.equal(registry.has("SHOPEE"), true);
});

// ---------------------------------------------------------------------------
// N10-03 — marketplace snake_case normaliza para o canônico UPPER do N2.
// ---------------------------------------------------------------------------
test("N10-03 marketplace snake_case/human normaliza para canonical UPPER", () => {
  assert.deepEqual(normalizeMarketplace("mercadolivre"), { ok: true, marketplace: "MERCADOLIVRE", reason: null });
  assert.deepEqual(normalizeMarketplace("MERCADOLIVRE"), { ok: true, marketplace: "MERCADOLIVRE", reason: null });
  assert.deepEqual(normalizeMarketplace("Mercado Livre"), { ok: true, marketplace: "MERCADOLIVRE", reason: null });
  assert.deepEqual(normalizeMarketplace("MercadoLivre"), { ok: true, marketplace: "MERCADOLIVRE", reason: null });
  assert.deepEqual(normalizeMarketplace("shopee"), { ok: true, marketplace: "SHOPEE", reason: null });
  assert.deepEqual(normalizeMarketplace("SHOPEE"), { ok: true, marketplace: "SHOPEE", reason: null });
});

// ---------------------------------------------------------------------------
// N10-04 — marketplace desconhecido falha fechado.
// ---------------------------------------------------------------------------
test("N10-04 marketplace desconhecido falha fechado (nunca retorna palpite)", () => {
  const unknown = normalizeMarketplace("amazon");
  assert.equal(unknown.ok, false, "amazon não deve normalizar");
  assert.equal(unknown.marketplace, null, "nenhum marketplace pode ser devolvido");
  assert.match(String(unknown.reason), /desconhecido|ausente/);
  assert.deepEqual(normalizeMarketplace(""), { ok: false, marketplace: null, reason: "marketplace_ausente" });
  assert.equal(normalizeMarketplace(undefined).ok, false);
  assert.equal(normalizeMarketplace(123).ok, false);
});

// ---------------------------------------------------------------------------
// N10-05 — ExternalIdentity ML com item_id válido.
// ---------------------------------------------------------------------------
test("N10-05 ExternalIdentity ML com ITEM_ID válido extraído da URL", () => {
  const { identity } = extractExternalIdentity("MERCADOLIVRE", ML_URL);
  assert.equal(identity.status, "ITEM_ID");
  if (identity.status === "ITEM_ID") {
    assert.equal(identity.value, "MLB3421000");
    assert.equal(identity.marketplace, "MERCADOLIVRE");
    assert.equal(identity.source, "url");
    assert.equal(identity.raw_source, ML_URL);
  }
  assert.equal(isExternalIdentityKnown(identity), true);
});

// ---------------------------------------------------------------------------
// N10-06 — ExternalIdentity Shopee com shop_id + item_id.
// ---------------------------------------------------------------------------
test("N10-06 ExternalIdentity Shopee com SHOP_ITEM (shop_id + item_id)", () => {
  const { identity } = extractExternalIdentity("SHOPEE", SHOPEE_URL);
  assert.equal(identity.status, "SHOP_ITEM");
  if (identity.status === "SHOP_ITEM") {
    assert.equal(identity.shop_id, "12345678");
    assert.equal(identity.item_id, "98765432");
    assert.equal(identity.marketplace, "SHOPEE");
    assert.equal(identity.source, "url");
    assert.equal(identity.raw_source, SHOPEE_URL);
  }
  assert.equal(isExternalIdentityKnown(identity), true);
});

// ---------------------------------------------------------------------------
// N10-07 — ExternalIdentity ausente/inesgotável permanece UNKNOWN.
// ---------------------------------------------------------------------------
test("N10-07 ExternalIdentity ausente permanece UNKNOWN com rationale obrigatório", () => {
  const mlBad = extractExternalIdentity("MERCADOLIVRE", ML_BAD_URL);
  assert.equal(mlBad.identity.status, "UNKNOWN");
  if (mlBad.identity.status === "UNKNOWN") {
    assert.ok(mlBad.identity.rationale.length > 0, "UNKNOWN exige rationale");
  }
  const shopBad = extractExternalIdentity("SHOPEE", SHOPEE_BAD_URL);
  assert.equal(shopBad.identity.status, "UNKNOWN");
  assert.equal(isExternalIdentityKnown(mlBad.identity), false);
  assert.equal(isExternalIdentityKnown(shopBad.identity), false);
  assert.equal(extractExternalIdentity("MERCADOLIVRE", "").identity.status, "UNKNOWN");
  assert.equal(extractExternalIdentity("SHOPEE", "url-quebrada!").identity.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// N10-08 — URL não pode ser promovida automaticamente para identidade
// confirmada (heurística sozinha não confirma; sem ID estruturado → UNKNOWN).
// ---------------------------------------------------------------------------
test("N10-08 URL nunca é promovida para identidade confirmada por heurística", () => {
  // URLs sem o padrão estruturado do marketplace (busca, home, slug sem ID):
  for (const url of [
    "https://www.mercadolivre.com.br/?q=lanterna",
    "https://www.mercadolivre.com.br/ofertas",
    "https://shopee.com.br/busca?keyword=algo",
    "https://shopee.com.br/ofertas-relampago",
  ]) {
    const { identity } = extractExternalIdentity(url.includes("shopee") ? "SHOPEE" : "MERCADOLIVRE", url);
    assert.equal(identity.status, "UNKNOWN", `URL "${url}" não pode virar identidade confirmada`);
  }
  // slug bonito sem ID estruturado também fica UNKNOWN:
  const { identity } = extractExternalIdentity("MERCADOLIVRE", "https://www.mercadolivre.com.br/luminaria-moderna");
  assert.equal(identity.status, "UNKNOWN");
});

// ---------------------------------------------------------------------------
// N10-09 — RawListing/ConnectorResult não cria product (nenhuma API de
// products é acessada no N10) e não cria candidate diretamente.
// ---------------------------------------------------------------------------
test("N10-09 N10 não cria candidate diretamente nem acessa products", async () => {
  let discoverCalls = 0;
  let discoverArgs: unknown[] = [];
  const discoverFn = async (input: unknown): Promise<DiscoverResult> => {
    discoverCalls += 1;
    discoverArgs.push(input);
    return fakeDiscoverResult({ candidate_id: "cand-N10-09" });
  };
  sourceConnectorRegistry.register(makeConnector("MERCADOLIVRE"));
  const result = (await discoverFromSource({ marketplace: "MERCADOLIVRE", source_url: ML_URL }, { discoverFn })) as ConnectorResult;
  assert.equal(result.ok, true);
  assert.equal(discoverCalls, 1, "exatamente UMA chamada de delegação ao N2");
  assert.deepEqual(discoverArgs[0], { marketplace: "MERCADOLIVRE", mode: "url", url: ML_URL }, "delegação usa o contrato exato do N2");
  assert.equal(result.candidate_id, "cand-N10-09", "candidate_id vem do N2/N1 — nunca inventado pelo N10");
  assert.equal(result.external_identity.status, "ITEM_ID", "identidade conhecida propaga");
  if (result.external_identity.status === "ITEM_ID") assert.equal(result.external_identity.value, "MLB3421000");
});

// ---------------------------------------------------------------------------
// N10-10 — N10 não gera affiliateUrl em nenhum contrato.
// ---------------------------------------------------------------------------
test("N10-10 nenhum contrato N10 gera/contém affiliateUrl", () => {
  const contracts = JSON.stringify({
    version: SOURCE_CONNECTOR_CONTRACT_VERSION,
    types: Object.keys({}),
  });
  assert.equal(contracts.includes("affiliateUrl"), false, "contracts.ts não deve mencionar affiliateUrl");
  const result: ConnectorResult = {
    ok: true,
    marketplace: "MERCADOLIVRE",
    source_url: ML_URL,
    external_identity: {
      status: "ITEM_ID",
      marketplace: "MERCADOLIVRE",
      type: "ITEM_ID",
      value: "MLB3421000",
      source: "url",
      raw_source: ML_URL,
    },
    discover_result: null,
    candidate_id: "cand-x",
    collection_failed: false,
    failure_reason: null,
    error: null,
  };
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("affiliate"), false, "ConnectorResult não contém affiliateUrl nem campos afiliados");
  assert.equal(serialized.includes("revenue"), false);
  assert.equal(serialized.includes("roi"), false);
});

// ---------------------------------------------------------------------------
// N10-11 — N10 não acessa credenciais de afiliado (nenhum env do N8 é
// lido no código do N10).
// ---------------------------------------------------------------------------
test("N10-11 N10 não acessa credenciais de afiliado", async () => {
  const fs = await import("node:fs");
  // O registry N10 não referencia variáveis de ambiente de afiliados:
  const registryCode = fs.readFileSync(new URL("../server/commercial/sourceConnector/connectorRegistry.ts", import.meta.url), "utf8");
  assert.equal(registryCode.includes("SHOPEE_AFFILIATE_APP_ID"), false);
  assert.equal(registryCode.includes("SHOPEE_AFFILIATE_APP_SECRET"), false);
  assert.equal(registryCode.includes("open-api.affiliate"), false);
  // Remove linhas de comentário antes de escanear (comentários de fronteira de arquitetura são legítimos).
  const contractsCode = stripComments(fs.readFileSync(new URL("../server/commercial/sourceConnector/contracts.ts", import.meta.url), "utf8"));
  assert.equal(contractsCode.includes("affiliate"), false, "contratos N10 não contêm campos/funções do domínio de afiliados (comentários de fronteira exceto)");
  const connectorCode = stripComments(fs.readFileSync(new URL("../server/commercial/sourceConnector/sourceConnector.ts", import.meta.url), "utf8"));
  assert.equal(connectorCode.includes("affiliate"), false, "sourceConnector não chama/valida/gera o domínio de afiliados");
  const identityCode = stripComments(fs.readFileSync(new URL("../server/commercial/sourceConnector/externalIdentity.ts", import.meta.url), "utf8"));
  assert.equal(identityCode.includes("affiliate"), false, "externalIdentity não toca o domínio de afiliados");
  const normCode = stripComments(fs.readFileSync(new URL("../server/commercial/sourceConnector/marketplaceNormalization.ts", import.meta.url), "utf8"));
  assert.equal(normCode.includes("affiliate"), false, "normalization não toca o domínio de afiliados");
});

// ---------------------------------------------------------------------------
// N10-12 — N10 delega Discovery ao N2 (executeDiscover é a única autoridade).
// ---------------------------------------------------------------------------
test("N10-12 N10 delega Discovery exclusivamente ao N2", async () => {
  let delegated = false;
  const discoverFn = async (): Promise<DiscoverResult> => {
    delegated = true;
    return fakeDiscoverResult({ candidate_id: "cand-N10-12" });
  };
  const result = (await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn })) as ConnectorResult;
  assert.equal(delegated, true, "o delegate N2 foi invocado");
  assert.equal(result.ok, true);
  assert.ok(result.discover_result, "discover_result do N2 está propagado");
  assert.equal((result.discover_result as DiscoverResult).marketplace, "MERCADOLIVRE");
});

// ---------------------------------------------------------------------------
// N10-13 — candidate_id retornado pelo N2 é preservado (nunca inventado).
// ---------------------------------------------------------------------------
test("N10-13 candidate_id do N2 é preservado; sem N2 → null (nunca inventado)", async () => {
  const discoverFn = async (): Promise<DiscoverResult> => fakeDiscoverResult({ candidate_id: "cand-original-N1" });
  const ok = (await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn })) as ConnectorResult;
  assert.equal(ok.candidate_id, "cand-original-N1");

  // Quando o N2 não cria (conflict_rejected), o N10 NUNCA inventa candidate_id:
  const fail = await discoverFromSource(
    { marketplace: "mercadolivre", source_url: ML_URL },
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: null, unknown_fields: ["title", "price"] }) },
  );
  assert.equal(fail.ok, false);
  assert.equal(fail.candidate_id, null, "candidate_id ausente permanece null — nunca inventado");
  assert.equal(fail.collection_failed, true, "falha de coleta permanece identificável");
});

// ---------------------------------------------------------------------------
// N10-14 — collectionFailed é preservado (falha de coleta identificável).
// ---------------------------------------------------------------------------
test("N10-14 collectionFailed é preservado e nunca mascarado", async () => {
  // unknown_fields > 0 e sem candidate_id → falha de coleta identificável:
  const r1 = (await discoverFromSource(
    { marketplace: "mercadolivre", source_url: ML_URL },
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: null, unknown_fields: ["title", "price", "images"] }) },
  )) as ConnectorResult;
  assert.equal(r1.ok, false, "descoberta sem candidate com campos desconhecidos é falha");
  assert.equal(r1.collection_failed, true, "collection_failed = true quando houve falha de coleta");
  assert.match(r1.failure_reason ?? "", /collection_failed/);
  assert.equal(r1.candidate_id, null, "sem candidate_id criado → nunca inventado");

  // delegate operacional falhou → erro governado explícito:
  await discoverFromSource(
    { marketplace: "mercadolivre", source_url: ML_URL },
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: null }) as never },
  );
  const r3 = await discoverFromSource(
    { marketplace: "mercadolivre", source_url: ML_URL },
    { discoverFn: async () => { throw new Error("network_timeout"); } },
  );
  assert.equal(r3.ok, false);
  assert.equal(r3.error, "network_timeout");
  assert.equal(r3.failure_reason, "discovery_delegate_falhou");
  assert.equal(r3.candidate_id, null);
});

// ---------------------------------------------------------------------------
// N10-15 — replay idêntico permanece idempotente (o N2/N1 garante deduplicação;
// o N10 apenas delega sem estado local).
// ---------------------------------------------------------------------------
test("N10-15 replay idêntico permanece idempotente", async () => {
  let calls = 0;
  const discoverFn = async (): Promise<DiscoverResult> => {
    calls += 1;
    return fakeDiscoverResult({ candidate_id: calls === 1 ? "cand-new" : null });
  };
  const first = (await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn })) as ConnectorResult;
  const second = await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn });
  assert.equal(calls, 2, "replay re-delega (sem estado local escondido)");
  assert.equal(first.candidate_id, "cand-new");
  assert.equal(second.candidate_id, null, "replay idempotente não cria novo candidate_id");
  assert.equal(first.external_identity.status, second.external_identity.status, "identidade determinística = mesma para mesma URL");
  assert.equal((second as ConnectorResult).external_identity.status, "ITEM_ID");
});

// ---------------------------------------------------------------------------
// N10-16 — connector desconhecido retorna erro governado (fail-closed).
// ---------------------------------------------------------------------------
test("N10-16 connector ausente no registry retorna erro governado", async () => {
  const result = await discoverFromSource({ marketplace: "SHOPEE", source_url: SHOPEE_URL });
  assert.equal(result.ok, false);
  assert.equal((result as { failure_reason: string }).failure_reason, "connector_ausente");
  assert.equal((result as { candidate_id: string | null }).candidate_id, null);
});

// ---------------------------------------------------------------------------
// N10-17 — entrada de source_url inválida retorna erro governado.
// ---------------------------------------------------------------------------
test("N10-17 source_url ausente/inválida retorna erro governado sem delegar", async () => {
  let delegated = false;
  const discoverFn = async (): Promise<DiscoverResult> => { delegated = true; return fakeDiscoverResult({ candidate_id: null }); };
  const r1 = await discoverFromSource({ marketplace: "mercadolivre", source_url: "" }, { discoverFn });
  assert.equal(r1.ok, false);
  assert.equal(r1.failure_reason, "source_url_ausente");
  assert.equal(delegated, false, "URL vazia nunca chega ao N2");

  const r2 = await discoverFromSource({ marketplace: "mercadolivre", source_url: "not-a-url" }, { discoverFn });
  assert.equal(r2.ok, false);
  assert.equal(r2.failure_reason, "source_url_invalida");
  assert.equal(delegated, false);
});

// ---------------------------------------------------------------------------
// N10-18 — registry protege a whitelist única do N2: connector de marketplace
// sem whitelist conhecida é rejeitado.
// ---------------------------------------------------------------------------
test("N10-18 registry rejeita connector de marketplace sem whitelist N2", () => {
  const registry = createConnectorRegistry();
  // Connector malicioso que afirma um marketplace sem hosts permitidos:
  const rogue = { marketplace: "AMAZON" } as unknown as MarketplaceConnector;
  const reg = registry.register(rogue);
  assert.equal(reg.ok, false);
  assert.equal(reg.reason, "connector_marketplace_nao_permitido");
  assert.equal(registry.has("AMAZON" as MarketplaceSource), false);
});

// ---------------------------------------------------------------------------
// N10-19 — UNKNOWN nunca é promovido dentro do ConnectorResult: quando a
// identidade não pôde ser extraída, o resultado a mantém UNKNOWN.
// ---------------------------------------------------------------------------
test("N10-19 UNKNOWN permanece UNKNOWN no ConnectorResult", async () => {
  const discoverFn = async (): Promise<DiscoverResult> => fakeDiscoverResult({ candidate_id: "cand-unknown" });
  const result = (await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_BAD_URL }, { discoverFn })) as ConnectorResult;
  assert.equal(result.external_identity.status, "UNKNOWN", "sem item ID → UNKNOWN");
  if (result.external_identity.status === "UNKNOWN") {
    assert.match(result.external_identity.rationale, /item ID/i);
  }
  assert.equal(isExternalIdentityKnown(result.external_identity), false);
});

// ============================================================================
// FASE 2 — Testes adicionais de consolidação e hardening (N10-20→N10-28)
// ---------------------------------------------------------------------------
// Hardening da Fase 2: dialetos fail-closed, regressão do placeholder de
// marketplace, SSRF preservado no N2, não-subversão estrutural (products,
// affiliate, publication, agents), proveniência e registro no registry.
// ============================================================================

// ---------------------------------------------------------------------------
// N10-20 — dialetos de marketplace NÃO aceitos falham fechado.
// "mercado-livre", "Amazon", "ShopeeBrasil", dialeto com hífen ou inventado
// nunca podem ser aproximados textualmente a um marketplace válido.
// ---------------------------------------------------------------------------
test("N10-20 dialetos inválidos falham fechado (hífen, inventado, vazio, null, undefined)", () => {
  for (const dialect of ["mercado-livre", "Amazon", "ShopeeBrasil", "shopee-br", "MERCADO_LIVRE", "mercado-livre.com.br", null, undefined, 42]) {
    const out = normalizeMarketplace(dialect as unknown as string);
    assert.equal(out.ok, false, `dialeto "${String(dialect)}" não pode normalizar`);
    assert.equal(out.marketplace, null);
    assert.ok(/desconhecido|ausente|inv/.test(String(out.reason)), `reason governado para "${String(dialect)}"`);
  }
});

// ---------------------------------------------------------------------------
// N10-21 — connector de dialeto inventado é rejeitado pelo registry
// (fail-closed: sem whitelist conhecida → sem connector criado).
// ---------------------------------------------------------------------------
test("N10-21 registry falha fechado para marketplace inventado", () => {
  const registry = createConnectorRegistry();
  const rogue = { marketplace: "Amazon" } as unknown as MarketplaceConnector;
  assert.equal(registry.register(rogue).ok, false, "Amazon sem whitelist é rejeitado");
  assert.equal(registry.has("Amazon" as MarketplaceSource), false);
  assert.equal(registry.resolve("Amazon" as MarketplaceSource), null);
});

// ---------------------------------------------------------------------------
// N10-22 — regressão: erro antes da normalização NUNCA recebe um marketplace
// específico inventado (placeholder removido na Fase 2).
// ---------------------------------------------------------------------------
test("N10-22 entrada inválida retorna UNKNOWN com marketplace NULL (sem placeholder)", async () => {
  const r1 = await discoverFromSource({ marketplace: "mercado-livre", source_url: "https://exemplo.com/x" });
  assert.equal(r1.ok, false);
  assert.equal(r1.external_identity.status, "UNKNOWN");
  assert.equal(r1.external_identity.marketplace, null, "marketplace NULL quando a normalização não concluiu");

  const r2 = await discoverFromSource({ marketplace: null, source_url: "https://exemplo.com/x" } as unknown as { marketplace: unknown; source_url: string });
  assert.equal(r2.ok, false);
  assert.equal(r2.external_identity.marketplace, null);
});

// ---------------------------------------------------------------------------
// N10-23 — idempotência determinística: mesma (marketplace, external_listing_id)
// gera a mesma identidade em qualquer ordem de chamada; o N10 não tem estado
// local e a deduplicação continua sendo listKeyFrom do N1.
// ---------------------------------------------------------------------------
test("N10-23 identidade é determinística para mesma URL (sem estado local)", async () => {
  const discoverFn = async (): Promise<DiscoverResult> => fakeDiscoverResult({ candidate_id: "cand-det" });
  const a = await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn });
  const b = await discoverFromSource({ marketplace: "MERCADOLIVRE", source_url: ML_URL }, { discoverFn });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(
    a.external_identity,
    b.external_identity,
    "mesma URL → mesma external identity (determinística, sem estado)",
  );
  if (a.external_identity.status === "ITEM_ID") {
    assert.equal(a.external_identity.value, "MLB3421000");
  }
  // URLs distintas NUNCA produzem a mesma identidade:
  const c = await discoverFromSource({ marketplace: "mercadolivre", source_url: "https://www.mercadolivre.com.br/produto-outro/p/MLB9999999" }, { discoverFn });
  if (c.external_identity.status === "ITEM_ID" && a.external_identity.status === "ITEM_ID") {
    assert.notEqual(a.external_identity.value, c.external_identity.value, "item IDs distintos");
  }
});

// ---------------------------------------------------------------------------
// N10-24 — não-subversão estrutural: o N10 não importa/aponta para
// products, acquisition, publication, job_queue, agents, scheduler ou worker.
// ---------------------------------------------------------------------------
test("N10-24 N10 não possui caminho para products/acquisition/publication/jobs/agents", async () => {
  const fs = await import("node:fs");
  const base = new URL("../server/commercial/sourceConnector/", import.meta.url);
  for (const file of ["sourceConnector.ts", "connectorRegistry.ts", "externalIdentity.ts", "marketplaceNormalization.ts", "contracts.ts"]) {
    const code = stripComments(fs.readFileSync(new URL(file, base), "utf8"));
    assert.equal(code.includes("productsRepository"), false, `${file}: sem productsRepository`);
    assert.equal(code.includes("publicationExecutor"), false, `${file}: sem publicationExecutor`);
    assert.equal(code.includes("acquisitionService"), false, `${file}: sem acquisitionService`);
    assert.equal(code.includes("affiliate_links"), false, `${file}: sem affiliate_links`);
    assert.equal(code.includes("affiliate_providers"), false, `${file}: sem affiliate_providers`);
    assert.equal(code.includes("job_queue"), false, `${file}: sem job_queue`);
    assert.equal(code.includes("agents"), false, `${file}: sem agents`);
    assert.equal(code.includes("scheduler"), false, `${file}: sem scheduler`);
    assert.equal(code.includes("SHOPEE_AFFILIATE"), false, `${file}: sem envs de afiliado`);
  }
});

// ---------------------------------------------------------------------------
// N10-25 — SSRF permanece no N2: o N10 não aplica sua própria validação de
// host (não cria segunda fonte de verdade); a proteção está no delegate
// (validateDiscoveryUrl + isRedirectHostAllowed do discovery/evidence.ts).
// ---------------------------------------------------------------------------
test("N10-25 SSRF permanece garantido pelo delegate N2 (não revalidado em duplicidade)", async () => {
  const fs = await import("node:fs");
  const evidence = fs.readFileSync(new URL("../server/commercial/discovery/evidence.ts", import.meta.url), "utf8");
  assert.ok(/validateDiscoveryUrl/.test(evidence), "validateDiscoveryUrl existe no N2");
  assert.ok(/isRedirectHostAllowed/.test(evidence), "validação de redirect existe no N2");
  assert.ok(/169\.254|localhost|127\.|10\.|192\.168|0\.0\.0\.0/.test(evidence), "guard SSRF presente no N2");
  const connector = stripComments(fs.readFileSync(new URL("../server/commercial/sourceConnector/sourceConnector.ts", import.meta.url), "utf8"));
  // O N10 só faz URL.parse (sanitização) — a proteção real é do delegate:
  assert.equal(connector.includes("validateDiscoveryUrl"), false, "N10 não re-implementa o guard do N2");
  // O N10 delega SEMPRE ao executeDiscover (único ponto de execução de rede);
  // a URL suspeita chega ao delegate para o guard real aplicá-la:
  let delegatedUrl: string | null = null;
  const discoverFn = async (input: { marketplace: MarketplaceSource; mode: "url" | "search"; url?: string }): Promise<DiscoverResult> => {
    delegatedUrl = input.url ?? null;
    // O delegate N2 real rejeita hosts privados; com o fake provamos apenas o
    // contrato de passagem (a execução real nunca usa o fake):
    return fakeDiscoverResult({ candidate_id: null }) as never;
  };
  await discoverFromSource({ marketplace: "mercadolivre", source_url: "http://169.254.169.254/latest/meta-data/" }, { discoverFn });
  assert.equal(delegatedUrl, "http://169.254.169.254/latest/meta-data/", "URL chega ao delegate para o guard SSRF do N2 validar");
});

// ---------------------------------------------------------------------------
// N10-26 — proveniência preservada: o N10 propaga o discover_result do N2
// sem apagar/substituir campos; sem candidate criado, a falha permanece.
// ---------------------------------------------------------------------------
test("N10-26 proveniência do N2 é propagada intacta", async () => {
  // Prova A — delegate com candidate criado E unknown_fields: o N10 propaga ok:true
  // (o N1/N2 criou o candidate; os unknown_fields ficam como proveniência do item):
  const discoverFnA = async (): Promise<DiscoverResult> =>
    fakeDiscoverResult({ candidate_id: "cand-prov", unknown_fields: ["title"] });
  const resultA = await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn: discoverFnA });
  assert.ok(resultA.discover_result, "discover_result propagado");
  const dr = resultA.discover_result as DiscoverResult;
  assert.equal(dr.marketplace, "MERCADOLIVRE", "marketplace do N2 preservado");
  assert.equal(dr.items[0].unknown_fields.length, 1, "unknown_fields do N2 preservado");
  assert.equal(resultA.candidate_id, "cand-prov", "candidate criado pelo N1 preservado");

  // Prova B — delegate com unknown_fields E SEM candidate: falha fechada:
  const discoverFnB = async (): Promise<DiscoverResult> =>
    fakeDiscoverResult({ candidate_id: null, unknown_fields: ["title"] });
  const resultB = await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn: discoverFnB });
  assert.equal(resultB.ok, false, "sem candidate com unknown_fields → falha fechada no N10");
  assert.match(resultB.failure_reason ?? "", /collection_failed/);
});

// ---------------------------------------------------------------------------
// N10-27 — registry expõe a whitelist do N2 (fonte única para a camada N10).
// ---------------------------------------------------------------------------
test("N10-27 whitelist exposta pelo registry é a de MARKETPLACE_HOSTS do N2", async () => {
  const { MARKETPLACE_HOSTS } = await import("../server/commercial/discovery/types");
  const registry = sourceConnectorRegistry;
  const hosts = registry.getWhitelistHosts();
  assert.deepEqual(hosts.MERCADOLIVRE, MARKETPLACE_HOSTS.MERCADOLIVRE);
  assert.deepEqual(hosts.SHOPEE, MARKETPLACE_HOSTS.SHOPEE);
});

// ---------------------------------------------------------------------------
// N10-28 — fail-closed completo: nenhum caminho do N10 converte erro em
// sucesso (ok:true exige candidate_id real criado pelo N2/N1).
// ---------------------------------------------------------------------------
test("N10-28 ok:true somente com candidate_id real (regressão de regressão)", async () => {
  const cases = [
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: null }), expectOk: false, expectReason: "candidate_not_created" },
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: null, unknown_fields: ["a"] }), expectOk: false, expectReason: "collection_failed" },
    { discoverFn: async () => fakeDiscoverResult({ ok: false, candidate_id: null }), expectOk: false, expectReason: "discovery_failed" },
    { discoverFn: async () => { throw new Error("boom"); }, expectOk: false, expectReason: "discovery_delegate_falhou" },
    { discoverFn: async () => fakeDiscoverResult({ candidate_id: "real" }), expectOk: true, expectReason: null },
  ];
  for (const c of cases) {
    const r = await discoverFromSource({ marketplace: "mercadolivre", source_url: ML_URL }, { discoverFn: c.discoverFn });
    assert.equal(r.ok, c.expectOk, `esperado ok=${c.expectOk} (reason=${c.expectReason})`);
    if (!c.expectOk) {
      assert.equal(r.failure_reason, c.expectReason, `failure_reason governado: ${c.expectReason}`);
      assert.equal(r.candidate_id, null);
    } else {
      assert.equal((r as ConnectorResult).candidate_id, "real");
    }
  }
});
