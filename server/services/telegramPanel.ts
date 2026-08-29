import { getTelegramWebhookDiagnostics } from "./telegramDiagnostics";
import { telegramApiFetch, getTelegramBotToken } from "./telegramApiClient";
import {
  PRIMARY_TELEGRAM_COMMANDS,
  SECONDARY_TELEGRAM_COMMANDS,
  renderAdvancedCommandHelp,
  renderPrimaryCommandHelp,
} from "./telegramCommands";
import * as telegramRepo from "../repositories/telegramRepository";
import * as productsRepository from "../repositories/productsRepository";
import {
  PUBLIC_PRODUCT_CATEGORIES,
  resolvePublicProductCategory,
} from "../../src/lib/productCategory";
import {
  evaluateWeeklyRuntimePreflight,
  type WeeklyRuntimePreflight,
} from "./newsletterWeeklyRuntimePreflight";

/**
 * Contrato completo do painel. Inclui comandos secundários por compatibilidade,
 * enquanto o menu nativo registrado no Telegram permanece enxuto.
 */
export const TELEGRAM_PANEL_COMMANDS = [
  ...PRIMARY_TELEGRAM_COMMANDS,
  ...SECONDARY_TELEGRAM_COMMANDS,
].map(item => ({ ...item }));

export async function registerTelegramCommands(): Promise<{ ok: boolean; reason?: string }> {
  if (!getTelegramBotToken()) {
    return { ok: false, reason: "TELEGRAM_BOT_TOKEN ausente; menu não registrado" };
  }
  try {
    const commands = PRIMARY_TELEGRAM_COMMANDS.map(({ command, description }) => ({ command, description }));
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
  return (
    "🧭 <b>MENU PRINCIPAL</b>\n\n" +
    renderPrimaryCommandHelp() +
    "\n\n🛡️ <b>REGRA OPERACIONAL</b>\nDECISION ≠ ACTION · PREVIEW ≠ PUBLICATION. Ações sensíveis exigem confirmação humana."
  );
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

export function renderWeeklyRuntimePreflight(preflight: WeeklyRuntimePreflight): string {
  const weeklyState = preflight.weeklyProductionEnabled ? "ATIVADA ❌" : "DESATIVADA ✅";
  const configured = preflight.testEmailConfigured ? "CONFIGURADO ✅" : "AUSENTE ❌";
  const valid = preflight.testEmailValid ? "VÁLIDO ✅" : "INVÁLIDO ❌";
  const brevoConfigured = preflight.brevoApiKeyPresent ? "CONFIGURADO ✅" : "AUSENTE ❌";
  const providerReady = preflight.brevoMarketingProviderReady ? "MARKETING CAMPAIGN ✅" : "NÃO PRONTO ❌";
  const subscribers = preflight.eligibleSubscribers === null ? "indisponível" : String(preflight.eligibleSubscribers);
  const ready = preflight.readyForTest ? "PRONTO ✅" : "BLOQUEADO ❌";
  const automatic = preflight.weeklyProductionEnabled ? "NÃO BLOQUEADO ❌" : "BLOQUEADO ✅";
  const masked = preflight.testEmailMasked ? ` (${preflight.testEmailMasked})` : "";

  return (
    "🛡️ <b>Cerberus Weekly — Preflight</b>\n" +
    `Produção semanal: <b>${weeklyState}</b>\n` +
    `Email de teste: <b>${configured}</b>${masked}\n` +
    `Formato do email: <b>${valid}</b>\n` +
    `Brevo: <b>${brevoConfigured}</b>\n` +
    `Provider: <b>${providerReady}</b>\n` +
    `Subscribers elegíveis: <b>${subscribers}</b>\n` +
    `Modo de teste: <b>${ready}</b>\n` +
    `Envio automático: <b>${automatic}</b>\n\n` +
    "Read-only · nenhum secret, campaign, recipient ou envio foi criado."
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

  const weeklyPreflight = await evaluateWeeklyRuntimePreflight();

  return (
    "🩺 <b>STATUS READ-ONLY</b>\n" +
    `Produtos: <b>${productsCount}</b> · ativos: <b>${activeCount}</b>\n` +
    `Pendentes: <b>${pendingCount}</b>\n` +
    `Telegram: ${telegramDiag}\n\n` +
    renderWeeklyRuntimePreflight(weeklyPreflight) +
    "\n\nNenhuma alteração foi executada."
  );
}

export async function renderPendingReviews(): Promise<string> {
  try {
    const reviews = await telegramRepo.listPendingReviews(25);
    if (!reviews.length) return "⏳ <b>PENDENTES</b>\n\nNenhuma revisão pendente no momento.";
    return (
      `⏳ <b>PENDENTES — ${reviews.length}</b>\n\n` +
      reviews.map(review => `• <code>${review.id}</code> · ${review.produto || review.rawTitle || "Produto sem título"}`).join("\n") +
      "\n\nUse /publicar &lt;review_id&gt; para encaminhar uma decisão ao card de confirmação."
    );
  } catch {
    return "⏳ <b>PENDENTES</b>\n\nFila indisponível para leitura agora; nenhuma alteração foi executada.";
  }
}

export async function renderApproved(): Promise<string> {
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
      : published.map((review, index) => `${index + 1}. ${String(review.produto || "(sem nome)").slice(0, 44)}`).join("\n");

  const catalogText = activeProducts === null
    ? "não disponível"
    : activeProducts.length === 0
      ? "catálogo vazio"
      : activeProducts.slice(0, 15).map(product => `• <code>${product.ref}</code> · ${String(product.produto).slice(0, 44)}`).join("\n") +
        (activeProducts.length > 15 ? `\n… +${activeProducts.length - 15}` : "");

  return (
    "✅ <b>APROVADOS / PUBLICADOS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    `<b>Decisões recentes</b>\n${reviewText}\n\n` +
    `<b>Catálogo ativo</b>\n${catalogText}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Read-only · nenhum estado foi alterado."
  );
}

export async function renderProducts(): Promise<string> {
  try {
    const products = await productsRepository.getProducts();
    if (!products.length) return "📦 <b>PRODUTOS</b>\n\nNenhum produto cadastrado.";
    const active = products.filter(product => product.ativo !== false).length;
    const paused = products.length - active;
    return (
      `📦 <b>PRODUTOS — ${products.length}</b>\n` +
      `🟢 Ativos: <b>${active}</b> · ⏸️ Pausados: <b>${paused}</b>\n\n` +
      products.slice(0, 30).map(product => `${product.ativo !== false ? "🟢" : "⏸️"} <code>${product.ref}</code> · ${product.produto}`).join("\n")
    );
  } catch {
    return "📦 <b>PRODUTOS</b>\n\nCatálogo indisponível para leitura agora.";
  }
}

export async function renderCategories(): Promise<string> {
  try {
    const products = await productsRepository.getProducts();
    const counts = new Map<string, number>();
    for (const product of products) {
      const category = resolvePublicProductCategory(product.categoria) || "Sem categoria pública";
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    return (
      "📁 <b>CATEGORIAS</b>\n\n" +
      PUBLIC_PRODUCT_CATEGORIES.map(category => `• ${category}: <b>${counts.get(category) || 0}</b>`).join("\n")
    );
  } catch {
    return "📁 <b>CATEGORIAS</b>\n\nTaxonomia indisponível para leitura agora.";
  }
}
