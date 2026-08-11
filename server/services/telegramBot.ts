import dotenv from "dotenv";
import { extractProductForReview, detectMarketplace, ExtractedReviewData } from "./productAutomation";
import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";

dotenv.config();

export { detectMarketplace };

// Token e Whitelist Padrão com Fallbacks Confiáveis
function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "8819631444:AAHaMTgMardKa9ZlRi4T2QEkEqmUck3tTeA";
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
    : `⚠️ <b>NÃO DETECTADO</b> (Clique em "💰 Alterar Preço" abaixo)`;

  const existingNotice = review.existingProduct
    ? `\n\n♻️ <i>Nota: Este produto já está cadastrado no acervo. Confirmar irá atualizar os dados.</i>`
    : "";

  return (
    `📋 <b>REVISÃO DE CADASTRO CERBERUS</b>\n\n` +
    `🏷️ <b>Produto:</b> ${review.produto}\n` +
    `📁 <b>Categoria:</b> ${review.categoria}\n` +
    `💰 <b>Preço:</b> ${priceFormatted}\n` +
    `🛒 <b>Marketplace:</b> ${review.marketplace}\n` +
    `🖼️ <b>Imagens:</b> ${review.imagens.length} encontradas\n` +
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

    // Ação: Confirmar & Publicar
    if (data.startsWith("confirm_pub:")) {
      const reviewId = data.split(":")[1];
      const review = await telegramRepo.getPendingReview(reviewId);

      if (!review) {
        await answerCallbackQuery(callbackId, "⚠️ Sessão de revisão expirada ou já finalizada.", true);
        return;
      }

      if (!review.preco || review.preco <= 0) {
        await answerCallbackQuery(
          callbackId,
          "⚠️ Defina um preço válido antes de publicar! Clique em '💰 Alterar Preço'.",
          true
        );
        return;
      }

      // Salva no Repositório de Produtos
      try {
        const siteBaseUrl = process.env.APP_URL || "https://cerberusfinds.com";
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

        await telegramRepo.deletePendingReview(reviewId);
        await telegramRepo.deleteUserState(senderId);

        await answerCallbackQuery(callbackId, "✅ Peça publicada com sucesso!");

        const productUrl = `${siteBaseUrl}/produto/${publishedProduct?.slug || publishedProduct?.id}`;
        const successText =
          `✅ <b>PEÇA PUBLICADA COM SUCESSO!</b>\n\n` +
          `<b>CERBERUS FINDS ARCHIVE</b>\n\n` +
          `🏷️ <b>Produto:</b> ${publishedProduct?.produto || review.produto}\n` +
          `📁 <b>Categoria:</b> ${publishedProduct?.categoria || review.categoria}\n` +
          `💰 <b>Preço:</b> R$ ${review.preco.toFixed(2).replace(".", ",")}\n` +
          `🆔 <b>REF:</b> ${publishedProduct?.ref || 'N/A'}\n\n` +
          `🔗 <b>Ver no site:</b>\n${productUrl}`;

        if (chatId && messageId) {
          await editTelegramMessageCaption(chatId, messageId, successText);
        } else if (chatId) {
          await sendTelegramMessage(chatId, successText);
        }
      } catch (err: any) {
        console.error("[Telegram Review Publish Error]:", err);
        await answerCallbackQuery(callbackId, "❌ Erro ao publicar produto no banco de dados.", true);
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

    // Se o usuário estiver no estado de digitação manual de preço
    const userState = await telegramRepo.getUserState(senderId);
    if (userState && userState.action === "awaiting_price") {
      const review = await telegramRepo.getPendingReview(userState.reviewId);
      if (review) {
        const parsedPrice = parseFloat(text.replace("R$", "").replace(",", ".").trim());
        if (isNaN(parsedPrice) || parsedPrice <= 0) {
          if (chatId) {
            await sendTelegramMessage(
              chatId,
              `❌ <b>Preço inválido.</b> Digite um valor numérico válido (ex: <code>89,90</code> ou <code>120</code>).`
            );
          }
          return;
        }

        review.preco = parsedPrice;
        await telegramRepo.savePendingReview(review);
        await telegramRepo.deleteUserState(senderId);

        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `✅ <b>Preço atualizado para R$ ${parsedPrice.toFixed(2).replace(".", ",")}!</b>\n\n` +
            `Acesse o card de revisão acima e clique em "✅ Confirmar & Publicar".`
          );
        }
        return;
      } else {
        await telegramRepo.deleteUserState(senderId);
      }
    }

    // Comandos básicos (/start e /help)
    if (text.startsWith("/start") || text.startsWith("/help")) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🏴 <b>BOT CERBERUS FINDS ARCHIVE</b>\n\n` +
          `Modo de Revisão e Curadoria Ativo!\n\n` +
          `👤 <b>Seu ID Telegram:</b> <code>${senderId}</code>\n` +
          `👤 <b>Usuário:</b> ${firstName} (${username})\n` +
          `✅ <b>Status Whitelist:</b> Autorizado\n\n` +
          `Envie um link de produto (Shopee, Mercado Livre, etc.) para extrair e revisar os dados antes de publicar.`
        );
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

        const cardText = buildReviewCardText(review);
        const keyboard = buildMainReviewKeyboard(reviewId);

        if (chatId) {
          if (review.imagens && review.imagens.length > 0) {
            await sendTelegramPhoto(chatId, review.imagens[0], cardText, keyboard);
          } else {
            await sendTelegramMessage(chatId, cardText, keyboard);
          }
        }
      }
    } else {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `ℹ️ Envie um link de produto (Shopee, Mercado Livre, etc.) para cadastrar e revisar no Cerberus Finds.`
        );
      }
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

