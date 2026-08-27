import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import {
  approveCampaign,
  cancelCampaign,
  confirmGeneralSend,
  createCampaignForProduct,
  createWeeklyCollectionCampaign,
  createWelcomeCampaignForSubscribers,
  renderCampaignTelegramPreview,
  retryFailedCampaign,
  sendCampaignTest,
  startGeneralSend,
  submitCampaignForApproval,
  updateCampaignSubjectAndPersist,
} from "./newsletterCampaignService";
import type { EmailCampaign } from "./newsletterCampaignState";
import type { NewsletterCampaignProvider } from "./newsletterProvider";
import {
  createSupabaseNewsletterCampaignStore,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";

const campaignCallbackLocks = new Map<string, Promise<void>>();

export type CampaignTelegramDeps = {
  answerCallbackQuery: (callbackId: string, text?: string, showAlert?: boolean) => Promise<unknown>;
  editTelegramMessageText: (chatId: number | string, messageId: number, text: string, replyMarkup?: unknown) => Promise<unknown>;
  sendTelegramMessage: (chatId: number | string, text: string, replyMarkup?: unknown) => Promise<unknown>;
  store?: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  provider?: NewsletterCampaignProvider;
  productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>;
  productsLoader?: () => Promise<import("../../src/types").Product[]>;
  now?: Date;
  collectionSince?: Date | null;
  collectionUntil?: Date | null;
  collectionSize?: number;
  minimumCollectionProducts?: number;
  verifyImageAccessibility?: boolean;
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
  const campaignId = data.split(":")[1] || "";
  if (!campaignId) return handleNewsletterCampaignCallbackOnce(data, callbackId, senderId, chatId, messageId, deps);
  const previous = campaignCallbackLocks.get(campaignId) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  campaignCallbackLocks.set(campaignId, tail);
  await previous;
  try {
    return await handleNewsletterCampaignCallbackOnce(data, callbackId, senderId, chatId, messageId, deps);
  } finally {
    release();
    if (campaignCallbackLocks.get(campaignId) === tail) campaignCallbackLocks.delete(campaignId);
  }
}

async function handleNewsletterCampaignCallbackOnce(
  data: string,
  callbackId: string,
  senderId: string,
  chatId: number | string | undefined,
  messageId: number | undefined,
  deps: CampaignTelegramDeps,
): Promise<boolean> {
  const env = deps.env || process.env;
  const campaignId = data.split(":")[1] || "";

  try {
    const store = deps.store || createSupabaseNewsletterCampaignStore();
    if (data === "campaign_collection") {
      const campaign = await createWeeklyCollectionCampaign(senderId, {
        store,
        env,
        productsLoader: deps.productsLoader,
        now: deps.now,
            collectionSince: deps.collectionSince,
    collectionUntil: deps.collectionUntil,
    collectionSize: deps.collectionSize,
    minimumCollectionProducts: deps.minimumCollectionProducts,
    verifyImageAccessibility: deps.verifyImageAccessibility,

      });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha 2 criada para aprovação.");
      return renderCampaignWithFallback(deps, chatId, messageId, pending, [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${pending.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${pending.id}` }],
        [{ text: "❌ Cancelar campanha", callback_data: `campaign_cancel:${pending.id}` }],
      ]);
    }

    if (data.startsWith("campaign_email:")) {
      const productId = data.slice("campaign_email:".length);
      const campaign = await createCampaignForProduct(productId, senderId, { store, env });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia criada para aprovação.");
      return renderCampaignWithFallback(deps, chatId, messageId, pending, [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${pending.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${pending.id}` }],
        [{ text: "❌ Cancelar campanha", callback_data: `campaign_cancel:${pending.id}` }],
      ]);
    }

    if (data === "campaign_welcome") {
      const campaign = await createWelcomeCampaignForSubscribers(senderId, { store, env });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha de boas-vindas criada para aprovação.");
      return renderCampaignWithFallback(deps, chatId, messageId, pending, [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${pending.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${pending.id}` }],
        [{ text: "❌ Cancelar campanha", callback_data: `campaign_cancel:${pending.id}` }],
      ]);
    }

    const campaign = await store.getCampaign(campaignId);
    if (!campaign) {
      await deps.answerCallbackQuery(callbackId, "Campanha não encontrada ou expirada.", true);
      return true;
    }

    if (data.startsWith("campaign_view:")) {
      await deps.answerCallbackQuery(callbackId);
      return renderCampaignWithFallback(deps, chatId, messageId, campaign, campaignKeyboard(campaign));
    }

    if (data.startsWith("campaign_submit:")) {
      if (campaign.status !== "draft") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia enviada para aprovação.");
      return renderCampaignWithFallback(deps, chatId, messageId, pending, campaignKeyboard(pending));
    }

    if (data.startsWith("campaign_approve:")) {
      if (campaign.status !== "pending_approval") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const approved = await approveCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia aprovada. Agora envie o teste controlado.");
      return renderCampaignWithFallback(deps, chatId, messageId, approved, campaignKeyboard(approved));
    }

    if (data.startsWith("campaign_test:")) {
      if (campaign.status !== "approved") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const result = await sendCampaignTest(campaign, senderId, { store, env, provider: deps.provider });
      await deps.answerCallbackQuery(callbackId, result.providerResult.status === "duplicate" ? "Teste já processado." : "Teste processado.");
      const rendered = await renderCampaignWithFallback(deps, chatId, messageId, result.campaign, campaignKeyboard(result.campaign));
      if (chatId) await deps.sendTelegramMessage(chatId, renderCampaignTestConfirmation(result.campaign, env.NEWSLETTER_TEST_EMAIL, env));
      return rendered;
    }

    if (data.startsWith("campaign_confirm_general:")) {
      if (campaign.status !== "test_sent") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const confirmed = await confirmGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Confirmação registrada. Revise antes de iniciar o envio geral.");
      return renderCampaignWithFallback(deps, chatId, messageId, confirmed, campaignKeyboard(confirmed));
    }

    if (data.startsWith("campaign_start:")) {
      if (campaign.status !== "test_sent" && campaign.status !== "failed") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const sending = await startGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Envio geral enfileirado.");
      return renderCampaignWithFallback(deps, chatId, messageId, sending, campaignKeyboard(sending));
    }

    if (data.startsWith("campaign_retry:")) {
      if (campaign.status !== "failed") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const retrying = await retryFailedCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Retry enfileirado para falhas.");
      return renderCampaignWithFallback(deps, chatId, messageId, retrying, campaignKeyboard(retrying));
    }

    if (data.startsWith("campaign_cancel:")) {
      if (campaign.status === "sent" || campaign.status === "cancelled") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const cancelled = await cancelCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha cancelada.");
      return renderCampaignWithFallback(deps, chatId, messageId, cancelled, campaignKeyboard(cancelled));
    }

    if (data.startsWith("campaign_subject_edit:")) {
      if (campaign.status !== "draft" && campaign.status !== "pending_approval") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      await telegramRepo.setUserState(senderId, { action: "campaign_subject", reviewId: campaign.id });
      await deps.answerCallbackQuery(callbackId, "Digite o novo assunto.");
      if (chatId) await deps.sendTelegramMessage(chatId, "✏️ <b>EDITAR ASSUNTO DA CAMPANHA</b>\n\nDigite um assunto entre 1 e 255 caracteres. Envie /cancelar para abandonar.");
      return true;
    }

    await deps.answerCallbackQuery(callbackId, "Ação de campanha não suportada.", true);
    return true;
  } catch (error) {
    const errorMessage = campaignErrorMessage(error);
    await deps.answerCallbackQuery(callbackId, errorMessage, true);
    if (chatId) {
      await deps.sendTelegramMessage(chatId, `⚠️ ${errorMessage}`);
      if (campaignId) {
        try {
          const store = deps.store || createSupabaseNewsletterCampaignStore();
          const current = await store.getCampaign(campaignId);
          if (current) await renderCampaignWithFallback(deps, chatId, messageId, current, campaignKeyboard(current));
        } catch {
          await deps.sendTelegramMessage(chatId, "⚠️ Não foi possível recarregar o estado atual da campanha.");
        }
      }
    }
    return true;
  }
}

export function renderCampaignCompletionReport(campaign: EmailCampaign): string {
  const noRecipients = campaign.counts.total === 0;
  const heading = campaign.status === "failed" ? "⚠️ <b>RELATÓRIO DE CAMPANHA COM FALHAS</b>" : "✅ <b>RELATÓRIO FINAL DA CAMPANHA</b>";
  const outcome = noRecipients
    ? "Campanha encerrada sem envio: não havia destinatários elegíveis."
    : campaign.status === "failed"
      ? "As falhas permanecem retryable até uma ação humana de retry."
      : "Nenhum retry é necessário.";
  return [
    heading,
    `Campanha: <code>${escapeTelegram(campaign.id)}</code>`,
    campaign.campaignType === "welcome"
      ? "Tipo: <b>Boas-vindas institucional</b>"
      : `Produto: <code>${escapeTelegram(campaign.productId)}</code>`,
    `Destinatários: <b>${campaign.counts.total}</b>`,
    `Sucesso: <b>${campaign.counts.success}</b>`,
    `Falhas: <b>${campaign.counts.failed}</b>`,
    `Ignorados: <b>${campaign.counts.skipped}</b>`,
    outcome,
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
      if (chatId) {
        const collectionProducts = updated.campaignType === "collection" ? await getCampaignProducts(updated, deps.productLoader) : [];
        const product = updated.campaignType === "welcome" || updated.campaignType === "collection"
          ? null
          : await getCampaignProduct(updated.productId, deps.productLoader);
        await deps.sendTelegramMessage(chatId, `✅ Assunto atualizado.\n\n${renderCampaignTelegramPreview(updated, product, collectionProducts)}`, campaignKeyboard(updated));
      }
  } catch (error) {
    const errorMessage = campaignErrorMessage(error);
    if (chatId) {
      await deps.sendTelegramMessage(chatId, `⚠️ ${errorMessage}`);
      if (state?.reviewId) {
        try {
          const store = deps.store || createSupabaseNewsletterCampaignStore();
          const current = await store.getCampaign(state.reviewId);
          if (current) await renderCampaignWithFallback(deps, chatId, undefined, current, campaignKeyboard(current));
        } catch {
          await deps.sendTelegramMessage(chatId, "⚠️ Não foi possível recarregar o estado atual da campanha.");
        }
      }
    }
  }
  return true;
}

export async function handleCollectionCampaignCommand(
  senderId: string,
  chatId: number | string | undefined,
  deps: CampaignTelegramDeps,
): Promise<boolean> {
  try {
    const store = deps.store || createSupabaseNewsletterCampaignStore();
    const env = deps.env || process.env;
    const campaign = await createWeeklyCollectionCampaign(senderId, {
      store,
      env,
      productsLoader: deps.productsLoader,
      now: deps.now,
      collectionSince: deps.collectionSince,
      collectionUntil: deps.collectionUntil,
      collectionSize: deps.collectionSize,
      minimumCollectionProducts: deps.minimumCollectionProducts,
      verifyImageAccessibility: deps.verifyImageAccessibility,
    });
    const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
    return renderCampaign(deps, chatId, undefined, pending, campaignKeyboard(pending));
  } catch (error) {
    if (chatId) await deps.sendTelegramMessage(chatId, `⚠️ ${campaignErrorMessage(error)}`);
    return true;
  }
}

export async function handleWelcomeCampaignCommand(
  senderId: string,
  chatId: number | string | undefined,
  deps: CampaignTelegramDeps,
): Promise<boolean> {
  try {
    const store = deps.store || createSupabaseNewsletterCampaignStore();
    const env = deps.env || process.env;
    const campaign = await createWelcomeCampaignForSubscribers(senderId, { store, env });
    const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
    return renderCampaign(deps, chatId, undefined, pending, campaignKeyboard(pending));
  } catch (error) {
    if (chatId) await deps.sendTelegramMessage(chatId, `⚠️ ${campaignErrorMessage(error)}`);
    return true;
  }
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

async function handleIncompatibleCampaignCallback(
  deps: CampaignTelegramDeps,
  callbackId: string,
  chatId: number | string | undefined,
  messageId: number | undefined,
  campaign: EmailCampaign,
): Promise<boolean> {
  const statusMessage = `Ação ignorada de forma idempotente: o estado autoritativo atual é ${campaign.status}.`;
  await deps.answerCallbackQuery(callbackId, statusMessage, true);
  return renderCampaignWithFallback(deps, chatId, messageId, campaign, campaignKeyboard(campaign));
}

async function renderCampaignWithFallback(
  deps: CampaignTelegramDeps,
  chatId: number | string | undefined,
  messageId: number | undefined,
  campaign: EmailCampaign,
  keyboard: any[][],
): Promise<boolean> {
  try {
    return await renderCampaign(deps, chatId, messageId, campaign, keyboard);
  } catch {
    if (!chatId) return true;
    const staleCardMessage = [
      "⚠️ <b>CARTÃO DE CAMPANHA DESATUALIZADO</b>",
      `Estado autoritativo: <code>${escapeTelegram(campaign.status)}</code>`,
      "O cartão anterior não pôde ser redesenhado automaticamente.",
      "Nenhuma ação adicional foi executada. Use a listagem de campanhas para reabrir o estado atual.",
    ].join("\n");
    await deps.sendTelegramMessage(chatId, staleCardMessage);
    return true;
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
  const collectionProducts = campaign.campaignType === "collection"
    ? await getCampaignProducts(campaign, deps.productLoader)
    : [];
  const product = campaign.campaignType === "welcome" || campaign.campaignType === "collection"
    ? null
    : await getCampaignProduct(campaign.productId, deps.productLoader);
  const text = renderCampaignTelegramPreview(campaign, product, collectionProducts);
  if (messageId) await deps.editTelegramMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
  else await deps.sendTelegramMessage(chatId, text, { inline_keyboard: keyboard });
  return true;
}

async function getCampaignProducts(campaign: EmailCampaign, productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>) {
  const products = await Promise.all(campaign.collectionProducts.map(link => getCampaignProduct(link.productId, productLoader)));
  if (products.some(product => !product)) throw new Error("CAMPAIGN_COLLECTION_PRODUCT_NOT_FOUND");
  return products as import("../../src/types").Product[];
}

async function getCampaignProduct(productId: string | null, productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>) {
  if (!productId) return null;
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
    "CAMPAIGN_NOT_DRAFT",
    "CAMPAIGN_NOT_PENDING_APPROVAL",
    "CAMPAIGN_TEST_REQUIRES_APPROVAL",
    "CAMPAIGN_TEST_ALREADY_SENT",
    "TEST_REQUIRED_AFTER_APPROVAL",
    "CAMPAIGN_TERMINAL",
    "RETRY_ONLY_FAILED_CAMPAIGN",
    "GENERAL_SEND_GATE_REQUIRED",
    "GENERAL_SEND_CONFIRMATION_REQUIRED",
    "CAMPAIGN_NOT_SENDING",
    "NEWSLETTER_TEST_EMAIL_MISSING",
    "NEWSLETTER_TEST_EMAIL_NOT_ELIGIBLE",
    "CAMPAIGN_PUBLIC_BASE_URL_MISSING",
    "CAMPAIGN_PROVIDER_NOT_CONFIGURED",
    "CAMPAIGN_SUBJECT_INVALID",
    "CAMPAIGN_SUBJECT_LOCKED",
    "CAMPAIGN_TYPE_INVALID",
    "CAMPAIGN_COLLECTION_PRODUCT_NOT_FOUND",
    "CAMPAIGN_COLLECTION_SIZE_INVALID",
    "CAMPAIGN_COLLECTION_MINIMUM_INVALID",
    "CAMPAIGN_COLLECTION_DATE_WINDOW_INVALID",
    "WELCOME_PRODUCT_FORBIDDEN",
  ]);
  if (message.startsWith("CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS:")) return "CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS";
  return known.has(message) ? message : "CAMPAIGN_OPERATION_FAILED";
}
