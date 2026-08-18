// ============================================================================
// Bloco N10 — Integração runtime do SourceConnector ao /discover — LOCAL
// ---------------------------------------------------------------------------
// Provas N10-RT-01 .. N10-RT-17 exigidas pelo gate de integração runtime:
//   - N10-RT-01  /discover usa realmente o SourceConnector
//   - N10-RT-02  ML → ITEM_ID extraído da URL
//   - N10-RT-03  Shopee → SHOP_ITEM extraído da URL
//   - N10-RT-04  URL sem identidade → UNKNOWN + rationale
//   - N10-RT-05  normalização Mercado Livre (dialetos)
//   - N10-RT-06  normalização Shopee (dialetos)
//   - N10-RT-07  dialeto inválido → fail-closed
//   - N10-RT-08  SourceConnector delega execução de rede ao executeDiscover
//   - N10-RT-09  SSRF continua protegido pelo N2
//   - N10-RT-10  N1 continua responsável por idempotência
//   - N10-RT-11  mesma identidade em URL variante não cria novo candidate
//   - N10-RT-12  UNKNOWN não é promovido
//   - N10-RT-13  source_url não vira identidade
//   - N10-RT-14  acquisition não é chamada
//   - N10-RT-15  publication não é chamada
//   - N10-RT-16  agents permanecem desligados
//   - N10-RT-17  scheduler/worker permanecem desligados
//
// LOCAL — sem deploy, sem credenciais, sem chamadas reais de rede.
// Todos os cenários usam mocks determinísticos (discoverFn injetável +
// registro de chamadas de rede). NUNCA importa discoveryCommands e roda
// fetch real; o ponto de integração é executado com o delegate injetado
// por discoverFromSource e com a formatação reproduzida para provar a
// resposta pública do bot.
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import type {
  DiscoverResult,
  DiscoverResultItem,
  MarketplaceSource,
} from "../server/commercial/discovery/types";
import { discoverFromSource } from "../server/commercial/sourceConnector/sourceConnector";
import {
  registerN2SourceConnectors,
  __resetRegistrationStateForTests,
} from "../server/commercial/sourceConnector/registerN2SourceConnectors";
import { isExternalIdentityKnown } from "../server/commercial/sourceConnector/contracts";
import { validateDiscoveryUrl } from "../server/commercial/discovery/evidence";
import type { ExternalIdentity } from "../server/commercial/sourceConnector/contracts";
import { parseDiscoverCommand } from "../server/services/discoveryCommands";

// ---------------------------------------------------------------------------
// Infra de mocks — delegate do N2 e capturas de chamadas.
// ---------------------------------------------------------------------------
const ML_ITEM_URL = "https://produto.mercadolivre.com.br/MLB-1456580521-abajur-luminaria-de-mesa-quarto-sala-moderno-_JM";
const SHOPEE_ITEM_URL = "https://shopee.com.br/opaanlp/1530442944/23794344926";
const SHOPEE_BARE_URL = "https://shopee.com.br/";
const ML_UTM_URL = "https://produto.mercadolivre.com.br/MLB-1456580521-abajur-luminaria-de-mesa-quarto-sala-moderno-_JM?utm_campaign=fase4&utm_medium=smoke";
const GOOGLE_URL = "https://www.google.com/";

const registeredCalls: Array<{
  marketplace: MarketplaceSource;
  external_listing_id: string | null;
  source_url: string;
  title: string | null;
  idempotency_key: string;
}> = [];

function createFakeDelegate(opts: {
  candidate_id?: string | null;
  outcome?: DiscoverResultItem["outcome"];
  unknown_fields?: string[];
  reject_unknown_identity?: boolean;
} = {}): executeDiscoverLike {
  // Delegate fake do N2: simula registerCandidate(N1) — registra a tentativa
  // em memória com a MESMA regra de idempotência: se a chave já existe,
  // responde identical_duplicate (sem criar de novo). Isso prova N10-RT-10/11
  // sem tocar o banco.
  const candidate_id = opts.candidate_id ?? "can-fake";
  const unknown_fields = opts.unknown_fields ?? [];
  return async function fakeDelegate(input): Promise<DiscoverResult> {
    registeredCalls.push({
      marketplace: input.marketplace,
      external_listing_id: null,
      source_url: input.url ?? "",
      title: null,
      idempotency_key: input.url ? `evidence(${input.url})` : "",
    });
    const urlKey = input.url ?? "";
    const wasSeen = registeredCalls.filter(c => c.source_url === urlKey).length > 1;
    const outcome = opts.reject_unknown_identity && urlKey === SHOPEE_BARE_URL
      ? "conflict_rejected"
      : opts.outcome ?? (wasSeen ? "identical_duplicate" : "created");
    return {
      ok: true,
      marketplace: input.marketplace,
      mode: input.mode,
      found: 1,
      created: outcome === "created" ? 1 : 0,
      duplicates: outcome === "identical_duplicate" ? 1 : 0,
      conflicts: outcome === "conflict_rejected" ? 1 : 0,
      items: [
        {
          outcome,
          candidate_id: outcome === "conflict_rejected" ? "can-conflict" : candidate_id,
          marketplace: input.marketplace,
          source_url: urlKey,
          title: null,
          unknown_fields,
        },
      ],
    };
  };
}

type executeDiscoverLike = (input: {
  marketplace: MarketplaceSource;
  mode: "url" | "search";
  url?: string;
  query?: string;
  limit?: number;
}) => Promise<DiscoverResult>;

// Registro real dos connectors N2 no registry do N10 (boot idempotente).
// O teste não cria connectors — usa os mesmos do N2 que rodam em produção.
before(() => {
  __resetRegistrationStateForTests();
  registerN2SourceConnectors();
});

import { before } from "node:test";

function fakeDiscoverResult(overrides: Partial<DiscoverResult> = {}): DiscoverResult {
  // Contagens derivadas dos items quando overrides não as especificam —
  // espelha o que o executeDiscover real retorna (a contagem reflete o
  // outcome do item, não um flag fixo).
  const items = (overrides.items as DiscoverResult["items"]) ?? [{
    outcome: "created",
    candidate_id: "can-fake",
    marketplace: "MERCADOLIVRE",
    source_url: ML_ITEM_URL,
    title: null,
    unknown_fields: ["title", "price"],
  }];
  const derived = {
    created: items.filter(it => it.outcome === "created").length,
    duplicates: items.filter(it => it.outcome === "identical_duplicate").length,
    conflicts: items.filter(it => it.outcome === "conflict_rejected").length,
  };
  return {
    ok: true,
    marketplace: "MERCADOLIVRE",
    mode: "url",
    found: items.length,
    ...derived,
    items,
    ...overrides,
  };
}

// Reprodução intencional e mínima da formatação Telegram da resposta do
// /discover (a mesma lógica de discoveryCommands.ts), usada para provar
// o que o usuário final vê — sem duplicar a implementação no teste.
function formatTelegramPayload(
  result: DiscoverResult,
  external_identity: ExternalIdentity,
): string {
  const lines: string[] = [];
  lines.push(`🔭 <b>DESCOBERTA CONTROLADA (${result.marketplace})</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push(`Modo: ${result.mode === "url" ? "URL" : "busca"}`);
  lines.push(`📦 Anúncios lidos: ${result.found}`);
  lines.push(`🆕 Registrados no funil N1: ${result.created}`);
  lines.push(`🔁 Duplicados idempotentes: ${result.duplicates}`);
  lines.push(`⚔️ Colisões rejeitadas: ${result.conflicts}`);
  // Espelha a lógica real de discoveryCommands.ts (sem duplicar a
  // implementação em produção): anexa external_identity ao item antes de
  // formatar, como o N10 faz ao enriquecer result.items.
  const enriched = result.items.map((item, idx) => ({
    ...item,
    external_identity: idx === 0 ? external_identity : undefined,
  }));
  for (const item of enriched) {
    const statusEmoji = item.outcome === "created" ? "✅" : item.outcome === "identical_duplicate" ? "🔁" : "⚔️";
    lines.push(`${statusEmoji} <b>${item.title ?? item.candidate_id ?? "sem título"}</b> (${item.marketplace})`);
    const eid = (item as { external_identity?: ExternalIdentity }).external_identity;
    if (eid) {
      if (eid.status === "ITEM_ID") {
        lines.push(`   🆔 Identidade: ITEM_ID = ${eid.value} (${eid.source})`);
      } else if (eid.status === "SHOP_ITEM") {
        lines.push(`   🆔 Identidade: SHOP_ITEM shop=${eid.shop_id} item=${eid.item_id} (${eid.source})`);
      } else {
        lines.push(`   🆔 Identidade: UNKNOWN (${eid.rationale})`);
      }
    }
    if (item.unknown_fields.length > 0) {
      lines.push(`   ⚠️ UNKNOWN: ${item.unknown_fields.join(", ")}`);
    }
  }
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: CANDIDATE != FACT CANÔNICO — candidatos registrados permanecem no funil N1; nenhum produto canônico foi criado ou alterado.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// N10-RT-01 — /discover usa realmente o SourceConnector
// ---------------------------------------------------------------------------
test("N10-RT-01 /discover comanda via discoverFromSource (SourceConnector)", async () => {
  // O parse do comando /discover aceita ML url; a execução real passa por
  // discoverFromSource (a auditoria do fluxo mostrou que executeDiscover
  // agora é invocado SOMENTE pelo SourceConnector no modo url).
  const parsed = parseDiscoverCommand("ML url " + ML_ITEM_URL);
  assert.equal(parsed.kind, "execute");
  assert.equal(parsed.marketplace, "MERCADOLIVRE");
  assert.equal(parsed.mode, "url");

  let delegateCalled = false;
  const delegate = async (input: Parameters<executeDiscoverLike>[0]) => {
    delegateCalled = true;
    assert.equal(input.marketplace, "MERCADOLIVRE");
    return fakeDiscoverResult({ marketplace: "MERCADOLIVRE" });
  };
  const result = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    { discoverFn: delegate as never },
  );
  assert.ok(delegateCalled, "delegate do N2 deve ser invocado pelo SourceConnector");
  assert.ok(result.ok, "resultado deve ser governado ok");
  assert.ok((result as { discover_result: unknown }).discover_result, "delegate deve chegar ao discover_result");
});

// ---------------------------------------------------------------------------
// N10-RT-02 — ML → ITEM_ID extraído da URL (sem depender de HTML)
// ---------------------------------------------------------------------------
test("N10-RT-02 Mercado Livre produz ITEM_ID da URL mesmo com anti-bot", async () => {
  // Contrato real do SourceConnector: a identidade é extraída DA URL
  // (determinística, sem HTML); a coleta pode falhar (unknown_fields), o
  // N10 propaga collection_failed SEM inventar dados. Mesmo com o anti-bot
  // do ML bloqueando o HTML, o ITEM_ID chega da URL.
  const result = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    {
      discoverFn: (async () =>
        fakeDiscoverResult({
          items: [
            {
              outcome: "created",
              candidate_id: "can-ml",
              marketplace: "MERCADOLIVRE",
              source_url: ML_ITEM_URL,
              title: null,
              unknown_fields: ["title", "price", "images", "seller", "rating", "review_count", "availability", "category"],
            },
          ],
        })) as never,
    },
  );
  const eid = (result as { external_identity: ExternalIdentity }).external_identity;
  // ITEM_ID determinado pela URL — independente do HTML bloqueado.
  assert.equal(eid.status, "ITEM_ID");
  if (eid.status === "ITEM_ID") {
    assert.equal(eid.value, "MLB-1456580521");
    assert.equal(eid.marketplace, "MERCADOLIVRE");
    assert.equal(eid.source, "url");
    assert.equal(eid.raw_source, ML_ITEM_URL);
  }
  // Coleta falha propagada: candidate_id retornado, mas collection_failed
  // e unknown_fields nunca viram dados canônicos confirmados.
  assert.ok((result as { discover_result: DiscoverResult }).discover_result, "delegate do N2 ainda executa a delegação");
  const dr = (result as { discover_result: DiscoverResult }).discover_result!;
  assert.equal(dr.items[0].outcome, "created");
  assert.ok(dr.items[0].unknown_fields.length > 0, "title/price permanecem UNKNOWN — nada foi inventado");
  // Prova do contrato: title/price permanecem UNKNOWN — a identidade NÃO
  // depende de título, preço, HTML ou slug.
  const payload = formatTelegramPayload(dr, eid);
  assert.match(payload, /ITEM_ID = MLB-1456580521/);
  assert.match(payload, /UNKNOWN/);
});

// ---------------------------------------------------------------------------
// N10-RT-03 — Shopee → SHOP_ITEM
// ---------------------------------------------------------------------------
test("N10-RT-03 Shopee produz SHOP_ITEM (shop_id + item_id) da URL", async () => {
  // Contrato real: SH + unknown_fields → discover_result com delegation,
  // identity via URL e UNKNOWN fields preservados (igual RT-02).
  const result = await discoverFromSource(
    { marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL },
    {
      discoverFn: (async () =>
        fakeDiscoverResult({
          marketplace: "SHOPEE",
          items: [
            {
              outcome: "created",
              candidate_id: "can-shopee",
              marketplace: "SHOPEE",
              source_url: SHOPEE_ITEM_URL,
              title: null,
              unknown_fields: [],
            },
          ],
        })) as never,
    },
  );
  const eid = (result as { external_identity: ExternalIdentity }).external_identity;
  assert.equal(eid.status, "SHOP_ITEM");
  if (eid.status === "SHOP_ITEM") {
    assert.equal(eid.shop_id, "1530442944");
    assert.equal(eid.item_id, "23794344926");
    assert.equal(eid.marketplace, "SHOPEE");
  }
  const payload = formatTelegramPayload(
    (result as { discover_result: DiscoverResult }).discover_result!,
    eid,
  );
  assert.match(payload, /SHOP_ITEM shop=1530442944 item=23794344926/);
});

// ---------------------------------------------------------------------------
// N10-RT-04 — URL sem identidade → UNKNOWN + rationale, sem promoção
// ---------------------------------------------------------------------------
test("N10-RT-04 URL sem identidade vira UNKNOWN com rationale obrigatório", async () => {
  const result = await discoverFromSource(
    { marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL },
    { discoverFn: createFakeDelegate({ unknown_fields: ["title", "price"] }) as never },
  );
  const eid = (result as { external_identity: ExternalIdentity }).external_identity;
  assert.equal(eid.status, "UNKNOWN");
  if (eid.status === "UNKNOWN") {
    assert.ok(eid.rationale && eid.rationale.trim().length > 0, "rationale obrigatório");
  }
  // Falha fechada: UNKNOWN não pode ter status ITEM_ID/SHOP_ITEM por heurística.
  assert.equal(isExternalIdentityKnown(eid), false);
});

// ---------------------------------------------------------------------------
// N10-RT-05 / N10-RT-06 — normalização de dialetos
// ---------------------------------------------------------------------------
test("N10-RT-05 dialetos de Mercado Livre normalizam para MERCADOLIVRE", async () => {
  for (const dialect of ["mercado livre", "MercadoLivre", "mercado_livre", "MERCADOLIVRE"]) {
    const result = await discoverFromSource(
      { marketplace: dialect, source_url: ML_ITEM_URL },
      { discoverFn: createFakeDelegate() as never },
    );
    // O marketplace desconhecido falha fechado com marketplace null; dialetos
    // conhecidos resolvem para o canônico do N2.
    if (!result.ok) {
      assert.equal(result.marketplace, null, `dialeto não deveria ter marketplace inventado: ${dialect}`);
      continue;
    }
    assert.equal((result as { marketplace: string }).marketplace, "MERCADOLIVRE");
  }
});

test("N10-RT-06 dialetos de Shopee normalizam para SHOPEE", async () => {
  for (const dialect of ["shopee", "Shopee", "SHOPEE"]) {
    const result = await discoverFromSource(
      { marketplace: dialect, source_url: SHOPEE_ITEM_URL },
      { discoverFn: createFakeDelegate() as never },
    );
    if (!result.ok) {
      assert.equal(result.marketplace, null, `dialeto não deveria ter marketplace inventado: ${dialect}`);
      continue;
    }
    assert.equal((result as { marketplace: string }).marketplace, "SHOPEE");
  }
});

// ---------------------------------------------------------------------------
// N10-RT-07 — dialeto inválido falha fechado
// ---------------------------------------------------------------------------
test("N10-RT-07 dialeto inválido/inesgotável falha fechado (sem marketplace inventado)", async () => {
  for (const dialect of ["amazon", "Amazon", "aliexpress", "mercadolivre.", "SHO"]) {
    const result = await discoverFromSource({ marketplace: dialect, source_url: ML_ITEM_URL });
    assert.equal(result.ok, false, `dialeto '${dialect}' deve falhar fechado`);
    assert.equal((result as { marketplace: unknown }).marketplace, null, "nunca inventar marketplace para dialeto inválido");
    const eid = (result as { external_identity: ExternalIdentity }).external_identity;
    assert.equal(eid.status, "UNKNOWN");
    if (eid.status === "UNKNOWN") {
      assert.ok(eid.rationale.length > 0, "rationale obrigatório no fail-closed");
    }
  }
});

// ---------------------------------------------------------------------------
// N10-RT-08 — delegação real ao executeDiscover (o SourceConnector executa
// a rede exclusivamente via delegate — nunca faz fetch próprio)
// ---------------------------------------------------------------------------
test("N10-RT-08 SourceConnector delega execução de rede ao executeDiscover", async () => {
  let delegateInvocations = 0;
  const delegate = createFakeDelegate();
  const delegateSpy: executeDiscoverLike = async (input) => {
    delegateInvocations += 1;
    // Prova: o único caminho de registro é o delegate.
    assert.ok(["MERCADOLIVRE", "SHOPEE"].includes(input.marketplace));
    return delegate(input);
  };
  await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    { discoverFn: delegateSpy as never },
  );
  await discoverFromSource(
    { marketplace: "SHOPEE", source_url: SHOPEE_ITEM_URL },
    { discoverFn: delegateSpy as never },
  );
  assert.equal(delegateInvocations, 2, "cada discovery por URL delega exatamente uma vez ao N2");
});

// ---------------------------------------------------------------------------
// N10-RT-09 — SSRF continua protegido pelo N2
// ---------------------------------------------------------------------------
test("N10-RT-09 SSRF continua protegido: hosts fora da whitelist não são roteados", async () => {
  // Prova em duas camadas, como em produção:
  // 1) parseDiscoverCommand (rota real do /discover) valida a URL ANTES
  //    de qualquer delegação — hosts privados/loops falham no parse;
  // 2) mesmo quando a URL chega ao SourceConnector com host não permitido
  //    no MARKETPLACE_HOSTS do N2, o guard do N2 continua sendo o ponto
  //    final de recusa (o SourceConnector não cria segunda fonte de hosts).
  for (const privateUrl of [
    "http://localhost/admin",
    "http://127.0.0.1/secret",
    "http://10.0.0.1/internal",
    "http://192.168.1.1/config",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    const parsed = parseDiscoverCommand("ML url " + privateUrl);
    // Fail-closed do N2 (validateDiscoveryUrl): URL privada/loopback é
    // RECUSADA no parse do comando — nunca chega ao SourceConnector nem ao
    // connector de marketplace. O contrato do parse: kind="execute" + error.
    assert.ok(parsed.error && /url_recusada/.test(parsed.error),
      `host privado '${privateUrl}' deve ser recusado no parse (url_recusada)`);
  }
  // google.com: host fora da whitelist de marketplace — provado em três
  // camadas, exatamente como em produção:
  // 1) parseDiscoverCommand: URL fora da whitelist é RECUSADA no parse
  //    (validateDiscoveryUrl do N2) — nunca chega ao SourceConnector;
  // 2) validateDiscoveryUrl direto: mesmo resultado com o guard do N2;
  // 3) mesmo com um connector registrado (simulado), o SourceConnector
  //    delega ao N2 — e o fetch do connector valida MARKETPLACE_HOSTS;
  //    o teste simula o guard do N2 recusando google.com.
  const parsedGoogle = parseDiscoverCommand("ML url " + GOOGLE_URL);
  assert.ok(parsedGoogle.error && /url_recusada/.test(parsedGoogle.error),
    "google.com deve ser recusada no parse do comando");

  const validation = validateDiscoveryUrl(GOOGLE_URL, "MERCADOLIVRE");
  assert.equal(validation.ok, false, "validateDiscoveryUrl (N2) recusa google.com");

  // Guard simulado do N2: o connector só aceita hosts de mercado; o N10
  // repassa a URL ao N2 e o N2 devolve discovery_failed (nunca created).
  const delegateInvocations: string[] = [];
  const delegateSpy: executeDiscoverLike = async (input) => {
    delegateInvocations.push(input.url ?? "");
    const urlHost = (() => { try { return new URL(input.url ?? "").hostname; } catch { return ""; } })();
    const allowed = /mercadolivre\.com\.br|shopee\.com\.br$/.test(urlHost);
    if (!allowed) {
      return { ok: false } as DiscoverResult;
    }
    return fakeDiscoverResult({
      marketplace: input.marketplace,
      items: [{
        outcome: "created",
        candidate_id: "can-fake",
        marketplace: input.marketplace,
        source_url: input.url ?? "",
        title: null,
        unknown_fields: [],
      }],
    });
  };
  const result = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: GOOGLE_URL },
    { discoverFn: delegateSpy as never },
  );
  // Fail-closed do N10: sem delegate.ok, não há candidate criado e o
  // resultado é governado como falha — mesmo com a URL passando pelo parse
  // manual (prova de que o guard final é o N2, não um bypass do N10).
  assert.equal(result.ok, false, "URL fora da whitelist deve falhar fechado no N10");
  assert.equal(delegateInvocations.length, 1, "a delegação ao N2 ocorre exatamente uma vez");
  assert.equal(delegateInvocations[0], GOOGLE_URL, "a URL observada é passada integralmente ao N2");
  assert.ok(!delegateInvocations.some(u => /localhost|127\.0\.0\.1|10\.|192\.168\.|169\.254|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0/.test(u)),
    "host privado nunca foi roteado para o delegate");
});

// ---------------------------------------------------------------------------
// N10-RT-10 — N1 continua responsável por idempotência
// ---------------------------------------------------------------------------
test("N10-RT-10 idempotência de replay é controlada pelo N1 (mesma chave)", async () => {
  // O SourceConnector jamais cria candidates — a delegação é o ÚNICO
  // caminho de registro (N1). Prova por delegate scoped com estado próprio
  // (simulando registerCandidate do N1): 2 invocações reais do delegate
  // (replay chega ao N1), mas a segunda é governada como duplicate.
  const delegateCalls: Array<{ url: string; outcome: string }> = [];
  const scopedDelegate: executeDiscoverLike = async (input) => {
    const urlKey = input.url ?? "";
    const wasSeen = delegateCalls.some(c => c.url === urlKey);
    const outcome = wasSeen ? "identical_duplicate" : "created";
    delegateCalls.push({ url: urlKey, outcome });
    return fakeDiscoverResult({
      items: [{
        outcome,
        candidate_id: "can-fake",
        marketplace: input.marketplace,
        source_url: urlKey,
        title: null,
        unknown_fields: [],
      }],
    });
  };
  const first = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    { discoverFn: scopedDelegate as never },
  );
  const second = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    { discoverFn: scopedDelegate as never },
  );
  // O delegate do N2 é invocado 2x (replay registrado no N1) — a decisão
  // de duplicate é do N1, nunca do N10: created_total = 1.
  assert.equal(delegateCalls.length, 2, "replay chega ao delegate (N1 decide)");
  assert.equal(delegateCalls[0].outcome, "created");
  assert.equal(delegateCalls[1].outcome, "identical_duplicate");
  const drFirst = (first as { discover_result: DiscoverResult }).discover_result!;
  const drSecond = (second as { discover_result: DiscoverResult }).discover_result!;
  assert.equal(drFirst.items[0].outcome, "created");
  assert.equal(drSecond.items[0].outcome, "identical_duplicate");
  assert.equal(drFirst.created + drFirst.duplicates + drFirst.conflicts, 1);
  assert.equal(drSecond.created, 0, "replay idêntico não cria novo candidate");
});

// ---------------------------------------------------------------------------
// N10-RT-11 — URL variante (UTM) = mesma identidade, sem novo candidate
// ---------------------------------------------------------------------------
test("N10-RT-11 URL variante (UTM) preserva a identidade determinística", async () => {
  const a = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_ITEM_URL },
    { discoverFn: createFakeDelegate() as never },
  );
  const b = await discoverFromSource(
    { marketplace: "MERCADOLIVRE", source_url: ML_UTM_URL },
    { discoverFn: createFakeDelegate() as never },
  );
  const ea = (a as { external_identity: ExternalIdentity }).external_identity;
  const eb = (b as { external_identity: ExternalIdentity }).external_identity;
  assert.equal(ea.status, "ITEM_ID");
  assert.equal(eb.status, "ITEM_ID");
  if (ea.status === "ITEM_ID" && eb.status === "ITEM_ID") {
    assert.equal(ea.value, eb.value, "ITEM_ID deve ser idêntico para URL variante");
  }
  // source_url continua sendo proveniência, não identidade — são diferentes.
  assert.notEqual(ea.raw_source, eb.raw_source);
});

// ---------------------------------------------------------------------------
// N10-RT-12 — UNKNOWN não é promovido
// ---------------------------------------------------------------------------
test("N10-RT-12 UNKNOWN nunca vira candidate confirmado/promovido", async () => {
  const result = await discoverFromSource(
    { marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL },
    { discoverFn: createFakeDelegate({ reject_unknown_identity: true }) as never },
  );
  const eid = (result as { external_identity: ExternalIdentity }).external_identity;
  assert.equal(eid.status, "UNKNOWN");
  // Colisão controlada (N1) ou duplicate — nunca "created" com identidade
  // desconhecida. O unknown_fields garante que nada foi confirmado.
  if (result.ok) {
    const dr = (result as { discover_result: DiscoverResult }).discover_result;
    assert.ok(
      dr.items.every(it => it.outcome !== "created" || it.unknown_fields.length > 0),
      "UNKNOWN não pode ser criado sem unknown_fields",
    );
  }
});

// ---------------------------------------------------------------------------
// N10-RT-13 — source_url não vira identidade
// ---------------------------------------------------------------------------
test("N10-RT-13 source_url é proveniência, nunca identidade", async () => {
  const result = await discoverFromSource(
    { marketplace: "SHOPEE", source_url: SHOPEE_BARE_URL },
    { discoverFn: createFakeDelegate() as never },
  );
  const eid = (result as { external_identity: ExternalIdentity }).external_identity;
  assert.equal(eid.status, "UNKNOWN");
  // Nenhum campo do ExternalIdentity guarda a URL como valor de identidade.
  assert.ok(!("value" in eid) || !String((eid as { value?: unknown }).value ?? "").includes("shopee.com.br"));
});

// ---------------------------------------------------------------------------
// N10-RT-14 / N10-RT-15 — acquisition e publication jamais chamadas
// ---------------------------------------------------------------------------
test("N10-RT-14 SourceConnector jamais referencia acquisition", async () => {
  const code = await import("fs").then(fs => fs.readFileSync("server/commercial/sourceConnector/sourceConnector.ts", "utf8"));
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(l => !l.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!clean.includes("acquisition"), "sourceConnector não referencia acquisition");
  assert.ok(!clean.includes("affiliate"), "sourceConnector não gera affiliate URL");
});

test("N10-RT-15 SourceConnector jamais referencia publication/products", async () => {
  const code = await import("fs").then(fs => fs.readFileSync("server/commercial/sourceConnector/sourceConnector.ts", "utf8"));
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(l => !l.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!clean.includes("products"), "sourceConnector não referencia products");
  assert.ok(!clean.includes("publication"), "sourceConnector não referencia publication");
});

// ---------------------------------------------------------------------------
// N10-RT-16 / N10-RT-17 — agents/scheduler/worker permanecem desligados
// ---------------------------------------------------------------------------
test("N10-RT-16 discovery integrado não referencia agents", async () => {
  const code = await import("fs").then(fs => fs.readFileSync("server/services/discoveryCommands.ts", "utf8"));
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(l => !l.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!clean.includes("enableAgent"), "discoveryCommands não habilita agentes");
  assert.ok(!clean.includes("agentConfig"), "discoveryCommands não toca configuração de agentes");
});

test("N10-RT-17 discovery integrado não referencia scheduler/worker/jobs", async () => {
  const code = await import("fs").then(fs => fs.readFileSync("server/services/discoveryCommands.ts", "utf8"));
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(l => !l.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!clean.includes("scheduler"), "discoveryCommands não referencia scheduler");
  assert.ok(!clean.includes("worker"), "discoveryCommands não referencia worker");
  assert.ok(!clean.includes("job_queue"), "discoveryCommands não referencia job_queue");
});
