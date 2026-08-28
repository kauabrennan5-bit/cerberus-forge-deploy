import { getTelegramWebhookDiagnostics } from "./telegramDiagnostics";
import { telegramApiFetch, getTelegramBotToken } from "./telegramApiClient";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  renderAdvancedCommandHelp,
  renderPrimaryCommandHelp,
} from "./telegramCommands";
import * as telegramRepo from "../repositories/telegramRepository";
import * as productsRepository from "../repositories/productsRepository";
import {
  PUBLIC_PRODUCT_CATEGORIES,
  resolvePublicProductCategory,
} from "../../src/lib/productCategory";

/** Menu nativo: só comandos que realmente precisam estar à mão. */
export const TELEGRAM_PANEL_COMMANDS = PRIMARY_TELEGRAM_COMMANDS.map(item => ({ ...item }));

export async function registerTelegramCommands(): Promise<{ ok: boolean; reason?: string }> {
  if (!getTelegramBotToken()) {
    return { ok: false, reason: "TELEGRAM_BOT_TOKEN ausente; menu não registrado" };
  }
  try {
    const commands = TELEGRAM_PANEL_COMMANDS.map(({ command, description }) => ({ command, description }));
    const res = await telegramApiFetch("setMyCommands", { commands });
    const result = await res.json();
    if (result?.ok === true) return { ok: true };
    return {
      ok: false,
      reason: typeof result?.description === "string" ? result.description : "unknown_error",
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown_error" };
  }
}

export function renderReadPanelMenu(): string {
  return "🧭 <b>MENU PRINCIPAL</b>\n\n" + renderPrimaryCommandHelp();
}

export function renderAdvancedPanel(): string {
  return renderAdvancedCommandHelp();
}

export async function renderToday(): Promise<string> {
  let summary: any = null;
  let pendingCount: number | null = null;

  try {
    summary = await productsRepository.getAnalyticsSummary();
  } catch {
    summary = null;
  }

  try {
    pendingCount = (await telegramRepo.listPendingReviews(50)).length;
  } catch {
    pendingCount = null;
  }

  const total = summary?.totalProducts ?? "?";
  const active = summary?.activeProducts ?? "?";
  const todayClicks = summary?.todayClicks ?? "?";
  const clicks7d = summary?.clicks7d ?? "?";
  const topName = Array.isArray(summary?.topProducts) && summary.topProducts[0]?.name
    ? String(summary.topProducts[0].name).slice(0, 48)
    : "sem dados ainda";

  let priority = "Verifique /status antes da próxima ação.";
  if (typeof pendingCount === "number" && pendingCount > 0) {
    priority = `Revisar <b>${pendingCount}</b> proposta(s) em /pendentes.`;
  } else if (typeof active === "number" && active === 0) {
    priority = "O catálogo não tem produtos ativos; revise /produtos.";
  } else if (summary) {
    priority = "Fila humana limpa. Próximo passo: acompanhar /analytics ou descobrir novos itens.";
  }

  return (
    "⚡ <b>CERBERUS — AGORA</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    `📦 Catálogo: <b>${active}/${total}</b> ativos\n` +
    `⏳ Pendentes: <b>${pendingCount ?? "?"}</b>\n` +
    `👆 Cliques hoje: <b>${todayClicks}</b> · 7d: <b>${clicks7d}</b>\n` +
    `🏆 Destaque recente: <i>${topName}</i>\n\n` +
    `🎯 <b>Prioridade:</b> ${priority}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Resumo read-only; nenhuma ação foi executada."
  );
}

export async function renderStatus(): Promise<string> {
  let productsCount = "não disponível";
  let activeCount = "não disponível";
  let pendingCount = "não disponível";
  let telegramDiag = "não disponível";

  try {
    const products = await productsRepository.getProducts();
    if (Array.isArray(products)) {
      productsCount = String(products.length);
      activeCount = String(products.filter(p => p.ativo !== false).length);
    }
  } catch {
    // explicit unavailable state below
  }

  try {
    const pending = await telegramRepo.listPendingReviews(50);
    pendingCount = String(Array.isArray(pending) ? pending.length : 0);
  } catch {
    // explicit unavailable state below
  }

  try {
    const diag = await getTelegramWebhookDiagnostics();
    telegramDiag =
      `token ${diag?.tokenConfigured === true ? "✅" : "❌"} · ` +
      `whitelist ${diag?.whitelistConfigured === true ? "✅" : "❌"} · ` +
      `webhook ${diag?.webhookMatchesExpectedUrl === true ? "✅" : "⚠️"} · ` +
      `API ${diag?.apiHealthy === true ? "✅" : "❌"} · ` +
      `secret ${diag?.secretConfigured === true ? "✅" : "⚠️"}`;
  } catch {
    // explicit unavailable state below
  }

  return (
    "🩺 <b>CERBERUS — STATUS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    `📦 Produtos: <b>${productsCount}</b> (${activeCount} ativos)\n` +
    `⏳ Pendentes: <b>${pendingCount}</b>\n` +
    `🤖 Telegram: ${telegramDiag}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Read-only · nenhum estado foi alterado."
  );
}

export async function renderPendingReviews(): Promise<string> {
  try {
    const pending = await telegramRepo.listPendingReviews(20);
    if (!Array.isArray(pending) || pending.length === 0) {
      return "✅ <b>FILA LIMPA</b>\n\nNenhuma proposta pendente no momento.";
    }
    const lines = pending.map((review, index) => {
      const name = typeof review.produto === "string" && review.produto.trim()
        ? review.produto.slice(0, 44)
        : "(sem nome)";
      const price = Number.isFinite(review.preco) && review.preco > 0
        ? `R$ ${review.preco.toFixed(2).replace(".", ",")}`
        : "preço pendente";
      return `${index + 1}. <b>${name}</b>\n   <code>${review.id}</code> · ${price}`;
    });
    return (
      `⏳ <b>PENDENTES — ${pending.length}</b>\n\n` +
      lines.join("\n\n") +
      "\n\nUse o card da review ou <code>/publicar &lt;ID&gt;</code>. A publicação continua exigindo confirmação humana."
    );
  } catch {
    return "⚠️ <b>FILA INDISPONÍVEL</b>\n\nA leitura falhou; nenhum dado foi alterado.";
  }
}

export async function renderApproved(): Promise<string> {
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
      : published.map((review, index) => `${index + 1}. ${String(review.produto || "(sem nome)").slice(0, 44)}`).join("\n");

  const catalogText = activeProducts === null
    ? "não disponível"
    : activeProducts.length === 0
      ? "catálogo vazio"
      : activeProducts.slice(0, 10).map(product => `• ${String(product.produto).slice(0, 44)}`).join("\n") +
        (activeProducts.length > 10 ? `\n… +${activeProducts.length - 10}` : "");

  return (
    "✅ <b>APROVADOS / PUBLICADOS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    `<b>Decisões recentes</b>\n${reviewText}\n\n` +
    `<b>Catálogo ativo</b>\n${catalogText}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Read-only · nenhum estado foi alterado."
  );
}

export async function renderCategories(): Promise<string> {
  const counts = new Map(PUBLIC_PRODUCT_CATEGORIES.map(category => [category, 0]));
  let invalidCount = 0;

  try {
    const products = await productsRepository.getProducts();
    for (const product of products) {
      if (product.ativo === false) continue;
      const category = resolvePublicProductCategory(product.categoria, {
        title: product.displayTitle || product.rawTitle || product.produto,
        description: product.descricao,
      });
      if (category && counts.has(category)) counts.set(category, (counts.get(category) || 0) + 1);
      else invalidCount += 1;
    }
  } catch {
    return "⚠️ <b>CATEGORIAS INDISPONÍVEIS</b>\n\nNão foi possível ler o catálogo. Nenhuma categoria foi alterada.";
  }

  const rows = PUBLIC_PRODUCT_CATEGORIES.map(category => `• <b>${category}</b> — ${counts.get(category) || 0}`);
  return (
    "🏷️ <b>TAXONOMIA PÚBLICA</b>\n\n" +
    rows.join("\n") +
    (invalidCount > 0 ? `\n\n⚠️ Produtos ativos fora da taxonomia: <b>${invalidCount}</b>` : "") +
    "\n\nCategorias são canônicas: o bot não cria nem renomeia categorias livremente."
  );
}
