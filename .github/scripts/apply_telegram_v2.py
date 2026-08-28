from pathlib import Path
import re

bot_path = Path("server/services/telegramBot.ts")
src = bot_path.read_text(encoding="utf-8")


def exact(old: str, new: str, label: str) -> None:
    global src
    if old not in src:
        raise SystemExit(f"MISSING_MARKER:{label}")
    src = src.replace(old, new, 1)


def sub(pattern: str, replacement: str, label: str) -> None:
    global src
    src2, count = re.subn(pattern, lambda _match: replacement, src, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"MISSING_OR_DUPLICATE_PATTERN:{label}:{count}")
    src = src2


exact('import * as categoriesRepository from "../repositories/categoriesRepository";\n', '', 'categories import')
exact('import type { ShopeePromotionEvidence } from "./scraper";\n', '', 'shopee evidence type import')
exact(
    'import * as telegramPanel from "./telegramPanel";\n',
    'import * as telegramPanel from "./telegramPanel";\n'
    'import { getTelegramBotToken, telegramApiFetch } from "./telegramApiClient";\n'
    'import { canonicalTelegramCommand, isKnownTelegramCommand, parseTelegramCommand, resolveReadOnlyShortcut, suggestTelegramCommand } from "./telegramCommands";\n'
    'import type { PendingReview } from "./telegramTypes";\n'
    'export type { PendingReview } from "./telegramTypes";\n'
    'export { getTelegramBotToken, telegramApiFetch } from "./telegramApiClient";\n',
    'v2 imports',
)

sub(
    r'const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;\n[\s\S]*?(?=function escapeTelegramHtml)',
    '',
    'local Telegram API client block',
)

sub(
    r'export interface PendingReview \{[\s\S]*?\n\}\n\n(?=export function resolveTelegramReviewCategory)',
    '',
    'local PendingReview interface',
)

sub(
    r'export function isUserAllowed\(userId: string \| number\): boolean \{[\s\S]*?\n\}',
    '''export function isUserAllowed(userId: string | number): boolean {
  const allowedEnv = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
  const allowedIds = allowedEnv.split(",").map(id => id.trim()).filter(Boolean);
  if (allowedIds.length === 0) return false;
  return allowedIds.includes(String(userId));
}''',
    'fail-closed whitelist',
)

sub(
    r'/\*\*\n \* Renderizador do Menu Principal /start e /admin\n \*/\nasync function renderMainMenu\([\s\S]*?\n\}\n\n(?=function renderSocialLinksSettings)',
    '''/** Menu principal: compacto, sem duplicar a mesma ação com nomes diferentes. */
async function renderMainMenu(chatId: number | string, messageId?: number, isEdit: boolean = false): Promise<void> {
  let summary: any = null;
  try {
    summary = await productsRepository.getAnalyticsSummary();
  } catch {
    summary = null;
  }

  const totalProducts = summary?.totalProducts ?? "?";
  const activeProducts = summary?.activeProducts ?? "?";
  const todayClicks = summary?.todayClicks ?? "?";
  const topProduct = Array.isArray(summary?.topProducts) && summary.topProducts[0]?.name
    ? String(summary.topProducts[0].name)
    : "Sem dados ainda";

  const text =
    "🏴 <b>CERBERUS FINDS</b>\\n" +
    "━━━━━━━━━━━━━━━━━━\\n" +
    `📦 <b>${activeProducts}/${totalProducts}</b> produtos ativos\\n` +
    `👆 <b>${todayClicks}</b> cliques hoje\\n` +
    `🏆 <i>${escapeTelegramHtml(topProduct)}</i>\\n\\n` +
    "Escolha o que precisa fazer agora.";

  const keyboard = {
    inline_keyboard: [
      [{ text: "⚡ Hoje", callback_data: "admin_today" }, { text: "⏳ Pendentes", callback_data: "product_approvals:0" }],
      [{ text: "📦 Produtos", callback_data: "products_list:0" }, { text: "🔎 Descobrir", callback_data: "admin_add" }],
      [{ text: "📊 Analytics", callback_data: "analytics_overview" }, { text: "🏷️ Categorias", callback_data: "admin_categories" }],
      [{ text: "📧 Campanhas", callback_data: "campaign_collection" }, { text: "🔗 Redes", callback_data: "social_links" }],
      [{ text: "🧠 Operator", callback_data: "operator_home" }, { text: "🩺 Sistema", callback_data: "admin_system" }],
    ],
  };

  if (isEdit && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
  else await sendTelegramMessage(chatId, text, keyboard);
}

''',
    'main menu',
)

marker = '/**\n * Processador Principal de Updates do Webhook (Texto + Callback Queries)\n */\n'
dedupe = '''const TELEGRAM_UPDATE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_UPDATE_DEDUPE_MAX = 500;
const processedTelegramUpdateIds = new Map<number, number>();

/** Evita reprocessar a mesma entrega do webhook na mesma instância. */
export function shouldProcessTelegramUpdate(updateId: unknown, now = Date.now()): boolean {
  if (typeof updateId !== "number" || !Number.isInteger(updateId)) return true;
  for (const [id, timestamp] of processedTelegramUpdateIds) {
    if (now - timestamp > TELEGRAM_UPDATE_DEDUPE_TTL_MS) processedTelegramUpdateIds.delete(id);
  }
  if (processedTelegramUpdateIds.has(updateId)) return false;
  processedTelegramUpdateIds.set(updateId, now);
  while (processedTelegramUpdateIds.size > TELEGRAM_UPDATE_DEDUPE_MAX) {
    const oldest = processedTelegramUpdateIds.keys().next().value;
    if (oldest === undefined) break;
    processedTelegramUpdateIds.delete(oldest);
  }
  return true;
}

'''
exact(marker, dedupe + marker, 'dedupe insertion')
exact(
    'export async function handleTelegramWebhookUpdate(update: any): Promise<void> {\n  if (!update) return;\n',
    'export async function handleTelegramWebhookUpdate(update: any): Promise<void> {\n  if (!update) return;\n  if (!shouldProcessTelegramUpdate(update.update_id)) {\n    logTelegramEvent("duplicate_update_ignored", { update_id: update.update_id });\n    return;\n  }\n',
    'dedupe guard',
)

exact(
    '    if (data.startsWith("product_approvals:")) {',
    '''    if (data === "admin_today") {
      await answerCallbackQuery(callbackId);
      const text = await telegramPanel.renderToday();
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "admin_menu" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("product_approvals:")) {''',
    'admin today callback',
)

sub(
    r'    if \(data === "admin_categories"\) \{[\s\S]*?\n    \}\n\n(?=    if \(data === "admin_add"\))',
    '''    if (data === "admin_categories") {
      await answerCallbackQuery(callbackId);
      const text = await telegramPanel.renderCategories();
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Menu", callback_data: "admin_menu" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

''',
    'read-only admin categories',
)

sub(
    r'    if \(data === "add_cat_init"\) \{[\s\S]*?\n    \}\n\n    if \(data\.startsWith\("rename_cat_init:"\)\) \{[\s\S]*?\n    \}\n',
    '''    if (data === "add_cat_init" || data.startsWith("rename_cat_init:")) {
      await telegramRepo.deleteUserState(senderId);
      await answerCallbackQuery(callbackId, "A taxonomia pública é fixa.");
      const text = await telegramPanel.renderCategories();
      if (chatId) await sendTelegramMessage(chatId, text);
      return;
    }
''',
    'legacy category callbacks',
)

exact(
    '    if (text.startsWith("/")) logTelegramEvent("command", { chat_id: chatId, command: text.split(/\\s+/, 1)[0].toLowerCase() });\n',
    '',
    'old command logger',
)

sub(
    r'    // --- FASE 25B \(Commit 1\) — PAINEL DE LEITURA \(READ-ONLY\) ---[\s\S]*?(?=    // /shopee-schema)',
    '''    const parsedCommand = parseTelegramCommand(text);
    const userState = await telegramRepo.getUserState(senderId);
    const shortcutCommand = !parsedCommand && !userState ? resolveReadOnlyShortcut(text) : null;
    const commandName = parsedCommand ? canonicalTelegramCommand(parsedCommand.name) : shortcutCommand;

    if (parsedCommand && !isKnownTelegramCommand(parsedCommand.name)) {
      const suggestion = suggestTelegramCommand(parsedCommand.name);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          suggestion
            ? `⚠️ Comando não reconhecido. Você quis dizer <code>/${suggestion}</code>?`
            : "⚠️ Comando não reconhecido. Use <code>/ajuda</code> para ver os atalhos disponíveis.",
        );
      }
      return;
    }

    if (commandName) logTelegramEvent("command", { chat_id: chatId, command: commandName });

    if (commandName === "menu") {
      if (chatId) await sendTelegramMessage(chatId, telegramPanel.renderReadPanelMenu());
      return;
    }
    if (commandName === "hoje") {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderToday());
      return;
    }
    if (commandName === "status") {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderStatus());
      return;
    }
    if (commandName === "pendentes") {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderPendingReviews());
      return;
    }
    if (commandName === "aprovados") {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderApproved());
      return;
    }
    if (commandName === "categorias") {
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderCategories());
      return;
    }
    if (commandName === "produtos" && (!parsedCommand || parsedCommand.name === "produtos" || parsedCommand.name === "listar")) {
      if (chatId) {
        const listView = await renderProductList(0);
        await sendTelegramMessage(chatId, listView.text, listView.keyboard);
      }
      return;
    }
    if (commandName === "ajuda") {
      if (chatId) await sendTelegramMessage(chatId, telegramPanel.renderReadPanelMenu());
      return;
    }
    if (commandName === "avancado") {
      if (chatId) await sendTelegramMessage(chatId, telegramPanel.renderAdvancedPanel());
      return;
    }
    if (commandName === "cancelar") {
      if (!userState) {
        if (chatId) await sendTelegramMessage(chatId, "✅ Não há fluxo ativo para cancelar.");
        return;
      }
      if (userState.reviewId) {
        const review = await telegramRepo.getPendingReview(userState.reviewId);
        if (review?.promotionDraft) {
          review.promotionDraft = null;
          await telegramRepo.savePendingReview(review);
        }
      }
      await telegramRepo.deleteUserState(senderId);
      if (chatId) await sendTelegramMessage(chatId, "❌ Fluxo atual cancelado. Nenhuma publicação foi executada.");
      return;
    }

''',
    'v2 primary command routing',
)

exact(
    '    const userState = await telegramRepo.getUserState(senderId);\n\n    if (userState?.action.startsWith("social_link:")) {',
    '    if (userState?.action.startsWith("social_link:")) {',
    'remove duplicate user state read',
)

sub(
    r'    if \(text\.startsWith\("/categorias"\)\) \{[\s\S]*?\n    \}\n\n    if \(text\.startsWith\("/help"\)\) \{[\s\S]*?\n    \}\n',
    '',
    'legacy categories/help text handlers',
)

sub(
    r'    if \(userState && userState\.action === "add_cat_name"\) \{[\s\S]*?\n    \}\n\n    if \(userState && userState\.action\.startsWith\("rename_cat_name:"\)\) \{[\s\S]*?\n    \}\n',
    '''    if (userState && (userState.action === "add_cat_name" || userState.action.startsWith("rename_cat_name:"))) {
      await telegramRepo.deleteUserState(senderId);
      if (chatId) await sendTelegramMessage(chatId, await telegramPanel.renderCategories());
      return;
    }

''',
    'legacy category states',
)

exact(
    '        await sendTelegramMessage(chatId, `✅ Categoria atualizada para <b>${category}</b>.`);',
    '        await sendTelegramMessage(chatId, `✅ Categoria atualizada para <b>${publicCategory}</b>.`);',
    'canonical category confirmation',
)

sub(
    r'    // Fallback de preço para revisão pendente[\s\S]*?(?=\n  \}\n\}\n\nexport async function startTelegramPolling)',
    '''    if (userState?.action === "awaiting_price") {
      const targetReview = userState.reviewId ? await telegramRepo.getPendingReview(userState.reviewId) : null;
      if (!targetReview) {
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, "⚠️ A revisão não está mais disponível. Abra a review novamente antes de alterar o preço.");
        return;
      }
      const normPrice = parseAndNormalizePrice(text);
      if (normPrice === null || normPrice <= 0) {
        if (chatId) await sendTelegramMessage(chatId, "❌ Valor inválido. Envie um preço como <code>89,90</code> ou use <code>/cancelar</code>.");
        return;
      }

      targetReview.preco = normPrice;
      await refreshReviewLifecycle(targetReview);
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.deleteUserState(senderId);
      const updatedCardText = buildReviewCardText(targetReview);
      const keyboard = buildMainReviewKeyboard(targetReview.id);
      if (chatId) {
        await sendTelegramMessage(chatId, `✅ Preço atualizado para R$ ${normPrice.toFixed(2).replace(".", ",")}.`);
        if (targetReview.cardMessageId) {
          await editTelegramMessageCaption(chatId, targetReview.cardMessageId, updatedCardText, keyboard);
        } else {
          const primaryImageUrl = resolveCanonicalProductImage(targetReview).primaryImageUrl;
          if (primaryImageUrl) await sendTelegramPhoto(chatId, primaryImageUrl, updatedCardText, keyboard);
          else await sendTelegramMessage(chatId, updatedCardText, keyboard);
        }
      }
      return;
    }

    if (chatId) {
      await sendTelegramMessage(
        chatId,
        "ℹ️ Não reconheci essa mensagem. Envie um link de produto, use <code>/menu</code> ou <code>/ajuda</code>. Mutações só acontecem em fluxos explícitos.",
      );
    }
    return;''',
    'explicit-only price editing',
)

if 'categoriesRepository' in src:
    raise SystemExit('INVARIANT:categoriesRepository remains in telegramBot')
if 'getLatestPendingReviewForUser(senderId, chatId)' in src:
    raise SystemExit('INVARIANT:implicit pending review fallback remains')

bot_path.write_text(src, encoding='utf-8')

commands_path = Path('server/services/telegramCommands.ts')
commands = commands_path.read_text(encoding='utf-8')
if '  colecao: "campanha2",' not in commands:
    commands = commands.replace(
        '  "redes-sociais": "redes",\n',
        '  "redes-sociais": "redes",\n  colecao: "campanha2",\n',
        1,
    )
commands_path.write_text(commands, encoding='utf-8')

read_test_path = Path('tests/telegramReadPanel.test.ts')
test_src = read_test_path.read_text(encoding='utf-8')
replacements = [
    ('assert.match(menu, /\\/publicar &lt;id&gt;/i, "placeholder do comando deve ser entidade HTML segura");',
     'assert.match(menu, /\\/publicar &lt;review_id&gt;/i, "placeholder do comando deve ser entidade HTML segura");'),
    ('assert.match(status, /Painel de leitura — nenhum estado foi alterado/i);',
     'assert.match(status, /Read-only · nenhum estado foi alterado/i);'),
    ('assert.match(status, /propostas pendentes: <b>\\d+/i, "contagem de pendentes presente");',
     'assert.match(status, /Pendentes: <b>\\d+/i, "contagem de pendentes presente");'),
    ('assert.match(status, /🔑 token: configurado/i);',
     'assert.match(status, /token ✅/i);'),
    ('assert.match(status, /PROPOSTAS PENDENTES|nenhuma proposta pendente|erro de infraestrutura/i);',
     'assert.match(status, /PENDENTES|FILA LIMPA|FILA INDISPONÍVEL/i);'),
    ('assert.match(report, /decisões humanas registradas/i);',
     'assert.match(report, /decisões recentes/i);'),
    ('assert.match(report, /catálogo canônico ativo/i);',
     'assert.match(report, /catálogo ativo/i);'),
    ('assert.match(report, /Painel de leitura — nenhum estado foi alterado/i);',
     'assert.match(report, /Read-only · nenhum estado foi alterado/i);'),
    ('console.log("R8:", JSON.stringify(result), "payload:", callPayload, "token env:", process.env.TELEGRAM_BOT_TOKEN?.slice(0,8)); assert.equal(result.ok, true, "setMyCommands registrado");',
     'assert.equal(result.ok, true, "setMyCommands registrado");'),
    ('assert.match(sentText, /CERBERUS FINDS — MENU CONSOLIDADO/i, "menu entregue");',
     'assert.match(sentText, /MENU PRINCIPAL/i, "menu entregue");'),
]
for old, new in replacements:
    test_src = test_src.replace(old, new)
read_test_path.write_text(test_src, encoding='utf-8')

diag_path = Path('tests/telegramDiagnostics.test.ts')
diag = diag_path.read_text(encoding='utf-8').replace(
    'process.env.TELEGRAM_ALLOWED_USER_IDS = "1976526372";',
    'process.env.TELEGRAM_ALLOWED_USER_IDS = "888111222";',
)
diag_path.write_text(diag, encoding='utf-8')

Path('tests/telegramCommandsV2.test.ts').write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  canonicalTelegramCommand,
  isKnownTelegramCommand,
  parseTelegramCommand,
  resolveReadOnlyShortcut,
  suggestTelegramCommand,
} from "../server/services/telegramCommands";

test("parser aceita comando com @bot e separa argumentos sem prefix collision", () => {
  assert.deepEqual(parseTelegramCommand("/status@CerberusBot agora"), { name: "status", args: "agora" });
  assert.deepEqual(parseTelegramCommand("/publicar rev_123"), { name: "publicar", args: "rev_123" });
  assert.equal(parseTelegramCommand("status"), null);
  assert.equal(isKnownTelegramCommand("statusfoo"), false);
  assert.equal(suggestTelegramCommand("statsu"), "status");
});

test("aliases preservam compatibilidade sem poluir menu primário", () => {
  assert.equal(canonicalTelegramCommand("help"), "ajuda");
  assert.equal(canonicalTelegramCommand("listar"), "produtos");
  assert.equal(canonicalTelegramCommand("colecao"), "campanha2");
  assert.equal(canonicalTelegramCommand("discover_batch"), "discover-batch");
  const names = PRIMARY_TELEGRAM_COMMANDS.map(item => item.command);
  assert.equal(new Set(names).size, names.length);
  for (const expected of ["hoje", "cancelar", "avancado", "categorias"]) assert.ok(names.includes(expected));
  for (const hidden of ["research", "agents", "recommendations", "discover-batch"]) assert.ok(!names.includes(hidden));
});

test("atalhos naturais são somente leituras explícitas", () => {
  assert.equal(resolveReadOnlyShortcut("ver status"), "status");
  assert.equal(resolveReadOnlyShortcut("listar produtos"), "produtos");
  assert.equal(resolveReadOnlyShortcut("ver categorias"), "categorias");
  assert.equal(resolveReadOnlyShortcut("publicar isso"), null);
  assert.equal(resolveReadOnlyShortcut("mudar preço 99"), null);
});
''', encoding='utf-8')

Path('tests/telegramBotV2Contract.test.ts').write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isUserAllowed, shouldProcessTelegramUpdate } from "../server/services/telegramBot";

test("whitelist Telegram é fail-closed e depende somente do ambiente", () => {
  const a = process.env.TELEGRAM_ALLOWED_USER_IDS;
  const b = process.env.TELEGRAM_ALLOWED_USERS;
  try {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ALLOWED_USERS;
    assert.equal(isUserAllowed("888111222"), false);
    process.env.TELEGRAM_ALLOWED_USER_IDS = "888111222,777000333";
    assert.equal(isUserAllowed("888111222"), true);
    assert.equal(isUserAllowed("999000111"), false);
  } finally {
    if (a === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = a;
    if (b === undefined) delete process.env.TELEGRAM_ALLOWED_USERS; else process.env.TELEGRAM_ALLOWED_USERS = b;
  }
});

test("update_id duplicado é processado uma única vez por instância", () => {
  const id = Math.floor(Math.random() * 1_000_000_000) + 1;
  assert.equal(shouldProcessTelegramUpdate(id, 1000), true);
  assert.equal(shouldProcessTelegramUpdate(id, 1001), false);
  assert.equal(shouldProcessTelegramUpdate(undefined, 1002), true);
});

test("contrato V2 remove CRUD livre e edição implícita de preço", () => {
  const source = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /categoriesRepository/);
  assert.doesNotMatch(source, /\.addCategory\(/);
  assert.doesNotMatch(source, /\.renameCategory\(/);
  assert.doesNotMatch(source, /getLatestPendingReviewForUser\(senderId, chatId\)/);
  assert.match(source, /parseTelegramCommand\(text\)/);
  assert.match(source, /userState\?\.action === "awaiting_price"/);
});
''', encoding='utf-8')

Path('tests/telegramPanelV2.test.ts').write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { renderApproved, renderCategories, TELEGRAM_PANEL_COMMANDS } from "../server/services/telegramPanel";
import * as telegramRepo from "../server/repositories/telegramRepository";
import type { PendingReview } from "../server/services/telegramTypes";

const publishedFixture: PendingReview = {
  id: "review-v2-published",
  chatId: 1,
  senderId: 1,
  firstName: "Teste",
  username: "N/A",
  createdAt: Date.now(),
  produto: "Produto publicado pelo teste",
  categoria: "Iluminação",
  preco: 10,
  imagens: ["https://example.com/item.jpg"],
  normalizedUrl: "https://example.com/item",
  status: "published",
};

test("/aprovados consulta status published em vez da fila pending", async () => {
  telegramRepo.setTestListReviewsByStatus(async statuses => {
    assert.deepEqual(statuses, ["published"]);
    return [publishedFixture];
  });
  try {
    const text = await renderApproved();
    assert.match(text, /Produto publicado pelo teste/);
    assert.match(text, /Decisões recentes/i);
  } finally {
    telegramRepo.setTestListReviewsByStatus(null);
  }
});

test("menu BotFather é compacto e descrições refletem o V2", () => {
  assert.ok(TELEGRAM_PANEL_COMMANDS.length <= 16);
  const shopee = TELEGRAM_PANEL_COMMANDS.find(item => item.command === "shopee");
  const categorias = TELEGRAM_PANEL_COMMANDS.find(item => item.command === "categorias");
  assert.ok(shopee && !/em breve/i.test(shopee.description));
  assert.ok(categorias && /taxonomia/i.test(categorias.description));
});

test("/categorias expõe taxonomia pública sem controles de criação", async () => {
  const text = await renderCategories();
  assert.match(text, /TAXONOMIA PÚBLICA/i);
  assert.match(text, /Iluminação/);
  assert.match(text, /Cozinha & Mesa/);
  assert.doesNotMatch(text, /Adicionar Categoria|Renomear Categoria/i);
});
''', encoding='utf-8')
# validation trigger: global V2 contracts migrated
