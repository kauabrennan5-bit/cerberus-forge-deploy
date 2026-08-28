import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  isKnownTelegramCommand,
} from "../server/services/telegramCommands";
import { buildProductListView } from "../server/services/telegramBot";

const telegramSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");

function assertHandler(token: string, pattern: RegExp): void {
  assert.match(telegramSource, pattern, `botão/rota ${token} precisa ter handler explícito`);
}

test("menu nativo é curto, único e mantém comandos secundários reconhecidos", () => {
  assert.ok(PRIMARY_TELEGRAM_COMMANDS.length <= 10, "menu nativo deve permanecer enxuto");
  const names = PRIMARY_TELEGRAM_COMMANDS.map(item => item.command);
  assert.equal(new Set(names).size, names.length, "comandos nativos não podem duplicar");
  for (const item of [...PRIMARY_TELEGRAM_COMMANDS, ...SECONDARY_TELEGRAM_COMMANDS]) {
    assert.ok(isKnownTelegramCommand(item.command), `/${item.command} deve continuar reconhecido`);
    assert.ok(item.description.length > 0 && item.description.length <= 256);
  }
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
  assert.equal(first.total, 21);
  assert.equal(first.totalPages, 5);
  assert.match(first.text, /21 cadastrados/);
  assert.equal(last.page, 4);
  assert.match(last.text, /Produto 21/);
  assert.match(last.text, /⏸️/);
});

test("lista do Telegram lê a fonte canônica sem filtro ativo/inativo", () => {
  const start = telegramSource.indexOf("async function renderProductList");
  const end = telegramSource.indexOf("async function renderMainMenu", start);
  assert.ok(start >= 0 && end > start);
  const section = telegramSource.slice(start, end);
  assert.match(section, /productsRepository\.getProducts\(\)/);
  assert.doesNotMatch(section, /\.filter\([^)]*ativo/);
});
