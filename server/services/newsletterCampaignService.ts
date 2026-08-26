import type { Product } from "../../src/types";
import * as productsRepository from "../repositories/productsRepository";
import {
  createSupabaseNewsletterCampaignStore,
  type NewsletterCampaignStore,
} from "../repositories/newsletterCampaignRepository";
import {
  createBrevoNewsletterProvider,
  type NewsletterCampaignProvider,
  type NewsletterProviderResult,
} from "./newsletterProvider";
import {
  createDryRunCampaignProvider,
  processNewsletterCampaignOnce,
} from "./newsletterCampaignWorker";
import {
  createCampaignDraft,
  transitionCampaign,
  type EmailCampaign,
} from "./newsletterCampaignState";
import {
  renderNewsletterCampaign,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from "./newsletterCampaignTemplate";
import { getNewsletterInstitutionalOptions } from "./newsletterInstitutional";

export type CampaignServiceOptions = {
  store?: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  productLoader?: (productId: string) => Promise<Product | null>;
  provider?: NewsletterCampaignProvider;
};

export async function createCampaignForProduct(
  productId: string,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const product = await (options.productLoader || productsRepository.getProductByIdOrSlug)(productId);
  const approvedStatus = !product?.status || product.status === "approved" || product.status === "published";
  if (!product || product.ativo !== true || !approvedStatus) throw new Error("CAMPAIGN_PRODUCT_NOT_ELIGIBLE");
  const env = options.env || process.env;
  const campaignId = crypto.randomUUID();
  const institutional = getNewsletterInstitutionalOptions(env);
  const rendered = renderNewsletterCampaign(product, {
    subject: env.NEWSLETTER_CAMPAIGN_SUBJECT || undefined,
    trackingCampaignId: campaignId,
    privacyUrl: institutional.privacyUrl,
    termsUrl: institutional.termsUrl,
    socialLinks: institutional.socialLinks,
  });
  const draft = createCampaignDraft(product.id, actorTelegramId, rendered, options.now || new Date(), campaignId);
  return (options.store || createSupabaseNewsletterCampaignStore()).createCampaign(draft);
}

export async function submitCampaignForApproval(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const transitioned = transitionCampaign(campaign, { type: "submit_for_approval", actorTelegramId }, options.now || new Date());
  return (options.store || createSupabaseNewsletterCampaignStore()).updateCampaign(transitioned);
}

export async function approveCampaign(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const transitioned = transitionCampaign(campaign, { type: "approve", actorTelegramId }, options.now || new Date());
  return (options.store || createSupabaseNewsletterCampaignStore()).updateCampaign(transitioned);
}

export async function cancelCampaign(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const transitioned = transitionCampaign(campaign, { type: "cancel", actorTelegramId }, options.now || new Date());
  return (options.store || createSupabaseNewsletterCampaignStore()).updateCampaign(transitioned);
}

export async function updateCampaignSubjectAndPersist(
  campaign: EmailCampaign,
  subject: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const { updateCampaignSubject } = await import("./newsletterCampaignState");
  const updated = updateCampaignSubject(campaign, subject);
  return (options.store || createSupabaseNewsletterCampaignStore()).updateCampaign(updated);
}

export async function sendCampaignTest(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<{ campaign: EmailCampaign; providerResult: NewsletterProviderResult }> {
  if (campaign.status !== "approved") throw new Error("CAMPAIGN_TEST_REQUIRES_APPROVAL");
  const env = options.env || process.env;
  const testEmail = (env.NEWSLETTER_TEST_EMAIL || "").trim().toLowerCase();
  if (!testEmail) throw new Error("NEWSLETTER_TEST_EMAIL_MISSING");
  const store = options.store || createSupabaseNewsletterCampaignStore();
  // The administrative test destination is intentionally outside the subscriber list.
  // Real campaign recipients receive persisted canonical unsubscribe tokens in the worker.
  const token = `campaign-test-token-${campaign.id}`;
  const publicBaseUrl = (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim();
  if (!publicBaseUrl) throw new Error("CAMPAIGN_PUBLIC_BASE_URL_MISSING");
  const unsubscribeUrl = buildUnsubscribeUrl(publicBaseUrl, token);
  const htmlContent = campaign.bodyHtml.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
  const textContent = campaign.bodyText.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
  const provider: NewsletterCampaignProvider = options.provider || (env.DRY_RUN === "true"
    ? createDryRunCampaignProvider()
    : createBrevoNewsletterProvider({
        apiKey: env.BREVO_API_KEY || "",
        senderEmail: env.NEWSLETTER_SENDER_EMAIL || "",
        senderName: env.NEWSLETTER_SENDER_NAME,
        subject: campaign.subject,
        timeoutMs: Number(env.NEWSLETTER_PROVIDER_TIMEOUT_MS || 15_000),
      }));
  const providerResult = await provider.sendCampaign({
    campaignId: campaign.id,
    recipientId: `test:${campaign.id}`,
    subscriberEmail: testEmail,
    subject: campaign.subject,
    htmlContent,
    textContent,
    idempotencyKey: `campaign-test-v1:${campaign.id}`,
  });
  const providerReference = providerResult.providerReference?.trim();
  if (!providerReference) throw new Error("CAMPAIGN_TEST_PROVIDER_REFERENCE_MISSING");
  const tested = transitionCampaign(campaign, {
    type: "record_test_sent",
    actorTelegramId,
    providerReference,
  }, options.now || new Date());
  return { campaign: await store.updateCampaign(tested), providerResult };
}

export async function confirmGeneralSend(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const confirmed = transitionCampaign(campaign, { type: "confirm_general_send", actorTelegramId }, options.now || new Date());
  return store.updateCampaign(confirmed);
}

export async function startGeneralSend(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const now = options.now || new Date();
  const sending = transitionCampaign(campaign, { type: "begin_sending", actorTelegramId }, now);
  await store.createEligibleRecipients(campaign.id);
  const counts = await store.summarizeRecipients(campaign.id);
  if (counts.total === 0) {
    const completed = transitionCampaign(sending, { type: "finish_sending", actorTelegramId, counts }, now);
    return store.updateCampaign(completed);
  }
  return store.updateCampaign({ ...sending, counts });
}

export async function retryFailedCampaign(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const retrying = transitionCampaign(campaign, { type: "retry_failed", actorTelegramId }, options.now || new Date());
  await store.resetFailedRecipients(campaign.id);
  const counts = await store.summarizeRecipients(campaign.id);
  return store.updateCampaign({ ...retrying, counts });
}

export async function processCampaignDryRun(
  campaignId: string,
  options: CampaignServiceOptions = {},
) {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  return processNewsletterCampaignOnce(store, campaignId, {
    dryRun: true,
    provider: createDryRunCampaignProvider(),
    publicBaseUrl: (options.env || process.env).NEWSLETTER_PUBLIC_BASE_URL || (options.env || process.env).PUBLIC_SITE_URL || "",
  });
}

export function renderCampaignTelegramPreview(campaign: EmailCampaign, product: Product): string {
  const price = Number.isFinite(product.ofertaPromocional?.price)
    ? `R$ ${product.ofertaPromocional!.price.toFixed(2).replace(".", ",")}`
    : `R$ ${product.preco.toFixed(2).replace(".", ",")}`;
  return [
    "📧 <b>PRÉVIA DE CAMPANHA</b>",
    `Status: <code>${campaign.status}</code>`,
    `Produto: <b>${escapeTelegram(product.displayTitle || product.produto)}</b>`,
    `Preço: <b>${price}</b>`,
    `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
    `Destinatários elegíveis: <b>${campaign.counts.total}</b>`,
    `Sucesso: <b>${campaign.counts.success}</b> · Falhas: <b>${campaign.counts.failed}</b> · Ignorados: <b>${campaign.counts.skipped}</b>`,
    "",
    "O HTML completo será enviado pelo worker. O CTA usa o link canônico/página ponte do produto com o helper de UTMs existente.",
    "O rodapé inclui disclosure de afiliado e descadastro individual.",
  ].join("\n");
}

function buildUnsubscribeUrl(publicBaseUrl: string, token: string): string {
  const url = new URL("/api/newsletter/unsubscribe", publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

function escapeTelegram(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
