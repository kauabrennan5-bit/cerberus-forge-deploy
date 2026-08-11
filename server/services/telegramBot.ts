import dotenv from "dotenv";
import { processProductUrl, ProcessProductResult, detectMarketplace } from "./productAutomation";

dotenv.config();

export { detectMarketplace };

/**
 * Verifica se um usuário do Telegram está autorizado na Whitelist
 */
export function isUserAllowed(senderId: string | number): boolean {
  const allowedStr = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
  const allowedList = allowedStr.split(",").map((id) => id.trim()).filter(Boolean);

  if (allowedList.length === 0) {
    // Fail-Closed: se nenhuma whitelist estiver configurada, nenhum usuário é autorizado
    return false;
  }

  return allowedList.includes(String(senderId));
}

/**
 * Envia uma mensagem em formato HTML usando a API oficial do Telegram Bot
 */
export function sendTelegramMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: any
): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ [Telegram Bot Warning] TELEGRAM_BOT_TOKEN não está configurado no ambiente.");
    return Promise.resolve(null);
  }

  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: replyMarkup,
    }),
  })
    .then((res) => res.json())
    .catch((err) => {
      console.error("[Telegram Bot Error] Erro ao enviar mensagem:", err);
      return null;
    });
}

/**
 * Processador Assíncrono de Updates do Webhook (FASE 2 - Automação Completa de Produtos)
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  if (!update) return;

  // Lidar com mensagens de texto
  if (update.message && update.message.text) {
    const msg = update.message;
    const senderId = msg.from?.id || "Desconhecido";
    const firstName = msg.from?.first_name || "Anônimo";
    const username = msg.from?.username ? `@${msg.from.username}` : "N/A";
    const text: string = msg.text.trim();
    const chatId = msg.chat?.id;

    // 1. Validação de Whitelist por Telegram User ID
    if (!isUserAllowed(senderId)) {
      console.warn(
        `🔒 [Telegram Whitelist] Acesso bloqueado para usuário não autorizado: ID ${senderId} (${firstName} - ${username})`
      );
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🔒 <b>Acesso Negado</b>\n\n` +
            `Seu usuário do Telegram (ID: <code>${senderId}</code>) não está autorizado no Cerberus Finds Archive.`
        );
      }
      return;
    }

    // 2. Comandos básicos (/start e /help)
    if (text.startsWith("/start") || text.startsWith("/help")) {
      console.log(`[Telegram Bot Log] Comando ${text} executado por ${firstName} (${senderId})`);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🏴 <b>BOT CERBERUS FINDS ARCHIVE</b>\n\n` +
            `Sistema de Ingestão e Curadoria Automática Ativo!\n\n` +
            `👤 <b>Seu ID Telegram:</b> <code>${senderId}</code>\n` +
            `👤 <b>Usuário:</b> ${firstName} (${username})\n` +
            `✅ <b>Status Whitelist:</b> Autorizado\n\n` +
            `Envie um link de produto (Shopee, Mercado Livre, etc.) para cadastrar automaticamente no catálogo.`
        );
      }
      return;
    }

    // 3. Detecção e Processamento de Links na Mensagem
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);

    if (matches && matches.length > 0) {
      const siteBaseUrl = process.env.APP_URL || "https://cerberusfinds.com";

      for (const link of matches) {
        const mkt = detectMarketplace(link);
        console.log(`[Telegram Bot Log] Processando link de ${firstName} (${senderId}): ${link} (${mkt})`);

        // Notificação prévia de processamento
        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `🔎 <b>Analisando a peça...</b>\n\n` +
              `🛒 <b>Marketplace:</b> ${mkt}\n` +
              `🔗 <code>${link}</code>`
          );
        }

        // Executa a automação completa (Scraper -> Gemini -> Validação -> Deduplicação -> Repository)
        const result: ProcessProductResult = await processProductUrl(link, {
          senderId,
          firstName,
          username
        });

        if (!chatId) continue;

        if (result.action === "created" && result.product) {
          const p = result.product;
          const productUrl = `${siteBaseUrl}/produto/${p.slug || p.id}`;
          await sendTelegramMessage(
            chatId,
            `✅ <b>PEÇA ADICIONADA</b>\n\n` +
              `<b>CERBERUS FINDS ARCHIVE</b>\n\n` +
              `<b>Produto:</b> ${p.produto}\n` +
              `<b>Categoria:</b> ${p.categoria}\n` +
              `<b>Preço:</b> R$ ${p.preco.toFixed(2).replace(".", ",")}\n` +
              `<b>Status:</b> ${p.status === "published" ? "Publicado" : "Pendente"}\n` +
              `<b>REF:</b> ${p.ref}\n\n` +
              `🔗 <b>Ver produto:</b>\n${productUrl}`
          );
        } else if (result.action === "updated" && result.product) {
          const p = result.product;
          const oldP = result.oldPrice ? `R$ ${result.oldPrice.toFixed(2).replace(".", ",")}` : "N/A";
          const newP = result.newPrice ? `R$ ${result.newPrice.toFixed(2).replace(".", ",")}` : `R$ ${p.preco.toFixed(2).replace(".", ",")}`;
          const changesText = result.changedFields && result.changedFields.length > 0
            ? result.changedFields.map((f) => `• ${f}`).join("\n")
            : "• dados atualizados";
          const productUrl = `${siteBaseUrl}/produto/${p.slug || p.id}`;

          await sendTelegramMessage(
            chatId,
            `♻️ <b>PEÇA ATUALIZADA</b>\n\n` +
              `<b>${p.produto}</b>\n\n` +
              `<b>Preço anterior:</b> ${oldP}\n` +
              `<b>Preço atual:</b> ${newP}\n\n` +
              `<b>Alterações:</b>\n${changesText}\n\n` +
              `🔗 <b>Ver produto:</b>\n${productUrl}`
          );
        } else if (result.action === "unchanged" && result.product) {
          const p = result.product;
          const productUrl = `${siteBaseUrl}/produto/${p.slug || p.id}`;

          await sendTelegramMessage(
            chatId,
            `ℹ️ <b>PEÇA JÁ EXISTENTE</b>\n\n` +
              `O produto <b>${p.produto}</b> (REF: ${p.ref}) já está cadastrado e nenhuma alteração relevante foi encontrada.\n\n` +
              `🔗 <b>Ver produto:</b>\n${productUrl}`
          );
        } else {
          // Falha de processamento
          await sendTelegramMessage(
            chatId,
            `❌ <b>NÃO FOI POSSÍVEL CADASTRAR</b>\n\n` +
              `<b>Motivo:</b>\n${result.reason || "Erro desconhecido ao processar o anúncio."}\n\n` +
              `<i>Nenhum produto foi criado.</i>`
          );
        }
      }
    } else {
      console.log(`[Telegram Bot Log] Mensagem sem link de ${firstName} (${senderId}): "${text}"`);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `ℹ️ <b>Mensagem recebida.</b> Envie um link de produto (Shopee, Mercado Livre, etc.) para cadastrar no Cerberus Finds.`
        );
      }
    }
  }
}

