from pathlib import Path

# 1) publishCommand fixture: choose one valid synthetic admin from a CSV whitelist.
p = Path('tests/publishCommand.test.ts')
s = p.read_text(encoding='utf-8')
old = 'const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";'
new = '''const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";
const TEST_ADMIN_USER_ID = Number(
  TELEGRAM_ALLOWED_USERS.split(",").map(id => id.trim()).find(id => /^-?\\d+$/.test(id)) ?? "1976526372",
);'''
if s.count(old) != 1:
    raise SystemExit(f'publish fixture declaration count={s.count(old)}')
s = s.replace(old, new, 1)
count = s.count('Number(TELEGRAM_ALLOWED_USERS)')
if count != 3:
    raise SystemExit(f'expected 3 stale Number(TELEGRAM_ALLOWED_USERS), found {count}')
s = s.replace('Number(TELEGRAM_ALLOWED_USERS)', 'TEST_ADMIN_USER_ID')
p.write_text(s, encoding='utf-8')

# 2) /aprovados: independent read fallbacks; one unavailable source must not hide the other.
p = Path('server/services/telegramPanel.ts')
s = p.read_text(encoding='utf-8')
start = s.index('export async function renderApproved(): Promise<string> {')
end = s.index('\nexport async function renderProducts(): Promise<string> {', start)
replacement = '''export async function renderApproved(): Promise<string> {
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
s = s[:start] + replacement + s[end:]
p.write_text(s, encoding='utf-8')

# 3) Read-panel tests: semantic read-only contract and primary/secondary command split.
p = Path('tests/telegramReadPanel.test.ts')
s = p.read_text(encoding='utf-8')
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
} from "../server/services/telegramCommands";'''
if s.count(import_old) != 1:
    raise SystemExit('telegramReadPanel import block not found exactly once')
s = s.replace(import_old, import_new, 1)

old_assert = '    assert.match(status, /Read-only · nenhum estado foi alterado/i);'
if s.count(old_assert) != 2:
    raise SystemExit(f'expected 2 stale status read-only assertions, found {s.count(old_assert)}')
new_assert = '    assert.match(status, /STATUS READ-ONLY/i);\n    assert.match(status, /Nenhuma alteração foi executada/i);'
s = s.replace(old_assert, new_assert, 2)

old_block = '''    assert.ok(callPayload, "API chamada");
    assert.equal(callPayload.commands.length, TELEGRAM_PANEL_COMMANDS.length, "todos os comandos registrados");
    for (const cmd of TELEGRAM_PANEL_COMMANDS) {
      assert.ok(callPayload.commands.some((c: any) => c.command === cmd.command), `comando ${cmd.command} registrado`);
    }'''
new_block = '''    assert.ok(callPayload, "API chamada");
    const nativeNames = callPayload.commands.map((c: any) => c.command);
    const primaryNames = PRIMARY_TELEGRAM_COMMANDS.map(c => c.command);
    assert.equal(new Set(nativeNames).size, nativeNames.length, "menu nativo sem duplicatas");
    assert.equal(nativeNames.length, primaryNames.length, "menu nativo contém somente comandos primários");
    for (const command of primaryNames) {
      assert.ok(nativeNames.includes(command), `comando primário ${command} registrado no menu nativo`);
    }
    for (const command of SECONDARY_TELEGRAM_COMMANDS.map(c => c.command)) {
      assert.equal(nativeNames.includes(command), false, `comando secundário ${command} não polui menu nativo`);
      assert.ok(TELEGRAM_PANEL_COMMANDS.some(c => c.command === command), `comando secundário ${command} preservado no painel`);
      assert.equal(isKnownTelegramCommand(command), true, `comando secundário ${command} continua roteável`);
    }
    for (const command of ["discover", "research", "assess", "shopee-offer", "campanha2", "boasvindas"]) {
      assert.equal(isKnownTelegramCommand(command), true, `comando avançado ${command} continua roteável`);
    }'''
if s.count(old_block) != 1:
    raise SystemExit('stale command-count assertion block not found exactly once')
s = s.replace(old_block, new_block, 1)
p.write_text(s, encoding='utf-8')
