import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import {
  approveCampaign,
  cancelCampaign,
  confirmGeneralSend,
  createCampaignForProduct,
  renderCampaignTelegramPreview,
  retryFailedCampaign,
  sendCampaignTest,
  startGeneralSend,
  submitCampaignForApproval,
  updateCampaignSubjectAndPersist,
} from "./newsletterCampaignService";
import type { EmailCampaign } from "./newsletterCampaignState";
import {
  createSupabaseNewsletterCampaignStore,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";

export type CampaignTelegramDeps = {
  answerCallbackQuery: (callbackId: string, text?: string, showAlert?: boolean) => Promise<unknown>;
  editTelegramMessageText: (chatId: number | string, messageId: number, text: string, replyMarkup?: unknown) => Promise<unknown>;
  sendTelegramMessage: (chatId: number | string, text: string, replyMarkup?: unknown) => Promise<unknown>;
  store?: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>;
};

export async function handleNewsletterCampaignCallback(
  data: string,
  callbackId: string,
  senderId: string,
  chatId: number | string | undefined,
  messageId: number | undefined,
  deps: CampaignTelegramDeps,
): Promise<boolean> {
  if (!data.startsWith("campaign_")) return false;
  const env = deps.env || process.env;

  try {
    const store = deps.store || createSupabaseNewsletterCampaignStore();
    if (data.startsWith("campaign_email:")) {
      const productId = data.slice("campaign_email:".length);
      const campaign = await createCampaignForProduct(productId, senderId, { store, env });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia criada para aprovação.");
      return renderCampaign(deps, chatId, messageId, pending, [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${pending.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${pending.id}` }],
        [{ text: "❌ Cancelar campanha", callback_data: `campaign_cancel:${pending.id}` }],
      ]);
    }

    const campaignId = data.split(":")[1] || "";
    const campaign = await store.getCampaign(campaignId);
    if (!campaign) {
      await deps.answerCallbackQuery(callbackId, "Campanha não encontrada ou expirada.", true);
      return true;
    }

    if (data.startsWith("campaign_view:")) {
      await deps.answerCallbackQuery(callbackId);
      return renderCampaign(deps, chatId, messageId, campaign, campaignKeyboard(campaign));
    }

    if (data.startsWith("campaign_submit:")) {
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia enviada para aprovação.");
      return renderCampaign(deps, chatId, messageId, pending, campaignKeyboard(pending));
    }

    if (data.startsWith("campaign_approve:")) {
      const approved = await approveCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia aprovada. Agora envie o teste controlado.");
      return renderCampaign(deps, chatId, messageId, approved, campaignKeyboard(approved));
    }

    if (data.startsWith("campaign_test:")) {
      const result = await sendCampaignTest(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, result.providerResult.status === "duplicate" ? "Teste já processado." : "Teste processado.");
      const rendered = await renderCampaign(deps, chatId, messageId, result.campaign, campaignKeyboard(result.campaign));
      if (chatId) await deps.sendTelegramMessage(chatId, renderCampaignTestConfirmation(result.campaign, env.NEWSLETTER_TEST_EMAIL, env));
      return rendered;
    }

    if (data.startsWith("campaign_confirm_general:")) {
      const confirmed = await confirmGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Confirmação registrada. Revise antes de iniciar o envio geral.");
      return renderCampaign(deps, chatId, messageId, confirmed, campaignKeyboard(confirmed));
    }

    if (data.startsWith("campaign_start:")) {
      const sending = await startGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Envio geral enfileirado.");
      return renderCampaign(deps, chatId, messageId, sending, campaignKeyboard(sending));
    }

    if (data.startsWith("campaign_retry:")) {
      const retrying = await retryFailedCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Retry enfileirado para falhas.");
      return renderCampaign(deps, chatId, messageId, retrying, campaignKeyboard(retrying));
    }

    if (data.startsWith("campaign_cancel:")) {
      const cancelled = await cancelCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha cancelada.");
      return renderCampaign(deps, chatId, messageId, cancelled, campaignKeyboard(cancelled));
    }

    if (data.startsWith("campaign_subject_edit:")) {
      await telegramRepo.setUserState(senderId, { action: "campaign_subject", reviewId: campaign.id });
      await deps.answerCallbackQuery(callbackId, "Digite o novo assunto.");
      if (chatId) await deps.sendTelegramMessage(chatId, "✏️ <b>EDITAR ASSUNTO DA CAMPANHA</b>\n\nDigite um assunto entre 1 e 255 caracteres. Envie /cancelar para abandonar.");
      return true;
    }

    await deps.answerCallbackQuery(callbackId, "Ação de campanha não suportada.", true);
    return true;
  } catch (error) {
    await deps.answerCallbackQuery(callbackId, campaignErrorMessage(error), true);
    if (chatId) await deps.sendTelegramMessage(chatId, `⚠️ ${campaignErrorMessage(error)}`);
    return true;
  }
}

export function renderCampaignCompletionReport(campaign: EmailCampaign): string {
  const heading = campaign.status === "failed" ? "⚠️ <b>RELATÓRIO DE CAMPANHA COM FALHAS</b>" : "✅ <b>RELATÓRIO FINAL DA CAMPANHA</b>";
  return [
    heading,
    `Campanha: <code>${escapeTelegram(campaign.id)}</code>`,
    `Produto: <code>${escapeTelegram(campaign.productId)}</code>`,
    `Destinatários: <b>${campaign.counts.total}</b>`,
    `Sucesso: <b>${campaign.counts.success}</b>`,
    `Falhas: <b>${campaign.counts.failed}</b>`,
    `Ignorados: <b>${campaign.counts.skipped}</b>`,
    campaign.status === "failed" ? "As falhas permanecem retryable até uma ação humana de retry." : "Nenhum retry é necessário.",
  ].join("\n");
}

export function campaignCompletionKeyboard(campaign: Pick<EmailCampaign, "id" | "status">): any[][] {
  return campaign.status === "failed"
    ? [[{ text: "🔁 Retry falhas", callback_data: `campaign_retry:${campaign.id}` }]]
    : [];
}

function renderCampaignTestConfirmation(campaign: EmailCampaign, testEmail: string | undefined, env: NodeJS.ProcessEnv): string {
  const masked = maskEmail(testEmail || "") || "destino configurado";
  return [
    "🧪 <b>TESTE CONTROLADO PROCESSADO</b>",
    `Campanha: <code>${escapeTelegram(campaign.id)}</code>`,
    `Destino: <code>${escapeTelegram(masked)}</code>`,
    `Modo: <b>${env.DRY_RUN === "true" ? "DRY_RUN/fake" : "provider configurado"}</b>`,
    "O envio geral continua bloqueado até a confirmação humana explícita.",
  ].join("\n");
}

function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "";
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function handleNewsletterCampaignText(
  text: string,
  senderId: string,
  chatId: number | string | undefined,
  deps: CampaignTelegramDeps,
): Promise<boolean> {
  const state = await telegramRepo.getUserState(senderId);
  if (state?.action !== "campaign_subject" || !state.reviewId) return false;
  if (text.trim().toLowerCase() === "/cancelar") {
    await telegramRepo.deleteUserState(senderId);
    if (chatId) await deps.sendTelegramMessage(chatId, "❌ Edição do assunto cancelada.");
    return true;
  }
  try {
    const store = deps.store || createSupabaseNewsletterCampaignStore();
    const campaign = await store.getCampaign(state.reviewId);
    if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
    const updated = await updateCampaignSubjectAndPersist(campaign, text, { store, env: deps.env || process.env });
    await telegramRepo.deleteUserState(senderId);
      if (chatId) await deps.sendTelegramMessage(chatId, `✅ Assunto atualizado.\n\n${renderCampaignTelegramPreview(updated, await getCampaignProduct(updated.productId, deps.productLoader))}`, campaignKeyboard(updated));
  } catch (error) {
    if (chatId) await deps.sendTelegramMessage(chatId, `⚠️ ${campaignErrorMessage(error)}`);
  }
  return true;
}

export type TelegramCampaignListView = {
  text: string;
  keyboard: any[][];
};

export function renderRecentCampaignsForTelegram(campaigns: EmailCampaign[]): TelegramCampaignListView {
  const visible = campaigns.slice(0, 10);
  const text = visible.length === 0
    ? "📧 <b>CAMPANHAS RECENTES</b>\n\nNenhuma campanha encontrada."
    : [
        "📧 <b>CAMPANHAS RECENTES</b>",
        "Selecione uma campanha para reabrir o cartão e continuar somente pelo gate disponível.",
        ...visible.map((campaign, index) => `${index + 1}. <b>${escapeTelegram(campaign.status)}</b> · ${escapeTelegram(campaign.subject)}`),
      ].join("\n\n");
  const keyboard = visible.map(campaign => [{
    text: `${campaignStatusLabel(campaign.status)} · ${campaign.subject.slice(0, 42)}`,
    callback_data: `campaign_view:${campaign.id}`,
  }]);
  return { text, keyboard };
}

function campaignStatusLabel(status: EmailCampaign["status"]): string {
  const labels: Record<EmailCampaign["status"], string> = {
    draft: "📝 Rascunho",
    pending_approval: "⏳ Aguardando aprovação",
    approved: "✅ Aprovada; aguardando teste",
    test_sent: "🧪 Teste enviado",
    sending: "🚚 Enviando",
    sent: "🏁 Concluída",
    failed: "⚠️ Com falhas",
    cancelled: "❌ Cancelada",
  };
  return labels[status];
}

export function campaignKeyboard(campaign: EmailCampaign): any[][] {
  switch (campaign.status) {
    case "draft":
      return [
        [{ text: "📨 Enviar para aprovação", callback_data: `campaign_submit:${campaign.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${campaign.id}` }, { text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    case "pending_approval":
      return [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${campaign.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${campaign.id}` }, { text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    case "approved":
      return [
        [{ text: "🧪 Enviar teste controlado", callback_data: `campaign_test:${campaign.id}` }],
        [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    case "test_sent": {
      const generalSendConfirmed = Boolean(campaign.generalSendConfirmedAt && campaign.generalSendConfirmedByTelegramId);
      return [
        [{
          text: generalSendConfirmed ? "🚀 Iniciar envio geral" : "✅ Confirmar envio geral",
          callback_data: generalSendConfirmed
            ? `campaign_start:${campaign.id}`
            : `campaign_confirm_general:${campaign.id}`,
        }],
        [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    }
    case "sending":
      return [[{ text: "🔄 Atualizar status", callback_data: `campaign_view:${campaign.id}` }]];
    case "failed":
      return [
        [{ text: "🔁 Retry falhas", callback_data: `campaign_retry:${campaign.id}` }],
        [{ text: "🔄 Atualizar status", callback_data: `campaign_view:${campaign.id}` }],
      ];
    case "sent":
      return [[{ text: "✅ Campanha concluída", callback_data: `campaign_view:${campaign.id}` }]];
    case "cancelled":
      return [[{ text: "↩️ Ver campanha", callback_data: `campaign_view:${campaign.id}` }]];
  }
}

async function renderCampaign(
  deps: CampaignTelegramDeps,
  chatId: number | string | undefined,
  messageId: number | undefined,
  campaign: EmailCampaign,
  keyboard: any[][],
): Promise<boolean> {
  if (!chatId) return true;
  const product = await getCampaignProduct(campaign.productId, deps.productLoader);
  const text = renderCampaignTelegramPreview(campaign, product);
  if (messageId) await deps.editTelegramMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
  else await deps.sendTelegramMessage(chatId, text, { inline_keyboard: keyboard });
  return true;
}

async function getCampaignProduct(productId: string, productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>) {
  const product = await (productLoader || productsRepository.getProductByIdOrSlug)(productId);
  if (!product) throw new Error("CAMPAIGN_PRODUCT_NOT_FOUND");
  return product;
}

function escapeTelegram(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function campaignErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = new Set([
    "CAMPAIGN_PRODUCT_NOT_ELIGIBLE",
    "CAMPAIGN_PRODUCT_NOT_FOUND",
    "CAMPAIGN_NOT_FOUND",
    "CAMPAIGN_TEST_REQUIRES_APPROVAL",
    "NEWSLETTER_TEST_EMAIL_MISSING",
    "NEWSLETTER_TEST_EMAIL_NOT_ELIGIBLE",
    "CAMPAIGN_PUBLIC_BASE_URL_MISSING",
    "CAMPAIGN_PROVIDER_NOT_CONFIGURED",
    "CAMPAIGN_SUBJECT_INVALID",
    "CAMPAIGN_SUBJECT_LOCKED",
  ]);
  return known.has(message) ? message : "CAMPAIGN_OPERATION_FAILED";
}
