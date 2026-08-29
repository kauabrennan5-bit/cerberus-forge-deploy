import type { NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { createSupabaseNewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { transitionCampaign, type EmailCampaign } from "./newsletterCampaignState";

const DEFAULT_BASE_URL = "https://api.brevo.com/v3";
const DEFAULT_TIMEOUT_MS = 15_000;

export type WeeklyBrevoStatusReconcileResult = {
  checked: number;
  finalized: number;
  pending: number;
  blocked: number;
  errors: number;
  finalizedCampaignIds: string[];
};

export type WeeklyBrevoStatusReconcileOptions = {
  env?: NodeJS.ProcessEnv;
  store?: NewsletterCampaignStore;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  limit?: number;
  now?: Date;
};

/**
 * Reconciliação read-only no provider: somente GET de campanhas Brevo.
 * A única escrita é finalizar no Cerberus uma campanha que a Brevo já confirma como sent.
 */
export async function reconcileWeeklyBrevoCampaignStatuses(
  options: WeeklyBrevoStatusReconcileOptions = {},
): Promise<WeeklyBrevoStatusReconcileResult> {
  const env = options.env || process.env;
  const apiKey = (env.BREVO_API_KEY || "").trim();
  if (!apiKey) throw new Error("WEEKLY_BREVO_STATUS_API_KEY_MISSING");
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const campaigns = await store.listSendingCampaigns(Math.max(1, Math.min(50, Math.trunc(options.limit || 20))));
  const weekly = campaigns.filter(campaign => campaign.editionKey?.startsWith("weekly:") && campaign.testProviderMessageId?.trim());
  const result: WeeklyBrevoStatusReconcileResult = {
    checked: 0,
    finalized: 0,
    pending: 0,
    blocked: 0,
    errors: 0,
    finalizedCampaignIds: [],
  };

  for (const campaign of weekly) {
    result.checked += 1;
    try {
      const status = await readBrevoCampaignStatus(
        campaign.testProviderMessageId || "",
        { apiKey, baseUrl, timeoutMs, fetchImpl },
      );
      if (status === "sent") {
        const actor = campaign.generalSendConfirmedByTelegramId
          || campaign.approvedByTelegramId
          || campaign.createdByTelegramId;
        const finalized = transitionCampaign(
          campaign,
          { type: "finish_sending", actorTelegramId: actor, counts: campaign.counts },
          options.now || new Date(),
        );
        await store.updateCampaign(finalized);
        result.finalized += 1;
        result.finalizedCampaignIds.push(campaign.id);
      } else if (status === "queued" || status === "draft") {
        result.pending += 1;
      } else {
        // Não inventamos conclusão/falha local para estados provider que exigem decisão humana.
        result.blocked += 1;
        console.error(`[NEWSLETTER-WEEKLY] provider_status_requires_review status=${safeStatus(status)}`);
      }
    } catch (error) {
      result.errors += 1;
      console.error(`[NEWSLETTER-WEEKLY] provider_status_reconcile_failed code=${safeErrorCode(error)}`);
    }
  }
  return result;
}

async function readBrevoCampaignStatus(
  campaignId: string,
  input: { apiKey: string; baseUrl: string; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<string> {
  const normalizedId = campaignId.trim();
  if (!/^\d+$/.test(normalizedId) || Number(normalizedId) <= 0) throw new Error("WEEKLY_BREVO_STATUS_CAMPAIGN_ID_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(
      `${input.baseUrl}/emailCampaigns/${encodeURIComponent(normalizedId)}?excludeHtmlContent=true`,
      {
        method: "GET",
        headers: { accept: "application/json", "api-key": input.apiKey },
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`WEEKLY_BREVO_STATUS_HTTP_${response.status}`);
    const body = await response.json().catch(() => null);
    const status = body && typeof body === "object" && typeof (body as { status?: unknown }).status === "string"
      ? String((body as { status: string }).status).trim().toLowerCase()
      : "";
    if (!/^[a-z_]{2,40}$/.test(status)) throw new Error("WEEKLY_BREVO_STATUS_INVALID_RESPONSE");
    return status;
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
      throw new Error("WEEKLY_BREVO_STATUS_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message.trim() : "WEEKLY_BREVO_STATUS_UNKNOWN";
  return /^[A-Z0-9_:-]{1,100}$/.test(value) ? value : "WEEKLY_BREVO_STATUS_UNKNOWN";
}

function safeStatus(value: string): string {
  return /^[a-z_]{2,40}$/.test(value) ? value : "unknown";
}
