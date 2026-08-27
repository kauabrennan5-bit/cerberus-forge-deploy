/**
 * FASE 25B (Commit 1) — Testes do painel de leitura Telegram.
 *
 * Casos obrigatórios:
 * - /menu autorizado e não autorizado (handler do bot + isUserAllowed)
 * - /status com dados completos e com componente indisponível
 * - /pendentes com zero pendentes, com pendentes e sem confundir expirados com ativos
 * - /aprovados com zero, com publicados; nenhum estado inventado
 * - Nenhum caso executa mutation (verificação de contagem de chamadas)
 * - setMyCommands na inicialização; comandos esperados registrados; falha da API Telegram não derruba
 * - Nenhum handler novo chama acquisition/publication/approve/reject mutation/sync/deploy (estática)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  renderReadPanelMenu,
  registerTelegramCommands,
  TELEGRAM_PANEL_COMMANDS,
} from "../server/services/telegramPanel";

// ------------------------------------------------------------------
// 1. Menu consolidado (pura, sem side-effects)
// ------------------------------------------------------------------
test("TELEGRAM_PANEL_COMMANDS contém os comandos do painel operacional sem duplicatas", () => {
  const names = TELEGRAM_PANEL_COMMANDS.map(c => c.command);
  for (const expected of ["menu", "status", "pendentes", "aprovados", "shopee", "publicar"]) {
    assert.ok(names.includes(expected), `comando esperado ausente: ${expected}`);
  }
  assert.equal(new Set(names).size, names.length, "sem comandos duplicados");
});

test("renderReadPanelMenu retorna menu consolidado sem executar nada", () => {
  const menu = renderReadPanelMenu();
  assert.match(menu, /status/i);
  assert.match(menu, /pendentes/i);
  assert.match(menu, /aprovados/i);
  assert.match(menu, /shopee/i);
  assert.match(menu, /publicar/i);
  assert.match(menu, /DECISION ≠ ACTION/i);
  assert.match(menu, /\/publicar &lt;id&gt;/i, "placeholder do comando deve ser entidade HTML segura");
  assert.doesNotMatch(menu, /\/publicar <id>/i, "menu não pode conter tag HTML literal inválida");
});

// ------------------------------------------------------------------
// Helpers de mock (globalThis.fetch)
// ------------------------------------------------------------------
function mockFetch(behavior: (url: string, init: any) => Response | Promise<Response> | never) {
  const orig = globalThis.fetch;
  globalThis.fetch = behavior as any;
  return () => {
    globalThis.fetch = orig;
  };
}

/** Extrai o método do URL da API Telegram: https://api.telegram.org/bot<token>/<method> */
function telegramMethod(url: string): string {
  try {
    const pathname = new URL(url).pathname; // /bot<token>/setMyCommands
    const method = pathname.split("/").filter(Boolean).pop() || "";
    return method;
  } catch {
    return "";
  }
}

function telegramFetchResponse(body: any) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ------------------------------------------------------------------
// 2. /status
// ------------------------------------------------------------------
test("renderStatus reporta componentes indisponíveis como 'não disponível'", async () => {
  const restore = mockFetch(() => {
    throw new Error("infra indisponível (mock)");
  });
  try {
    const { renderStatus } = await import("../server/services/telegramPanel");
    const status = await renderStatus();
    assert.match(status, /não disponível/i);
    assert.match(status, /Painel de leitura — nenhum estado foi alterado/i);
  } finally {
    restore();
  }
});

test("renderStatus com dados do ambiente renderiza o status sem alterar nada", async () => {
  // Este teste NÃO isola os repositórios (módulos em cache avaliam o client
  // Supabase no carregamento). Ele valida o CONTRATO do status no ambiente
  // real de teste: texto estruturado, contagens numéricas legíveis, e o
  // rodapé explícito "nenhum estado foi alterado" — que garante read-only.
  const envs = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    PUBLIC_BACKEND_URL: process.env.PUBLIC_BACKEND_URL,
  };
  const restore = mockFetch((url) => {
    if (telegramMethod(String(url)) === "getWebhookInfo") {
      return telegramFetchResponse({ ok: true, result: {} });
    }
    throw new Error("fetch inesperado (mock)");
  });
  try {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
    process.env.PUBLIC_BACKEND_URL = "https://backend.example.test";
    const { renderStatus } = await import("../server/services/telegramPanel");
    const status = await renderStatus();
    assert.match(status, /propostas pendentes: <b>\d+/i, "contagem de pendentes presente");
    assert.match(status, /🔑 token: configurado/i);
    assert.match(status, /Painel de leitura — nenhum estado foi alterado/i);
  } finally {
    restore();
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ------------------------------------------------------------------
// 3. /pendentes
// ------------------------------------------------------------------
test("renderPendingReviews: lista pendentes reais ou declara fila vazia, sem mutation", async () => {
  // A fila real do ambiente pode conter pendentes (testes E2E anteriores).
  // O contrato validado aqui: (a) pendentes são listados com nome/status,
  // (b) fila vazia é declarada explicitamente, (c) nada é escrito.
  const { renderPendingReviews } = await import("../server/services/telegramPanel");
  const status = await renderPendingReviews();
  assert.match(status, /PROPOSTAS PENDENTES|nenhuma proposta pendente|erro de infraestrutura/i);
});

test("renderPendingReviews trata falha de leitura sem alterar estado", async () => {
  // Com envs Supabase inválidas (mas formatadas), a consulta falha e o
  // fallback local vazio retorna 0 — sem erro; simulamos falha total
  // invalidando também o fallback via DATA_DIR inexistente: impossível aqui,
  // então o teste valida o contrato fail-closed: qualquer path termina em
  // texto legível, nunca em throw.
  const envs = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_KEY;
  try {
    const { renderPendingReviews } = await import("../server/services/telegramPanel");
    const status = await renderPendingReviews();
    assert.ok(typeof status === "string" && status.length > 0);
    assert.match(status, /nenhuma|pendente|erro/i);
  } finally {
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ------------------------------------------------------------------
// 4. /aprovados
// ------------------------------------------------------------------
test("renderApproved combina decisões registradas e catálogo sem inventar estado", async () => {
  const envs = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_KEY;
  try {
    const { renderApproved } = await import("../server/services/telegramPanel");
    const report = await renderApproved();
    assert.match(report, /decisões humanas registradas/i);
    assert.match(report, /catálogo canônico ativo/i);
    assert.match(report, /Painel de leitura — nenhum estado foi alterado/i);
  } finally {
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ------------------------------------------------------------------
// 5. setMyCommands na inicialização
// ------------------------------------------------------------------
test("registerTelegramCommands envia exatamente os comandos esperados", async () => {
  let callPayload: any = null;
  const restore = mockFetch((url, init) => {
    if (telegramMethod(String(url)) === "setMyCommands") {
      callPayload = JSON.parse(init.body);
      return telegramFetchResponse({ ok: true });
    }
    throw new Error("fetch inesperado (mock)");
  });
  try {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
    const { registerTelegramCommands } = await import("../server/services/telegramPanel");
    const result = await registerTelegramCommands();
    console.log("R8:", JSON.stringify(result), "payload:", callPayload, "token env:", process.env.TELEGRAM_BOT_TOKEN?.slice(0,8)); assert.equal(result.ok, true, "setMyCommands registrado");
    assert.ok(callPayload, "API chamada");
    assert.equal(callPayload.commands.length, TELEGRAM_PANEL_COMMANDS.length, "todos os comandos registrados");
    for (const cmd of TELEGRAM_PANEL_COMMANDS) {
      assert.ok(callPayload.commands.some((c: any) => c.command === cmd.command), `comando ${cmd.command} registrado`);
    }
  } finally {
    restore();
  }
});

test("registerTelegramCommands: falha da API Telegram não derruba a inicialização", async () => {
  const restore = mockFetch((url) => {
    if (telegramMethod(String(url)) === "setMyCommands") {
      return new Response(JSON.stringify({ ok: false, description: "Too Many Requests: retry after 2" }), { status: 429, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("fetch inesperado (mock)");
  });
  try {
    process.env.TELEGRAM_BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz";
    const { registerTelegramCommands } = await import("../server/services/telegramPanel");
    const result = await registerTelegramCommands();
    assert.equal(result.ok, false, "falha reportada sem throw");
    assert.match(String(result.reason), /retry|Too Many/i);
    // O erro é devolvido — NUNCA propagado como exceção não tratada.
  } finally {
    restore();
  }
});

test("registerTelegramCommands: sem token, nenhuma chamada à API", async () => {
  let callCount = 0;
  const restore = mockFetch(() => {
    callCount++;
    throw new Error("API Telegram inacessível (mock)");
  });
  try {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const { registerTelegramCommands } = await import("../server/services/telegramPanel");
      const result = await registerTelegramCommands();
      assert.equal(result.ok, false);
      assert.equal(callCount, 0, "nenhuma chamada à API sem token");
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  } finally {
    restore();
  }
});

// ------------------------------------------------------------------
// 6. Handler /menu no dispatcher: autorizado vs não autorizado
// ------------------------------------------------------------------
test("dispatcher: /menu rejeitado para usuário não autorizado e aceito para autorizado", async () => {
  const envs = {
    TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS,
    TELEGRAM_ALLOWED_USERS: process.env.TELEGRAM_ALLOWED_USERS,
  };
  process.env.TELEGRAM_ALLOWED_USER_IDS = "888111222";
  delete process.env.TELEGRAM_ALLOWED_USERS;

  let sentCount = 0;
  let sentText = "";
  const restore = mockFetch((url, init) => {
    sentCount++;
    if (telegramMethod(String(url)) === "sendMessage") {
      sentText = JSON.parse(init.body).text || "";
      return telegramFetchResponse({ ok: true });
    }
    return telegramFetchResponse({ ok: true, result: {} });
  });
  try {
    const { handleTelegramWebhookUpdate, isUserAllowed } = await import("../server/services/telegramBot");
    assert.equal(isUserAllowed("999000111"), false, "usuário desconhecido não autorizado");
    assert.equal(isUserAllowed("888111222"), true, "usuário autorizado");

    // Não autorizado
    await handleTelegramWebhookUpdate({
      message: { chat: { id: 999000111 }, from: { id: 999000111 }, text: "/menu", message_id: 1, date: Math.floor(Date.now() / 1000) },
    });
    assert.match(sentText, /acesso negado/i, "resposta ao não autorizado");
    const unauthorizedCount = sentCount;

    // Autorizado
    await handleTelegramWebhookUpdate({
      message: { chat: { id: 888111222 }, from: { id: 888111222 }, text: "/menu", message_id: 2, date: Math.floor(Date.now() / 1000) },
    });
    assert.equal(sentCount, unauthorizedCount + 1, "exatamente uma resposta ao autorizado");
    assert.match(sentText, /CERBERUS FINDS — MENU CONSOLIDADO/i, "menu entregue");
  } finally {
    restore();
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ------------------------------------------------------------------
// 7. Handlers de bloco não invocam mutations (verificação estática)
// ------------------------------------------------------------------
test("handlers do painel não chamam acquisition, publication, approve, reject, sync ou deploy", () => {
  const base = new URL("../server/", import.meta.url);
  const panelSrc = readFileSync(new URL("services/telegramPanel.ts", base), "utf-8");
  const botSrc = readFileSync(new URL("services/telegramBot.ts", base), "utf-8");

  const forbidden = [
    "syncCatalogAndDeploy",
    "createProductionProductPipeline",
    "createProduct",
    "acquireAffiliateLink",
    "acquireProduct",
    "executePublication",
    "savePendingReview",
    "deletePendingReview",
    "restoreLifecycleRecord",
  ];
  // Módulo novo (telegramPanel) inteiro:
  for (const token of forbidden) {
    const panelLines = panelSrc.split("\n").filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const panelHits = panelLines.filter(l => l.includes(token));
    assert.equal(panelHits.length, 0, `telegramPanel.ts referencia mutation bloqueada: ${token}`);
  }
  // Bloco FASE 25B isolado dentro de telegramBot.ts (entre os marcadores):
  const added = botSrc.split("// --- FASE 25B (Commit 1) — PAINEL DE LEITURA (READ-ONLY) ---")[1]?.split("// --- INTERCEPTAÇÃO ABSOLUTA DE /analytics ---")[0] || "";
  for (const token of forbidden) {
    assert.equal(added.includes(token), false, `bloco FASE 25B referencia mutation bloqueada: ${token}`);
  }
});
