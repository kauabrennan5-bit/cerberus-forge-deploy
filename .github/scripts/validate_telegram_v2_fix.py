from pathlib import Path

# A) publishCommand fixture: production accepts a comma-separated whitelist.
# The test fixture must select one valid allowed ID instead of Number(csv).
publish = Path("tests/publishCommand.test.ts")
text = publish.read_text(encoding="utf-8")
marker = 'const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";'
replacement = '''const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";
const TEST_ADMIN_USER_ID = Number(
  TELEGRAM_ALLOWED_USERS.split(",").map(id => id.trim()).find(id => /^-?\\d+$/.test(id)) ?? "1976526372",
);'''
if text.count(marker) != 1:
    raise SystemExit(f"publish fixture declaration count={text.count(marker)}")
text = text.replace(marker, replacement, 1)
count = text.count("Number(TELEGRAM_ALLOWED_USERS)")
if count != 3:
    raise SystemExit(f"expected 3 stale Number(TELEGRAM_ALLOWED_USERS), found {count}")
text = text.replace("Number(TELEGRAM_ALLOWED_USERS)", "TEST_ADMIN_USER_ID")
publish.write_text(text, encoding="utf-8")

# B) /aprovados: read sources independently. One unavailable source must not
# suppress data from the other source, and the panel stays explicitly read-only.
panel = Path("server/services/telegramPanel.ts")
text = panel.read_text(encoding="utf-8")
start = text.index("export async function renderApproved(): Promise<string> {")
end = text.index("\nexport async function renderProducts(): Promise<string> {", start)
approved = '''export async function renderApproved(): Promise<string> {
  let published: any[] | null = null;
  let activeProducts: any[] | null = null;

  try {
    published = await telegramRepo.listReviewsByStatus(["published"], 25);
  } catch {
    published = null;
  }

  try {
    const products = await productsRepository.getProducts();
    activeProducts = Array.isArray(products) ? products.filter(product => product.ativo !== false) : [];
  } catch {
    activeProducts = null;
  }

  const reviewText = published === null
    ? "não disponível"
    : published.length === 0
      ? "nenhuma decisão publicada recente"
      : published.map((review, index) => `${index + 1}. ${String(review.produto || "(sem nome)").slice(0, 44)}`).join("\\n");

  const catalogText = activeProducts === null
    ? "não disponível"
    : activeProducts.length === 0
      ? "catálogo vazio"
      : activeProducts.slice(0, 15).map(product => `• <code>${product.ref}</code> · ${String(product.produto).slice(0, 44)}`).join("\\n") +
        (activeProducts.length > 15 ? `\\n… +${activeProducts.length - 15}` : "");

  return (
    "✅ <b>APROVADOS / PUBLICADOS</b>\\n" +
    "━━━━━━━━━━━━━━━━━━\\n" +
    `<b>Decisões recentes</b>\\n${reviewText}\\n\\n` +
    `<b>Catálogo ativo</b>\\n${catalogText}\\n` +
    "━━━━━━━━━━━━━━━━━━\\n" +
    "Read-only · nenhum estado foi alterado."
  );
}
'''
text = text[:start] + approved + text[end:]
panel.write_text(text, encoding="utf-8")

# C) Read-panel tests: validate semantics rather than stale wording/count and
# retain the historical /aprovados contract as permanent coverage.
read_panel = Path("tests/telegramReadPanel.test.ts")
text = read_panel.read_text(encoding="utf-8")
import_old = '''import {
  renderReadPanelMenu,
  registerTelegramCommands,
  TELEGRAM_PANEL_COMMANDS,
} from "../server/services/telegramPanel";'''
import_new = '''import {
  renderReadPanelMenu,
  registerTelegramCommands,
  TELEGRAM_PANEL_COMMANDS,
} from "../server/services/telegramPanel";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  isKnownTelegramCommand,
} from "../server/services/telegramCommands";
import { setTestListReviewsByStatus } from "../server/repositories/telegramRepository";'''
if text.count(import_old) != 1:
    raise SystemExit("telegramReadPanel import block mismatch")
text = text.replace(import_old, import_new, 1)

old_status = '    assert.match(status, /Read-only · nenhum estado foi alterado/i);'
if text.count(old_status) != 2:
    raise SystemExit(f"expected 2 stale status assertions, found {text.count(old_status)}")
new_status = '    assert.match(status, /STATUS READ-ONLY/i);\n    assert.match(status, /Nenhuma alteração foi executada/i);'
text = text.replace(old_status, new_status, 2)

old_approved = '''test("renderApproved combina decisões registradas e catálogo sem inventar estado", async () => {
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
    assert.match(report, /decisões recentes/i);
    assert.match(report, /catálogo ativo/i);
    assert.match(report, /Read-only · nenhum estado foi alterado/i);
  } finally {
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});'''
new_approved = '''test("renderApproved preserva decisões publicadas quando outra fonte fica indisponível", async () => {
  const envs = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_KEY;
  setTestListReviewsByStatus(async statuses => {
    assert.deepEqual(statuses, ["published"], "/aprovados consulta somente decisões publicadas");
    return [{ id: "published-test", produto: "Produto publicado de teste", status: "published" } as any];
  });
  try {
    const { renderApproved } = await import("../server/services/telegramPanel");
    const report = await renderApproved();
    assert.match(report, /decisões recentes/i);
    assert.match(report, /Produto publicado de teste/i, "fonte saudável permanece visível");
    assert.match(report, /catálogo ativo/i);
    assert.match(report, /não disponível/i, "fonte indisponível é declarada sem inventar dados");
    assert.match(report, /Read-only · nenhum estado foi alterado/i);
  } finally {
    setTestListReviewsByStatus(null);
    for (const [key, value] of Object.entries(envs)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});'''
if text.count(old_approved) != 1:
    raise SystemExit("renderApproved contract test mismatch")
text = text.replace(old_approved, new_approved, 1)

old_commands = '''    assert.ok(callPayload, "API chamada");
    assert.equal(callPayload.commands.length, TELEGRAM_PANEL_COMMANDS.length, "todos os comandos registrados");
    for (const cmd of TELEGRAM_PANEL_COMMANDS) {
      assert.ok(callPayload.commands.some((c: any) => c.command === cmd.command), `comando ${cmd.command} registrado`);
    }'''
new_commands = '''    assert.ok(callPayload, "API chamada");
    const nativeNames = callPayload.commands.map((c: any) => c.command);
    const primaryNames = PRIMARY_TELEGRAM_COMMANDS.map(c => c.command);
    assert.equal(primaryNames.length, 10, "contrato V2 mantém exatamente dez comandos principais");
    assert.equal(new Set(nativeNames).size, nativeNames.length, "menu nativo sem duplicatas");
    assert.deepEqual(nativeNames, primaryNames, "setMyCommands reflete exatamente o menu primário V2");
    for (const command of SECONDARY_TELEGRAM_COMMANDS.map(c => c.command)) {
      assert.equal(nativeNames.includes(command), false, `comando secundário ${command} não polui menu nativo`);
      assert.ok(TELEGRAM_PANEL_COMMANDS.some(c => c.command === command), `comando secundário ${command} preservado no painel`);
      assert.equal(isKnownTelegramCommand(command), true, `comando secundário ${command} continua roteável`);
    }
    for (const command of ["discover", "research", "assess", "priority", "opportunities", "risks", "experiments", "agents", "decisions", "recommendations", "affiliates", "cycle", "shopee-schema", "shopee-offer", "campanha2", "boasvindas"]) {
      assert.equal(isKnownTelegramCommand(command), true, `comando avançado ${command} continua roteável`);
    }'''
if text.count(old_commands) != 1:
    raise SystemExit("stale command-count assertion block mismatch")
text = text.replace(old_commands, new_commands, 1)
read_panel.write_text(text, encoding="utf-8")

# D) Permanently retain the meaningful contracts that used to exist only in
# three runner-generated suites. This restores semantics, not a historical count.
ui = Path("tests/telegramUiContract.test.ts")
text = ui.read_text(encoding="utf-8")
commands_import_old = '''import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  isKnownTelegramCommand,
} from "../server/services/telegramCommands";
import { buildProductListView } from "../server/services/telegramBot";'''
commands_import_new = '''import {
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
import { TELEGRAM_PANEL_COMMANDS } from "../server/services/telegramPanel";'''
if text.count(commands_import_old) != 1:
    raise SystemExit("telegramUiContract import block mismatch")
text = text.replace(commands_import_old, commands_import_new, 1)

source_marker = 'const telegramSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");'
source_replacement = source_marker + '\nconst panelSource = readFileSync(new URL("../server/services/telegramPanel.ts", import.meta.url), "utf8");'
if text.count(source_marker) != 1:
    raise SystemExit("telegramUiContract source marker mismatch")
text = text.replace(source_marker, source_replacement, 1)

old_menu = '''test("menu nativo é curto, único e mantém comandos secundários reconhecidos", () => {
  assert.ok(PRIMARY_TELEGRAM_COMMANDS.length <= 10, "menu nativo deve permanecer enxuto");
  const names = PRIMARY_TELEGRAM_COMMANDS.map(item => item.command);
  assert.equal(new Set(names).size, names.length, "comandos nativos não podem duplicar");
  for (const item of [...PRIMARY_TELEGRAM_COMMANDS, ...SECONDARY_TELEGRAM_COMMANDS]) {
    assert.ok(isKnownTelegramCommand(item.command), `/${item.command} deve continuar reconhecido`);
    assert.ok(item.description.length > 0 && item.description.length <= 256);
  }
});'''
new_menu = '''test("menu nativo tem dez comandos, descrições válidas e preserva compatibilidade", () => {
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
});'''
if text.count(old_menu) != 1:
    raise SystemExit("telegramUiContract menu test mismatch")
text = text.replace(old_menu, new_menu, 1)

insert_before = 'test("botões do menu principal possuem handlers alcançáveis", () => {'
restored_contracts = '''test("parser, aliases e atalhos naturais preservam o contrato V2", () => {
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

'''
if text.count(insert_before) != 1:
    raise SystemExit("telegramUiContract insertion marker mismatch")
text = text.replace(insert_before, restored_contracts + insert_before, 1)

critical_marker = '''test("ações críticas de produto possuem handlers", () => {
  assertHandler("product_view", /if \\(data\\.startsWith\\(\"product_view:\"\\)\\)/);'''
# Avoid brittle whole-block replacement: add structural invariants before the test closes.
critical_end = '''  assertHandler("analytics_product", /if \\(data\\.startsWith\\(\"analytics_product:\"\\)\\)/);
});'''
critical_new = '''  assertHandler("analytics_product", /if \\(data\\.startsWith\\(\"analytics_product:\"\\)\\)/);
  assert.doesNotMatch(telegramSource, /categoriesRepository/);
  assert.doesNotMatch(telegramSource, /\\.addCategory\\(/);
  assert.doesNotMatch(telegramSource, /\\.renameCategory\\(/);
  assert.doesNotMatch(telegramSource, /getLatestPendingReviewForUser\\(senderId, chatId\\)/);
});'''
if text.count(critical_end) != 1:
    raise SystemExit("telegramUiContract critical handler end mismatch")
text = text.replace(critical_end, critical_new, 1)

catalog_marker = '''  assert.equal(first.total, 21);
  assert.equal(first.totalPages, 5);'''
catalog_new = '''  assert.equal(products.length, 21, "fixture read-only representa o catálogo completo");
  assert.equal(products.filter(product => product.ativo !== false).length, 8, "oito produtos ativos");
  assert.equal(products.filter(product => product.ativo === false).length, 13, "treze produtos pausados");
  assert.equal(first.total, 21);
  assert.equal(first.totalPages, 5);'''
if text.count(catalog_marker) != 1:
    raise SystemExit("telegramUiContract catalog marker mismatch")
text = text.replace(catalog_marker, catalog_new, 1)

final_marker = '''test("lista do Telegram lê a fonte canônica sem filtro ativo/inativo", () => {'''
categories_contract = '''test("painel de categorias usa taxonomia pública fixa e não expõe CRUD livre", () => {
  assert.match(panelSource, /PUBLIC_PRODUCT_CATEGORIES/);
  assert.match(panelSource, /PUBLIC_PRODUCT_CATEGORIES\\.map/);
  assert.doesNotMatch(panelSource, /addCategory\\(|renameCategory\\(/);
});

'''
if text.count(final_marker) != 1:
    raise SystemExit("telegramUiContract final insertion marker mismatch")
text = text.replace(final_marker, categories_contract + final_marker, 1)
ui.write_text(text, encoding="utf-8")

print("PATCHED=server/services/telegramPanel.ts,tests/publishCommand.test.ts,tests/telegramReadPanel.test.ts,tests/telegramUiContract.test.ts")
