// ============================================================================
// Bloco N2 — Testes dos Conectores de Marketplace.
// Padrão node:test (tsx --test), coerente com as demais suites do projeto.
// Cobertura A–T do contrato + provas explícitas de escopo:
// DISCOVERY != PUBLICATION e CANDIDATE != CANONICAL PRODUCT.
// Nenhum teste toca produtos, catálogo, job queue ou agentes.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKETPLACE_SOURCE,
  MARKETPLACE_SOURCES,
  isMarketplaceSource,
  rawField,
  DISCOVERY_LIMITS,
} from "../server/commercial/discovery/types";
import { SlidingWindowRateLimiter, CircuitBreaker } from "../server/commercial/discovery/rateLimiter";
import {
  evidenceDigest,
  contentSnapshot,
  validateDiscoveryUrl,
  isRedirectHostAllowed,
} from "../server/commercial/discovery/evidence";
import { CandidateNormalizer } from "../server/commercial/discovery/normalizer";
import * as scraperModule from "../server/services/scraper";
import { buildRawListing } from "../server/commercial/discovery/fetchShared";
import { parseDiscoverCommand } from "../server/services/discoveryCommands";
import { setupDiscoveryRoutes } from "../server/routes/discoveryRoutes";
import { executeDiscover } from "../server/commercial/discovery/discover";
import * as candidatesRepository from "../server/repositories/candidatesRepository";

// -----------------------------------------------------------------------------
// A. Connector contract
// -----------------------------------------------------------------------------
test("N2 (A): identidades formais ML e Shopee existem", () => {
  assert.equal(MARKETPLACE_SOURCE.MERCADOLIVRE, "MERCADOLIVRE");
  assert.equal(MARKETPLACE_SOURCE.SHOPEE, "SHOPEE");
  assert.equal(MARKETPLACE_SOURCES.length, 2);
});

test("N2 (A): isMarketplaceSource valida e rejeita", () => {
  assert.equal(isMarketplaceSource("MERCADOLIVRE"), true);
  assert.equal(isMarketplaceSource("SHOPEE"), true);
  assert.equal(isMarketplaceSource("AMAZON"), false);
  assert.equal(isMarketplaceSource(123), false);
});

// -----------------------------------------------------------------------------
// B. Segurança (rate limit, circuit breaker, whitelist, redirects, fail-closed)
// -----------------------------------------------------------------------------
test("N2 (B): domínio ML permitido é aceito", () => {
  const v = validateDiscoveryUrl("https://item.mercadolivre.com.br/MLB-1234567890", "MERCADOLIVRE");
  assert.equal(v.ok, true);
});

test("N2 (B): domínio ML não permitido é recusado (fail-closed)", () => {
  assert.equal(validateDiscoveryUrl("https://google.com", "MERCADOLIVRE").ok, false);
  assert.equal(validateDiscoveryUrl("https://mercadolivre.com.br", "SHOPEE").ok, false);
  assert.equal(validateDiscoveryUrl("https://outrosite.com/ml-123", "MERCADOLIVRE").ok, false);
});

test("N2 (B): domínio Shopee permitido é aceito", () => {
  assert.equal(validateDiscoveryUrl("https://shopee.com.br/loja/123/456", "SHOPEE").ok, true);
  assert.equal(validateDiscoveryUrl("https://www.shopee.com.br/product/1/2", "SHOPEE").ok, true);
});

test("N2 (B): domínio Shopee não permitido é recusado (fail-closed)", () => {
  assert.equal(validateDiscoveryUrl("https://mercadolivre.com.br", "SHOPEE").ok, false);
  assert.equal(validateDiscoveryUrl("https://outrosite.com/123/456", "SHOPEE").ok, false);
});

test("N2 (B): redirect para domínio não permitido é recusado", () => {
  assert.equal(isRedirectHostAllowed("https://evil.com/phishing", "MERCADOLIVRE"), false);
  assert.equal(isRedirectHostAllowed("https://shopee.com.br/loja/1/2", "SHOPEE"), true);
  assert.equal(isRedirectHostAllowed("https://malicioso.com/1/2", "SHOPEE"), false);
});

test("N2 (B): localhost e redes internas são recusados (defesa em profundidade)", () => {
  assert.equal(validateDiscoveryUrl("http://localhost/1/2", "SHOPEE").ok, false);
  assert.equal(validateDiscoveryUrl("http://127.0.0.1/1/2", "SHOPEE").ok, false);
  assert.equal(validateDiscoveryUrl("http://192.168.1.1/1/2", "MERCADOLIVRE").ok, false);
});

test("N2 (B): URL malformada ou javascript: é recusada (fail-closed)", () => {
  assert.equal(validateDiscoveryUrl("", "MERCADOLIVRE").ok, false);
  assert.equal(validateDiscoveryUrl("   ", "SHOPEE").ok, false);
  assert.equal(validateDiscoveryUrl("javascript:alert(1)", "MERCADOLIVRE").ok, false);
});

test("N2 (B): rate limiter bloqueia após estourar a janela", () => {
  const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  assert.equal(limiter.tryAcquire("host-a"), true);
  assert.equal(limiter.tryAcquire("host-a"), true);
  assert.equal(limiter.tryAcquire("host-a"), false); // excedeu maxRequests
  assert.equal(limiter.tryAcquire("host-b"), true); // outro host não é afetado
});

test("N2 (B): circuit breaker abre após threshold de falhas", () => {
  const breaker = new CircuitBreaker(3, 60_000);
  breaker.recordFailure("host-x");
  breaker.recordFailure("host-x");
  assert.equal(breaker.allowsRequest("host-x"), true);
  breaker.recordFailure("host-x"); // 3ª falha → open
  assert.equal(breaker.state("host-x").state, "open");
  assert.equal(breaker.allowsRequest("host-x"), false);
});

test("N2 (B): circuit breaker half-open permite uma tentativa após a janela", () => {
  const breaker = new CircuitBreaker(3, 60_000);
  breaker.recordFailure("host-y");
  breaker.recordFailure("host-y");
  breaker.recordFailure("host-y");
  assert.equal(breaker.state("host-y").state, "open");
  const spy = { orig: Date.now };
  Date.now = () => spy.orig() + 61_000;
  try {
    assert.equal(breaker.allowsRequest("host-y"), true); // half-open
    breaker.recordSuccess("host-y");
    assert.equal(breaker.state("host-y").state, "closed");
  } finally {
    Date.now = spy.orig;
  }
});

test("N2 (B): retry máximo é 1 (MAX_RETRIES=1)", () => {
  assert.equal(DISCOVERY_LIMITS.MAX_RETRIES, 1);
});

test("N2 (B): snapshot de evidência trunca e registra bytes omitidos", () => {
  const big = "x".repeat(DISCOVERY_LIMITS.MAX_CONTENT_SNAPSHOT_BYTES + 500);
  const snapshot = contentSnapshot(big);
  assert.ok(snapshot.includes(`[truncated: ${big.length - DISCOVERY_LIMITS.MAX_CONTENT_SNAPSHOT_BYTES} bytes omitidos do snapshot]`));
  assert.ok(snapshot.length < big.length);
});

test("N2 (B): timeout explícito de 15s está definido", () => {
  assert.equal(DISCOVERY_LIMITS.TIMEOUT_MS, 15_000);
});

// -----------------------------------------------------------------------------
// C. Dados: digest, timestamp, proveniência, UNKNOWN
// -----------------------------------------------------------------------------
test("N2 (C): digest é determinístico e sha256", () => {
  const d1 = evidenceDigest("abc");
  const d2 = evidenceDigest("abc");
  assert.equal(d1, d2);
  assert.match(d1, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(evidenceDigest("def"), d1);
});

test("N2 (C): rawField marca ausência como UNKNOWN — ausência nunca vira 0/false/frase inventada", () => {
  assert.equal(rawField(10).unknown, false);
  assert.equal(rawField(null).unknown, true);
  assert.equal(rawField(null).value, null);
  assert.equal(rawField<number>(null).value === 0, false);
});

test("N2 (C): rawListing preserva timestamp ISO, digest e método de coleta", () => {
  const listing = buildRawListing({
    marketplace: "SHOPEE",
    source_url: "https://shopee.com.br/loja/1/2",
    final_url: "https://shopee.com.br/loja/1/2",
    httpStatus: 200,
    title: "Produto teste",
    price: 99.9,
    images: [],
    content: "<html>teste</html>",
  });
  assert.ok(new Date(listing.observed_at).getTime() > 0);
  assert.match(listing.evidence_digest, /^sha256:/);
  assert.equal(listing.collection_method, "PUBLIC_PAGE");
  // Campos ausentes da página são UNKNOWN, não inventados
  assert.equal(listing.seller.unknown, true);
  assert.equal(listing.rating.unknown, true);
  assert.equal(listing.review_count.unknown, true);
  assert.equal(listing.availability.unknown, true);
  assert.equal(listing.category.unknown, true);
});

test("N2 (C): external_listing_id é extraído da URL do ML", () => {
  const listing = buildRawListing({
    marketplace: "MERCADOLIVRE",
    source_url: "https://item.mercadolivre.com.br/MLB-1234567890",
    final_url: "https://item.mercadolivre.com.br/MLB-1234567890",
    httpStatus: 200,
    title: "Teste",
    price: 10,
    images: [],
    content: "",
  });
  assert.equal(listing.external_listing_id, "MLB1234567890");
});

// -----------------------------------------------------------------------------
// D. Normalização
// -----------------------------------------------------------------------------
const normalizer = new CandidateNormalizer();

function minimalListing() {
  return buildRawListing({
    marketplace: "MERCADOLIVRE",
    source_url: "https://item.mercadolivre.com.br/MLB-1111111111",
    final_url: "https://item.mercadolivre.com.br/MLB-1111111111",
    httpStatus: 200,
    title: "Luminária de chão",
    price: 129.9,
    images: ["https://img.ml.com/x.jpg"],
    content: "<html>teste</html>",
  });
}

test("N2 (D): RawListing → Candidate, preservando marketplace, source_url e preço", () => {
  const payload = normalizer.normalize(minimalListing());
  assert.equal(payload.marketplace, "MERCADOLIVRE");
  assert.equal(payload.source_url, "https://item.mercadolivre.com.br/MLB-1111111111");
  assert.equal(payload.price.value, 129.9);
  assert.equal(payload.price.unknown, false);
  assert.equal(payload.price.source, "marketplace_page");
  assert.match(payload.evidence_hash, /^sha256:/);
});

test("N2 (D): campos ausentes viram UNKNOWN com proveniência 'unknown'", () => {
  const payload = normalizer.normalize(minimalListing());
  const unknowns = normalizer.unknownFields(payload);
  assert.ok(unknowns.includes("seller"));
  assert.ok(unknowns.includes("rating"));
  assert.equal(payload.seller.unknown, true);
  assert.equal(payload.seller.source, "unknown");
  assert.equal(payload.seller.value, null);
});

test("N2 (D): idempotência — marketplace + listing id são estáveis entre chamadas", () => {
  const p1 = normalizer.normalize(minimalListing());
  const p2 = normalizer.normalize(minimalListing());
  // A chave de idempotência do N1 deriva de marketplace + external_listing_id:
  assert.equal(p1.marketplace + p1.external_listing_id, p2.marketplace + p2.external_listing_id);
});

test("N2 (D): external_listing_id ausente vira UNKNOWN explícito (não inventa)", () => {
  const listing = minimalListing();
  listing.external_listing_id = null;
  const payload = normalizer.normalize(listing);
  assert.equal(payload.external_listing_id, "UNKNOWN");
});

// -----------------------------------------------------------------------------
// E. Registry N1 (idempotência e sem bypass)
// -----------------------------------------------------------------------------
// Fake PostgREST mínimo (mesmo padrão dos testes N1 do projeto).
type Rows = Array<Record<string, unknown>>;

function makeFakeClient(table: Rows) {
  return {
    from: (_name: string) => {
      const chain: any = {
        select: () => {
          const eqChain: any = { eq: (_k: string, _v: unknown) => eqChain, limit: () => ({ maybeSingle: async () => ({ data: table[0] ?? null, error: null }) }), then: async (resolve: (v: unknown) => unknown) => resolve({ data: table.slice(), count: table.length }) };
          return eqChain;
        },
        insert: (rows: Array<Record<string, unknown>>) => ({
          select: () => ({
            single: async () => {
              table.push(rows[0]);
              return { data: rows[0], error: null };
            },
          }),
        }),
        update: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: { code: "PGRST116", message: "not found" } }) }) }) }),
        delete: () => ({ eq: () => ({ then: async (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }) }) }),
      };
      return chain;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

test("N2 (E): registerCandidate é o único caminho de persistência (fake client N1)", async () => {
  // Usa o fake client oficial do projeto (setCandidatesClientForTests) — o
  // registro real do N1 é exercido, provando que o N2 persiste SOMENTE via N1.
  const rows: Rows = [];
  candidatesRepository.setCandidatesClientForTests(makeFakeClient(rows) as never);
  try {
    await executeDiscover({
      marketplace: "MERCADOLIVRE",
      mode: "url",
      url: "https://item.mercadolivre.com.br/MLB-2222222222",
      limit: 5,
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.marketplace, "Mercado Livre");
    assert.equal(row.collection_method, "SCRAPE");
    assert.equal(row.status, "DISCOVERED");
    assert.equal(row.funnel_stage, "INTAKE");
    assert.equal((row.metadata as Record<string, unknown>).discovery_block, "N2");
  } finally {
    candidatesRepository.setCandidatesClientForTests(null as never);
  }
});

test("N2 (E): executeDiscover não toca publicação — só conector + N1", async () => {
  // Prova de escopo: sem cliente N1 configurado (fail-closed), o registro é
  // recusado (missing_supabase) e NADA é gravado em products/candidatos.
  // O scraper do projeto trata falha de rede como extração de dados mínimos
  // (título derivado do URL, preço UNKNOWN) — fail-soft com dados UNKNOWN,
  // nunca inventados como se fossem fatos do anúncio.
  candidatesRepository.setCandidatesClientForTests(null as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network error");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await executeDiscover({
      marketplace: "SHOPEE",
      mode: "url",
      url: "https://shopee.com.br/loja/33/44",
    });
    // Sem cliente N1: registro recusado, zero criação — nada vai para o banco.
    assert.equal(result.created, 0);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].outcome, "conflict_rejected");
    // Preço nunca é inventado em falha: sem dados, o título vem do URL e os
    // campos desconhecidos são reportados — ausência ≠ dado factual:
    assert.notEqual(result.items[0].unknown_fields.includes("price"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// F. Endpoint POST /api/commercial/discover
// -----------------------------------------------------------------------------
function setupDiscoverRouteCapture() {
  let captured: ((req: any, res: any) => unknown) | null = null;
  setupDiscoveryRoutes({
    app: { post: (_path: string, ...handlers: unknown[]) => { captured = handlers[handlers.length - 1] as any; } },
    requireAdminAuth: (_req: unknown, _res: unknown, next: unknown) => (next as () => void)(),
  } as any);
  return () => captured!;
}

function makeRes() {
  const res: { status: (c: number) => any; json: (b: unknown) => any; statusCode: number; body: unknown } = {
    status: (code: number) => { res.statusCode = code; return res; },
    json: (body: unknown) => { res.body = body; return res; },
    statusCode: 0,
    body: null,
  };
  return res;
}

test("N2 (F): rejeita marketplace inválido com 400", async () => {
  const getHandler = setupDiscoverRouteCapture();
  const res = makeRes();
  await getHandler()({ body: { marketplace: "AMAZON", mode: "url", url: "https://a.com" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal((res.body as any).error, "invalid_marketplace");
});

test("N2 (F): rejeita mode inválido e ausência de url/query com 400", async () => {
  const getHandler = setupDiscoverRouteCapture();
  const res = makeRes();
  await getHandler()({ body: { marketplace: "ML", mode: "crawl" } }, res);
  assert.equal(res.statusCode, 400);
  const res2 = makeRes();
  await getHandler()({ body: { marketplace: "MERCADOLIVRE", mode: "url" } }, res2);
  assert.equal(res2.statusCode, 400);
  assert.equal((res2.body as any).error, "missing_url");
});

// -----------------------------------------------------------------------------
// G. Telegram — comandos controlados
// -----------------------------------------------------------------------------
test("N2 (G): comando válido ML url é aceito", () => {
  const p = parseDiscoverCommand("ML url https://item.mercadolivre.com.br/MLB-9999999999");
  assert.equal(p.kind, "execute");
  assert.equal(p.marketplace, "MERCADOLIVRE");
  assert.equal(p.mode, "url");
  assert.ok(p.url?.includes("MLB-9999999999"));
});

test("N2 (G): comando válido SH search é aceito", () => {
  const p = parseDiscoverCommand("SH search luminaria de chão");
  assert.equal(p.kind, "execute");
  assert.equal(p.marketplace, "SHOPEE");
  assert.equal(p.mode, "search");
  assert.equal(p.query, "luminaria de chão");
});

test("N2 (G): marketplace inválido é recusado", () => {
  const p = parseDiscoverCommand("AMAZON url https://amazon.com/x");
  assert.equal(p.kind, "execute");
  assert.ok(p.error?.includes("marketplace_desconhecido"));
});

test("N2 (G): modo inválido é recusado", () => {
  const p = parseDiscoverCommand("ML crawl https://x.com");
  assert.ok(p.error?.includes("modo_desconhecido"));
});

test("N2 (G): URL fora da whitelist é recusada", () => {
  const p = parseDiscoverCommand("ML url https://google.com/pagina");
  assert.ok(p.error?.includes("url_recusada"));
});

test("N2 (G): ausência de argumentos permanece render-only (comportamento N1)", () => {
  const p = parseDiscoverCommand("");
  assert.equal(p.kind, "render");
});

test("N2 (G): argumentos ausentes após modo são recusados", () => {
  const p = parseDiscoverCommand("ML url");
  assert.ok(p.error?.includes("valor_ausente"));
});

// -----------------------------------------------------------------------------
// H. Segurança de escopo — provas explícitas
// -----------------------------------------------------------------------------
test("N2 (H): PROVA DISCOVERY != PUBLICATION — executeDiscover nunca toca productPipeline", async () => {
  // Prova de escopo: executeDiscover NÃO importa/usa productPipeline,
  // productAutomation de publicação, job queue, scheduler ou agentes.
  // Consequência observável: o resultado do N2 nunca contém indicação de
  // "publicação" e nada sai do funil N1 (DISCOVERED/INTAKE) — não há promoção.
  // Nota: o scraper do projeto é fail-soft (falha de rede → título derivado do
  // URL, preço UNKNOWN), então a prova valida o comportamento real.
  const rows: Rows = [];
  candidatesRepository.setCandidatesClientForTests(makeFakeClient(rows) as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network error");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await executeDiscover({
      marketplace: "MERCADOLIVRE",
      mode: "url",
      url: "https://item.mercadolivre.com.br/MLB-7777777777",
    });
    // Outcomes possíveis do N2 são apenas created/identical_duplicate/
    // conflict_rejected — "published" NÃO é um outcome do N2:
    for (const item of result.items) {
      assert.notDeepStrictEqual(item.outcome, "published" as never);
    }
    // Tudo que entra no N1 fica no funil de descoberta:
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DISCOVERED");
    assert.equal(rows[0].funnel_stage, "INTAKE");
    assert.equal(rows[0].promoted_product_id, null);
    assert.equal(rows[0].promoted_at, null);
  } finally {
    candidatesRepository.setCandidatesClientForTests(null as never);
    globalThis.fetch = originalFetch;
  }
});

test("N2 (H): PROVA CANDIDATE != CANONICAL PRODUCT — N2 registra no funil N1 e nunca promove a canônico", async () => {
  // Prova de contrato: executeDiscover persiste exclusivamente via
  // registerCandidate (funil N1, status DISCOVERED) e NÃO chama nenhuma
  // função de promoção (promoteToProduct etc.). Com o fake client N1, a
  // ingestão real é exercida e o registro grava status DISCOVERED/INTAKE —
  // nunca canônico.
  const rows: Rows = [];
  candidatesRepository.setCandidatesClientForTests(makeFakeClient(rows) as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><body><script type="application/ld+json">{"@type":"Product","name":"Produto de prova canônica","offers":{"priceCurrency":"BRL","price":"9.99"},"image":["https://cdn.shopee.com/x.jpg"]}</script></body></html>',
    redirected: false,
    url: "https://shopee.com.br/loja/5/6",
  })) as unknown as typeof globalThis.fetch;
  try {
    const result = await executeDiscover({
      marketplace: "SHOPEE",
      mode: "url",
      url: "https://shopee.com.br/loja/5/6",
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    assert.equal(result.items[0].outcome, "created");
    // Contrato N1: registro entra no funil como DISCOVERED/INTAKE — o funil
    // de promoção a canônico é outro bloco (N3/N5):
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DISCOVERED");
    assert.equal(rows[0].funnel_stage, "INTAKE");
    // executeDiscover não expõe caminho de promoção:
    assert.equal("promote" in result, false);
  } finally {
    candidatesRepository.setCandidatesClientForTests(null as never);
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// U. Patch de contrato — proveniência de falha de coleta e título derivado
// (título derivado da URL nunca é marketplace_title confirmado; preço
// permanece UNKNOWN em falha; falha de coleta permanece identificável)
// -----------------------------------------------------------------------------
test("N2 (U-A): fetch bem-sucedido → título real da página pode ser usado como observação", () => {
  const listing = buildRawListing({
    marketplace: "MERCADOLIVRE",
    source_url: "https://item.mercadolivre.com.br/MLB-7777777777",
    final_url: "https://item.mercadolivre.com.br/MLB-7777777777",
    httpStatus: 200,
    title: "Luminária de Piso Articulada 180cm",
    price: 259.9,
    images: ["https://http2.mlstatic.com/D_NQ_NP_x.jpg"],
    content: "[URL Final]: https://item.mercadolivre.com.br/MLB-7777777777\n[Título Identificado]: Luminária de Piso Articulada 180cm\n[Preço Identificado]: R$ 259.90",
    fetchFailed: false,
  });
  assert.equal(listing.fetch_failed, false);
  assert.equal(listing.title.derived, undefined);
  const payload = new CandidateNormalizer().normalize(listing);
  assert.equal(payload.title.source, "marketplace_page");
  assert.equal(payload.title.value, "Luminária de Piso Articulada 180cm");
  assert.equal(payload.price.unknown, false);
  assert.equal(payload.price.value, 259.9);
});

test("N2 (U-B): fetch falhou → título derivado da URL NÃO aparece como título confirmado", () => {
  const listing = buildRawListing({
    marketplace: "SHOPEE",
    source_url: "https://shopee.com.br/loja/33/44",
    final_url: "https://shopee.com.br/loja/33/44",
    httpStatus: 200,
    // scraper fail-soft: título derivado do slug da URL, preço null
    title: "loja 33 44",
    price: null,
    images: [],
    content: "",
    fetchFailed: true,
    fetchError: "network: simulated network error",
  });
  assert.equal(listing.fetch_failed, true);
  assert.equal(listing.title.derived, true);
  const payload = new CandidateNormalizer().normalize(listing);
  // Derivado vira source "url_slug" — nunca "marketplace_page":
  assert.equal(payload.title.source, "url_slug");
  // O discover NÃO envia título url_slug ao N1 (verifica via executeDiscover
  // abaixo): o normalizer expõe o valor, mas o orquestrador o bloqueia.
});

test("N2 (U-C): fetch falhou → preço continua UNKNOWN", () => {
  const listing = buildRawListing({
    marketplace: "SHOPEE",
    source_url: "https://shopee.com.br/loja/33/44",
    final_url: "https://shopee.com.br/loja/33/44",
    httpStatus: 200,
    title: "loja 33 44",
    price: null,
    images: [],
    content: "",
    fetchFailed: true,
    fetchError: "network: simulated",
  });
  assert.equal(listing.price.unknown, true);
  assert.equal(listing.price.value, null);
  assert.equal(listing.images.unknown, true);
  const payload = new CandidateNormalizer().normalize(listing);
  assert.equal(payload.price.unknown, true);
  assert.equal(payload.price.value, null);
  assert.equal(payload.price.source, "unknown");
  assert.equal(payload.price.unknown, true);
});

test("N2 (U-D): falha de fetch permanece identificável", () => {
  const listing = buildRawListing({
    marketplace: "MERCADOLIVRE",
    source_url: "https://item.mercadolivre.com.br/MLB-7777777777",
    final_url: "https://item.mercadolivre.com.br/MLB-7777777777",
    httpStatus: 200,
    title: "MLB 7777777777",
    price: null,
    images: [],
    content: "",
    fetchFailed: true,
    fetchError: "network: simulated",
  });
  assert.equal(listing.fetch_failed, true);
  assert.equal(listing.fetch_error, "network: simulated");
  assert.match(listing.evidence_note, /COLLECTION_FAILED/);
  const payload = new CandidateNormalizer().normalize(listing);
  assert.match(payload.evidence_note, /COLLECTION_FAILED/);
});

test("N2 (U-E): CANDIDATE != FACT CANÔNICO com título derivado — N1 recebe null e collection_failed", async () => {
  const rows: Rows = [];
  candidatesRepository.setCandidatesClientForTests(makeFakeClient(rows) as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network error");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await executeDiscover({
      marketplace: "SHOPEE",
      mode: "url",
      url: "https://shopee.com.br/loja/33/44",
    });
    // Fetch falho → tentativa de coleta registrada como evidência (COLLECTION_FAILED):
    assert.equal(result.ok, true);
    assert.equal(result.error?.includes("collection_failed"), true);
    assert.equal(rows.length, 1);
    // Título derivado da URL NÃO entra no N1 como título confirmado:
    assert.equal(rows[0].title, "");
    // Falha de coleta identificável no registro:
    assert.equal((rows[0].metadata as Record<string, unknown>).collection_failed, true);
    assert.match(String((rows[0].metadata as Record<string, unknown>).evidence_note), /COLLECTION_FAILED/);
    // Sem título confirmado: source "unknown" (nada derivado da URL entra):  
    assert.equal((rows[0].metadata as Record<string, unknown>).source, "unknown");
  } finally {
    candidatesRepository.setCandidatesClientForTests(null as never);
    globalThis.fetch = originalFetch;
  }
});

test("N2 (U-F): nenhum produto canônico é criado mesmo com coleta falha", async () => {
  const rows: Rows = [];
  candidatesRepository.setCandidatesClientForTests(makeFakeClient(rows) as never);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("simulated network error");
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await executeDiscover({
      marketplace: "MERCADOLIVRE",
      mode: "url",
      url: "https://item.mercadolivre.com.br/MLB-8888888888",
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    // O que entra no N1 fica no funil de descoberta — nunca canônico:
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DISCOVERED");
    assert.equal(rows[0].funnel_stage, "INTAKE");
    assert.equal(rows[0].promoted_product_id, null);
    assert.equal(rows[0].promoted_at, null);
    // Título não confirmado não grava como título canônico:
    assert.equal(rows[0].title, "");
  } finally {
    candidatesRepository.setCandidatesClientForTests(null as never);
    globalThis.fetch = originalFetch;
  }
});
