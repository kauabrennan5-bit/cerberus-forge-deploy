import * as core from "./telegramBotCore";
import * as productsRepository from "../repositories/productsRepository";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { resolvePublicSiteUrl } from "./newsletterInstitutional";
import {
  approveProductRotation,
  cancelProductRotation,
  getProductRotationRequest,
  proposeNextProductRotationCandidate,
  rejectRotationCandidateAndSearchAgain,
  startProductRotation,
  type RotationProposal,
} from "./productRotation";

export * from "./telegramBotCore";

// Structural Telegram V2 contract remains implemented in telegramBotCore.ts,
// including parseTelegramCommand(text) and shouldProcessTelegramUpdate.

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function money(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0
    ? `R$ ${amount.toFixed(2).replace(".", ",")}`
    : "não informado";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "UNKNOWN"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
}

function rotationKeyboard(requestId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Aprovar substituição", callback_data: `rotation_approve:${requestId}` }],
      [{ text: "🔁 Buscar outra opção", callback_data: `rotation_retry:${requestId}` }],
      [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }],
    ],
  };
}

function searchingKeyboard(requestId: string) {
  return {
    inline_keyboard: [[{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]],
  };
}

async function sendRotationProposal(proposal: RotationProposal): Promise<void> {
  const { request, source, candidate, score } = proposal;
  const sourceTitle = source.displayTitle || source.produto;
  const candidateTitle = candidate.displayTitle || candidate.produto;
  const caption = [
    "🔄 <b>CERBERUS — PROPOSTA DE ROTAÇÃO</b>",
    "",
    "<b>Peça atual</b>",
    `• ${escapeHtml(sourceTitle)}`,
    `• ${escapeHtml(source.ref || source.id)}`,
    `• ${money(source.preco)}`,
    "",
    "⬇️ <b>Substituir por</b>",
    `• ${escapeHtml(candidateTitle)}`,
    `• ${escapeHtml(candidate.ref || candidate.id)}`,
    `• ${money(candidate.preco)}`,
    `• Categoria: ${escapeHtml(candidate.categoria)}`,
    `• Score Cerberus: <b>${Math.round(score)}/100</b>`,
    "",
    "✅ Identidade Shopee, disponibilidade, link afiliado, imagem, título editorial, preço, categoria e pipeline foram revalidados.",
    "",
    "<i>A peça atual continua publicada. Nada será substituído até você aprovar.</i>",
  ].join("\n");
  const image = resolveCanonicalProductImage(candidate).primaryImageUrl || candidate.imagens?.[0];
  if (image && /^https:\/\//i.test(image)) {
    const sent = await core.sendTelegramPhoto(request.telegramChatId, image, caption, rotationKeyboard(request.id));
    if (sent.ok) return;
  }
  await core.sendTelegramMessage(request.telegramChatId, caption, rotationKeyboard(request.id));
}

async function searchAndDeliverRotation(requestId: string, chatId: string | number): Promise<void> {
  try {
    const proposal = await proposeNextProductRotationCandidate(requestId);
    await sendRotationProposal(proposal);
  } catch (error) {
    await core.sendTelegramMessage(
      chatId,
      "⚠️ <b>ROTAÇÃO SEM CANDIDATO APROVADO</b>\n\n" +
        `Motivo: <code>${escapeHtml(safeError(error))}</code>\n\n` +
        "A peça atual continua publicada e nenhuma troca foi feita.",
      { inline_keyboard: [[{ text: "🔁 Tentar novamente", callback_data: `rotation_retry:${requestId}` }], [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]] },
    );
  }
}

async function applyRotationAndNotify(requestId: string, chatId: string | number): Promise<void> {
  try {
    const applied = await approveProductRotation(requestId);
    await core.sendTelegramMessage(
      chatId,
      "✅ <b>ROTAÇÃO CONCLUÍDA</b>\n\n" +
        `${escapeHtml(applied.source.displayTitle || applied.source.produto)}\n` +
        "⬇️ substituído por\n" +
        `<b>${escapeHtml(applied.replacement.displayTitle || applied.replacement.produto)}</b>\n\n` +
        `Categoria: ${escapeHtml(applied.replacement.categoria)}\n` +
        `Preço: ${money(applied.replacement.preco)}\n\n` +
        "✅ Nova peça publicada\n✅ Catálogo público sincronizado\n✅ Peça anterior arquivada como <code>ROTATED_BY_USER</code>",
      { inline_keyboard: [[{ text: "👁️ Ver nova peça", callback_data: `product_view:${applied.replacement.id}` }], [{ text: "📦 Produtos", callback_data: "products_list:0" }]] },
    );
  } catch (error) {
    await core.sendTelegramMessage(
      chatId,
      "❌ <b>ROTAÇÃO NÃO APLICADA</b>\n\n" +
        `Motivo: <code>${escapeHtml(safeError(error))}</code>\n\n` +
        "O Cerberus executou o rollback quando necessário. A peça anterior não deve ser removida sem uma sincronização pública confirmada.",
      { inline_keyboard: [[{ text: "🔁 Tentar aprovação novamente", callback_data: `rotation_approve:${requestId}` }], [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]] },
    );
  }
}

async function renderProductWithRotation(chatId: string | number, messageId: number, productId: string): Promise<void> {
  const product = await productsRepository.getProductByIdOrSlug(productId);
  if (!product) {
    await core.editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "products_list:0" }]] });
    return;
  }
  const activePublished = product.ativo !== false && (!product.status || product.status === "approved" || product.status === "published");
  const text = `👁️ <b>DETALHES DO PRODUTO</b>\n\n` +
    `<b>Nome:</b> ${escapeHtml(product.displayTitle || product.produto)}\n` +
    `<b>REF:</b> <code>${escapeHtml(product.ref || product.id)}</code>\n` +
    `<b>Preço:</b> ${money(product.preco)}\n` +
    `<b>Categoria:</b> ${escapeHtml(product.categoria)}\n` +
    `<b>Status:</b> ${product.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n` +
    `<b>Destaque:</b> ${product.destaque ? "Sim" : "Não"}\n`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "🎯 Ver Analytics", callback_data: `analytics_product:${product.id}:7d` }],
      ...(activePublished ? [[{ text: "🔄 Rotacionar peça", callback_data: `product_rotate:${product.id}` }]] : []),
      ...(activePublished ? [[{ text: "📧 Criar campanha", callback_data: `campaign_email:${product.id}` }]] : []),
      [{ text: "✏️ Editar", callback_data: `product_edit:${product.id}` }, { text: "🗄️ Arquivar", callback_data: `product_del_confirm:${product.id}` }],
      [{ text: "🔗 Abrir no Site", url: `${resolvePublicSiteUrl()}/produto/${encodeURIComponent(product.slug || product.id)}` }],
      [{ text: "⬅️ Voltar", callback_data: "products_list:0" }],
    ],
  };
  await core.editTelegramMessageText(chatId, messageId, text, keyboard);
}

function customRotationCallback(data: string): boolean {
  return data.startsWith("product_view:")
    || data.startsWith("product_rotate:")
    || data.startsWith("rotation_approve:")
    || data.startsWith("rotation_retry:")
    || data.startsWith("rotation_cancel:");
}

/**
 * Thin extension over the proven Telegram bot. The original implementation is
 * preserved byte-for-byte in telegramBotCore.ts; only product detail/rotation
 * callbacks are intercepted here.
 */
export async function handleTelegramWebhookUpdate(update: any): Promise<void> {
  const cb = update?.callback_query;
  const data = String(cb?.data || "");
  if (!cb || !customRotationCallback(data)) {
    return core.handleTelegramWebhookUpdate(update);
  }

  if (!core.shouldProcessTelegramUpdate(update?.update_id)) return;
  const callbackId = String(cb.id || "");
  const senderId = cb.from?.id;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!core.isUserAllowed(senderId)) {
    await core.answerCallbackQuery(callbackId, "🔒 Acesso não autorizado.", true);
    return;
  }
  if (!chatId) {
    await core.answerCallbackQuery(callbackId, "Chat inválido.", true);
    return;
  }

  if (data.startsWith("product_view:")) {
    await core.answerCallbackQuery(callbackId);
    if (messageId) await renderProductWithRotation(chatId, messageId, data.slice("product_view:".length));
    return;
  }

  if (data.startsWith("product_rotate:")) {
    const productId = data.slice("product_rotate:".length);
    try {
      const request = await startProductRotation({ sourceProductId: productId, requestedBy: senderId, telegramChatId: chatId });
      await core.answerCallbackQuery(callbackId, "Buscando substituto...");
      await core.sendTelegramMessage(
        chatId,
        "🔄 <b>ROTAÇÃO INICIADA</b>\n\nO produto atual continuará no site enquanto o Cerberus procura e revalida um substituto da mesma categoria.",
        searchingKeyboard(request.id),
      );
      void searchAndDeliverRotation(request.id, chatId);
    } catch (error) {
      await core.answerCallbackQuery(callbackId, "Não foi possível iniciar a rotação.", true);
      await core.sendTelegramMessage(chatId, `⚠️ <b>ROTAÇÃO NÃO INICIADA</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  const requestId = data.split(":")[1] || "";
  if (data.startsWith("rotation_retry:")) {
    await core.answerCallbackQuery(callbackId, "Buscando outra opção...");
    if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    try {
      const current = await getProductRotationRequest(requestId);
      if (!current || ["cancelled", "replaced", "applying"].includes(current.status)) throw new Error(`ROTATION_NOT_RETRYABLE:${current?.status || "missing"}`);
      const request = current.status === "candidate_ready" && current.candidateProductId
        ? await rejectRotationCandidateAndSearchAgain(requestId)
        : current;
      await core.sendTelegramMessage(
        chatId,
        current.status === "candidate_ready"
          ? "🔎 <b>OUTRA OPÇÃO SOLICITADA</b>\n\nO candidato anterior foi rejeitado. A peça atual continua publicada enquanto uma nova opção é procurada."
          : "🔎 <b>NOVA TENTATIVA DE ROTAÇÃO</b>\n\nO Cerberus voltou a procurar um candidato qualificado. A peça atual continua publicada.",
        searchingKeyboard(request.id),
      );
      void searchAndDeliverRotation(request.id, chatId);
    } catch (error) {
      await core.sendTelegramMessage(chatId, `⚠️ <b>NÃO FOI POSSÍVEL BUSCAR OUTRA OPÇÃO</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  if (data.startsWith("rotation_cancel:")) {
    await core.answerCallbackQuery(callbackId, "Rotação cancelada.");
    if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    try {
      await cancelProductRotation(requestId);
      await core.sendTelegramMessage(chatId, "❌ <b>ROTAÇÃO CANCELADA</b>\n\nNenhuma substituição foi feita. A peça atual permanece publicada.");
    } catch (error) {
      await core.sendTelegramMessage(chatId, `⚠️ <b>FALHA AO CANCELAR ROTAÇÃO</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  if (data.startsWith("rotation_approve:")) {
    await core.answerCallbackQuery(callbackId, "Revalidando e aplicando substituição...");
    if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    await core.sendTelegramMessage(chatId, "🚀 <b>APROVAÇÃO RECEBIDA</b>\n\nO candidato será revalidado novamente antes da troca. O produto antigo só sai depois da sincronização segura do catálogo.");
    void applyRotationAndNotify(requestId, chatId);
    return;
  }

  return core.handleTelegramWebhookUpdate(update);
}
