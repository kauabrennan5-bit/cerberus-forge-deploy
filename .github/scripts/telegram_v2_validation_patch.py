from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one occurrence, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


publish = Path("tests/publishCommand.test.ts")
text = publish.read_text()
marker = 'const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";\n'
if text.count(marker) != 1:
    raise SystemExit("publish fixture marker mismatch")
text = text.replace(
    marker,
    marker
    + 'const ADMIN_USER_ID = Number(TELEGRAM_ALLOWED_USERS.split(",")[0]?.trim() || "1976526372");\n'
    + 'assert.ok(Number.isSafeInteger(ADMIN_USER_ID) && ADMIN_USER_ID > 0, "fixture admin precisa resolver um ID permitido válido");\n',
    1,
)
occurrences = text.count('Number(TELEGRAM_ALLOWED_USERS)')
if occurrences != 3:
    raise SystemExit(f"publish fixture expected 3 stale Number(...) uses, found {occurrences}")
text = text.replace('Number(TELEGRAM_ALLOWED_USERS)', 'ADMIN_USER_ID')
publish.write_text(text)

panel = Path("server/services/telegramPanel.ts")
text = panel.read_text()
old_footer = '    "Nenhuma alteração foi executada."\n'
new_footer = '    "Read-only · nenhum estado foi alterado."\n'
if text.count(old_footer) != 1:
    raise SystemExit("renderStatus footer marker mismatch")
text = text.replace(old_footer, new_footer, 1)

approved_pattern = re.compile(
    r'export async function renderApproved\(\): Promise<string> \{.*?\n\}\n\n(?=export async function renderProducts)',
    re.S,
)
approved_replacement = '''export async function renderApproved(): Promise<string> {
  let published: any[] | null = null;
  let activeProducts: any[] | null = null;

  try {
    published = await telegramRepo.listReviewsByStatus(["published"], 10);
  } catch {
    published = null;
  }

  try {
    const products = await productsRepository.getProducts();
    activeProducts = Array.isArray(products) ? products.filter(p => p.ativo !== false) : [];
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
      : activeProducts.slice(0, 10).map(product => `• ${String(product.produto).slice(0, 44)}`).join("\\n") +
        (activeProducts.length > 10 ? `\\n… +${activeProducts.length - 10}` : "");

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
text, count = approved_pattern.subn(approved_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"renderApproved replacement count={count}")
panel.write_text(text)

read_panel = Path("tests/telegramReadPanel.test.ts")
text = read_panel.read_text()
import_marker = '''import {
  renderReadPanelMenu,
  registerTelegramCommands,
  TELEGRAM_PANEL_COMMANDS,
} from "../server/services/telegramPanel";
'''
import_replacement = import_marker + '''import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  isKnownTelegramCommand,
} from "../server/services/telegramCommands";
'''
if text.count(import_marker) != 1:
    raise SystemExit("telegramReadPanel import marker mismatch")
text = text.replace(import_marker, import_replacement, 1)

command_pattern = re.compile(
    r'test\("registerTelegramCommands envia exatamente os comandos esperados", async \(\) => \{.*?\n\}\);\n\n(?=test\("registerTelegramCommands: falha)',
    re.S,
)
command_replacement = '''test("registerTelegramCommands registra somente o menu nativo e preserva comandos compatíveis", async () => {
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
    assert.equal(result.ok, true, "setMyCommands registrado");
    assert.ok(callPayload, "API chamada");

    const registeredNames = callPayload.commands.map((c: any) => c.command);
    const primaryNames = PRIMARY_TELEGRAM_COMMANDS.map(c => c.command);
    assert.deepEqual(registeredNames, primaryNames, "setMyCommands deve refletir exatamente o menu nativo V2");
    assert.equal(new Set(registeredNames).size, registeredNames.length, "menu nativo sem duplicatas");

    for (const cmd of SECONDARY_TELEGRAM_COMMANDS) {
      assert.equal(registeredNames.includes(cmd.command), false, `/${cmd.command} não deve poluir o menu nativo`);
      assert.ok(TELEGRAM_PANEL_COMMANDS.some(c => c.command === cmd.command), `/${cmd.command} preservado no painel completo`);
      assert.equal(isKnownTelegramCommand(cmd.command), true, `/${cmd.command} continua roteável`);
    }

    for (const command of [
      "discover", "research", "assess", "priority", "opportunities", "risks",
      "experiments", "agents", "decisions", "recommendations", "affiliates",
      "cycle", "shopee-schema", "shopee-offer", "campanha2", "boasvindas",
    ]) {
      assert.equal(isKnownTelegramCommand(command), true, `/${command} avançado continua roteável`);
    }
  } finally {
    restore();
  }
});

'''
text, count = command_pattern.subn(command_replacement, text, count=1)
if count != 1:
    raise SystemExit(f"registerTelegramCommands test replacement count={count}")
read_panel.write_text(text)
