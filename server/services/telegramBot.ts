import dotenv from "dotenv";

dotenv.config();

/**
 * Detecta o marketplace a partir de uma URL
 */
export function detectMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("shopee.com.br") || hostname.includes("shope.ee")) {
      return "Shopee";
    }
    if (
      hostname.includes("mercadolivre.com.br") ||
      hostname.includes("mercadolibre.com") ||
      hostname.includes("mercadolivre.com")
    ) {
      return "Mercado Livre";
    }
    return "Outro / E-Commerce Generalista";
  } catch {
    if (url.includes("shopee") || url.includes("shope.ee")) return "Shopee";
    if (url.includes("mercadolivre") || url.includes("mercadolibre")) return "Mercado Livre";
    return "Outro / Desconhecido";
  }
}

/**
 * Verifica se um usuário do Telegram está autorizado na Whitelist
 */
export function isUserAllowed(senderId: string | number): boolean {
  const allowedStr = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
  const allowedList = allowedStr.split(",").map((id) => id.trim()).filter(Boolean);

  if (allowedList.length === 0) {
    // Se nenhuma restrição for configurada, permite o acesso em dev
    return true;
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
 * Processador Assíncrono de Updates do Webhook (FASE 4.1 - Apenas registro e infraestrutura)
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
      return;
    }

    // 2. Comandos básicos (/start e /help)
    if (text.startsWith("/start") || text.startsWith("/help")) {
      console.log(`[Telegram Bot Log] Comando ${text} executado por ${firstName} (${senderId})`);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `🏴 <b>BOT CERBERUS FINDS - FASE 4.1 (INFRAESTRUTURA)</b>\n\n` +
            `Infraestrutura ativa com sucesso!\n\n` +
            `👤 <b>Seu ID Telegram:</b> <code>${senderId}</code>\n` +
            `👤 <b>Usuário:</b> ${firstName} (${username})\n` +
            `✅ <b>Status Whitelist:</b> Autorizado\n\n` +
            `Envie um link da Shopee ou Mercado Livre para registrar o log no servidor.`
        );
      }
      return;
    }

    // 3. Detecção de Links na Mensagem
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);

    if (matches && matches.length > 0) {
      for (const link of matches) {
        const marketplace = detectMarketplace(link);
        const isoDate = new Date().toISOString();

        // Registra logs detalhados exigidos na Fase 4.1
        console.log(`
=== [TELEGRAM WEBHOOK - FASE 4.1 REGISTRO DE LINK] ===
📅 Data/Hora: ${isoDate}
👤 Usuário ID: ${senderId}
👤 Nome: ${firstName}
👤 Username: ${username}
🔗 Link Recebido: ${link}
🛒 Marketplace Detectado: ${marketplace}
======================================================
`);

        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `📥 <b>Link Recebido com Sucesso! (Fase 4.1)</b>\n\n` +
              `🛒 <b>Marketplace:</b> ${marketplace}\n` +
              `🔗 <b>URL:</b> <code>${link}</code>\n` +
              `📅 <b>Data:</b> ${isoDate}\n\n` +
              `ℹ️ <i>Link registrado nos logs de infraestrutura do servidor.</i>`
          );
        }
      }
    } else {
      console.log(`[Telegram Bot Log] Mensagem sem link de ${firstName} (${senderId}): "${text}"`);
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `ℹ️ <b>Mensagem recebida.</b> Envie um link de produto (Shopee ou Mercado Livre) para teste da infraestrutura.`
        );
      }
    }
  }
}
