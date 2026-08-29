import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";
import { NewsletterProviderError, type NewsletterProviderResult } from "./newsletterProvider";
import { BREVO_NATIVE_UNSUBSCRIBE } from "./newsletterWeeklyTemplate";

export type WeeklyBrevoCampaignOperation = "create" | "send_test" | "send_now";

export type WeeklyBrevoCampaignResult = NewsletterProviderResult & {
  brevoCampaignId: string;
  operation: WeeklyBrevoCampaignOperation;
  providerRef: string;
};

export type WeeklyBrevoCreateInput = {
  campaignId: string;
  name: string;
  subject: string;
  htmlContent: string;
  previewText?: string;
  listIds?: number[];
};

export interface WeeklyBrevoMarketingProvider {
  createCampaign(input: WeeklyBrevoCreateInput): Promise<WeeklyBrevoCampaignResult>;
  sendTest(brevoCampaignId: string, emailTo: string[]): Promise<WeeklyBrevoCampaignResult>;
  sendNow(brevoCampaignId: string): Promise<WeeklyBrevoCampaignResult>;
}

export type WeeklyBrevoMarketingProviderOptions = {
  apiKey: string;
  senderEmail: string;
  senderName?: string;
  replyToEmail?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "https://api.brevo.com/v3";
const DEFAULT_SENDER_NAME = "Cerberus Finds";
const DEFAULT_TIMEOUT_MS = 15_000;

export function createConfiguredWeeklyBrevoMarketingProvider(
  env: NodeJS.ProcessEnv = process.env,
): WeeklyBrevoMarketingProvider {
  return createWeeklyBrevoMarketingProvider({
    apiKey: env.BREVO_API_KEY || "",
    senderEmail: env.NEWSLETTER_SENDER_EMAIL || "",
    senderName: env.NEWSLETTER_SENDER_NAME,
    replyToEmail: env.NEWSLETTER_REPLY_TO_EMAIL,
    timeoutMs: Number(env.NEWSLETTER_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
}

export function createWeeklyBrevoMarketingProvider(
  options: WeeklyBrevoMarketingProviderOptions,
): WeeklyBrevoMarketingProvider {
  const apiKey = options.apiKey.trim();
  const senderEmail = normalizeNewsletterEmail(options.senderEmail);
  const replyToCandidate = normalizeNewsletterEmail(options.replyToEmail);
  const replyToEmail = replyToCandidate || senderEmail;
  if (!apiKey || !isValidNewsletterEmail(senderEmail) || !isValidNewsletterEmail(replyToEmail)) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "WEEKLY_BREVO_CONFIG_MISSING",
      "Provider de marketing Brevo não configurado com API key, remetente e reply-to válidos.",
    );
  }
  if (isTechnicalBrevoRelayEmail(senderEmail)) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "WEEKLY_BREVO_PUBLIC_SENDER_REQUIRED",
      "A weekly exige remetente público em domínio de marca verificado.",
    );
  }

  const senderName = (options.senderName || DEFAULT_SENDER_NAME).trim() || DEFAULT_SENDER_NAME;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const fetchImpl = options.fetchImpl || fetch;

  const request = async (
    operation: WeeklyBrevoCampaignOperation,
    path: string,
    body: Record<string, unknown> | undefined,
    existingCampaignId?: string,
  ): Promise<WeeklyBrevoCampaignResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const responseText = await response.text();
      const responseBody = parseJson(responseText);
      if (!response.ok) throw classifyBrevoHttpFailure(response.status);
      const brevoCampaignId = operation === "create"
        ? normalizeCampaignId(responseBody.id)
        : normalizeCampaignId(existingCampaignId);
      if (!brevoCampaignId) {
        throw new NewsletterProviderError(
          "unknown",
          "WEEKLY_BREVO_CAMPAIGN_ID_MISSING",
          "Brevo não retornou uma referência de campanha válida.",
        );
      }
      return {
        status: "succeeded",
        brevoCampaignId,
        operation,
        providerRef: brevoCampaignId,
        providerReference: brevoCampaignId,
      };
    } catch (error) {
      if (error instanceof NewsletterProviderError) throw error;
      if (isAbortError(error)) {
        throw new NewsletterProviderError("timeout", "WEEKLY_BREVO_TIMEOUT", "Timeout no provider de marketing Brevo.");
      }
      throw new NewsletterProviderError(
        "unknown",
        "WEEKLY_BREVO_TRANSPORT_ERROR",
        "Falha de transporte no provider de marketing Brevo.",
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async createCampaign(input) {
      const campaignId = input.campaignId.trim();
      const name = input.name.replace(/\s+/g, " ").trim();
      const subject = input.subject.replace(/\s+/g, " ").trim();
      if (!campaignId || !name || !subject) {
        throw new NewsletterProviderError(
          "permanent_4xx",
          "WEEKLY_BREVO_CREATE_INPUT_INVALID",
          "Identidade, nome ou assunto da campanha semanal são inválidos.",
        );
      }
      assertMarketingHtml(input.htmlContent);
      const payload: Record<string, unknown> = {
        name,
        type: "classic",
        sender: { email: senderEmail, name: senderName },
        replyTo: replyToEmail,
        subject,
        htmlContent: input.htmlContent,
      };
      const previewText = input.previewText?.replace(/\s+/g, " ").trim();
      if (previewText) payload.previewText = previewText;
      const listIds = normalizeListIds(input.listIds);
      if (listIds.length > 0) payload.recipients = { listIds };
      return request("create", "/emailCampaigns", payload);
    },

    async sendTest(brevoCampaignId, emailTo) {
      const normalizedId = requireCampaignId(brevoCampaignId);
      const recipients = emailTo.map(normalizeNewsletterEmail).filter(Boolean);
      if (recipients.length !== 1 || !isValidNewsletterEmail(recipients[0])) {
        throw new NewsletterProviderError(
          "permanent_4xx",
          "WEEKLY_BREVO_TEST_EMAIL_REQUIRED",
          "O teste semanal exige exatamente um NEWSLETTER_TEST_EMAIL válido.",
        );
      }
      return request(
        "send_test",
        `/emailCampaigns/${encodeURIComponent(normalizedId)}/sendTest`,
        { emailTo: recipients },
        normalizedId,
      );
    },

    async sendNow(brevoCampaignId) {
      const normalizedId = requireCampaignId(brevoCampaignId);
      return request(
        "send_now",
        `/emailCampaigns/${encodeURIComponent(normalizedId)}/sendNow`,
        undefined,
        normalizedId,
      );
    },
  };
}

function assertMarketingHtml(htmlContent: string): void {
  const html = htmlContent.trim();
  if (!html || !html.includes(BREVO_NATIVE_UNSUBSCRIBE)) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "WEEKLY_UNSUBSCRIBE_PLACEHOLDER_REQUIRED",
      "HTML semanal deve preservar o placeholder nativo de unsubscribe da Brevo.",
    );
  }
  const escaped = BREVO_NATIVE_UNSUBSCRIBE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchor = new RegExp(`<a\\b[^>]*href=["']${escaped}["'][^>]*>`, "i");
  if (!anchor.test(html)) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "WEEKLY_UNSUBSCRIBE_ANCHOR_REQUIRED",
      "HTML semanal deve conter âncora de unsubscribe suportada pela Brevo.",
    );
  }
}

function normalizeListIds(values: number[] | undefined): number[] {
  if (!values) return [];
  return [...new Set(values.map(value => Math.trunc(Number(value))).filter(value => Number.isSafeInteger(value) && value > 0))];
}

function requireCampaignId(value: string): string {
  const normalized = normalizeCampaignId(value);
  if (!normalized) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "WEEKLY_BREVO_CAMPAIGN_ID_INVALID",
      "ID da campanha Brevo inválido.",
    );
  }
  return normalized;
}

function normalizeCampaignId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim()) && Number(value.trim()) > 0) return value.trim();
  return "";
}

function parseJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function classifyBrevoHttpFailure(status: number): NewsletterProviderError {
  if (status === 408 || status === 429 || status >= 500) {
    return new NewsletterProviderError(
      "transient_5xx",
      `WEEKLY_BREVO_HTTP_${status}`,
      "Provider de marketing Brevo indisponível ou limitou a solicitação.",
    );
  }
  if (status >= 400 && status < 500) {
    return new NewsletterProviderError(
      "permanent_4xx",
      `WEEKLY_BREVO_HTTP_${status}`,
      "Provider de marketing Brevo rejeitou a solicitação.",
    );
  }
  return new NewsletterProviderError(
    "unknown",
    `WEEKLY_BREVO_HTTP_${status}`,
    "Provider de marketing Brevo retornou resposta não classificada.",
  );
}

function isTechnicalBrevoRelayEmail(email: string): boolean {
  const domain = email.split("@").pop()?.toLowerCase() || "";
  return domain === "brevosend.com" || domain.endsWith(".brevosend.com");
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}
