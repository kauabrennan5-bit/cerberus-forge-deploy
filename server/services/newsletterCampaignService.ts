import { createHash } from "node:crypto";
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
  type CampaignProductLink,
  type EmailCampaign,
} from "./newsletterCampaignState";
import {
  renderNewsletterCampaign,
  renderNewsletterCollectionCampaign,
  renderNewsletterWelcomeCampaign,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from "./newsletterCampaignTemplate";
import {
  getStartOfNewsletterCollectionWindow,
  selectNewestNewsletterProducts,
} from "./newsletterCampaignCollection";
import {
  getNewsletterInstitutionalOptions,
} from "./newsletterInstitutional";
import {
  assessProductReadiness,
  type ProductImageProbe,
} from "../../src/lib/productCanonical";
import { normalizeNewsletterEmail } from "./newsletterConsent";

const campaignTestLocks = new Map<string, Promise<void>>();

export type CampaignServiceOptions = {
  store?: NewsletterCampaignStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  productLoader?: (productId: string) => Promise<Product | null>;
  productsLoader?: () => Promise<Product[]>;
  collectionSince?: Date | null;
  collectionUntil?: Date | null;
  collectionSize?: number;
  minimumCollectionProducts?: number;
  provider?: NewsletterCampaignProvider;
  /** Probe injetável para validar acessibilidade da imagem principal sem duplicar lógica. */
  imageProbe?: ProductImageProbe;
  verifyImageAccessibility?: boolean;
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
  const readiness = await assessProductReadiness(product, {
    channel: "campaign",
    verifyImageAccessibility: options.verifyImageAccessibility !== false,
    imageProbe: options.imageProbe,
  });
  if (!readiness.ready) {
    throw new Error(`CAMPAIGN_PRODUCT_NOT_READY:${readiness.errors.join(",")}`);
  }
  const campaignId = crypto.randomUUID();
  const institutional = await getNewsletterInstitutionalOptions(env);
  const heroImageUrl = readiness.product.primaryImageUrl;
  const rendered = renderNewsletterCampaign(product, {
    subject: env.NEWSLETTER_CAMPAIGN_SUBJECT || undefined,
    trackingCampaignId: campaignId,
    privacyUrl: institutional.privacyUrl,
    termsUrl: institutional.termsUrl,
    socialLinks: institutional.socialLinks,
    heroImageUrl,
    heroImageStatus: "clean",
  });
  const draft = createCampaignDraft(product.id, actorTelegramId, rendered, options.now || new Date(), campaignId);
  return (options.store || createSupabaseNewsletterCampaignStore()).createCampaign(draft);
}

export async function createWeeklyCollectionCampaign(
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const campaignId = crypto.randomUUID();
  const products = await (options.productsLoader || productsRepository.getProducts)();
  const collectionSince = options.collectionSince === undefined ? getStartOfNewsletterCollectionWindow(now) : options.collectionSince;
  const selection = await selectNewestNewsletterProducts(products, {
    collectionSize: options.collectionSize ?? Number(env.NEWSLETTER_COLLECTION_SIZE || 10),
    minimumProducts: options.minimumCollectionProducts ?? Number(env.NEWSLETTER_COLLECTION_MINIMUM_PRODUCTS || 5),
    since: collectionSince,
    until: options.collectionUntil === undefined ? null : options.collectionUntil,
    verifyImageAccessibility: options.verifyImageAccessibility !== false,
    imageProbe: options.imageProbe,
  });
  const editionWindowStart = collectionSince || getStartOfNewsletterCollectionWindow(now);
  const editionKey = buildNewsletterCollectionEditionKey(selection.products, editionWindowStart);
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const existing = await store.findOperationalCollectionByEditionKey(editionKey);
  if (existing) throw new Error("CAMPAIGN_COLLECTION_ALREADY_EXISTS");
  const institutional = await getNewsletterInstitutionalOptions(env);
  const rendered = renderNewsletterCollectionCampaign(selection.products, {
    subject: buildNewsletterCollectionSubject(env.NEWSLETTER_COLLECTION_SUBJECT, editionWindowStart, selection.products.length),
    collectionTitle: `${selection.products.length} NOVOS ACHADOS`,
    trackingCampaignId: campaignId,
    privacyUrl: institutional.privacyUrl,
    termsUrl: institutional.termsUrl,
    socialLinks: institutional.socialLinks,
    finalBrowseUrl: env.NEWSLETTER_COLLECTION_BROWSE_URL || undefined,
  });
  const collectionProducts: CampaignProductLink[] = selection.products.map((product, index) => ({
    productId: product.id,
    position: index + 1,
    layout: index === 0 ? "feature" : "grid",
  }));
  const draft = createCampaignDraft(null, actorTelegramId, rendered, now, campaignId, "collection", collectionProducts, editionKey);
  let persisted: EmailCampaign;
  try {
    persisted = await store.createCampaign(draft);
  } catch (error) {
    if (isCollectionEditionConflict(error)) throw new Error("CAMPAIGN_COLLECTION_ALREADY_EXISTS");
    throw error;
  }
  await store.createCampaignProducts(persisted.id, collectionProducts);
  return { ...persisted, collectionProducts, editionKey };
}

export function buildNewsletterCollectionEditionKey(products: readonly Product[], editionWindowStart: Date): string {
  const productIds = [...new Set(products.map(product => product.id.trim()).filter(Boolean))].sort();
  if (productIds.length === 0) throw new Error("CAMPAIGN_COLLECTION_PRODUCTS_REQUIRED");
  const digest = createHash("sha256").update(productIds.join("\n"), "utf8").digest("hex");
  return `collection:${editionWindowStart.toISOString().slice(0, 10)}:${digest}`;
}

export function buildNewsletterCollectionSubject(configuredSubject: string | undefined, editionWindowStart: Date, productCount: number): string {
  const base = configuredSubject?.trim() || "Novidades da semana";
  const dateKey = editionWindowStart.toISOString().slice(0, 10);
  return `${base} — Edição ${dateKey} · ${productCount} novos achados`.slice(0, 255);
}

function isCollectionEditionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = String(candidate.code || "");
  const details = String(candidate.message || candidate.details || "");
  return code === "23505" && details.includes("email_campaigns_edition_key_unique");
}

export async function createWelcomeCampaignForSubscribers(
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const env = options.env || process.env;
  const campaignId = crypto.randomUUID();
  const institutional = await getNewsletterInstitutionalOptions(env);
  const rendered = renderNewsletterWelcomeCampaign({
    subject: env.NEWSLETTER_WELCOME_SUBJECT || undefined,
    trackingCampaignId: campaignId,
    privacyUrl: institutional.privacyUrl,
    termsUrl: institutional.termsUrl,
    socialLinks: institutional.socialLinks,
  });
  const draft = createCampaignDraft(null, actorTelegramId, rendered, options.now || new Date(), campaignId, "welcome");
  return (options.store || createSupabaseNewsletterCampaignStore()).createCampaign(draft);
}

async function readCurrentCampaign(store: NewsletterCampaignStore, campaignId: string): Promise<EmailCampaign> {
  const current = await store.getCampaign(campaignId);
  if (!current) throw new Error("CAMPAIGN_NOT_FOUND");
  return current;
}

async function withCampaignTestLock<T>(campaignId: string, operation: () => Promise<T>): Promise<T> {
  const previous = campaignTestLocks.get(campaignId) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  campaignTestLocks.set(campaignId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (campaignTestLocks.get(campaignId) === tail) campaignTestLocks.delete(campaignId);
  }
}

export async function submitCampaignForApproval(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const current = await readCurrentCampaign(store, campaign.id);
  const transitioned = transitionCampaign(current, { type: "submit_for_approval", actorTelegramId }, options.now || new Date());
  return store.updateCampaign(transitioned);
}

export async function approveCampaign(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const current = await readCurrentCampaign(store, campaign.id);
  const transitioned = transitionCampaign(current, { type: "approve", actorTelegramId }, options.now || new Date());
  return store.updateCampaign(transitioned);
}

export async function cancelCampaign(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const current = await readCurrentCampaign(store, campaign.id);
  const transitioned = transitionCampaign(current, { type: "cancel", actorTelegramId }, options.now || new Date());
  return store.updateCampaign(transitioned);
}

export async function updateCampaignSubjectAndPersist(
  campaign: EmailCampaign,
  subject: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const { updateCampaignSubject } = await import("./newsletterCampaignState");
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const current = await readCurrentCampaign(store, campaign.id);
  const updated = updateCampaignSubject(current, subject);
  return store.updateCampaign(updated);
}

export async function sendCampaignTest(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<{ campaign: EmailCampaign; providerResult: NewsletterProviderResult }> {
  return withCampaignTestLock(campaign.id, async () => {
    const env = options.env || process.env;
    const store = options.store || createSupabaseNewsletterCampaignStore();
    const current = await readCurrentCampaign(store, campaign.id);
    if (current.status !== "approved") {
      if (current.status === "test_sent" && current.testProviderMessageId?.trim()) {
        throw new Error("CAMPAIGN_TEST_ALREADY_SENT");
      }
      throw new Error("CAMPAIGN_TEST_REQUIRES_APPROVAL");
    }
    const testEmail = getConfiguredNewsletterTestEmail(env);
    if (!testEmail) throw new Error("NEWSLETTER_TEST_EMAIL_MISSING");
    // The administrative test destination is intentionally outside the subscriber list.
    // Real campaign recipients receive persisted canonical unsubscribe tokens in the worker.
    const token = `campaign-test-token-${current.id}`;
    const publicBaseUrl = (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim();
    if (!publicBaseUrl) throw new Error("CAMPAIGN_PUBLIC_BASE_URL_MISSING");
    const unsubscribeUrl = buildUnsubscribeUrl(publicBaseUrl, token);
    const testSubject = `[Teste controlado] ${current.subject}`;
    const htmlContent = current.bodyHtml.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
    const textContent = current.bodyText.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);
    const provider: NewsletterCampaignProvider = options.provider || (env.DRY_RUN === "true"
      ? createDryRunCampaignProvider()
      : createBrevoNewsletterProvider({
          apiKey: env.BREVO_API_KEY || "",
          senderEmail: env.NEWSLETTER_SENDER_EMAIL || "",
          senderName: env.NEWSLETTER_SENDER_NAME,
          subject: current.subject,
          timeoutMs: Number(env.NEWSLETTER_PROVIDER_TIMEOUT_MS || 15_000),
        }));
    const providerResult = await provider.sendCampaign({
      campaignId: current.id,
      recipientId: `test:${current.id}`,
      subscriberEmail: testEmail,
      subject: testSubject,
      htmlContent,
      textContent,
      idempotencyKey: `campaign-test-v1:${current.id}`,
    });
    const providerReference = providerResult.providerReference?.trim();
    if (!providerReference) throw new Error("CAMPAIGN_TEST_PROVIDER_REFERENCE_MISSING");
    const tested = transitionCampaign(current, {
      type: "record_test_sent",
      actorTelegramId,
      providerReference,
    }, options.now || new Date());
    return { campaign: await store.updateCampaign(tested), providerResult };
  });
}

export async function confirmGeneralSend(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const current = await readCurrentCampaign(store, campaign.id);
  const confirmed = transitionCampaign(current, { type: "confirm_general_send", actorTelegramId }, options.now || new Date());
  return store.updateCampaign(confirmed);
}

export async function startGeneralSend(
  campaign: EmailCampaign,
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const now = options.now || new Date();
  const current = await readCurrentCampaign(store, campaign.id);
  const sending = transitionCampaign(current, { type: "begin_sending", actorTelegramId }, now);
  // A campanha geral deve alcançar todos os assinantes elegíveis; o endereço de teste
  // não é excluído aqui porque o teste controlado já terminou e a confirmação humana
  // autoriza o envio real para a lista completa.
  await store.createEligibleRecipients(current.id);
  const counts = await store.summarizeRecipients(current.id);
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
  const current = await readCurrentCampaign(store, campaign.id);
  const retrying = transitionCampaign(current, { type: "retry_failed", actorTelegramId }, options.now || new Date());
  await store.resetFailedRecipients(current.id);
  const counts = await store.summarizeRecipients(current.id);
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

export function renderCampaignTelegramPreview(campaign: EmailCampaign, product: Product | null, collectionProducts: Product[] = []): string {
  if (campaign.status === "test_sent") {
    return [
      "🧪 <b>TESTE CONTROLADO ENVIADO</b>",
      `Status: <code>${escapeTelegram(campaign.status)}</code>`,
      `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
      campaign.testSentAt ? `Executado em: <code>${escapeTelegram(campaign.testSentAt)}</code>` : "Teste controlado já executado.",
      "Este teste já foi processado. Nenhuma aprovação, edição, reteste ou ação de envio está disponível neste cartão.",
    ].join("\n");
  }
  if (campaign.status === "sent") {
    return [
      "✅ <b>CAMPANHA CONCLUÍDA</b>",
      `Status: <code>${escapeTelegram(campaign.status)}</code>`,
      `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
      "Nenhuma ação operacional está disponível neste cartão.",
    ].join("\n");
  }
  if (campaign.status === "cancelled") {
    return [
      "❌ <b>CAMPANHA CANCELADA</b>",
      `Status: <code>${escapeTelegram(campaign.status)}</code>`,
      `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
      "Nenhuma ação operacional está disponível neste cartão.",
    ].join("\n");
  }
  if (campaign.campaignType === "collection") {
    return [
      "📧 <b>PRÉVIA DE CAMPANHA</b>",
      "Tipo: <b>Campanha 2 · coleção semanal</b>",
      `Status: <code>${campaign.status}</code>`,
      `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
      `Produtos na coleção: <b>${collectionProducts.length}</b>`,
      collectionProducts.length > 0
        ? collectionProducts.map((item, index) => `${index + 1}. ${escapeTelegram(item.displayTitle || item.produto)}`).join("\n")
        : "Produtos: aguardando resolução da coleção.",
      `Destinatários elegíveis: <b>${campaign.counts.total}</b>`,
      `Sucesso: <b>${campaign.counts.success}</b> · Falhas: <b>${campaign.counts.failed}</b> · Ignorados: <b>${campaign.counts.skipped}</b>`,
      "",
      "Cada produto usa imagem canônica, CTA VER OFERTA e UTM individual.",
      "O rodapé mantém disclosure de afiliado, links legais e descadastro individual.",
    ].join("\n");
  }
  if (campaign.campaignType === "welcome") {
    return [
      "📧 <b>PRÉVIA DE CAMPANHA</b>",
      "Tipo: <b>Boas-vindas institucional</b>",
      `Status: <code>${campaign.status}</code>`,
      `Assunto: <b>${escapeTelegram(campaign.subject)}</b>`,
      `Destinatários elegíveis: <b>${campaign.counts.total}</b>`,
      `Sucesso: <b>${campaign.counts.success}</b> · Falhas: <b>${campaign.counts.failed}</b> · Ignorados: <b>${campaign.counts.skipped}</b>`,
      "",
      "A mensagem é enviada somente a assinantes com consentimento de marketing ativo.",
      "O HTML inclui identificação da Cerberus Finds, disclosure, links legais e descadastro individual.",
    ].join("\n");
  }
  if (!product) throw new Error("CAMPAIGN_PRODUCT_NOT_FOUND");
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

function getConfiguredNewsletterTestEmail(env: NodeJS.ProcessEnv): string {
  return normalizeNewsletterEmail(env.NEWSLETTER_TEST_EMAIL || "");
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
