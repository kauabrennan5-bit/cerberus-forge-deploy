import { createHash } from "node:crypto";
import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";
import { sanitizeOperationalText } from "./operationalDiagnostics";
import { renderNewsletterWelcomeCampaign } from "./newsletterCampaignTemplate";
import { getNewsletterInstitutionalOptions } from "./newsletterInstitutional";

export type NewsletterProviderResult =
  | { status: "succeeded"; providerReference?: string }
  | { status: "duplicate"; providerReference?: string };

export type NewsletterProviderFailureKind = "timeout" | "transient_5xx" | "permanent_4xx" | "unknown";

export class NewsletterProviderError extends Error {
  constructor(
    public readonly kind: NewsletterProviderFailureKind,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NewsletterProviderError";
  }
}

export interface NewsletterProviderInput {
  subscriberEmail: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface NewsletterCampaignProviderInput {
  campaignId: string;
  recipientId: string;
  subscriberEmail: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  idempotencyKey: string;
}

export interface NewsletterProvider {
  project(input: NewsletterProviderInput, idempotencyKey: string): Promise<NewsletterProviderResult>;
}

export interface NewsletterCampaignProvider {
  sendCampaign(input: NewsletterCampaignProviderInput): Promise<NewsletterProviderResult>;
}

export type BrevoNewsletterProvider = NewsletterProvider & NewsletterCampaignProvider;

export interface BrevoNewsletterProviderOptions {
  apiKey: string;
  senderEmail: string;
  senderName?: string;
  subject?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface NewsletterProviderConfigStatus {
  provider: "brevo";
  configured: boolean;
  apiKeyPresent: boolean;
  senderEmailPresent: boolean;
  senderNamePresent: boolean;
}

const DEFAULT_BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER_NAME = "Cerberus Finds";
const DEFAULT_SUBJECT = "Sua inscrição no Cerberus Finds foi confirmada";
const DEFAULT_TIMEOUT_MS = 15_000;

export function getNewsletterProviderConfigStatus(env: NodeJS.ProcessEnv = process.env): NewsletterProviderConfigStatus {
  const apiKeyPresent = Boolean(env.BREVO_API_KEY?.trim());
  const senderEmailPresent = Boolean(env.NEWSLETTER_SENDER_EMAIL?.trim());
  const senderNamePresent = Boolean((env.NEWSLETTER_SENDER_NAME || DEFAULT_SENDER_NAME).trim());
  return {
    provider: "brevo",
    configured: apiKeyPresent && senderEmailPresent,
    apiKeyPresent,
    senderEmailPresent,
    senderNamePresent,
  };
}

export function createBrevoNewsletterProvider(options: BrevoNewsletterProviderOptions): BrevoNewsletterProvider {
  const apiKey = options.apiKey.trim();
  const senderEmail = normalizeNewsletterEmail(options.senderEmail);
  if (!apiKey || !isValidNewsletterEmail(senderEmail)) {
    throw new NewsletterProviderError(
      "permanent_4xx",
      "PROVIDER_CONFIG_MISSING",
      "Provider Brevo não configurado com API key e remetente válidos.",
    );
  }

  const senderName = (options.senderName || DEFAULT_SENDER_NAME).trim() || DEFAULT_SENDER_NAME;
  const subject = (options.subject || DEFAULT_SUBJECT).trim() || DEFAULT_SUBJECT;
  const institutional = getNewsletterInstitutionalOptions();
  const endpoint = options.endpoint || DEFAULT_BREVO_ENDPOINT;
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const fetchImpl = options.fetchImpl || fetch;

  const sendMessage = async (input: {
    subscriberEmail: string;
    subject: string;
    htmlContent: string;
    textContent: string;
    idempotencyKey: string;
  }): Promise<NewsletterProviderResult> => {
    const subscriberEmail = normalizeNewsletterEmail(input.subscriberEmail);
    if (!isValidNewsletterEmail(subscriberEmail) || !input.idempotencyKey.trim()) {
      throw new NewsletterProviderError("permanent_4xx", "INVALID_PROVIDER_INPUT", "Entrada inválida para o provider.");
    }
    const normalizedSubject = input.subject.replace(/\s+/g, " ").trim();
    if (!normalizedSubject || !input.htmlContent.trim() || !input.textContent.trim()) {
      throw new NewsletterProviderError("permanent_4xx", "INVALID_PROVIDER_CONTENT", "Conteúdo inválido para o provider.");
    }

    const providerIdempotencyKey = toProviderUuid(input.idempotencyKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({
          sender: { email: senderEmail, name: senderName },
          subject: normalizedSubject,
          htmlContent: input.htmlContent,
          textContent: input.textContent,
          messageVersions: [{
            to: [{ email: subscriberEmail }],
            subject: normalizedSubject,
            htmlContent: input.htmlContent,
            textContent: input.textContent,
          }],
          headers: { idempotencyKey: providerIdempotencyKey },
        }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      const responseBody = parseJson(responseText);

      if (response.ok) {
        return {
          status: "succeeded",
          providerReference: extractProviderReference(responseBody),
        };
      }

      if (isProviderDuplicate(response.status, responseBody, responseText)) {
        return {
          status: "duplicate",
          providerReference: extractProviderReference(responseBody),
        };
      }

      throw classifyBrevoHttpFailure(response.status);
    } catch (error) {
      if (error instanceof NewsletterProviderError) throw error;
      if (isAbortError(error)) {
        throw new NewsletterProviderError("timeout", "PROVIDER_TIMEOUT", "Timeout ao enviar mensagem ao provider.");
      }
      throw new NewsletterProviderError("unknown", "PROVIDER_TRANSPORT_ERROR", "Falha de transporte ao enviar mensagem ao provider.");
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async project(input, idempotencyKey) {
      return sendMessage({
        subscriberEmail: input.subscriberEmail,
        subject,
        htmlContent: renderNewsletterWelcomeCampaign({
          subject,
          preheader: "Sua inscrição no Cerberus Finds foi confirmada.",
          includeUnsubscribe: false,
          privacyUrl: institutional.privacyUrl,
          termsUrl: institutional.termsUrl,
          socialLinks: institutional.socialLinks,
        }).html,
        textContent: renderNewsletterWelcomeCampaign({
          subject,
          preheader: "Sua inscrição no Cerberus Finds foi confirmada.",
          includeUnsubscribe: false,
          privacyUrl: institutional.privacyUrl,
          termsUrl: institutional.termsUrl,
          socialLinks: institutional.socialLinks,
        }).text,
        idempotencyKey,
      });
    },
    async sendCampaign(input) {
      if (!input.campaignId.trim() || !input.recipientId.trim()) {
        throw new NewsletterProviderError("permanent_4xx", "INVALID_CAMPAIGN_PROVIDER_INPUT", "Identidade da campanha inválida.");
      }
      return sendMessage(input);
    },
  };
}

export function createConfiguredNewsletterProvider(env: NodeJS.ProcessEnv = process.env): BrevoNewsletterProvider {
  return createBrevoNewsletterProvider({
    apiKey: env.BREVO_API_KEY || "",
    senderEmail: env.NEWSLETTER_SENDER_EMAIL || "",
    senderName: env.NEWSLETTER_SENDER_NAME,
    subject: env.NEWSLETTER_SUBJECT,
    timeoutMs: Number(env.NEWSLETTER_PROVIDER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  });
}

function toProviderUuid(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8).join("")}-${digest.slice(8, 12).join("")}-${digest.slice(12, 16).join("")}-${digest.slice(16, 20).join("")}-${digest.slice(20, 32).join("")}`;
}


function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function extractProviderReference(body: Record<string, unknown>): string | undefined {
  const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
  if (messageId) return sanitizeOperationalText(messageId);
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds : [];
  const first = messageIds.find((value): value is string => typeof value === "string");
  return first ? sanitizeOperationalText(first) : undefined;
}

function isProviderDuplicate(status: number, body: Record<string, unknown>, responseText: string): boolean {
  if (status !== 400 && status !== 409) return false;
  const normalized = `${String(body.code || "")} ${String(body.message || "")} ${responseText}`.toLowerCase();
  return normalized.includes("duplicate_parameter") || normalized.includes("idempotency") && normalized.includes("duplicate");
}

function classifyBrevoHttpFailure(status: number): NewsletterProviderError {
  if (status === 408 || status === 429 || status >= 500) {
    return new NewsletterProviderError("transient_5xx", `PROVIDER_HTTP_${status}`, "Provider indisponível ou limitou a solicitação.");
  }
  if (status >= 400 && status < 500) {
    return new NewsletterProviderError("permanent_4xx", `PROVIDER_HTTP_${status}`, "Provider rejeitou a solicitação.");
  }
  return new NewsletterProviderError("unknown", `PROVIDER_HTTP_${status}`, "Provider retornou uma resposta não classificada.");
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}
