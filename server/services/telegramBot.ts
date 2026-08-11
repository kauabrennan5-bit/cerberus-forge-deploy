import dotenv from "dotenv";
import { extractProductForReview, detectMarketplace, ExtractedReviewData } from "./productAutomation";
import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import * as categoriesRepository from "../repositories/categoriesRepository";

dotenv.config();

export { detectMarketplace };

// Token e Whitelist Padrão com Fallbacks Confiáveis
function getBotToken(): string {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN não configurado no ambiente");
  }
  return token;
}

/**
 * Verifica se um usuário do Telegram está autorizado na Whitelist
 */
export function isUserAllowed(senderId: string | number): boolean {
  const allowedStr = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "1976526372";
  const allowedList = allowedStr.split(",").map((id) => id.trim()).filter(Boolean);

  if (allowedList.length === 0) {
    return false;
  }

  return allowedList.includes(String(senderId));
}

// Interface da sessão de revisão pendente
export interface PendingReview extends ExtractedReviewData {
  id: string;
  chatId: string | number;
  senderId: string | number;
  firstName: string;
  username: string;
  createdAt: number;
  cardMessageId?: number;
}

/**
 * Normaliza o valor de preço enviado pelo usuário para um número decimal (maior que zero).
 * Suporta formatos: "72", "72,90", "R$ 72,90", "72.90", "r$ 72,90", "1.250,90"
 */
export function parseAndNormalizePrice(input: string): number | null {
  if (!input || typeof input !== "string") return null;

  let cleaned = input
    .replace(/^[rR]?\$\s*/, "")
    .replace(/\$/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();

  if (!cleaned) return null;

  if (cleaned.includes(".") && cleaned.includes(",")) {
    if (cleaned.indexOf(".") < cleaned.indexOf(",")) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (cleaned.includes(",")) {
    cleaned = cleaned.replace(",", ".");
  }

  const val = parseFloat(cleaned);
  if (isNaN(val) || !isFinite(val)) return null;
  if (val <= 0) return null;

  return Math.round(val * 100) / 100;
}

/**
 * Envia uma mensagem de texto em formato HTML usando a API do Telegram
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: any
): Promise<any> {
  const token = getBotToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
        reply_markup: replyMarkup,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("[Telegram Bot Error] Erro ao enviar mensagem:", err);
    return null;
  }
}

/**
 * Envia uma foto com legenda e botões inline
 */
export async function sendTelegramPhoto(
  chatId: string | number,
  photoUrl: string,
  caption: string,
  replyMarkup?: any
): Promise<any> {
  const token = getBotToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      // Fallback para texto se a foto falhar
      return await sendTelegramMessage(chatId, caption, replyMarkup);
    }
    return data;
  } catch (err) {
    console.warn("[Telegram Bot Warning] Falha ao enviar foto, fallback para texto:", err);
    return await sendTelegramMessage(chatId, caption, replyMarkup);
  }
}

/**
 * Responde a uma requisição de Callback Query (para parar o carregamento do botão inline)
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert: boolean = false
): Promise<any> {
  const token = getBotToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: showAlert,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("[Telegram Bot Error] Erro ao responder Callback Query:", err);
    return null;
  }
}

/**
 * Edita o texto de uma mensagem de texto enviada anteriormente
 */
export async function editTelegramMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: any
): Promise<any> {
  const token = getBotToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("[Telegram Bot Error] Erro ao editar texto da mensagem:", err);
    return null;
  }
}

/**
 * Edita a legenda de uma mensagem de foto enviada anteriormente
 */
export async function editTelegramMessageCaption(
  chatId: string | number,
  messageId: number,
  caption: string,
  replyMarkup?: any
): Promise<any> {
  const token = getBotToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption: caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      // Se não for uma mensagem de mídia com foto, tenta editar o texto
      return await editTelegramMessageText(chatId, messageId, caption, replyMarkup);
    }
    return data;
  } catch {
    return await editTelegramMessageText(chatId, messageId, caption, replyMarkup);
  }
}

/**
 * Monta o texto HTML formatado para o card de revisão do produto
 */
function buildReviewCardText(review: PendingReview): string {
  const priceFormatted = review.preco && review.preco > 0
    ? `R$ ${review.preco.toFixed(2).replace(".", ",")}`
    : `⚠️ <b>Preço não detectado.</b>\n👉 <i>Digite o preço de venda que deseja cadastrar.</i>`;

  const existingNotice = review.existingProduct
    ? `\n\n♻️ <i>Nota: Este produto já está cadastrado no acervo. Confirmar irá atualizar os dados.</i>`
    : "";

  return (
    `📋 <b>REVISÃO DE CADASTRO CERBERUS</b>\n\n` +
    `🏷️ <b>Produto:</b> ${review.produto}\n` +
    `📁 <b>Categoria:</b> ${review.categoria}\n` +
    `💰 <b>Preço:</b> ${priceFormatted}\n` +
    `🛒 <b>Marketplace:</b> ${review.marketplace}\n` +
    `🖼️ <b>Imagens:</b> ${review.imagens?.length || 0} encontradas\n` +
    `🔗 <code>${review.normalizedUrl}</code>${existingNotice}\n\n` +
    `<i>Confirme os dados ou ajuste o preço/categoria antes de publicar no acervo:</i>`
  );
}

/**
 * Monta os botões inline do card principal de revisão
 */
function buildMainReviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Confirmar & Publicar", callback_data: `confirm_pub:${reviewId}` }],
      [
        { text: "💰 Alterar Preço", callback_data: `edit_price:${reviewId}` },
        { text: "🏷️ Alterar Categoria", callback_data: `edit_cat:${reviewId}` }
      ],
      [{ text: "❌ Cancelar", callback_data: `cancel_rev:${reviewId}` }]
    ]
  };
}

/**
 * Processador Principal de Updates do Webhook (Texto + Callback Queries)
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!update) return;

  // 1. LIDAR COM CALLBACK QUERIES (Cliques nos botões inline)
  if (update.callback_query) {
    const cb = update.callback_query;
    const callbackId = cb.id;
    const senderId = cb.from?.id || "Desconhecido";
    const firstName = cb.from?.first_name || "Anônimo";
    const data: string = cb.data || "";
    const msg = cb.message;
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;

    if (!isUserAllowed(senderId)) {
      await answerCallbackQuery(callbackId, "🔒 Acesso não autorizado.", true);
      return;
    }

    // --- NOVOS COMANDOS ADMINISTRATIVOS (CALLBACKS) ---

    // Ação: Paginação de Produtos
    if (data.startsWith("list_page:")) {
      const page = parseInt(data.split(":")[1]);
      await answerCallbackQuery(callbackId);
      const products = await productsRepository.getProducts();
      const pageSize = 10;
      const start = page * pageSize;
      const end = start + pageSize;
      const paged = products.slice(start, end);
      
      let text = `📦 <b>CATÁLOGO CERBERUS (Pág ${page + 1})</b>\n\n`;
      const buttons = [];
      
      for (const p of paged) {
        text += `• <code>${p.ref}</code> - ${p.produto.slice(0, 30)}${p.produto.length > 30 ? '...' : ''} (${p.ativo ? '✅' : '⏸'})\n`;
        buttons.push([{ text: `📝 Editar ${p.ref}`, callback_data: `admin_edit:${p.id}` }]);
      }
      
      const navRow = [];
      if (page > 0) navRow.push({ text: "⬅️ Anterior", callback_data: `list_page:${page - 1}` });
      if (end < products.length) navRow.push({ text: "Próxima ➡️", callback_data: `list_page:${page + 1}` });
      if (navRow.length > 0) buttons.push(navRow);
      
      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, text, { inline_keyboard: buttons });
      }
      return;
    }

    // Ação: Menu de Edição de Produto Específico
    if (data.startsWith("admin_edit:")) {
      const prodId = data.split(":")[1];
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (!product) {
        await answerCallbackQuery(callbackId, "❌ Produto não encontrado.", true);
        return;
      }
      
      await answerCallbackQuery(callbackId);
      const text = `🛠️ <b>ADMIN: EDITAR PRODUTO</b>\n\n` +
                   `🆔 <b>REF:</b> <code>${product.ref}</code>\n` +
                   `🏷️ <b>Título:</b> ${product.produto}\n` +
                   `💰 <b>Preço:</b> R$ ${product.preco.toFixed(2)}\n` +
                   `📁 <b>Categoria:</b> ${product.categoria}\n` +
                   `📊 <b>Status:</b> ${product.ativo ? 'Ativo ✅' : 'Pausado ⏸'}\n\n` +
                   `<i>Escolha o que deseja alterar:</i>`;
                   
      const keyboard = {
        inline_keyboard: [
          [{ text: "📝 Título", callback_data: `field_edit:${prodId}:produto` }, { text: "💰 Preço", callback_data: `field_edit:${prodId}:preco` }],
          [{ text: "📁 Categoria", callback_data: `field_edit:${prodId}:categoria` }, { text: "📝 Descrição", callback_data: `field_edit:${prodId}:descricao` }],
          [{ text: product.ativo ? "⏸ Pausar" : "✅ Ativar", callback_data: `toggle_active:${prodId}` }, { text: "🗑️ REMOVER", callback_data: `confirm_del:${prodId}` }],
          [{ text: "⬅️ Voltar para Lista", callback_data: "list_page:0" }]
        ]
      };
      
      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, text, keyboard);
      }
      return;
    }

    // Ação: Solicitar novo valor para campo
    if (data.startsWith("field_edit:")) {
      const [, prodId, field] = data.split(":");
      await answerCallbackQuery(callbackId);
      await telegramRepo.setUserState(senderId, { action: `edit_field:${field}`, productId: prodId });
      
      if (chatId) {
        const fieldNames: any = { produto: "Título", preco: "Preço", categoria: "Categoria", descricao: "Descrição" };
        await sendTelegramMessage(chatId, `✍️ <b>ALTERAR ${fieldNames[field].toUpperCase()}</b>\n\nDigite o novo valor para este campo:`);
      }
      return;
    }

    // Ação: Alternar Ativo/Pausado
    if (data.startsWith("toggle_active:")) {
      const prodId = data.split(":")[1];
      const product = await productsRepository.getProductByIdOrSlug(prodId);
      if (product) {
        await productsRepository.updateProduct(prodId, { ativo: !product.ativo });
        await answerCallbackQuery(callbackId, `✅ Status alterado para ${!product.ativo ? 'Ativo' : 'Pausado'}`);
        // Recarrega o menu de edição
        const updated = await productsRepository.getProductByIdOrSlug(prodId);
        if (updated && chatId && messageId) {
          // Re-executa a lógica de admin_edit para atualizar a UI
          const text = `🛠️ <b>ADMIN: EDITAR PRODUTO</b>\n\n` +
                       `🆔 <b>REF:</b> <code>${updated.ref}</code>\n` +
                       `🏷️ <b>Título:</b> ${updated.produto}\n` +
                       `💰 <b>Preço:</b> R$ ${updated.preco.toFixed(2)}\n` +
                       `📁 <b>Categoria:</b> ${updated.categoria}\n` +
                       `📊 <b>Status:</b> ${updated.ativo ? 'Ativo ✅' : 'Pausado ⏸'}\n\n` +
                       `<i>Escolha o que deseja alterar:</i>`;
          const keyboard = {
            inline_keyboard: [
              [{ text: "📝 Título", callback_data: `field_edit:${prodId}:produto` }, { text: "💰 Preço", callback_data: `field_edit:${prodId}:preco` }],
              [{ text: "📁 Categoria", callback_data: `field_edit:${prodId}:categoria` }, { text: "📝 Descrição", callback_data: `field_edit:${prodId}:descricao` }],
              [{ text: updated.ativo ? "⏸ Pausar" : "✅ Ativar", callback_data: `toggle_active:${prodId}` }, { text: "🗑️ REMOVER", callback_data: `confirm_del:${prodId}` }],
              [{ text: "⬅️ Voltar para Lista", callback_data: "list_page:0" }]
            ]
          };
          await editTelegramMessageText(chatId, messageId, text, keyboard);
        }
      }
      return;
    }

    // Ação: Confirmar Remoção
    if (data.startsWith("confirm_del:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "⚠️ Confirmação necessária!");
      const keyboard = {
        inline_keyboard: [
          [{ text: "🔥 CONFIRMAR REMOÇÃO", callback_data: `exec_del:${prodId}` }],
          [{ text: "❌ Cancelar", callback_data: `admin_edit:${prodId}` }]
        ]
      };
      if (chatId && messageId) {
        await editTelegramMessageText(chatId, messageId, `🚨 <b>VOCÊ TEM CERTEZA?</b>\n\nEsta ação irá remover permanentemente o produto do catálogo estático e do banco de dados.`, keyboard);
      }
      return;
    }

    // Ação: Executar Remoção
    if (data.startsWith("exec_del:")) {
      const prodId = data.split(":")[1];
      await answerCallbackQuery(callbackId, "🗑️ Removendo...");
      const success = await productsRepository.deleteProduct(prodId);
      if (success) {
        if (chatId && messageId) {
          await editTelegramMessageText(chatId, messageId, `✅ <b>Produto removido com sucesso!</b>\nO catálogo será reconstruído automaticamente.`);
        }
      } else {
        await answerCallbackQuery(callbackId, "❌ Erro ao remover.", true);
      }
      return;
    }

    // Ação: Confirmar & Publicar
    if (data.startsWith("confirm_pub:")) {
      console.log("[TELEGRAM PUBLISH 1] Callback recebido");
      const reviewId = data.split(":")[1];

      // Responder imediatamente ao callback para nunca travar o botão
      await answerCallbackQuery(callbackId, "⏳ Processando publicação...");

      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        console.warn(`[TELEGRAM PUBLISH ERROR] Revisão ${reviewId} não encontrada ou expirada.`);
        if (chatId) {
          await sendTelegramMessage(chatId, "⚠️ <b>Sessão de revisão expirada ou já finalizada.</b> Envie o link novamente.");
        }
        return;
      }
      console.log("[TELEGRAM PUBLISH 2] Revisão localizada:", reviewId);

      if (!review.preco || review.preco <= 0) {
        console.warn("[TELEGRAM PUBLISH ERROR] Preço inválido na revisão.");
        if (chatId) {
          await sendTelegramMessage(chatId, "⚠️ <b>Defina um preço válido antes de publicar!</b> Clique em '💰 Alterar Preço'.");
        }
        return;
      }
      console.log("[TELEGRAM PUBLISH 3] Preço validado:", review.preco);

      try {
        const siteBaseUrl = process.env.APP_URL || "https://cerberus-static-catalog.onrender.com";
        let publishedProduct: any = null;

        if (review.existingProduct) {
          publishedProduct = await productsRepository.updateProduct(review.existingProduct.id, {
            produto: review.produto,
            categoria: review.categoria,
            preco: review.preco,
            imagens: review.imagens,
            link: review.normalizedUrl,
            descricao: review.descricao
          });
        } else {
          publishedProduct = await productsRepository.createProduct({
            produto: review.produto,
            categoria: review.categoria,
            preco: review.preco,
            imagens: review.imagens,
            link: review.normalizedUrl,
            descricao: review.descricao,
            status: "published"
          });
        }

        if (!publishedProduct || !publishedProduct.id) {
          throw new Error("Falha ao gravar produto no Supabase.");
        }
        console.log("[TELEGRAM PUBLISH 4] Produto gravado no Supabase. ID:", publishedProduct.id);

        const doubleCheck = await productsRepository.getProductByIdOrSlug(publishedProduct.id);
        if (!doubleCheck) {
          throw new Error("Produto não localizado na verificação pós-gravação do Supabase.");
        }
        console.log("[TELEGRAM PUBLISH 5] Produto confirmado no Supabase com sucesso.");

        console.log("[TELEGRAM PUBLISH 6] CatalogSync iniciado...");
        const { syncCatalogAndDeploy } = await import("./catalogSync");
        const syncResult = await syncCatalogAndDeploy(publishedProduct.produto || review.produto, publishedProduct.id);

        if (!syncResult.jsonCount && syncResult.supabaseCount > 0) {
          throw new Error("Falha ao regenerar o arquivo products.json estático.");
        }
        console.log("[TELEGRAM PUBLISH 7] products.json regenerado. Itens:", syncResult.jsonCount);

        console.log("[TELEGRAM PUBLISH 8] Deploy do Static Site acionado via hook.");

        // Verificação final no catálogo público
        const publicCheckUrl = `${syncResult.staticSiteUrl}/data/products.json?t=${Date.now()}`;
        console.log(`[TELEGRAM PUBLISH 9] Verificando catálogo público em ${publicCheckUrl}...`);
        
        let foundPublic = false;
        try {
          const pubRes = await fetch(publicCheckUrl);
          if (pubRes.ok) {
            const pubJson = await pubRes.json();
            if (Array.isArray(pubJson) && pubJson.some((p: any) => p.id === publishedProduct.id)) {
              foundPublic = true;
            }
          }
        } catch (chkErr) {
          console.warn("[TELEGRAM PUBLISH WARNING] Falha na checagem pública imediata:", chkErr);
        }

        console.log(`[TELEGRAM PUBLISH 10] Publicação concluída. Visível no site público: ${foundPublic ? 'Sim' : 'Pendente de propagação CDN'}`);

        // Apenas agora remove a revisão pendente
        await telegramRepo.deletePendingReview(reviewId);
        await telegramRepo.deleteUserState(senderId);

        const productUrl = `${siteBaseUrl}/produto/${publishedProduct.slug || publishedProduct.id}`;
        const successText =
          `✅ <b>PEÇA PUBLICADA COM SUCESSO!</b>\n\n` +
          `<b>CERBERUS FINDS ARCHIVE</b>\n\n` +
          `🏷️ <b>Produto:</b> ${publishedProduct.produto || review.produto}\n` +
          `📁 <b>Categoria:</b> ${publishedProduct.categoria || review.categoria}\n` +
          `💰 <b>Preço:</b> R$ ${review.preco.toFixed(2).replace(".", ",")}\n` +
          `🆔 <b>REF:</b> ${publishedProduct.ref || 'N/A'}\n\n` +
          `🔗 <b>Ver no site:</b>\n${productUrl}\n\n` +
          `⚡ <i>Supabase gravado & Catálogo estático atualizado (${syncResult.jsonCount} peças).</i>`;

        if (chatId && messageId) {
          await editTelegramMessageCaption(chatId, messageId, successText);
        } else if (chatId) {
          await sendTelegramMessage(chatId, successText);
        }
      } catch (err: any) {
        console.error("[TELEGRAM PUBLISH ERROR]", err);
        const errorMsg = err?.message || "Erro desconhecido.";
        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `❌ <b>FALHA NA ETAPA DE PUBLICAÇÃO:</b>\n\n` +
            `O produto <b>NÃO</b> foi publicado.\n` +
            `<i>Motivo do erro: ${errorMsg}</i>\n\n` +
            `A sessão de revisão foi mantida pendente. Tente novamente clicando em 'Confirmar & Publicar'.`
          );
        }
      }
      return;
    }

    // Ação: Alterar Preço
    if (data.startsWith("edit_price:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        await answerCallbackQuery(callbackId, "⚠️ Sessão de revisão expirada.", true);
        return;
      }

      await telegramRepo.setUserState(senderId, { action: "awaiting_price", reviewId });
      await answerCallbackQuery(callbackId, "✍️ Aguardando novo preço...");

      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `💰 <b>DIGITE O NOVO PREÇO:</b>\n\n` +
          `Envie apenas o valor numérico em reais (Exemplo: <code>89,90</code> ou <code>120</code>).`
        );
      }
      return;
    }

    // Ação: Menu de Categorias
    if (data.startsWith("edit_cat:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        await answerCallbackQuery(callbackId, "⚠️ Sessão de revisão expirada.", true);
        return;
      }

      await answerCallbackQuery(callbackId, "Escolha a categoria:");

      const catKeyboard = {
        inline_keyboard: [
          [
            { text: "Camisetas", callback_data: `set_cat:${reviewId}:Camisetas` },
            { text: "Calças", callback_data: `set_cat:${reviewId}:Calças` }
          ],
          [
            { text: "Moletons", callback_data: `set_cat:${reviewId}:Moletons` },
            { text: "Jaquetas", callback_data: `set_cat:${reviewId}:Jaquetas` }
          ],
          [
            { text: "Calçados", callback_data: `set_cat:${reviewId}:Calçados` },
            { text: "Acessórios", callback_data: `set_cat:${reviewId}:Acessórios` }
          ],
          [
            { text: "⬅️ Voltar", callback_data: `back_rev:${reviewId}` }
          ]
        ]
      };

      if (chatId && messageId) {
        await editTelegramMessageCaption(
          chatId,
          messageId,
          `🏷️ <b>SELECIONE A CATEGORIA DESEJADA:</b>\n\n` +
          `Produto atual: <b>${review.produto}</b>\n` +
          `Categoria atual: <i>${review.categoria}</i>`,
          catKeyboard
        );
      }
      return;
    }

    // Ação: Definir Categoria Escolhida
    if (data.startsWith("set_cat:")) {
      const parts = data.split(":");
      const reviewId = parts[1];
      const selectedCategory = parts[2];
      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        await answerCallbackQuery(callbackId, "⚠️ Sessão de revisão expirada.", true);
        return;
      }

      review.categoria = selectedCategory;
      await telegramRepo.savePendingReview(review);
      await answerCallbackQuery(callbackId, `✅ Categoria alterada para ${selectedCategory}`);

      if (chatId && messageId) {
        await editTelegramMessageCaption(
          chatId,
          messageId,
          buildReviewCardText(review),
          buildMainReviewKeyboard(reviewId)
        );
      }
      return;
    }

    // Ação: Voltar ao menu principal da revisão
    if (data.startsWith("back_rev:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        await answerCallbackQuery(callbackId, "⚠️ Sessão expirada.", true);
        return;
      }

      await answerCallbackQuery(callbackId);

      if (chatId && messageId) {
        await editTelegramMessageCaption(
          chatId,
          messageId,
          buildReviewCardText(review),
          buildMainReviewKeyboard(reviewId)
        );
      }
      return;
    }

    // Ação: Cancelar Revisão
    if (data.startsWith("cancel_rev:")) {
      const reviewId = data.split(":")[1];
      await telegramRepo.deletePendingReview(reviewId);
      await telegramRepo.deleteUserState(senderId);

      await answerCallbackQuery(callbackId, "❌ Cadastro cancelado.");

      if (chatId && messageId) {
        await editTelegramMessageCaption(chatId, messageId, `❌ <b>Cadastro da peça cancelado.</b>`);
      }
      return;
    }
  }

  // 2. LIDAR COM MENSAGENS DE TEXTO
  if (update.message && update.message.text) {
    const msg = update.message;
    const senderId = msg.from?.id || "Desconhecido";
    const firstName = msg.from?.first_name || "Anônimo";
    const username = msg.from?.username ? `@${msg.from.username}` : "N/A";
    const text: string = msg.text.trim();
    const chatId = msg.chat?.id;

    if (!isUserAllowed(senderId)) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🔒 <b>Acesso Negado</b>\n\n` +
          `Seu usuário do Telegram (ID: <code>${senderId}</code>) não está autorizado no Cerberus Finds Archive.`
        );
      }
      return;
    }

    // Comandos básicos (/start e /help)
    if (text.startsWith("/start") || text.startsWith("/help")) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🏴 <b>BOT CERBERUS FINDS ARCHIVE</b>\n\n` +
          `Modo de Revisão e Curadoria Ativo!\n\n` +
          `👤 <b>Seu ID Telegram:</b> <code>${senderId}</code>\n` +
          `✅ <b>Status Whitelist:</b> Autorizado\n\n` +
          `<b>COMANDOS ADMINISTRATIVOS:</b>\n` +
          `/listar - Ver e editar todos os produtos\n` +
          `/categorias - Gerenciar categorias\n\n` +
          `Ou envie um link de produto para cadastrar novo.`
        );
      }
      return;
    }

    // Comando: /listar
    if (text.startsWith("/listar") || text.startsWith("/produtos")) {
      const products = await productsRepository.getProducts();
      const pageSize = 10;
      const paged = products.slice(0, pageSize);
      
      let listText = `📦 <b>CATÁLOGO CERBERUS</b>\nTotal: ${products.length} peças\n\n`;
      const buttons = [];
      
      for (const p of paged) {
        listText += `• <code>${p.ref}</code> - ${p.produto.slice(0, 30)}${p.produto.length > 30 ? '...' : ''} (${p.ativo ? '✅' : '⏸'})\n`;
        buttons.push([{ text: `📝 Editar ${p.ref}`, callback_data: `admin_edit:${p.id}` }]);
      }
      
      if (products.length > pageSize) {
        buttons.push([{ text: "Próxima ➡️", callback_data: "list_page:1" }]);
      }
      
      if (chatId) {
        await sendTelegramMessage(chatId, listText, { inline_keyboard: buttons });
      }
      return;
    }

    // Comando: /editar [REF]
    if (text.startsWith("/editar ")) {
      const ref = text.split(" ")[1];
      const product = await productsRepository.getProductByIdOrSlug(ref);
      if (product && chatId) {
        // Reutiliza a lógica de admin_edit
        const editTxt = `🛠️ <b>ADMIN: EDITAR PRODUTO</b>\n\n🆔 <b>REF:</b> <code>${product.ref}</code>\n🏷️ <b>Título:</b> ${product.produto}\n💰 <b>Preço:</b> R$ ${product.preco.toFixed(2)}\n📁 <b>Categoria:</b> ${product.categoria}\n📊 <b>Status:</b> ${product.ativo ? 'Ativo ✅' : 'Pausado ⏸'}`;
        const keyboard = {
          inline_keyboard: [
            [{ text: "📝 Título", callback_data: `field_edit:${product.id}:produto` }, { text: "💰 Preço", callback_data: `field_edit:${product.id}:preco` }],
            [{ text: "📁 Categoria", callback_data: `field_edit:${product.id}:categoria` }, { text: "📝 Descrição", callback_data: `field_edit:${product.id}:descricao` }],
            [{ text: product.ativo ? "⏸ Pausar" : "✅ Ativar", callback_data: `toggle_active:${product.id}` }, { text: "🗑️ REMOVER", callback_data: `confirm_del:${product.id}` }]
          ]
        };
        await sendTelegramMessage(chatId, editTxt, keyboard);
      } else if (chatId) {
        await sendTelegramMessage(chatId, `❌ Produto com REF <code>${ref}</code> não encontrado.`);
      }
      return;
    }

    // Comando: /remover [REF]
    if (text.startsWith("/remover ")) {
      const ref = text.split(" ")[1];
      const product = await productsRepository.getProductByIdOrSlug(ref);
      if (product && chatId) {
        const keyboard = {
          inline_keyboard: [
            [{ text: "🔥 CONFIRMAR REMOÇÃO", callback_data: `exec_del:${product.id}` }],
            [{ text: "❌ Cancelar", callback_data: `admin_edit:${product.id}` }]
          ]
        };
        await sendTelegramMessage(chatId, `🚨 <b>CONFIRMAR REMOÇÃO</b>\n\nProduto: <b>${product.produto}</b>\nREF: <code>${product.ref}</code>`, keyboard);
      } else if (chatId) {
        await sendTelegramMessage(chatId, `❌ Produto com REF <code>${ref}</code> não encontrado.`);
      }
      return;
    }

    // Comando: /categorias
    if (text.startsWith("/categorias")) {
      const cats = await categoriesRepository.getCategories();
      let catTxt = `📁 <b>CATEGORIAS DO CATÁLOGO</b>\n\n`;
      const buttons = [];
      
      for (const c of cats) {
        catTxt += `• ${c.name}\n`;
        buttons.push([{ text: `✏️ Renomear ${c.name}`, callback_data: `rename_cat_init:${c.name}` }]);
      }
      
      buttons.push([{ text: "➕ Adicionar Nova", callback_data: "add_cat_init" }]);
      
      if (chatId) {
        await sendTelegramMessage(chatId, catTxt, { inline_keyboard: buttons });
      }
      return;
    }

    // Detecção de links na mensagem
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);

    if (matches && matches.length > 0) {
      for (const link of matches) {
        const mkt = detectMarketplace(link);

        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `🔎 <b>Analisando a peça...</b>\n\n` +
            `🛒 <b>Marketplace:</b> ${mkt}\n` +
            `🔗 <code>${link}</code>`
          );
        }

        // Executa extração por IA + Scraper
        const extResult = await extractProductForReview(link);

        if (!extResult.success || !extResult.data) {
          if (chatId) {
            await sendTelegramMessage(
              chatId,
              `❌ <b>NÃO FOI POSSÍVEL EXTRAIR</b>\n\n` +
              `<b>Motivo:</b>\n${extResult.error || "Erro ao ler a página."}`
            );
          }
          continue;
        }

        const data = extResult.data;
        const reviewId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

        const review: PendingReview = {
          id: reviewId,
          chatId: chatId || 0,
          senderId,
          firstName,
          username,
          createdAt: Date.now(),
          ...data
        };

        await telegramRepo.savePendingReview(review);

        // Se o preço não for detectado (null ou <= 0), vincula o estado do usuário ao ID desta revisão
        if (!review.preco || review.preco <= 0) {
          await telegramRepo.setUserState(senderId, { action: "awaiting_price", reviewId });
        }

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

    // Se NÃO for comando e NÃO for link, processa como entrada de preço para a revisão pendente existente!
    let targetReview: PendingReview | null = null;
    const userState = await telegramRepo.getUserState(senderId);

    // Lidar com entradas de texto para estados administrativos
    if (userState && userState.action.startsWith("edit_field:")) {
      const field = userState.action.split(":")[1];
      const prodId = userState.productId;
      const update: any = {};
      
      if (field === "preco") {
        const p = parseAndNormalizePrice(text);
        if (p === null) {
          if (chatId) await sendTelegramMessage(chatId, "❌ Preço inválido. Tente novamente.");
          return;
        }
        update[field] = p;
      } else {
        update[field] = text;
      }
      
      await productsRepository.updateProduct(prodId, update);
      await telegramRepo.deleteUserState(senderId);
      if (chatId) await sendTelegramMessage(chatId, `✅ Campo <b>${field}</b> atualizado com sucesso!`);
      return;
    }

    if (userState && userState.action === "awaiting_price") {
      targetReview = await telegramRepo.getPendingReview(userState.reviewId);
    }

    if (!targetReview) {
      // Busca a revisão pendente existente vinculada ao usuário/chat ID
      targetReview = await telegramRepo.getLatestPendingReviewForUser(senderId, chatId);
    }

    const normPrice = parseAndNormalizePrice(text);

    if (!targetReview) {
      console.log(`
[TELEGRAM PRICE]
Chat/User: ${chatId || senderId} / ${username} (${firstName})
Preço recebido: "${text}"
Preço normalizado: ${normPrice !== null ? `R$ ${normPrice.toFixed(2)}` : "N/A"}
Revisão atualizada: Nenhuma
Resultado: Nenhuma revisão pendente encontrada
`);

      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `⚠️ <b>Nenhuma revisão pendente encontrada.</b>\n\n` +
          `Envie primeiro o link de um produto (Shopee, Mercado Livre, etc.) para cadastrar e revisar.`
        );
      }
      return;
    }

    if (normPrice !== null && normPrice > 0) {
      targetReview.preco = normPrice;
      await telegramRepo.savePendingReview(targetReview);
      await telegramRepo.deleteUserState(senderId);

      console.log(`
[TELEGRAM PRICE]
Chat/User: ${chatId || senderId} / ${username} (${firstName})
Preço recebido: "${text}"
Preço normalizado: R$ ${normPrice.toFixed(2)}
Revisão atualizada: ${targetReview.id}
Resultado: Preço atualizado com sucesso
`);

      const updatedCardText = buildReviewCardText(targetReview);
      const keyboard = buildMainReviewKeyboard(targetReview.id);

      if (chatId) {
        // Envia mensagem simples informando o preço salvo
        await sendTelegramMessage(
          chatId,
          `✅ <b>Preço atualizado para R$ ${normPrice.toFixed(2).replace(".", ",")}!</b>`
        );

        // Atualiza a legenda/texto do card de revisão existente
        let updatedOnCard = false;
        if (targetReview.cardMessageId) {
          const editRes = await editTelegramMessageCaption(
            chatId,
            targetReview.cardMessageId,
            updatedCardText,
            keyboard
          );
          if (editRes && editRes.ok) {
            updatedOnCard = true;
          }
        }

        // Se não conseguiu editar o card anterior, envia o card atualizado
        if (!updatedOnCard) {
          let sentMsg: any = null;
          if (targetReview.imagens && targetReview.imagens.length > 0) {
            sentMsg = await sendTelegramPhoto(chatId, targetReview.imagens[0], updatedCardText, keyboard);
          } else {
            sentMsg = await sendTelegramMessage(chatId, updatedCardText, keyboard);
          }
          if (sentMsg?.result?.message_id) {
            targetReview.cardMessageId = sentMsg.result.message_id;
            await telegramRepo.savePendingReview(targetReview);
          }
        }
      }
      return;
    } else {
      console.log(`
[TELEGRAM PRICE]
Chat/User: ${chatId || senderId} / ${username} (${firstName})
Preço recebido: "${text}"
Preço normalizado: N/A
Revisão atualizada: ${targetReview.id}
Resultado: Preço inválido (deve ser maior que zero)
`);

      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Preço inválido.</b>\n\n` +
          `Digite o preço de venda numérico desejado (Exemplo: <code>72</code>, <code>72,90</code> ou <code>R$ 72,90</code>).`
        );
      }
      return;
    }
  }
}

let isPolling = false;
let lastUpdateOffset = 0;

/**
 * Inicia o Long Polling do Telegram para garantir que o Bot responda instantaneamente
 * mesmo em ambientes sem suporte a Webhook direto (como containers com proxy/auth de preview).
 */
export function startTelegramPolling(): void {
  if (isPolling) {
    console.log("ℹ️ [Telegram Polling] Long Polling já está ativo.");
    return;
  }

  isPolling = true;
  console.log("🚀 [Telegram Polling] Iniciando serviço de Long Polling do Bot...");

  (async () => {
    while (isPolling) {
      const token = getBotToken();
      if (!token) {
        await new Promise((res) => setTimeout(res, 5000));
        continue;
      }

      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateOffset}&timeout=15`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            lastUpdateOffset = Math.max(lastUpdateOffset, update.update_id + 1);
            try {
              await handleTelegramWebhookUpdate(update);
            } catch (err) {
              console.error("[Telegram Polling] Erro ao processar update:", err);
            }
          }
        } else if (data.error_code === 409) {
          // Conflito: Webhook está ativo. Aguarda 20s antes de tentar novamente
          await new Promise((res) => setTimeout(res, 20000));
        } else {
          await new Promise((res) => setTimeout(res, 3000));
        }
      } catch (err: any) {
        console.warn("[Telegram Polling Warning] Falha na conexão do polling:", err?.message);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
}

