import path from "path";
import fs from "fs";
import { fetchProductDataFromUrl } from "./scraper";
import * as productsRepository from "../repositories/productsRepository";
import * as categoriesRepository from "../repositories/categoriesRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import * as googleAnalytics from "./googleAnalytics";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export function isUserAllowed(userId: string | number): boolean {
  const allowedEnv = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "1976526372";
  const allowedIds = allowedEnv.split(",").map(id => id.trim()).filter(Boolean);
  return allowedIds.includes(String(userId));
}

export async function sendTelegramMessage(chatId: number | string, text: string, replyMarkup?: any): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload: any = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error("Erro ao enviar mensagem Telegram:", err);
  }
}

export async function sendTelegramPhoto(chatId: number | string, photoUrl: string, caption: string, replyMarkup?: any): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload: any = {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: "HTML"
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`${TELEGRAM_API_BASE}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error("Erro ao enviar foto Telegram:", err);
  }
}

export async function editTelegramMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: any): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "HTML"
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`${TELEGRAM_API_BASE}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error("Erro ao editar texto Telegram:", err);
  }
}

export async function editTelegramMessageCaption(chatId: number | string, messageId: number, caption: string, replyMarkup?: any): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload: any = {
      chat_id: chatId,
      message_id: messageId,
      caption: caption,
      parse_mode: "HTML"
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(`${TELEGRAM_API_BASE}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error("Erro ao editar legenda Telegram:", err);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert: boolean = false): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const payload: any = {
      callback_query_id: callbackQueryId,
      show_alert: showAlert
    };
    if (text) payload.text = text;
    await fetch(`${TELEGRAM_API_BASE}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Erro ao responder callback query:", err);
  }
}

function detectMarketplace(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("shopee")) return "Shopee";
  if (lower.includes("mercadolivre") || lower.includes("mercadolado") || lower.includes("mercadol")) return "Mercado Livre";
  return "Outros";
}

function parseAndNormalizePrice(input: string): number | null {
  if (!input) return null;
  let clean = input.replace(/[^0-9,.]/g, "").trim();
  if (!clean) return null;
  if (clean.includes(",") && clean.includes(".")) {
    if (clean.indexOf(",") > clean.indexOf(".")) {
      clean = clean.replace(".", "").replace(",", ".");
    } else {
      clean = clean.replace(",", "");
    }
  } else if (clean.includes(",")) {
    clean = clean.replace(",", ".");
  }
  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

export interface PendingReview {
  id: string;
  chatId: number;
  senderId: number | string;
  firstName: string;
  username: string;
  createdAt: number;
  expiresAt?: number;
  produto: string;
  categoria: string;
  preco: number;
  imagens: string[];
  normalizedUrl: string;
  descricao?: string;
  status?: "pending" | "published" | "cancelled";
  cardMessageId?: number;
  existingProduct?: any;
}

function buildReviewCardText(review: PendingReview): string {
  const precoStr = review.preco && review.preco > 0 ? `R$ ${review.preco.toFixed(2).replace(".", ",")}` : "⚠️ <i>Não detectado (Definir abaixo)</i>";
  return `🛡️ <b>CERBERUS FINDS — PAINEL DE REVISÃO</b>\n\n` +
         `🏷️ <b>Produto:</b> ${review.produto}\n` +
         `📁 <b>Categoria:</b> ${review.categoria}\n` +
         `💰 <b>Preço:</b> ${precoStr}\n` +
         `🔗 <b>Link:</b> <code>${review.normalizedUrl}</code>\n\n` +
         `<i>Revise os dados abaixo antes de confirmar a publicação:</i>`;
}

function buildMainReviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Confirmar & Publicar", callback_data: `confirm_pub:${reviewId}` }],
      [
        { text: "💰 Alterar Preço", callback_data: `edit_price:${reviewId}` },
        { text: "📁 Alterar Categoria", callback_data: `edit_cat:${reviewId}` }
      ],
      [{ text: "❌ Cancelar", callback_data: `cancel_rev:${reviewId}` }]
    ]
  };
}

async function extractProductForReview(url: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const scraped = await fetchProductDataFromUrl(url);
    if (!scraped || !scraped.success) {
      return { success: false, error: scraped?.error || "Falha ao extrair dados do link." };
    }
    return {
      success: true,
      data: {
        produto: scraped.title || "Produto Cerberus",
        categoria: scraped.category || "Acessórios",
        preco: Number(scraped.price) || 0,
        imagens: scraped.images && scraped.images.length > 0 ? scraped.images : ["https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=800&q=80"],
        normalizedUrl: url,
        descricao: scraped.description || ""
      }
    };
  } catch (err: any) {
    return { success: false, error: err?.message || "Erro interno no scraper." };
  }
}

function logAndValidateReviewCallback(
  actionName: string,
  reviewId: string,
  chatId: string | number | undefined,
  review: PendingReview | null
): { valid: boolean; reason?: string } {
  const statusStr = review ? (review.status || "pending") : "não localizada";
  let valid = true;
  let reason = "OK";
  if (!review) {
    valid = false;
    reason = "Revisão não localizada no sistema.";
  } else if (statusStr === "published") {
    valid = false;
    reason = "Esta revisão já foi publicada.";
  } else if (statusStr === "cancelled") {
    valid = false;
    reason = "Esta revisão foi cancelada.";
  }
  return { valid, reason };
}

/**
 * Renderizador do Menu Principal /start e /admin
 */
async function renderMainMenu(chatId: number | string, messageId?: number, isEdit: boolean = false): Promise<void> {
  const text = 
    "🏛️ <b>CERBERUS FINDS</b>\n" +
    "<b>Painel Administrativo</b>\n\n" +
    "Selecione uma opção abaixo:";

  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ Adicionar produto", callback_data: "admin_add" }, { text: "📋 Produtos", callback_data: "products_list:0" }],
      [{ text: "🔎 Buscar produto", callback_data: "products_search_init" }, { text: "📊 Visão geral", callback_data: "analytics_overview" }],
      [{ text: "🎯 Analytics por produto", callback_data: "analytics_products:0" }, { text: "🏷️ Categorias", callback_data: "admin_categories" }],
      [{ text: "⭐ Destaques", callback_data: "admin_highlights" }, { text: "🩺 Status do sistema", callback_data: "admin_system" }]
    ]
  };

  if (isEdit && messageId) {
    await editTelegramMessageText(chatId, messageId, text, keyboard);
  } else {
    await sendTelegramMessage(chatId, text, keyboard);
  }
}

/**
 * Processador Principal de Updates do Webhook (Texto + Callback Queries)
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!update) return;

  // 1. CALLBACK QUERIES
  if (update.callback_query) {
    const cb = update.callback_query;
    const callbackId = cb.id;
    const senderId = cb.from?.id || "Desconhecido";
    const data: string = cb.data || "";
    const msg = cb.message;
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;

    if (!isUserAllowed(senderId)) {
      await answerCallbackQuery(callbackId, "🔒 Acesso não autorizado.", true);
      return;
    }

    // --- NAMESPACE: ADMIN / MENU ---
    if (data === "admin_menu" || data === "admin_back") {
      await answerCallbackQuery(callbackId);
      if (chatId && messageId) await renderMainMenu(chatId, messageId, true);
      return;
    }

    if (data === "admin_system") {
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const gaStatus = googleAnalytics.getGA4Status();
      const gaApiStr = gaStatus.isConfigured ? "🟢 Configurada" : "⚪ Não configurada";
      const text = "🩺 <b>STATUS DO SISTEMA</b>\n\n" +
                   "Backend 🟢\n" +
                   "Supabase 🟢\n" +
                   "Telegram 🟢\n" +
                   "API 🟢\n" +
                   "Site 🟢\n" +
                   "Analytics operacional 🟢\n" +
                   "GA4 Data API " + gaApiStr + "\n\n" +
                   "📦 Produtos cadastrados: <b>" + products.length + "</b>\n" +
                   "🕒 Atualizado: <b>" + new Date().toLocaleString("pt-BR") + "</b>";
      const keyboard = { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "admin_menu" }]] };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data === "admin_highlights") {
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const highlights = products.filter(p => p.destaque);
      let text = `⭐ <b>DESTAQUES DO CATÁLOGO</b>\nTotal em destaque: <b>${highlights.length}</b>\n\n`;
      const buttons = [];
      for (const p of highlights.slice(0, 10)) {
        text += `• <code>${p.ref}</code> - ${p.produto}\n`;
        buttons.push([{ text: `✏️ ${p.ref}`, callback_data: `product_edit:${p.id}` }]);
      }
      buttons.push([{ text: "⬅️ Voltar", callback_data: "admin_menu" }]);
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data === "admin_categories") {
      await answerCallbackQuery(callbackId);
      const cats = await categoriesRepository.getCategories();
      let text = "🏷️ <b>GERENCIAR CATEGORIAS</b>\n\n";
      const buttons = [];
      for (const c of cats) {
        text += `• ${c.name}\n`;
        buttons.push([{ text: `✏️ Renomear ${c.name}`, callback_data: `rename_cat_init:${c.name}` }]);
      }
      buttons.push([{ text: "➕ Adicionar Categoria", callback_data: "add_cat_init" }]);
      buttons.push([{ text: "⬅️ Voltar", callback_data: "admin_menu" }]);
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data === "admin_add") {
      await answerCallbackQuery(callbackId);
      if (chatId) {
        await sendTelegramMessage(chatId, "➕ <b>ADICIONAR NOVO PRODUTO</b>\n\nEnvie o link de um produto da Shopee ou Mercado Livre para iniciar a extração automática por IA e revisão.");
      }
      return;
    }

    // --- NAMESPACE: PRODUCTS ---
    if (data.startsWith("products_list:")) {
      const page = parseInt(data.split(":")[1]) || 0;
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const pageSize = 5;
      const start = page * pageSize;
      const end = start + pageSize;
      const paged = products.slice(start, end);
      const total = products.length;
      const actives = products.filter(p => p.ativo !== false).length;
      const inactives = total - actives;

      let text = `📋 <b>CATÁLOGO DE PRODUTOS</b>\n\n` +
                 `• Total: <b>${total}</b>\n` +
                 `• Ativos: <b>${actives}</b>\n` +
                 `• Pausados: <b>${inactives}</b>\n\n` +
                 `Exibindo pág ${page + 1} de ${Math.ceil(total / pageSize) || 1}:\n\n`;

      const buttons = [];
      for (const p of paged) {
        const statusEmoji = p.ativo !== false ? "🟢" : "⏸️";
        text += `${statusEmoji} <b>${p.produto.slice(0, 32)}</b>\n` +
                `REF: <code>${p.ref}</code> | R$ ${p.preco.toFixed(2).replace(".", ",")}\n\n`;
        
        buttons.push([
          { text: `👁️ ${p.ref}`, callback_data: `product_view:${p.id}` },
          { text: `✏️ Editar`, callback_data: `product_edit:${p.id}` },
          { text: p.ativo !== false ? "⏸️ Pausar" : "🟢 Ativar", callback_data: `product_toggle:${p.id}` }
        ]);
      }

      const navRow = [];
      if (page > 0) navRow.push({ text: "◀️ Anterior", callback_data: `products_list:${page - 1}` });
      if (end < total) navRow.push({ text: "Próxima ▶️", callback_data: `products_list:${page + 1}` });
      if (navRow.length > 0) buttons.push(navRow);

      buttons.push([{ text: "🔎 Buscar", callback_data: "products_search_init" }, { text: "⬅️ Menu Principal", callback_data: "admin_menu" }]);

      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      }
      return;
    }

    if (data.startsWith("product_view:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) {
        if (chatId && messageId) await editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "products_list:0" }]] });
        return;
      }

      let text = `👁️ <b>DETALHES DO PRODUTO</b>\n\n` +
                 `<b>Nome:</b> ${product.produto}\n` +
                 `<b>REF:</b> <code>${product.ref}</code>\n` +
                 `<b>Preço:</b> R$ ${product.preco.toFixed(2).replace(".", ",")}\n` +
                 `<b>Categoria:</b> ${product.categoria}\n` +
                 `<b>Status:</b> ${product.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n` +
                 `<b>Destaque:</b> ${product.destaque ? "Sim" : "Não"}\n`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🎯 Ver Analytics", callback_data: `analytics_product:${product.id}:7d` }],
          [{ text: "✏️ Editar", callback_data: `product_edit:${product.id}` }, { text: "🗑️ Remover", callback_data: `product_del_confirm:${product.id}` }],
          [{ text: "🔗 Abrir no Site", url: `https://cerberusfinds.com/produto/${product.slug || product.id}` }],
          [{ text: "⬅️ Voltar", callback_data: "products_list:0" }]
        ]
      };

      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, text, keyboard);
      }
      return;
    }

    if (data.startsWith("product_toggle:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (product) {
        const newStatus = product.ativo === false ? true : false;
        await productsRepository.updateProduct(product.id, { ativo: newStatus });
      }
      // Retorna para a lista
      const products = await productsRepository.getProducts();
      // ... redirecionar para products_list:0 reusando o callback
      const callbackDataCopy = "products_list:0";
      // Executa o handler de listagem
      return handleTelegramWebhookUpdate({ callback_query: { ...cb, data: callbackDataCopy } });
    }

    if (data.startsWith("product_edit:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) return;

      const editTxt = `🛠️ <b>EDITAR PRODUTO</b>\n\n` +
                      `🆔 <b>REF:</b> <code>${product.ref}</code>\n` +
                      `🏷️ <b>Título:</b> ${product.produto}\n` +
                      `💰 <b>Preço:</b> R$ ${product.preco.toFixed(2).replace(".", ",")}\n` +
                      `📁 <b>Categoria:</b> ${product.categoria}\n` +
                      `📊 <b>Status:</b> ${product.ativo !== false ? 'Ativo 🟢' : 'Pausado ⏸️'}\n\n` +
                      `<i>Selecione o campo que deseja alterar:</i>`;

      const keyboard = {
        inline_keyboard: [
          [{ text: "📝 Título", callback_data: `field_edit:${product.id}:produto` }, { text: "💰 Preço", callback_data: `field_edit:${product.id}:preco` }],
          [{ text: "📁 Categoria", callback_data: `field_edit:${product.id}:categoria` }, { text: "📝 Descrição", callback_data: `field_edit:${product.id}:descricao` }],
          [{ text: product.ativo !== false ? "⏸ Pausar" : "🟢 Ativar", callback_data: `product_toggle:${product.id}` }, { text: "🗑️ REMOVER", callback_data: `product_del_confirm:${product.id}` }],
          [{ text: "⬅️ Voltar", callback_data: `product_view:${product.id}` }]
        ]
      };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, editTxt, keyboard);
      return;
    }

    if (data.startsWith("field_edit:")) {
      const parts = data.split(":");
      const prodId = parts[1];
      const field = parts[2];
      await answerCallbackQuery(callbackId, `Digite o novo valor para ${field}:`);
      await telegramRepo.setUserState(senderId, { action: `edit_field:${field}`, productId: prodId });
      if (chatId) {
        await sendTelegramMessage(chatId, `✏️ <b>EDITAR CAMPO: ${field.toUpperCase()}</b>\n\nEnvie o novo valor por mensagem de texto:`);
      }
      return;
    }

    if (data.startsWith("product_del_confirm:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) return;

      const keyboard = {
        inline_keyboard: [
          [{ text: "🔥 CONFIRMAR REMOÇÃO", callback_data: `product_del_exec:${product.id}` }],
          [{ text: "❌ Cancelar", callback_data: `product_edit:${product.id}` }]
        ]
      };
      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, `🚨 <b>CONFIRMAR REMOÇÃO</b>\n\nProduto: <b>${product.produto}</b>\nREF: <code>${product.ref}</code>\n\nEsta ação removerá o produto do Supabase, gerará commit no GitHub e rebuild estático.`, keyboard);
      }
      return;
    }

    if (data.startsWith("product_del_exec:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "Removendo produto...");
      const success = await productsRepository.deleteProduct(prodId);
      if (chatId) {
        if (success) {
          await sendTelegramMessage(chatId, "✅ <b>Produto removido com sucesso do Supabase e do site estático!</b>");
          await renderMainMenu(chatId);
        } else {
          await sendTelegramMessage(chatId, "❌ Falha ao remover produto.");
        }
      }
      return;
    }

    if (data === "products_search_init") {
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: "products_search" });
      if (chatId) {
        await sendTelegramMessage(chatId, "🔎 <b>BUSCAR PRODUTO</b>\n\nDigite o nome, REF ou termo para buscar no catálogo:");
      }
      return;
    }

    // --- NAMESPACE: ANALYTICS (ESTRITO SUPABASE) ---
    if (data === "analytics_overview") {
      await answerCallbackQuery(callbackId);
      let opSummary;
      let opError = null;
      try {
        opSummary = await productsRepository.getAnalyticsSummary();
      } catch (err: any) {
        opError = err.message;
      }

      let text = "📊 <b>CERBERUS ANALYTICS</b>\n\n";
      if (opError) {
        text += "⚠️ <i>Analytics temporariamente indisponível.</i>\n<code>" + opError + "</code>";
      } else if (opSummary) {
        text += "📦 <b>CATÁLOGO</b>\n" +
                "• Total: <b>" + opSummary.totalProducts + "</b>\n" +
                "• Ativos: <b>" + opSummary.activeProducts + "</b>\n" +
                "• Pausados: <b>" + (opSummary.totalProducts - opSummary.activeProducts) + "</b>\n\n" +
                "🖱️ <b>CLIQUES</b>\n" +
                "• Hoje: <b>" + opSummary.todayClicks + "</b>\n" +
                "• Últimos 7 dias: <b>" + opSummary.clicks7d + "</b>\n" +
                "• Últimos 30 dias: <b>" + opSummary.clicks30d + "</b>\n" +
                "• Total: <b>" + opSummary.totalClicks + "</b>\n\n" +
                "🛒 <b>MARKETPLACES</b>\n" +
                "• Shopee: <b>" + (opSummary.marketplaceCounts.Shopee || 0) + "</b>\n" +
                "• Mercado Livre: <b>" + (opSummary.marketplaceCounts["Mercado Livre"] || 0) + "</b>\n\n" +
                "🔥 <b>TOP PRODUTOS</b>\n" +
                (opSummary.topProducts.length > 0 ? opSummary.topProducts.map((p, i) => `${i+1}. ${p.name} — ${p.count} cliques`).join("\n") : "Nenhum clique registrado ainda");
      }

      const keyboard = {
        inline_keyboard: [
          [{ text: "🎯 Analytics por produto", callback_data: "analytics_products:0" }],
          [{ text: "🔄 Atualizar", callback_data: "analytics_overview" }, { text: "⬅️ Menu Principal", callback_data: "admin_menu" }]
        ]
      };
      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    if (data.startsWith("analytics_products:")) {
      const page = parseInt(data.split(":")[1]) || 0;
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const pageSize = 5;
      const start = page * pageSize;
      const end = start + pageSize;
      const paged = products.slice(start, end);
      const total = products.length;

      let text = `🎯 <b>ESCOLHER PRODUTO (Pág ${page + 1}/${Math.ceil(total / pageSize) || 1})</b>\n\nSelecione um produto abaixo para ver o analytics detalhado:\n\n`;
      const buttons = [];

      for (const p of paged) {
        buttons.push([{ text: `[${p.ref}] ${p.produto.slice(0, 30)}`, callback_data: `analytics_product:${p.id}:7d` }]);
      }

      const navRow = [];
      if (page > 0) navRow.push({ text: "◀️ Anterior", callback_data: `analytics_products:${page - 1}` });
      if (end < total) navRow.push({ text: "Próxima ▶️", callback_data: `analytics_products:${page + 1}` });
      if (navRow.length > 0) buttons.push(navRow);

      buttons.push([{ text: "📈 Visão Geral", callback_data: "analytics_overview" }, { text: "⬅️ Menu Principal", callback_data: "admin_menu" }]);

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      return;
    }

    if (data.startsWith("analytics_product:")) {
      const parts = data.split(":");
      const prodId = parts[1];
      const period = parts[2] || "7d";
      await answerCallbackQuery(callbackId);

      const stats = await productsRepository.getProductAnalytics(prodId, period);
      if (!stats) {
        if (chatId && messageId) await editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "analytics_products:0" }]] });
        return;
      }

      const p = stats.product;
      let periodClicks = stats.clicks7d;
      let periodLabel = "7 dias";
      if (period === "today") { periodClicks = stats.todayClicks; periodLabel = "Hoje"; }
      else if (period === "30d") { periodClicks = stats.clicks30d; periodLabel = "30 dias"; }
      else if (period === "total") { periodClicks = stats.totalClicks; periodLabel = "Total"; }

      const text = `📊 <b>ANALYTICS DO PRODUTO</b>\n\n` +
                   `<b>Nome:</b> ${p.produto}\n` +
                   `<b>REF:</b> <code>${p.ref}</code>\n` +
                   `<b>Categoria:</b> ${p.categoria}\n` +
                   `<b>Status:</b> ${p.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n\n` +
                   `🖱️ <b>CLIQUES (${periodLabel})</b>\n` +
                   `• Hoje: <b>${stats.todayClicks}</b>\n` +
                   `• 7 dias: <b>${stats.clicks7d}</b>\n` +
                   `• 30 dias: <b>${stats.clicks30d}</b>\n` +
                   `• Total: <b>${stats.totalClicks}</b>\n\n` +
                   `🛒 <b>MARKETPLACE</b>\n` +
                   `• Shopee: <b>${stats.marketplaceCounts.Shopee || 0}</b>\n` +
                   `• Mercado Livre: <b>${stats.marketplaceCounts["Mercado Livre"] || 0}</b>\n`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: period === "today" ? "• Hoje •" : "Hoje", callback_data: `analytics_product:${p.id}:today` },
            { text: period === "7d" ? "• 7d •" : "7d", callback_data: `analytics_product:${p.id}:7d` },
            { text: period === "30d" ? "• 30d •" : "30d", callback_data: `analytics_product:${p.id}:30d` },
            { text: period === "total" ? "• Total •" : "Total", callback_data: `analytics_product:${p.id}:total` }
          ],
          [{ text: "🔄 Atualizar", callback_data: `analytics_product:${p.id}:${period}` }],
          [{ text: "⬅️ Produtos", callback_data: "analytics_products:0" }, { text: "🏠 Menu Principal", callback_data: "admin_menu" }]
        ]
      };

      if (chatId && messageId) await editTelegramMessageText(chatId, messageId, text, keyboard);
      return;
    }

    // --- NAMESPACE: CATEGORIES / REVIEWS ---
    if (data === "add_cat_init") {
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: "add_cat_name" });
      if (chatId) await sendTelegramMessage(chatId, "📁 <b>ADICIONAR CATEGORIA</b>\n\nDigite o nome da nova categoria:");
      return;
    }

    if (data.startsWith("rename_cat_init:")) {
      const oldName = data.split(":")[1];
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: `rename_cat_name:${oldName}` });
      if (chatId) await sendTelegramMessage(chatId, `✏️ <b>RENOMEAR CATEGORIA: ${oldName}</b>\n\nDigite o novo nome:`);
      return;
    }

    if (data.startsWith("confirm_pub:")) {
      const reviewId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "⏳ Publicando...");
      const review = await telegramRepo.getPendingReview(reviewId);
      const validation = logAndValidateReviewCallback("Confirmar & Publicar", reviewId, chatId, review);
      if (!validation.valid || !review) {
        if (chatId) await sendTelegramMessage(chatId, `⚠️ ${validation.reason}`);
        return;
      }
      try {
        const publishedProduct = await productsRepository.createProduct({
          produto: review.produto,
          categoria: review.categoria,
          preco: review.preco,
          imagens: review.imagens,
          link: review.normalizedUrl,
          descricao: review.descricao,
          status: "published"
        });
        review.status = "published";
        await telegramRepo.savePendingReview(review);
        await telegramRepo.deleteUserState(senderId);

        const successText = `✅ <b>PEÇA PUBLICADA COM SUCESSO!</b>\n\n<b>${publishedProduct.produto}</b>\nREF: <code>${publishedProduct.ref}</code>\nPreço: R$ ${review.preco.toFixed(2)}`;
        if (chatId && messageId) await editTelegramMessageCaption(chatId, messageId, successText);
        else if (chatId) await sendTelegramMessage(chatId, successText);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Falha ao publicar: ${err.message}`);
      }
      return;
    }

    if (data.startsWith("edit_price:")) {
      const reviewId = data.split(":")[1];
      await telegramRepo.setUserState(senderId, { action: "awaiting_price", reviewId });
      await answerCallbackQuery(callbackId, "Digite o novo preço:");
      if (chatId) await sendTelegramMessage(chatId, "💰 <b>DIGITE O NOVO PREÇO EM REAIS:</b>");
      return;
    }

    if (data.startsWith("cancel_rev:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);
      if (review) { review.status = "cancelled"; await telegramRepo.savePendingReview(review); }
      await telegramRepo.deleteUserState(senderId);
      await answerCallbackQuery(callbackId, "❌ Cancelado.");
      if (chatId && messageId) await editTelegramMessageCaption(chatId, messageId, "❌ Cadastro cancelado.");
      return;
    }
  }

  // 2. MENSAGENS DE TEXTO
  if (update.message && update.message.text) {
    const msg = update.message;
    const senderId = msg.from?.id || "Desconhecido";
    const firstName = msg.from?.first_name || "Anônimo";
    const username = msg.from?.username ? `@${msg.from.username}` : "N/A";
    const text: string = msg.text.trim();
    const chatId = msg.chat?.id;

    if (!isUserAllowed(senderId)) {
      if (chatId) await sendTelegramMessage(chatId, `🔒 <b>Acesso Negado</b> (ID: <code>${senderId}</code>)`);
      return;
    }

    // --- INTERCEPTAÇÃO ABSOLUTA DE /analytics ---
    if (text.startsWith("/analytics")) {
      const parts = text.split(" ");
      const arg = parts[1] ? parts[1].trim() : "";

      if (arg) {
        const stats = await productsRepository.getProductAnalytics(arg, "7d");
        if (!stats) {
          if (chatId) await sendTelegramMessage(chatId, `⚠️ Produto <code>${arg}</code> não encontrado no Supabase.`);
          return;
        }
        const p = stats.product;
        const textResp = `📊 <b>ANALYTICS DO PRODUTO</b>\n\n` +
                         `<b>Nome:</b> ${p.produto}\n` +
                         `<b>REF:</b> <code>${p.ref}</code>\n` +
                         `<b>Preço:</b> R$ ${p.preco.toFixed(2).replace(".", ",")}\n` +
                         `<b>Cliques (7d):</b> ${stats.clicks7d} (Hoje: ${stats.todayClicks})\n` +
                         `<b>Total:</b> ${stats.totalClicks}\n`;
        const keyboard = {
          inline_keyboard: [
            [{ text: "📊 Visão Geral", callback_data: "analytics_overview" }, { text: "🔗 Abrir", url: p.link }]
          ]
        };
        if (chatId) await sendTelegramMessage(chatId, textResp, keyboard);
        return;
      } else {
        // Redireciona para visão geral
        let opSummary = await productsRepository.getAnalyticsSummary();
        let textResp = "📊 <b>CERBERUS ANALYTICS</b>\n\n" +
                       "📦 Total: <b>" + opSummary.totalProducts + "</b> | Ativos: <b>" + opSummary.activeProducts + "</b>\n" +
                       "🖱️ Cliques hoje: <b>" + opSummary.todayClicks + "</b> | 7d: <b>" + opSummary.clicks7d + "</b> | Total: <b>" + opSummary.totalClicks + "</b>\n";
        const keyboard = {
          inline_keyboard: [
            [{ text: "🎯 Analytics por produto", callback_data: "analytics_products:0" }],
            [{ text: "🏠 Menu Principal", callback_data: "admin_menu" }]
          ]
        };
        if (chatId) await sendTelegramMessage(chatId, textResp, keyboard);
        return;
      }
    }

    // --- COMANDOS /start /admin /listar /categorias /help ---
    if (text.startsWith("/start") || text.startsWith("/admin")) {
      if (chatId) await renderMainMenu(chatId);
      return;
    }

    if (text.startsWith("/listar") || text.startsWith("/produtos")) {
      if (chatId) {
        // Redireciona para o callback list_page:0 via simulação de mensagem ou chamada direta
        const fakeCb = { callback_query: { id: "fake", from: { id: senderId }, message: { chat: { id: chatId }, message_id: 0 }, data: "products_list:0" } };
        await handleTelegramWebhookUpdate(fakeCb);
      }
      return;
    }

    if (text.startsWith("/categorias")) {
      const cats = await categoriesRepository.getCategories();
      let catTxt = "🏷️ <b>CATEGORIAS DO CATÁLOGO</b>\n\n";
      const buttons = [];
      for (const c of cats) {
        catTxt += `• ${c.name}\n`;
        buttons.push([{ text: `✏️ ${c.name}`, callback_data: `rename_cat_init:${c.name}` }]);
      }
      buttons.push([{ text: "➕ Adicionar", callback_data: "add_cat_init" }]);
      buttons.push([{ text: "⬅️ Menu", callback_data: "admin_menu" }]);
      if (chatId) await sendTelegramMessage(chatId, catTxt, { inline_keyboard: buttons });
      return;
    }

    if (text.startsWith("/help")) {
      if (chatId) await renderMainMenu(chatId);
      return;
    }

    // --- DETECÇÃO DE LINKS (FLUXO DE PUBLICAÇÃO) ---
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);
    if (matches && matches.length > 0) {
      for (const link of matches) {
        if (chatId) await sendTelegramMessage(chatId, `🔎 Analisando peça de <b>${detectMarketplace(link)}</b>...`);
        const extResult = await extractProductForReview(link);
        if (!extResult.success || !extResult.data) {
          if (chatId) await sendTelegramMessage(chatId, `❌ Falha ao extrair: ${extResult.error || "Erro desconhecido"}`);
          continue;
        }
        const reviewId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const review: PendingReview = {
          id: reviewId,
          chatId: chatId || 0,
          senderId,
          firstName,
          username,
          createdAt: Date.now(),
          ...extResult.data
        };
        await telegramRepo.savePendingReview(review);
        const cardText = buildReviewCardText(review);
        const keyboard = buildMainReviewKeyboard(reviewId);

        if (chatId) {
          let sentMsg: any = null;
          if (review.imagens && review.imagens.length > 0) {
            sentMsg = await sendTelegramPhoto(chatId, review.imagens[0], cardText, keyboard);
          } else {
            sentMsg = await sendTelegramMessage(chatId, cardText, keyboard);
          }
          if (sentMsg?.result?.message_id) {
            review.cardMessageId = sentMsg.result.message_id;
            await telegramRepo.savePendingReview(review);
          }
        }
      }
      return;
    }

    // --- ESTADOS DE USUÁRIO / MÁQUINAS DE ESTADO ---
    const userState = await telegramRepo.getUserState(senderId);

    if (userState && userState.action.startsWith("edit_field:")) {
      const field = userState.action.split(":")[1];
      const prodId = userState.productId;
      const update: any = {};
      if (field === "preco") {
        const p = parseAndNormalizePrice(text);
        if (p === null) {
          if (chatId) await sendTelegramMessage(chatId, "❌ Preço inválido.");
          return;
        }
        update[field] = p;
      } else {
        update[field] = text;
      }
      try {
        await productsRepository.updateProduct(prodId, update);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Campo <b>${field}</b> atualizado com sucesso no Supabase e no site!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro ao atualizar: ${err.message}`);
      }
      return;
    }

    if (userState && userState.action === "products_search") {
      await telegramRepo.deleteUserState(senderId);
      const query = text.toLowerCase();
      const products = await productsRepository.getProducts();
      const matched = products.filter(p => p.produto.toLowerCase().includes(query) || p.ref.toLowerCase().includes(query) || p.categoria.toLowerCase().includes(query));
      
      let textResp = `🔎 <b>RESULTADOS DA BUSCA: "${text}"</b>\nEncontradas: ${matched.length} peças\n\n`;
      const buttons = [];
      for (const p of matched.slice(0, 10)) {
        textResp += `• <code>${p.ref}</code> - ${p.produto}\n`;
        buttons.push([{ text: `👁️ ${p.ref}`, callback_data: `product_view:${p.id}` }]);
      }
      buttons.push([{ text: "⬅️ Menu Principal", callback_data: "admin_menu" }]);
      if (chatId) await sendTelegramMessage(chatId, textResp, { inline_keyboard: buttons });
      return;
    }

    if (userState && userState.action === "add_cat_name") {
      try {
        await categoriesRepository.addCategory(text);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Categoria <b>${text}</b> adicionada com sucesso!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro: ${err.message}`);
      }
      return;
    }

    if (userState && userState.action.startsWith("rename_cat_name:")) {
      const oldName = userState.action.split(":")[1];
      try {
        await categoriesRepository.renameCategory(oldName, text);
        await telegramRepo.deleteUserState(senderId);
        if (chatId) await sendTelegramMessage(chatId, `✅ Categoria renomeada de ${oldName} para ${text}!`);
      } catch (err: any) {
        if (chatId) await sendTelegramMessage(chatId, `❌ Erro: ${err.message}`);
      }
      return;
    }

    // Fallback de preço para revisão pendente
    let targetReview: PendingReview | null = null;
    if (userState && userState.action === "awaiting_price") {
      targetReview = await telegramRepo.getPendingReview(userState.reviewId);
    }
    if (!targetReview) {
      targetReview = await telegramRepo.getLatestPendingReviewForUser(senderId, chatId);
    }

    const normPrice = parseAndNormalizePrice(text);
    if (!targetReview) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "⚠️ <b>Comando ou mensagem não reconhecida.</b>\n\nEnvie o link de um produto para cadastrar ou digite /start para abrir o painel administrativo."
        );
      }
      return;
    }

    if (normPrice !== null && normPrice > 0) {
      targetReview.preco = normPrice;
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.deleteUserState(senderId);

      const updatedCardText = buildReviewCardText(targetReview);
      const keyboard = buildMainReviewKeyboard(targetReview.id);

      if (chatId) {
        await sendTelegramMessage(chatId, `✅ Preço atualizado para R$ ${normPrice.toFixed(2).replace(".", ",")}:`);
        if (targetReview.cardMessageId) {
          await editTelegramMessageCaption(chatId, targetReview.cardMessageId, updatedCardText, keyboard);
        } else {
          await sendTelegramPhoto(chatId, targetReview.imagens[0], updatedCardText, keyboard);
        }
      }
    } else {
      if (chatId) {
        await sendTelegramMessage(chatId, "❌ Valor de preço inválido. Envie um número válido (ex: 89,90).");
      }
    }
  }
}

export async function startTelegramPolling(): Promise<void> {
  console.log("🤖 [Telegram Bot] Polling desativado em favor do Webhook do Render.");
}
