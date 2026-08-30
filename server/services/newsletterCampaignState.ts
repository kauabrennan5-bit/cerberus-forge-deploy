import type { RenderedNewsletterCampaign } from "./newsletterCampaignTemplate";
import type { WeeklyCompositionMode, WeeklyEditorialSnapshot } from "./newsletterWeeklyEditorial";

export const EMAIL_CAMPAIGN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "test_sent",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;
export type EmailCampaignStatus = (typeof EMAIL_CAMPAIGN_STATUSES)[number];
export const EMAIL_CAMPAIGN_TYPES = ["product", "welcome", "collection"] as const;
export type EmailCampaignType = (typeof EMAIL_CAMPAIGN_TYPES)[number];

export type CampaignProductLink = {
  productId: string;
  position: number;
  layout: "feature" | "grid";
};

export type CampaignCounts = {
  total: number;
  success: number;
  failed: number;
  skipped: number;
};

export type EmailCampaign = {
  id: string;
  campaignType: EmailCampaignType;
  productId: string | null;
  /** Produtos ordenados da coleção; vazio para campanhas individuais e welcome. */
  collectionProducts: CampaignProductLink[];
  /** Assinatura canônica da edição collection; nula para campanhas individuais/welcome. */
  editionKey: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  status: EmailCampaignStatus;
  createdByTelegramId: string;
  approvedByTelegramId: string | null;
  createdAt: string;
  approvedAt: string | null;
  testSentAt: string | null;
  testSentByTelegramId: string | null;
  testProviderMessageId: string | null;
  generalSendConfirmedAt: string | null;
  generalSendConfirmedByTelegramId: string | null;
  sentAt: string | null;
  archivedAt?: string | null;
  archiveReason?: string | null;
  editorialSnapshot: WeeklyEditorialSnapshot | null;
  editorialFingerprint: string | null;
  editorialCompositionMode: WeeklyCompositionMode | null;
  editorialCategories: string[];
  previewExpiresAt: string | null;
  approvalExpiresAt: string | null;
  approvalAudienceCount: number | null;
  approvalAudienceStatus: "pending" | "ready" | "mismatch" | "unavailable" | null;
  counts: CampaignCounts;
};

export type CampaignEditorialMetadata = Pick<EmailCampaign,
  | "editorialSnapshot"
  | "editorialFingerprint"
  | "editorialCompositionMode"
  | "editorialCategories"
  | "previewExpiresAt"
  | "approvalExpiresAt"
  | "approvalAudienceCount"
  | "approvalAudienceStatus"
>;

export type CampaignTransition =
  | { type: "submit_for_approval"; actorTelegramId: string }
  | { type: "approve"; actorTelegramId: string }
  | { type: "cancel"; actorTelegramId: string }
  | { type: "record_test_sent"; actorTelegramId: string; providerReference: string }
  | { type: "confirm_general_send"; actorTelegramId: string }
  | { type: "begin_sending"; actorTelegramId: string }
  | { type: "finish_sending"; actorTelegramId: string; counts: CampaignCounts }
  | { type: "retry_failed"; actorTelegramId: string };

export class CampaignStateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CampaignStateError";
  }
}

export function createCampaignDraft(
  productId: string | null,
  createdByTelegramId: string,
  rendered: RenderedNewsletterCampaign,
  now = new Date(),
  id?: string,
  campaignType: EmailCampaignType = "product",
  collectionProducts: CampaignProductLink[] = [],
  editionKey: string | null = null,
  editorial: Partial<CampaignEditorialMetadata> = {},
): EmailCampaign {
  const actor = normalizeActor(createdByTelegramId);
  const campaignId = id || crypto.randomUUID();
  if (!EMAIL_CAMPAIGN_TYPES.includes(campaignType)) {
    throw new CampaignStateError("CAMPAIGN_TYPE_INVALID", "Tipo de campanha inválido.");
  }
  if (campaignType === "product" && !productId?.trim()) {
    throw new CampaignStateError("PRODUCT_ID_REQUIRED", "Produto obrigatório.");
  }
  if (campaignType === "welcome" && productId !== null) {
    throw new CampaignStateError("WELCOME_PRODUCT_FORBIDDEN", "Campanha de boas-vindas não pode referenciar produto.");
  }
  const normalizedCollectionProducts = collectionProducts.map(link => ({
    productId: link.productId.trim(),
    position: Math.trunc(link.position),
    layout: link.layout,
  }));
  if (campaignType !== "collection" && normalizedCollectionProducts.length > 0) {
    throw new CampaignStateError("COLLECTION_PRODUCTS_FORBIDDEN", "Somente campanhas collection podem referenciar vários produtos.");
  }
  if (campaignType === "collection") {
    if (productId !== null) {
      throw new CampaignStateError("COLLECTION_PRODUCT_FORBIDDEN", "Campanha collection não usa produto primário.");
    }
    if (normalizedCollectionProducts.length === 0 || normalizedCollectionProducts.some(link => !link.productId || link.position < 1 || !["feature", "grid"].includes(link.layout))) {
      throw new CampaignStateError("COLLECTION_PRODUCTS_REQUIRED", "Campanha collection exige produtos ordenados.");
    }
    if (new Set(normalizedCollectionProducts.map(link => link.productId)).size !== normalizedCollectionProducts.length) {
      throw new CampaignStateError("COLLECTION_PRODUCTS_DUPLICATE", "Campanha collection não pode repetir produto.");
    }
  }
  return {
    id: campaignId,
    campaignType,
    productId: productId?.trim() || null,
    collectionProducts: normalizedCollectionProducts,
    editionKey: editionKey?.trim() || null,
    subject: rendered.subject,
    bodyHtml: rendered.html,
    bodyText: rendered.text,
    status: "draft",
    createdByTelegramId: actor,
    approvedByTelegramId: null,
    createdAt: now.toISOString(),
    approvedAt: null,
    testSentAt: null,
    testSentByTelegramId: null,
    testProviderMessageId: null,
    generalSendConfirmedAt: null,
    generalSendConfirmedByTelegramId: null,
    sentAt: null,
    archivedAt: null,
    archiveReason: null,
    editorialSnapshot: editorial.editorialSnapshot || null,
    editorialFingerprint: editorial.editorialFingerprint || null,
    editorialCompositionMode: editorial.editorialCompositionMode || null,
    editorialCategories: editorial.editorialCategories || [],
    previewExpiresAt: editorial.previewExpiresAt || null,
    approvalExpiresAt: editorial.approvalExpiresAt || null,
    approvalAudienceCount: editorial.approvalAudienceCount ?? null,
    approvalAudienceStatus: editorial.approvalAudienceStatus || null,
    counts: { total: 0, success: 0, failed: 0, skipped: 0 },
  };
}

export function transitionCampaign(
  campaign: EmailCampaign,
  transition: CampaignTransition,
  now = new Date(),
): EmailCampaign {
  const actor = normalizeActor(transition.actorTelegramId);
  const next = structuredClone(campaign);
  const timestamp = now.toISOString();

  if (transition.type === "cancel") {
    if (["sent", "cancelled"].includes(campaign.status)) {
      throw new CampaignStateError("CAMPAIGN_TERMINAL", "Campanha encerrada não pode ser cancelada novamente.");
    }
    next.status = "cancelled";
    return next;
  }

  if (transition.type === "submit_for_approval") {
    expectStatus(campaign, "draft", "CAMPAIGN_NOT_DRAFT");
    next.status = "pending_approval";
    return next;
  }

  if (transition.type === "approve") {
    expectStatus(campaign, "pending_approval", "CAMPAIGN_NOT_PENDING_APPROVAL");
    next.status = "approved";
    next.approvedAt = timestamp;
    next.approvedByTelegramId = actor;
    return next;
  }

  if (transition.type === "record_test_sent") {
    expectStatus(campaign, "approved", "TEST_REQUIRED_AFTER_APPROVAL");
    const providerReference = transition.providerReference.trim();
    if (!providerReference) {
      throw new CampaignStateError("TEST_PROVIDER_REFERENCE_REQUIRED", "Referência do provider ausente.");
    }
    next.status = "test_sent";
    next.testSentAt = timestamp;
    next.testSentByTelegramId = actor;
    next.testProviderMessageId = providerReference;
    return next;
  }

  if (transition.type === "confirm_general_send") {
    if (campaign.status !== "test_sent" && campaign.status !== "approved") {
      throw new CampaignStateError("TEST_CONFIRMATION_REQUIRED", "Confirmação geral exige campanha aprovada ou teste enviado.");
    }
    if (campaign.status === "approved" && (campaign.testSentAt || campaign.testProviderMessageId)) {
      throw new CampaignStateError("GENERAL_SEND_GATE_REQUIRED", "Campanha com teste registrado deve seguir o fluxo de teste.");
    }
    next.generalSendConfirmedAt = timestamp;
    next.generalSendConfirmedByTelegramId = actor;
    return next;
  }

  if (transition.type === "begin_sending") {
    if (campaign.status !== "test_sent" && campaign.status !== "approved" && campaign.status !== "failed") {
      throw new CampaignStateError("GENERAL_SEND_GATE_REQUIRED", "Envio geral exige campanha aprovada, confirmação humana e, quando aplicável, teste enviado.");
    }
    if (!campaign.generalSendConfirmedAt || !campaign.generalSendConfirmedByTelegramId) {
      throw new CampaignStateError("GENERAL_SEND_CONFIRMATION_REQUIRED", "Confirmação humana do envio geral ausente.");
    }
    next.status = "sending";
    return next;
  }

  if (transition.type === "retry_failed") {
    expectStatus(campaign, "failed", "RETRY_ONLY_FAILED_CAMPAIGN");
    if (!campaign.generalSendConfirmedAt || !campaign.generalSendConfirmedByTelegramId) {
      throw new CampaignStateError("GENERAL_SEND_CONFIRMATION_REQUIRED", "Retry exige confirmação humana já registrada.");
    }
    next.status = "sending";
    return next;
  }

  if (transition.type === "finish_sending") {
    expectStatus(campaign, "sending", "CAMPAIGN_NOT_SENDING");
    validateCounts(transition.counts);
    next.counts = transition.counts;
    next.status = transition.counts.failed > 0 ? "failed" : "sent";
    next.sentAt = transition.counts.failed === 0 ? timestamp : null;
    return next;
  }

  throw new CampaignStateError("UNKNOWN_CAMPAIGN_TRANSITION", "Transição de campanha não suportada.");
}

export function canEditCampaign(campaign: Pick<EmailCampaign, "status">): boolean {
  return campaign.status === "draft" || campaign.status === "pending_approval";
}

export function updateCampaignSubject(campaign: EmailCampaign, subject: string): EmailCampaign {
  if (!canEditCampaign(campaign)) {
    throw new CampaignStateError("CAMPAIGN_SUBJECT_LOCKED", "O assunto só pode ser alterado antes da aprovação.");
  }
  const normalized = subject.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 255) {
    throw new CampaignStateError("CAMPAIGN_SUBJECT_INVALID", "O assunto deve ter entre 1 e 255 caracteres.");
  }
  return { ...structuredClone(campaign), subject: normalized };
}

export function canApproveCampaign(campaign: Pick<EmailCampaign, "status">): boolean {
  return campaign.status === "pending_approval";
}

export function canConfirmGeneralSend(campaign: Pick<EmailCampaign, "status">): boolean {
  return campaign.status === "test_sent";
}

function expectStatus(campaign: EmailCampaign, expected: EmailCampaignStatus, code: string): void {
  if (campaign.status !== expected) {
    throw new CampaignStateError(code, `Estado atual incompatível: ${campaign.status}. Esperado: ${expected}.`);
  }
}

function validateCounts(counts: CampaignCounts): void {
  if ([counts.total, counts.success, counts.failed, counts.skipped].some(value => !Number.isInteger(value) || value < 0)) {
    throw new CampaignStateError("CAMPAIGN_COUNTS_INVALID", "Contagens de campanha inválidas.");
  }
  if (counts.success + counts.failed + counts.skipped !== counts.total) {
    throw new CampaignStateError("CAMPAIGN_COUNTS_INCOMPLETE", "As contagens não fecham o total de destinatários.");
  }
}

function normalizeActor(value: string): string {
  const actor = value.trim();
  if (!actor) throw new CampaignStateError("TELEGRAM_ACTOR_REQUIRED", "Ator Telegram obrigatório.");
  return actor;
}
