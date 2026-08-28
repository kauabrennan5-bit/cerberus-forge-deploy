import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  canonicalTelegramCommand,
  isKnownTelegramCommand,
  parseTelegramCommand,
  resolveReadOnlyShortcut,
  suggestTelegramCommand,
} from "../server/services/telegramCommands";
import {
  buildProductListView,
  isUserAllowed,
  shouldProcessTelegramUpdate,
} from "../server/services/telegramBot";
import { TELEGRAM_PANEL_COMMANDS } from "../server/services/telegramPanel";

const telegramSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../server/services/telegramPanel.ts", import.meta.url), "utf8");

function assertHandler(token: string, pattern: RegExp): void {
  assert.match(telegramSource, pattern, `botão/rota ${token} precisa ter handler explícito`);
}

test("menu nativo tem dez comandos, descrições válidas e preserva compatibilidade", () => {
  assert.equal(PRIMARY_TELEGRAM_COMMANDS.length, 10, "menu nativo V2 tem exatamente dez comandos");
  const names = PRIMARY_TELEGRAM_COMMANDS.map(item => item.command);
  assert.equal(new Set(names).size, names.length, "comandos nativos não podem duplicar");
  for (const item of [...PRIMARY_TELEGRAM_COMMANDS, ...SECONDARY_TELEGRAM_COMMANDS]) {
    assert.ok(isKnownTelegramCommand(item.command), `/${item.command} deve continuar reconhecido`);
    assert.ok(item.description.length > 0 && item.description.length <= 256);
  }
  const shopee = TELEGRAM_PANEL_COMMANDS.find(item => item.command === "shopee");
  const categorias = TELEGRAM_PANEL_COMMANDS.find(item => item.command === "categorias");
  assert.ok(shopee && !/em breve/i.test(shopee.description));
  assert.ok(categorias && /taxonomia/i.test(categorias.description));
});

test("parser, aliases e atalhos naturais preservam o contrato V2", () => {
  assert.deepEqual(parseTelegramCommand("/status@CerberusBot agora"), { name: "status", args: "agora" });
  assert.deepEqual(parseTelegramCommand("/publicar rev_123"), { name: "publicar", args: "rev_123" });
  assert.equal(parseTelegramCommand("status"), null);
  assert.equal(isKnownTelegramCommand("statusfoo"), false);
  assert.equal(suggestTelegramCommand("statsu"), "status");
  assert.equal(canonicalTelegramCommand("help"), "ajuda");
  assert.equal(canonicalTelegramCommand("listar"), "produtos");
  assert.equal(canonicalTelegramCommand("colecao"), "campanha2");
  assert.equal(canonicalTelegramCommand("discover_batch"), "discover-batch");
  assert.equal(resolveReadOnlyShortcut("ver status"), "status");
  assert.equal(resolveReadOnlyShortcut("listar produtos"), "produtos");
  assert.equal(resolveReadOnlyShortcut("ver categorias"), "categorias");
  assert.equal(resolveReadOnlyShortcut("publicar isso"), null);
  assert.equal(resolveReadOnlyShortcut("mudar preço 99"), null);
});

test("autorização permanece fail-closed e update_id é deduplicado", () => {
  const ids = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const users = process.env.TELEGRAM_ALLOWED_USERS;
  try {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ALLOWED_USERS;
    assert.equal(isUserAllowed("888111222"), false);
    process.env.TELEGRAM_ALLOWED_USER_IDS = "888111222,777000333";
    assert.equal(isUserAllowed("888111222"), true);
    assert.equal(isUserAllowed("999000111"), false);
  } finally {
    if (ids === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = ids;
    if (users === undefined) delete process.env.TELEGRAM_ALLOWED_USERS;
    else process.env.TELEGRAM_ALLOWED_USERS = users;
  }

  const updateId = Math.floor(Math.random() * 1_000_000_000) + 1;
  assert.equal(shouldProcessTelegramUpdate(updateId, 1000), true);
  assert.equal(shouldProcessTelegramUpdate(updateId, 1001), false);
  assert.equal(shouldProcessTelegramUpdate(undefined, 1002), true);
});

test("botões do menu principal possuem handlers alcançáveis", () => {
  assertHandler("admin_today", /if \(data === "admin_today"\)/);
  assertHandler("product_approvals", /if \(data\.startsWith\("product_approvals:"\)\)/);
  assertHandler("products_list", /if \(data\.startsWith\("products_list:"\)\)/);
  assertHandler("admin_add", /if \(data === "admin_add"\)/);
  assertHandler("analytics_overview", /if \(data === "analytics_overview"\)/);
  assertHandler("admin_categories", /if \(data === "admin_categories"\)/);
  assertHandler("campaign_collection", /handleNewsletterCampaignCallback\(data,/);
  assertHandler("social_links", /if \(data === "social_links"\)/);
  assertHandler("operator_home", /if \(data === "operator_home" \|\| data === "operator_refresh"\)/);
  assertHandler("admin_system", /if \(data === "admin_system"\)/);
  assertHandler("admin_menu", /if \(data === "admin_menu" \|\| data === "admin_back"\)/);
});

test("ações críticas de produto possuem handlers", () => {
  assertHandler("product_view", /if \(data\.startsWith\("product_view:"\)\)/);
  assertHandler("product_edit", /if \(data\.startsWith\("product_edit:"\)\)/);
  assertHandler("product_toggle", /if \(data\.startsWith\("product_toggle:"\)\)/);
  assertHandler("product_del_confirm", /if \(data\.startsWith\("product_del_confirm:"\)\)/);
  assertHandler("product_del_exec", /if \(data\.startsWith\("product_del_exec:"\)\)/);
  assertHandler("field_edit", /if \(data\.startsWith\("field_edit:"\)\)/);
  assertHandler("products_search_init", /if \(data === "products_search_init"\)/);
  assertHandler("analytics_product", /if \(data\.startsWith\("analytics_product:"\)\)/);
  assert.doesNotMatch(telegramSource, /categoriesRepository/);
  assert.doesNotMatch(telegramSource, /\.addCategory\(/);
  assert.doesNotMatch(telegramSource, /\.renameCategory\(/);
  assert.doesNotMatch(telegramSource, /getLatestPendingReviewForUser\(senderId, chatId\)/);
});

test("catálogo do Telegram não esconde produtos pausados", () => {
  const products = Array.from({ length: 21 }, (_, index) => ({
    id: `prod-${index + 1}`,
    ref: `REF-${String(index + 1).padStart(3, "0")}`,
    produto: `Produto ${index + 1}`,
    preco: index + 1,
    ativo: index < 8,
  }));
  const first = buildProductListView(products, 0);
  const last = buildProductListView(products, 4);
  assert.equal(products.length, 21, "fixture read-only representa o catálogo completo");
  assert.equal(products.filter(product => product.ativo !== false).length, 8, "oito produtos ativos");
  assert.equal(products.filter(product => product.ativo === false).length, 13, "treze produtos pausados");
  assert.equal(first.total, 21);
  assert.equal(first.totalPages, 5);
  assert.match(first.text, /21 cadastrados/);
  assert.equal(last.page, 4);
  assert.match(last.text, /Produto 21/);
  assert.match(last.text, /⏸️/);
});

test("painel de categorias usa taxonomia pública fixa e não expõe CRUD livre", () => {
  assert.match(panelSource, /PUBLIC_PRODUCT_CATEGORIES/);
  assert.match(panelSource, /PUBLIC_PRODUCT_CATEGORIES\.map/);
  assert.doesNotMatch(panelSource, /addCategory\(|renameCategory\(/);
});

test("lista do Telegram lê a fonte canônica sem filtro ativo/inativo", () => {
  const start = telegramSource.indexOf("async function renderProductList");
  const end = telegramSource.indexOf("async function renderMainMenu", start);
  assert.ok(start >= 0 && end > start);
  const section = telegramSource.slice(start, end);
  assert.match(section, /productsRepository\.getProducts\(\)/);
  assert.doesNotMatch(section, /\.filter\([^)]*ativo/);
});
