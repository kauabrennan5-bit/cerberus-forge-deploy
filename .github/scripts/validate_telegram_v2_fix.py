from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one occurrence, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


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


# C) Read-panel tests: validate semantics rather than stale wording/count.
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
} from "../server/services/telegramCommands";'''
if text.count(import_old) != 1:
    raise SystemExit("telegramReadPanel import block mismatch")
text = text.replace(import_old, import_new, 1)

old_status = '    assert.match(status, /Read-only · nenhum estado foi alterado/i);'
if text.count(old_status) != 2:
    raise SystemExit(f"expected 2 stale status assertions, found {text.count(old_status)}")
new_status = '    assert.match(status, /STATUS READ-ONLY/i);\n    assert.match(status, /Nenhuma alteração foi executada/i);'
text = text.replace(old_status, new_status, 2)

old_commands = '''    assert.ok(callPayload, "API chamada");
    assert.equal(callPayload.commands.length, TELEGRAM_PANEL_COMMANDS.length, "todos os comandos registrados");
    for (const cmd of TELEGRAM_PANEL_COMMANDS) {
      assert.ok(callPayload.commands.some((c: any) => c.command === cmd.command), `comando ${cmd.command} registrado`);
    }'''
new_commands = '''    assert.ok(callPayload, "API chamada");
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
if text.count(old_commands) != 1:
    raise SystemExit("stale command-count assertion block mismatch")
text = text.replace(old_commands, new_commands, 1)
read_panel.write_text(text, encoding="utf-8")

print("PATCHED=server/services/telegramPanel.ts,tests/publishCommand.test.ts,tests/telegramReadPanel.test.ts")
