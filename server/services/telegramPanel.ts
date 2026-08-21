/**
 * N17 — FASE 25B — COMMIT 1 — TELEGRAM READ PANEL
 * Painel operacional de LEITURA para o Telegram.
 *
 * REGRAS DE SEGURANÇA (contrato desta fase):
 * - ZERO escrita no Supabase causada por qualquer função deste módulo.
 * - ZERO chamada de publication, N16 execute, N17 acquisition, syncCatalogAndDeploy.
 * - ZERO alteração de produto, PendingReview, lifecycle ou governança.
 * - Dados ausentes são reportados explicitamente como "não disponível".
 * - Nenhuma credencial, token ou valor sensível é logado ou embutido aqui.
 */
import { getTelegramWebhookDiagnostics } from "./telegramDiagnostics";
import { telegramApiFetch, getTelegramBotToken } from "./telegramBot";
import * as telegramRepo from "../repositories/telegramRepository";
import * as productsRepository from "../repositories/productsRepository";

// ---------------------------------------------------------------
// setMyCommands — registro dos comandos no BotFather
// ---------------------------------------------------------------
/**
 * Lista canônica de comandos registrados no Telegram.
 * /shopee e /publicar aparecem no menu MAS o dispatcher responde
 * "ainda não disponíveis" — nenhum comportamento parcial é criado.
 */
export const TELEGRAM_PANEL_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Iniciar o bot" },
  { command: "menu", description: "Menu consolidado de comandos" },
  { command: "status", description: "Status geral do sistema (somente leitura)" },
  { command: "pendentes", description: "Propostas pendentes de decisão" },
  { command: "aprovados", description: "Reviews aprovadas e catálogo atual" },
  { command: "shopee", description: "Lote Shopee (em breve)" },
  { command: "publicar", description: "Encaminhar review à publicação (em breve)" },
  { command: "listar", description: "Listar produtos do catálogo" },
  { command: "produtos", description: "Catálogo de produtos" },
  { command: "categorias", description: "Gestão de categorias" },
  { command: "discover", description: "Descobrir produtos por URL ou busca" },
  { command: "discover-batch", description: "Descoberta em lote" },
  { command: "research", description: "Pesquisa de candidato" },
  { command: "assess", description: "Avaliação de candidato" },
  { command: "priority", description: "Painel de prioridades" },
  { command: "opportunities", description: "Oportunidades comerciais" },
  { command: "risks", description: "Painel de riscos" },
  { command: "experiments", description: "Experiments registrados" },
  { command: "agents", description: "Agentes registrados" },
  { command: "decisions", description: "Decisões registradas" },
  { command: "recommendations", description: "Recomendações do brain" },
  { command: "affiliates", description: "Registry de links afiliados" },
  { command: "cycle", description: "Estado do ciclo comercial" },
  { command: "help", description: "Ajuda e acesso rápido" },
];

/**
 * Chamada Telegram setMyCommands. Fail-safe: qualquer falha da API do
 * Telegram é logada (sem credenciais) e NUNCA derruba o processo principal.
 * A aplicação é webhook-only e o bot continua operando mesmo sem menu registrado.
 */
export async function registerTelegramCommands(): Promise<{ ok: boolean; reason?: string }> {
  if (!getTelegramBotToken()) {
    return { ok: false, reason: "TELEGRAM_BOT_TOKEN ausente; menu não registrado (bot inoperante)" };
  }
  try {
    const commands = TELEGRAM_PANEL_COMMANDS.map(({ command, description }) => ({ command, description }));
    const res = await telegramApiFetch("setMyCommands", { commands });
    const result = await res.json();
    if (result?.ok === true) {
      return { ok: true };
    }
    return { ok: false, reason: typeof result?.description === "string" ? result.description : "unknown_error" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "unknown_error" };
  }
}

// ---------------------------------------------------------------
// /menu — menu consolidado (read-only)
// ---------------------------------------------------------------
export function renderReadPanelMenu(): string {
  return (
    "🛡️ <b>CERBERUS FINDS — MENU CONSOLIDADO</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🧭 <b>PAINEL OPERACIONAL</b>\n" +
    "/status — status geral do sistema\n" +
    "/pendentes — propostas aguardando decisão\n" +
    "/aprovados — aprovadas e catálogo atual\n\n" +
    "📦 <b>CATÁLOGO</b>\n" +
    "/listar · /produtos · /categorias\n\n" +
    "🔎 <b>DESCOBERTA E ANÁLISE</b>\n" +
    "/discover · /discover-batch\n" +
    "/research · /assess\n" +
    "/priority · /opportunities · /risks\n\n" +
    "🧠 <b>COMERCIAL E GOVERNANÇA</b>\n" +
    "/experiments · /agents · /decisions\n" +
    "/recommendations · /affiliates · /cycle\n\n" +
    "🛒 <b>SHOPEE AFFILIATE (PREVIEW)</b>\n" +
    "/shopee — em breve\n" +
    "/publicar — em breve\n\n" +
    "/start · /help\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "DECISION ≠ ACTION · nada é publicado sem decisão humana."
  );
}

// ---------------------------------------------------------------
// /status — contagens existentes + diagnóstico Telegram (read-only)
// ---------------------------------------------------------------
/**
 * Agrega somente dados que já têm repositório/serviço existente.
 * Nenhum componente é chamado com efeito colateral; se algum estiver
 * indisponível, o valor é reportado como "não disponível".
 */
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
    productsCount = "não disponível";
    activeCount = "não disponível";
  }

  try {
    const pending = await telegramRepo.listPendingReviews(20);
    pendingCount = String(Array.isArray(pending) ? pending.length : 0);
  } catch {
    pendingCount = "não disponível";
  }

  try {
    const diag = await getTelegramWebhookDiagnostics();
    telegramDiag =
      `🔑 token: ${diag?.tokenConfigured === true ? "configurado" : "ausente"} · ` +
      `🛡️ whitelist: ${diag?.whitelistConfigured === true ? "ok" : "ausente"} · ` +
      `🔗 webhook: ${diag?.webhookConfigured === true ? "configurado" : "não configurado"} · ` +
      `💚 api: ${diag?.apiHealthy === true ? "saudável" : "indisponível"}`;
  } catch {
    telegramDiag = "não disponível";
  }

  return (
    "🛡️ <b>CERBERUS FINDS — STATUS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    `📦 Catálogo: <b>${productsCount}</b> produtos (${activeCount} ativos)\n` +
    `⏳ Propostas pendentes: <b>${pendingCount}</b>\n` +
    `🤖 Telegram: ${telegramDiag}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Painel de leitura — nenhum estado foi alterado."
  );
}

// ---------------------------------------------------------------
// /pendentes — listPendingReviews existente (read-only)
// ---------------------------------------------------------------
/**
 * Usa telegramRepo.listPendingReviews, que já filtra status='pending'.
 * Registros expirados são lidos como o próprio repositório os classifica —
 * este módulo não altera nem reclassifica nenhum registro.
 */
export async function renderPendingReviews(): Promise<string> {
  try {
    const pending = await telegramRepo.listPendingReviews(20);
    if (!Array.isArray(pending) || pending.length === 0) {
      return "⏳ <b>NENHUMA PROPOSTA PENDENTE</b>\n\nNão há PendingReviews com status=pending no momento.";
    }
    const lines = pending.map((r, i) => {
      const nome = typeof r.produto === "string" && r.produto.trim() ? r.produto.slice(0, 40) : "(sem nome)";
      const status = typeof r.status === "string" && r.status ? r.status : "pending";
      return `<b>${i + 1}.</b> ${nome}\n   status: <code>${status}</code>`;
    });
    return "⏳ <b>PROPOSTAS PENDENTES</b>\n\n" + lines.join("\n\n") + "\n\nUse o card no Telegram para decidir (✅ PUBLICAR · ❌ DESCARTAR).";
  } catch {
    return "⚠️ <b>ERRO DE INFRAESTRUTURA</b>\n\nNão foi possível consultar as propostas pendentes (leitura falhou). Nenhum dado foi alterado.";
  }
}

// ---------------------------------------------------------------
// /aprovados — reviews publicadas + catálogo canônico (read-only)
// ---------------------------------------------------------------
/**
 * Limitação documentada: a tabela telegram_pending_reviews não possui um
 * estado "aprovado e encaminhado à publicação" além de status='published'
 * (decisão humana registrada via approve_only). Portanto este comando
 * mostra os dois conjuntos com rótulos explícitos, sem inventar estado:
 * - "DECISÕES HUMANAS REGISTRADAS" = reviews com status=published
 * - "CATÁLOGO CANÔNICO" = produtos ativos do Supabase
 */
export async function renderApproved(): Promise<string> {
  let publishedReviews = "não disponível";
  let catalog = "não disponível";

  try {
    const reviews = await telegramRepo.listPendingReviews(50);
    const published = Array.isArray(reviews) ? reviews.filter(r => r.status === "published") : [];
    publishedReviews = published.length === 0
      ? "nenhuma decisão registrada ainda"
      : published.map((r, i) => {
          const nome = typeof r.produto === "string" && r.produto.trim() ? r.produto.slice(0, 40) : "(sem nome)";
          return `<b>${i + 1}.</b> ${nome}`;
        }).join("\n");
  } catch {
    publishedReviews = "não disponível";
  }

  try {
    const products = await productsRepository.getProducts();
    const active = Array.isArray(products) ? products.filter(p => p.ativo !== false) : [];
    catalog = active.length === 0
      ? "catálogo vazio"
      : active.map(p => `• ${String(p.produto).slice(0, 40)}`).join("\n");
  } catch {
    catalog = "não disponível";
  }

  return (
    "✅ <b>APROVADOS</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "📋 <b>DECISÕES HUMANAS REGISTRADAS</b>\n" +
    `(reviews com status=published)\n${publishedReviews}\n\n` +
    "📦 <b>CATÁLOGO CANÔNICO ATIVO</b>\n" +
    `(produtos ativos no Supabase)\n${catalog}\n` +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Painel de leitura — nenhum estado foi alterado."
  );
}
