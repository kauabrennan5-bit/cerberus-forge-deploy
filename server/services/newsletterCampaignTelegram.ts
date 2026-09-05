import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import {
  approveCampaign,
  cancelCampaign,
  confirmGeneralSend,
  createCampaignForProduct,
  createCustomCollectionCampaign,
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
import type { WeeklyBrevoMarketingProvider } from "./newsletterWeeklyBrevoProvider";
import {
  getWeeklyMarketingTestSendError,
  retryWeeklyMarketingTest,
} from "./newsletterWeeklyDelivery";
import { syncWeeklyBrevoProductionAudience } from "./newsletterWeeklyBrevoAudienceSync";
import { assertWeeklyApprovedContentCurrent } from "./newsletterWeeklyContentPreflight";
import {
  createSupabaseNewsletterCampaignStore,
  type CampaignTelegramCard,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";

const campaignCallbackLocks = new Map<string, Promise<void>>();
const CAMPAIGN_BUILDER_ACTION = "campaign_builder";
const CAMPAIGN_BUILDER_PAGE_SIZE = 6;
const CAMPAIGN_BUILDER_MAX_PRODUCTS = 10;

type CampaignBuilderState = {
  catalogProductIds: string[];
  selectedProductIds: string[];
  page: number;
};

export type CampaignTelegramDeps = {
  answerCallbackQuery: (callbackId: string, text?: string, showAlert?: boolean) => Promise<unknown>;
  editTelegramMessageText: (chatId: number | string, messageId: number, text: string, replyMarkup?: unknown) => Promise<unknown>;
  editTelegramMessageReplyMarkup?: (chatId: number | string, messageId: number, replyMarkup?: unknown) => Promise<unknown>;
  sendTelegramMessage: (chatId: number | string, text: string, replyMarkup?: unknown) => Promise<unknown>;
  store?: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  provider?: NewsletterCampaignProvider;
  weeklyProvider?: WeeklyBrevoMarketingProvider;
  productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>;
  productsLoader?: () => Promise<import("../../src/types").Product[]>;
  now?: Date;
  collectionSince?: Date | null;
  collectionUntil?: Date | null;
  collectionSize?: number;
  minimumCollectionProducts?: number;
  verifyImageAccessibility?: boolean;
  productionAudienceSync?: () => Promise<{ listId: number; eligibleSubscribers: number; brevoMembers: number }>;
  productionEnabledCheck?: () => Promise<boolean>;
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

    if (data === "campaign_builder_start") {
      return startCustomCampaignBuilder(callbackId, senderId, chatId, messageId, deps);
    }
    if (data.startsWith("campaign_builder_toggle:")) {
      const index = Number(data.slice("campaign_builder_toggle:".length));
      return toggleCustomCampaignProduct(callbackId, senderId, chatId, messageId, index, deps);
    }
    if (data.startsWith("campaign_builder_page:")) {
      const page = Number(data.slice("campaign_builder_page:".length));
      return changeCustomCampaignBuilderPage(callbackId, senderId, chatId, messageId, page, deps);
    }
    if (data === "campaign_builder_clear") {
      return clearCustomCampaignBuilder(callbackId, senderId, chatId, messageId, deps);
    }
    if (data === "campaign_builder_cancel") {
      await telegramRepo.deleteUserState(senderId);
      await deps.answerCallbackQuery(callbackId, "Montagem cancelada. Nenhuma campanha foi criada.");
      const view = renderRecentCampaignsForTelegram(await store.listRecentCampaigns(10));
      if (chatId && messageId) await deps.editTelegramMessageText(chatId, messageId, view.text, { inline_keyboard: view.keyboard });
      else if (chatId) await deps.sendTelegramMessage(chatId, view.text, { inline_keyboard: view.keyboard });
      return true;
    }
    if (data === "campaign_builder_done") {
      const builder = await readCustomCampaignBuilder(senderId);
      if (!builder) {
        await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas e comece novamente.", true);
        return true;
      }
      if (builder.selectedProductIds.length < 1) {
        await deps.answerCallbackQuery(callbackId, "Selecione pelo menos 1 produto.", true);
        return true;
      }
      if (builder.selectedProductIds.length > CAMPAIGN_BUILDER_MAX_PRODUCTS) {
        await deps.answerCallbackQuery(callbackId, "O limite é de 10 produtos por campanha.", true);
        return true;
      }
      const campaign = await createCustomCollectionCampaign(builder.selectedProductIds, senderId, {
        store,
        env,
        productsLoader: deps.productsLoader,
        now: deps.now,
        verifyImageAccessibility: deps.verifyImageAccessibility,
      });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await telegramRepo.deleteUserState(senderId);
      await deps.answerCallbackQuery(callbackId, `Campanha montada com ${builder.selectedProductIds.length} produto(s). Revise a prévia antes de aprovar.`);
      return renderCampaignWithFallback(deps, chatId, messageId, pending, campaignKeyboard(pending));
    }

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
      await syncCampaignTelegramState(campaign.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_submit:")) {
      if (campaign.status !== "draft") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia enviada para aprovação.");
      await syncCampaignTelegramState(pending.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_weekly_approve:")) {
      if (campaign.status !== "pending_approval" && campaign.status !== "approved") {
        return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      }
      const isWeeklyTest = campaign.editionKey?.startsWith("weekly-test:");
      if (!isWeeklyTest) {
        await assertWeeklyApprovedContentCurrent({
          campaign,
          productsLoader: deps.productsLoader || productsRepository.getProducts,
          store,
          now: deps.now,
        });
      }
      const approved = campaign.status === "pending_approval"
        ? await approveCampaign(campaign, senderId, { store, env })
        : campaign;
      if (isWeeklyTest) {
        await deps.answerCallbackQuery(callbackId, "Aprovação registrada. Processando somente o teste controlado.");
        try {
          const tested = approved.testProviderMessageId?.trim()
            ? await retryWeeklyMarketingTest(approved, senderId, {
                store,
                env,
                provider: deps.weeklyProvider,
              })
            : await sendCampaignTest(approved, senderId, {
                store,
                env,
                provider: deps.provider,
                weeklyProvider: deps.weeklyProvider,
              });
          await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));
        } catch (error) {
          await renderWeeklyTestFailureState(error, approved.id, deps, chatId, messageId);
        }
        return true;
      }
      // Persiste pending antes da chamada externa; uma falha de sync jamais
      // pode reutilizar a contagem ready observada no momento do draft.
      const approvalPending = await store.updateCampaign({
        ...approved,
        approvalAudienceCount: null,
        approvalAudienceStatus: "pending",
      });
      const audience = await (deps.productionAudienceSync || (() => syncWeeklyBrevoProductionAudience({ env })))();
      const audienceReady = audience.eligibleSubscribers > 0 && audience.eligibleSubscribers === audience.brevoMembers;
      const approvalReady = await store.updateCampaign({
        ...approvalPending,
        approvalAudienceCount: audience.eligibleSubscribers,
        approvalAudienceStatus: audienceReady ? "ready" : "mismatch",
      });
      await deps.answerCallbackQuery(
        callbackId,
        audienceReady
          ? `Campanha aprovada. Nenhum email foi enviado. Confirme o envio para ${audience.eligibleSubscribers} assinantes no segundo botão.`
          : "Campanha aprovada, mas o envio segue bloqueado: audiência Brevo divergente.",
        !audienceReady,
      );
      await syncCampaignTelegramState(approvalReady.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_weekly_send:")) {
      if (
        campaign.status !== "approved"
        || campaign.campaignType !== "collection"
        || !campaign.editionKey?.startsWith("weekly:")
        || campaign.approvalAudienceStatus !== "ready"
        || !campaign.approvalAudienceCount
      ) {
        return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      }
      const confirmed = campaign.generalSendConfirmedAt
        ? campaign
        : await confirmGeneralSend(campaign, senderId, { store, env, now: deps.now });
      const sending = await startGeneralSend(confirmed, senderId, {
        store,
        env,
        now: deps.now,
        weeklyProvider: deps.weeklyProvider,
        productsLoader: deps.productsLoader,
        productionAudienceSync: deps.productionAudienceSync,
        productionEnabledCheck: deps.productionEnabledCheck,
      });
      await deps.answerCallbackQuery(callbackId, "Confirmação final registrada. Envio entregue ao provider Brevo.");
      await syncCampaignTelegramState(sending.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_weekly_retry_test:")) {
      if (
        campaign.status !== "approved"
        || campaign.campaignType !== "collection"
        || !campaign.editionKey?.startsWith("weekly-test:")
        || !campaign.testProviderMessageId?.trim()
      ) {
        return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      }
      if (
        campaign.counts.total !== 0
        || campaign.counts.success !== 0
        || campaign.counts.failed !== 0
        || campaign.counts.skipped !== 0
      ) {
        await deps.answerCallbackQuery(callbackId, "Retry bloqueado: estado de destinatários incompatível.", true);
        return true;
      }
      await deps.answerCallbackQuery(callbackId, "Retry autorizado. Repetindo somente /sendTest na mesma campanha Brevo.");
      try {
        const tested = await retryWeeklyMarketingTest(campaign, senderId, {
          store,
          env,
          provider: deps.weeklyProvider,
        });
        await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));
      } catch (error) {
        await renderWeeklyTestFailureState(error, campaign.id, deps, chatId, messageId);
      }
      return true;
    }

    if (data.startsWith("campaign_approve:")) {
      if (campaign.status !== "pending_approval") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const approved = await approveCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Prévia aprovada. Agora envie o teste controlado.");
      await syncCampaignTelegramState(approved.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_test:")) {
      if (campaign.status !== "approved") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      if (campaign.editionKey?.startsWith("weekly-test:") && campaign.testProviderMessageId?.trim()) {
        await deps.answerCallbackQuery(callbackId, "Retry autorizado. Repetindo somente /sendTest na mesma campanha Brevo.");
        try {
          const tested = await retryWeeklyMarketingTest(campaign, senderId, {
            store,
            env,
            provider: deps.weeklyProvider,
          });
          await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));
        } catch (error) {
          await renderWeeklyTestFailureState(error, campaign.id, deps, chatId, messageId);
        }
        return true;
      }
      const result = await sendCampaignTest(campaign, senderId, { store, env, provider: deps.provider, weeklyProvider: deps.weeklyProvider });
      await deps.answerCallbackQuery(callbackId, result.providerResult.status === "duplicate" ? "Teste já processado." : "Teste processado.");
      await syncCampaignTelegramState(result.campaign.id, deps, messageReference(chatId, messageId));
      if (chatId) await deps.sendTelegramMessage(chatId, renderCampaignTestConfirmation(result.campaign, env.NEWSLETTER_TEST_EMAIL, env));
      return true;
    }

    if (data.startsWith("campaign_confirm_general:")) {
      if (campaign.status !== "approved" && campaign.status !== "test_sent") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const confirmed = await confirmGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Confirmação registrada. Revise antes de iniciar o envio geral.");
      await syncCampaignTelegramState(confirmed.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_start:")) {
      if (campaign.status !== "approved" && campaign.status !== "test_sent" && campaign.status !== "failed") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const sending = await startGeneralSend(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Envio geral enfileirado.");
      await syncCampaignTelegramState(sending.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_retry:")) {
      if (campaign.status !== "failed") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const retrying = await retryFailedCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Retry enfileirado para falhas.");
      await syncCampaignTelegramState(retrying.id, deps, messageReference(chatId, messageId));
      return true;
    }

    if (data.startsWith("campaign_cancel:")) {
      if (campaign.status === "sent" || campaign.status === "cancelled") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const cancelled = await cancelCampaign(campaign, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha cancelada.");
      await syncCampaignTelegramState(cancelled.id, deps, messageReference(chatId, messageId));
      return true;
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
  const keyboard = [
    [{ text: "🧩 Monte sua campanha", callback_data: "campaign_builder_start" }],
    ...visible.map(campaign => [{
      text: `${campaignStatusLabel(campaign.status)} · ${campaign.subject.slice(0, 42)}`,
      callback_data: `campaign_view:${campaign.id}`,
    }]),
  ];
  return { text, keyboard };
}

function isCampaignBuilderProduct(product: import("../../src/types").Product): boolean {
  const statusOk = !product.status || product.status === "approved" || product.status === "published";
  return Boolean(product.id?.trim()) && product.ativo === true && statusOk;
}

function normalizeBuilderState(value: unknown): CampaignBuilderState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CampaignBuilderState>;
  const catalogProductIds = Array.isArray(candidate.catalogProductIds)
    ? candidate.catalogProductIds.map(String).map(item => item.trim()).filter(Boolean)
    : [];
  const selectedProductIds = Array.isArray(candidate.selectedProductIds)
    ? candidate.selectedProductIds.map(String).map(item => item.trim()).filter(id => catalogProductIds.includes(id))
    : [];
  const page = Number.isInteger(candidate.page) ? Math.max(0, Number(candidate.page)) : 0;
  if (catalogProductIds.length === 0) return null;
  return { catalogProductIds, selectedProductIds: [...new Set(selectedProductIds)].slice(0, CAMPAIGN_BUILDER_MAX_PRODUCTS), page };
}

async function readCustomCampaignBuilder(senderId: string): Promise<CampaignBuilderState | null> {
  const state = await telegramRepo.getUserState(senderId);
  if (state?.action !== CAMPAIGN_BUILDER_ACTION) return null;
  return normalizeBuilderState(state.data);
}

async function writeCustomCampaignBuilder(senderId: string, state: CampaignBuilderState): Promise<void> {
  await telegramRepo.setUserState(senderId, { action: CAMPAIGN_BUILDER_ACTION, data: state });
}

async function startCustomCampaignBuilder(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, deps: CampaignTelegramDeps): Promise<boolean> {
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const catalog = products.filter(isCampaignBuilderProduct).sort((a, b) => {
    const right = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : 0;
    const left = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
  if (catalog.length === 0) {
    await deps.answerCallbackQuery(callbackId, "Não há produtos ativos disponíveis para montar campanha.", true);
    return true;
  }
  const state: CampaignBuilderState = { catalogProductIds: catalog.map(product => product.id.trim()), selectedProductIds: [], page: 0 };
  await writeCustomCampaignBuilder(senderId, state);
  await deps.answerCallbackQuery(callbackId, "Selecione de 1 a 10 produtos. O primeiro selecionado será o HERO.");
  return renderCustomCampaignBuilder(senderId, chatId, messageId, state, deps);
}

async function toggleCustomCampaignProduct(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, index: number, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  if (!Number.isInteger(index) || index < 0 || index >= state.catalogProductIds.length) {
    await deps.answerCallbackQuery(callbackId, "Produto inválido nesta sessão.", true);
    return true;
  }
  const productId = state.catalogProductIds[index];
  const selected = [...state.selectedProductIds];
  const currentIndex = selected.indexOf(productId);
  if (currentIndex >= 0) selected.splice(currentIndex, 1);
  else {
    if (selected.length >= CAMPAIGN_BUILDER_MAX_PRODUCTS) {
      await deps.answerCallbackQuery(callbackId, "Limite atingido: no máximo 10 produtos.", true);
      return true;
    }
    selected.push(productId);
  }
  const next = { ...state, selectedProductIds: selected };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId, currentIndex >= 0 ? `Produto removido · ${selected.length}/10` : `Produto adicionado · ${selected.length}/10`);
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function changeCustomCampaignBuilderPage(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, page: number, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  const maxPage = Math.max(0, Math.ceil(state.catalogProductIds.length / CAMPAIGN_BUILDER_PAGE_SIZE) - 1);
  const next = { ...state, page: Math.max(0, Math.min(maxPage, Number.isFinite(page) ? Math.trunc(page) : 0)) };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId);
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function clearCustomCampaignBuilder(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  const next = { ...state, selectedProductIds: [] };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId, "Seleção limpa.");
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function renderCustomCampaignBuilder(senderId: string, chatId: number | string | undefined, messageId: number | undefined, state: CampaignBuilderState, deps: CampaignTelegramDeps): Promise<boolean> {
  if (!chatId) return true;
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const byId = new Map(products.map(product => [product.id, product] as const));
  const maxPage = Math.max(0, Math.ceil(state.catalogProductIds.length / CAMPAIGN_BUILDER_PAGE_SIZE) - 1);
  const page = Math.max(0, Math.min(maxPage, state.page));
  const start = page * CAMPAIGN_BUILDER_PAGE_SIZE;
  const ids = state.catalogProductIds.slice(start, start + CAMPAIGN_BUILDER_PAGE_SIZE);
  const selectedSet = new Set(state.selectedProductIds);
  const selectedLines = state.selectedProductIds.map((id, index) => {
    const product = byId.get(id);
    const title = product?.displayTitle || product?.produto || id;
    return `${index + 1}. ${escapeTelegram(String(title).slice(0, 58))}${index === 0 ? " · <b>HERO</b>" : ""}`;
  });
  const text = [
    "🧩 <b>MONTE SUA CAMPANHA</b>",
    "Selecione de <b>1 a 10 produtos</b>. O primeiro selecionado vira o destaque/HERO.",
    `Selecionados: <b>${state.selectedProductIds.length}/10</b> · Página <b>${page + 1}/${maxPage + 1}</b>`,
    "",
    selectedLines.length ? `<b>Ordem atual</b>\n${selectedLines.join("\n")}` : "Nenhum produto selecionado ainda.",
    "",
    "Toque nos produtos abaixo para adicionar/remover. Nada é enviado automaticamente.",
  ].join("\n");
  const keyboard: any[][] = ids.map((id, offset) => {
    const product = byId.get(id);
    const title = String(product?.displayTitle || product?.produto || "Produto indisponível").replace(/\s+/g, " ").trim();
    const absoluteIndex = start + offset;
    return [{ text: `${selectedSet.has(id) ? "✅" : "◻️"} ${absoluteIndex + 1}. ${title.slice(0, 42)}`, callback_data: `campaign_builder_toggle:${absoluteIndex}` }];
  });
  const navigation: any[] = [];
  if (page > 0) navigation.push({ text: "⬅️ Anterior", callback_data: `campaign_builder_page:${page - 1}` });
  if (page < maxPage) navigation.push({ text: "Próxima ➡️", callback_data: `campaign_builder_page:${page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  if (state.selectedProductIds.length > 0) {
    keyboard.push([{ text: `✅ Montar campanha (${state.selectedProductIds.length})`, callback_data: "campaign_builder_done" }]);
    keyboard.push([{ text: "🗑 Limpar seleção", callback_data: "campaign_builder_clear" }]);
  }
  keyboard.push([{ text: "❌ Cancelar", callback_data: "campaign_builder_cancel" }]);
  if (messageId) await deps.editTelegramMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
  else await deps.sendTelegramMessage(chatId, text, { inline_keyboard: keyboard });
  return true;
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
      if (campaign.editionKey?.startsWith("weekly-test:")) {
        return [
          [{ text: "✅ Aprovar teste", callback_data: `campaign_weekly_approve:${campaign.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
        ];
      }
      if (campaign.editionKey?.startsWith("weekly:")) {
        return [
          [{ text: "✅ Aprovar campanha", callback_data: `campaign_weekly_approve:${campaign.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
        ];
      }
      return [
        [{ text: "✅ Aprovar prévia", callback_data: `campaign_approve:${campaign.id}` }],
        [{ text: "✏️ Editar assunto", callback_data: `campaign_subject_edit:${campaign.id}` }, { text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    case "approved":
      if (campaign.editionKey?.startsWith("weekly-test:")) {
        return campaign.testProviderMessageId?.trim()
          ? [
              [{ text: "🔄 Tentar envio de teste novamente", callback_data: `campaign_weekly_retry_test:${campaign.id}` }],
              [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
            ]
          : [
              [{ text: "🧪 Enviar teste controlado", callback_data: `campaign_weekly_approve:${campaign.id}` }],
              [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
            ];
      }
      if (campaign.editionKey?.startsWith("weekly:")) {
        if (campaign.approvalAudienceStatus === "ready" && (campaign.approvalAudienceCount || 0) > 0) {
          return [
            [{ text: `🚀 Enviar agora para ${campaign.approvalAudienceCount} assinantes`, callback_data: `campaign_weekly_send:${campaign.id}` }],
            [{ text: "↩️ Voltar / cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
          ];
        }
        return [
          [{ text: "🔄 Revalidar audiência", callback_data: `campaign_weekly_approve:${campaign.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
        ];
      }
      if (campaign.generalSendConfirmedAt && campaign.generalSendConfirmedByTelegramId) {
        return [
          [{ text: "🚀 Enviar campanha geral", callback_data: `campaign_start:${campaign.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
        ];
      }
      return [
        [{ text: "🧪 Enviar teste controlado", callback_data: `campaign_test:${campaign.id}` }],
        [{ text: "📣 Confirmar envio geral direto", callback_data: `campaign_confirm_general:${campaign.id}` }],
        [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${campaign.id}` }],
      ];
    case "test_sent":
      return [];
    case "sending":
      return [[{ text: "🔄 Atualizar status", callback_data: `campaign_view:${campaign.id}` }]];
    case "failed":
      return [
        [{ text: "🔁 Retry falhas", callback_data: `campaign_retry:${campaign.id}` }],
        [{ text: "🔄 Atualizar status", callback_data: `campaign_view:${campaign.id}` }],
      ];
    case "sent":
      return [];
    case "cancelled":
      return [];
  }
}

export type CampaignTelegramSyncDeps = Pick<CampaignTelegramDeps, "editTelegramMessageText" | "editTelegramMessageReplyMarkup" | "sendTelegramMessage" | "store" | "productLoader">;

export type CampaignTelegramSyncResult = {
  campaign: EmailCampaign;
  card: CampaignTelegramCard | null;
  outcome: "updated" | "already_synchronized" | "reconciliation_sent" | "missing_reference" | "unavailable";
  providerCalled: false;
};

export async function syncCampaignTelegramState(
  campaignId: string,
  deps: CampaignTelegramSyncDeps,
  messageRef?: Pick<CampaignTelegramCard, "chatId" | "messageId">,
): Promise<CampaignTelegramSyncResult> {
  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
  const savedCard = await store.getCampaignTelegramCard(campaignId);
  const explicitCard = messageRef && isValidCardReference(messageRef)
    ? { campaignId, chatId: String(messageRef.chatId), messageId: messageRef.messageId, updatedAt: new Date().toISOString() }
    : null;
  const card = explicitCard || savedCard;
  if (!card) return { campaign, card: null, outcome: "missing_reference", providerCalled: false };

  const presentation = await buildCampaignPresentation(campaign, deps);
  try {
    const textResult = await deps.editTelegramMessageText(card.chatId, card.messageId, presentation.text, { inline_keyboard: presentation.keyboard });
    if (telegramOperationSucceeded(textResult)) {
      const persisted = await persistCardIfNeeded(store, savedCard, card);
      return { campaign, card: persisted, outcome: "updated", providerCalled: false };
    }

    const textAlreadySynchronized = telegramMessageIsNotModified(textResult);
    let markupSynchronized = !deps.editTelegramMessageReplyMarkup;
    if (deps.editTelegramMessageReplyMarkup) {
      try {
        const markupResult = await deps.editTelegramMessageReplyMarkup(card.chatId, card.messageId, { inline_keyboard: presentation.keyboard });
        markupSynchronized = telegramOperationSucceeded(markupResult) || telegramMessageIsNotModified(markupResult);
      } catch {
        markupSynchronized = false;
      }
    }

    if (textAlreadySynchronized && markupSynchronized) {
      const persisted = await persistCardIfNeeded(store, savedCard, card);
      return { campaign, card: persisted, outcome: "already_synchronized", providerCalled: false };
    }
  } catch {
    // Falha de edição não cancela a campanha nem altera o provider; a reconciliação abaixo usa o estado autoritativo.
    if (deps.editTelegramMessageReplyMarkup) {
      try {
        await deps.editTelegramMessageReplyMarkup(card.chatId, card.messageId, { inline_keyboard: presentation.keyboard });
      } catch {
        // O cartão antigo pode estar inacessível; a nova apresentação ainda será tentada.
      }
    }
  }

  const reconciliationText = [
    presentation.text,
    "",
    "⚠️ <b>CARTÃO ANTERIOR DESATUALIZADO</b>",
    "O estado atual foi reexibido abaixo com os controles autoritativos disponíveis.",
  ].join("\n");
  try {
    const sent = await deps.sendTelegramMessage(card.chatId, reconciliationText, { inline_keyboard: presentation.keyboard });
    const newMessageId = extractTelegramMessageId(sent);
    if (telegramOperationSucceeded(sent) && newMessageId) {
      await store.saveCampaignTelegramCard(campaignId, card.chatId, newMessageId);
      return {
        campaign,
        card: await store.getCampaignTelegramCard(campaignId),
        outcome: "reconciliation_sent",
        providerCalled: false,
      };
    }
  } catch {
    // Nenhum provider é chamado quando Telegram falha.
  }
  return { campaign, card: savedCard || card, outcome: "unavailable", providerCalled: false };
}

async function buildCampaignPresentation(campaign: EmailCampaign, deps: CampaignTelegramSyncDeps): Promise<{ text: string; keyboard: any[][] }> {
  const collectionProducts = campaign.campaignType === "collection"
    ? await getCampaignProducts(campaign, deps.productLoader)
    : [];
  const product = campaign.campaignType === "welcome" || campaign.campaignType === "collection"
    ? null
    : await getCampaignProduct(campaign.productId, deps.productLoader);
  return {
    text: renderCampaignTelegramPreview(campaign, product, collectionProducts),
    keyboard: campaignKeyboard(campaign),
  };
}

function isValidCardReference(reference: Pick<CampaignTelegramCard, "chatId" | "messageId">): boolean {
  return Boolean(String(reference.chatId).trim()) && Number.isSafeInteger(reference.messageId) && reference.messageId > 0;
}

function messageReference(chatId: number | string | undefined, messageId: number | undefined): Pick<CampaignTelegramCard, "chatId" | "messageId"> | undefined {
  if (chatId === undefined || messageId === undefined) return undefined;
  const reference = { chatId: String(chatId), messageId };
  return isValidCardReference(reference) ? reference : undefined;
}

function telegramOperationSucceeded(result: unknown): boolean {
  if (result === undefined || result === null) return true;
  if (typeof result !== "object") return true;
  if (!Object.prototype.hasOwnProperty.call(result, "ok")) return true;
  return (result as { ok?: unknown }).ok === true;
}

function telegramMessageIsNotModified(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const candidate = result as { description?: unknown; failureReason?: unknown; message?: unknown };
  const text = [candidate.description, candidate.failureReason, candidate.message]
    .filter(value => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("message is not modified");
}

async function persistCardIfNeeded(
  store: NewsletterCampaignStore,
  savedCard: CampaignTelegramCard | null,
  card: CampaignTelegramCard,
): Promise<CampaignTelegramCard | null> {
  const shouldPersist = !savedCard || savedCard.chatId !== card.chatId || savedCard.messageId !== card.messageId;
  if (shouldPersist) await store.saveCampaignTelegramCard(card.campaignId, card.chatId, card.messageId);
  return shouldPersist ? store.getCampaignTelegramCard(card.campaignId) : savedCard;
}

function extractTelegramMessageId(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const outer = result as { result?: unknown };
  if (!outer.result || typeof outer.result !== "object") return null;
  const messageId = Number((outer.result as { message_id?: unknown }).message_id);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

async function renderWeeklyTestFailureState(
  error: unknown,
  campaignId: string,
  deps: CampaignTelegramDeps,
  chatId: number | string | undefined,
  messageId: number | undefined,
): Promise<void> {
  if (!chatId) return;
  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const current = await store.getCampaign(campaignId);
  if (!current) return;
  const failure = getWeeklyMarketingTestSendError(error);
  const providerDetails = failure?.providerError;
  const safeCode = failure?.safeCode || campaignErrorMessage(error);
  const statusLine = providerDetails?.status ? `HTTP: <code>${providerDetails.status}</code>` : null;
  const providerCodeLine = providerDetails?.providerCode
    ? `Provider code: <code>${escapeTelegram(providerDetails.providerCode)}</code>`
    : null;
  const text = [
    "⚠️ <b>ENVIO DE TESTE NÃO CONFIRMADO</b>",
    "",
    `Campanha: <code>${escapeTelegram(current.id)}</code>`,
    "Provider: <b>BREVO</b>",
    "Operação: <b>SEND_TEST</b>",
    `Resultado: <b>${failure?.sendTestResult === "unknown" ? "UNKNOWN" : "FAILED"}</b>`,
    providerDetails ? `Erro: <code>${escapeTelegram(providerDetails.kind.toUpperCase())}</code>` : null,
    statusLine,
    `Código seguro: <code>${escapeTelegram(safeCode)}</code>`,
    providerCodeLine,
    "",
    "A aprovação e a referência da Marketing Campaign foram preservadas.",
    "Nenhum cliente real foi envolvido e nenhum sendNow foi executado.",
  ].filter(Boolean).join("\n");
  const keyboard = campaignKeyboard(current);
  try {
    const sent = await deps.sendTelegramMessage(chatId, text, { inline_keyboard: keyboard });
    const newMessageId = extractTelegramMessageId(sent);
    if (telegramOperationSucceeded(sent) && newMessageId) {
      await store.saveCampaignTelegramCard(current.id, String(chatId), newMessageId);
      return;
    }
  } catch {
    // Fallback abaixo reconcilia somente Telegram e não executa provider.
  }
  await syncCampaignTelegramState(current.id, deps, messageReference(chatId, messageId));
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
    try {
      const synced = await syncCampaignTelegramState(campaign.id, deps, messageReference(chatId, messageId));
      if (synced.outcome !== "missing_reference") return true;
    } catch {
      // O fallback textual abaixo não executa nenhuma ação operacional de campanha.
    }
    const staleCardMessage = [
      "⚠️ <b>CARTÃO DE CAMPANHA DESATUALIZADO</b>",
      `Estado autoritativo: <code>${escapeTelegram(campaign.status)}</code>`,
      "O cartão anterior não pôde ser redesenhado automaticamente.",
      "Os controles abaixo são derivados do estado autoritativo atual.",
    ].join("\n");
    await deps.sendTelegramMessage(chatId, staleCardMessage, { inline_keyboard: campaignKeyboard(campaign) });
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
  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const presentation = await buildCampaignPresentation(campaign, deps);
  const finalPresentation = { ...presentation, keyboard };
  if (messageId) {
    const result = await deps.editTelegramMessageText(chatId, messageId, finalPresentation.text, { inline_keyboard: finalPresentation.keyboard });
    if (!telegramOperationSucceeded(result)) {
      if (!telegramMessageIsNotModified(result)) throw new Error("TELEGRAM_CARD_EDIT_FAILED");
      if (deps.editTelegramMessageReplyMarkup) {
        const markupResult = await deps.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: finalPresentation.keyboard });
        if (!telegramOperationSucceeded(markupResult) && !telegramMessageIsNotModified(markupResult)) {
          throw new Error("TELEGRAM_CARD_EDIT_FAILED");
        }
      }
    }
    await store.saveCampaignTelegramCard(campaign.id, String(chatId), messageId);
  } else {
    const result = await deps.sendTelegramMessage(chatId, finalPresentation.text, { inline_keyboard: finalPresentation.keyboard });
    if (!telegramOperationSucceeded(result)) throw new Error("TELEGRAM_CARD_SEND_FAILED");
    const sentMessageId = extractTelegramMessageId(result);
    if (sentMessageId) await store.saveCampaignTelegramCard(campaign.id, String(chatId), sentMessageId);
  }
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
  const weeklyFailure = getWeeklyMarketingTestSendError(error);
  if (weeklyFailure) return weeklyFailure.safeCode;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("WEEKLY_CONTENT_CHANGED_REGENERATE_REQUIRED:")) {
    return "Conteúdo mudou desde a aprovação. A campanha precisa ser regenerada.";
  }
  if (message === "WEEKLY_MARKETING_PRODUCTION_AUDIENCE_CHANGED_AFTER_APPROVAL") {
    return "A audiência mudou desde a aprovação. Revalide a campanha antes de enviar.";
  }
  if (message === "WEEKLY_MARKETING_PRODUCTION_APPROVAL_EXPIRED") {
    return "A aprovação expirou. A campanha precisa ser regenerada e aprovada novamente.";
  }
  if (message === "CAMPAIGN_CUSTOM_SELECTION_REQUIRED") return "Selecione pelo menos 1 produto para montar a campanha.";
  if (message === "CAMPAIGN_CUSTOM_SELECTION_LIMIT") return "O limite da campanha manual é de 10 produtos.";
  if (message.startsWith("CAMPAIGN_CUSTOM_PRODUCT_NOT_READY:")) return "Um dos produtos selecionados não está pronto para campanha. Remova-o ou corrija o produto e tente novamente.";
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
    "CAMPAIGN_TELEGRAM_CARD_REFERENCE_INVALID",
    "TELEGRAM_CARD_EDIT_FAILED",
    "TELEGRAM_CARD_SEND_FAILED",
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
    "CAMPAIGN_COLLECTION_ALREADY_EXISTS",
    "PROVIDER_PUBLIC_SENDER_REQUIRED",
    "WELCOME_PRODUCT_FORBIDDEN",
    "WEEKLY_MARKETING_TEST_PROVIDER_REFERENCE_REQUIRED",
    "WEEKLY_MARKETING_TEST_REAL_RECIPIENTS_FORBIDDEN",
  ]);
  if (message.startsWith("CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS:")) return "CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS";
  return known.has(message) ? message : "CAMPAIGN_OPERATION_FAILED";
}
