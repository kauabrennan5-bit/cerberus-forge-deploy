import type { RenderedNewsletterCampaign } from "./newsletterCampaignTemplate";

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

export type CampaignCounts = {
  total: number;
  success: number;
  failed: number;
  skipped: number;
};

export type EmailCampaign = {
  id: string;
  productId: string;
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
  generalSendConfirmedAt: string | null;
  generalSendConfirmedByTelegramId: string | null;
  sentAt: string | null;
  counts: CampaignCounts;
};

export type CampaignTransition =
  | { type: "submit_for_approval"; actorTelegramId: string }
  | { type: "approve"; actorTelegramId: string }
  | { type: "cancel"; actorTelegramId: string }
  | { type: "record_test_sent"; actorTelegramId: string }
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
  productId: string,
  createdByTelegramId: string,
  rendered: RenderedNewsletterCampaign,
  now = new Date(),
  id?: string,
): EmailCampaign {
  const actor = normalizeActor(createdByTelegramId);
  const campaignId = id || crypto.randomUUID();
  if (!productId.trim()) throw new CampaignStateError("PRODUCT_ID_REQUIRED", "Produto obrigatório.");
  return {
    id: campaignId,
    productId: productId.trim(),
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
    generalSendConfirmedAt: null,
    generalSendConfirmedByTelegramId: null,
    sentAt: null,
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
    next.status = "test_sent";
    next.testSentAt = timestamp;
    next.testSentByTelegramId = actor;
    return next;
  }

  if (transition.type === "confirm_general_send") {
    expectStatus(campaign, "test_sent", "TEST_CONFIRMATION_REQUIRED");
    next.generalSendConfirmedAt = timestamp;
    next.generalSendConfirmedByTelegramId = actor;
    return next;
  }

  if (transition.type === "begin_sending") {
    if (campaign.status !== "test_sent" && campaign.status !== "failed") {
      throw new CampaignStateError("GENERAL_SEND_GATE_REQUIRED", "Envio geral exige teste enviado e confirmação humana.");
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
