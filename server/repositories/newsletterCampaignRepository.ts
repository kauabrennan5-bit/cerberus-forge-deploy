import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase as configuredSupabase, requireSupabase } from "./productsRepository";
import type { CampaignCounts, EmailCampaign, EmailCampaignStatus, EmailCampaignType } from "../services/newsletterCampaignState";
import { issueUnsubscribeToken } from "../services/newsletterConsent";

export type EmailCampaignRecipientStatus = "pending" | "sent" | "failed" | "skipped_unsubscribed";

export type EmailCampaignRecipient = {
  id: string;
  campaignId: string;
  subscriberEmail: string;
  status: EmailCampaignRecipientStatus;
  providerMessageId: string | null;
  errorDetail: string | null;
  sentAt: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  leaseUntil: string | null;
  leaseToken: string | null;
  processingStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignSubscriberEligibility = {
  status: "subscribed" | "unsubscribed" | "suppressed";
  marketing_consent: boolean;
};

export interface NewsletterCampaignStore {
  createCampaign(campaign: EmailCampaign): Promise<EmailCampaign>;
  getCampaign(campaignId: string): Promise<EmailCampaign | null>;
  listRecentCampaigns(limit: number): Promise<EmailCampaign[]>;
  updateCampaign(campaign: EmailCampaign): Promise<EmailCampaign>;
  createEligibleRecipients(campaignId: string): Promise<number>;
  claimRecipient(campaignId: string, leaseToken: string, leaseMs: number): Promise<{ recipient: EmailCampaignRecipient; leaseToken: string } | null>;
  readSubscriber(email: string): Promise<CampaignSubscriberEligibility | null>;
  prepareUnsubscribeToken(email: string): Promise<string>;
  markRecipientSent(recipientId: string, leaseToken: string, providerMessageId?: string): Promise<EmailCampaignRecipient | null>;
  markRecipientSkipped(recipientId: string, leaseToken: string, reason: string): Promise<EmailCampaignRecipient | null>;
  markRecipientFailed(recipientId: string, leaseToken: string, errorDetail: string, nextAttemptAt: string): Promise<EmailCampaignRecipient | null>;
  summarizeRecipients(campaignId: string): Promise<CampaignCounts>;
  listRetryableRecipients(campaignId: string): Promise<EmailCampaignRecipient[]>;
  resetFailedRecipients(campaignId: string): Promise<number>;
  listSendingCampaigns(limit: number): Promise<EmailCampaign[]>;
}

export function createSupabaseNewsletterCampaignStore(client: SupabaseClient = requireSupabase()): NewsletterCampaignStore {
  return new SupabaseNewsletterCampaignStore(client);
}

export function getConfiguredCampaignSupabase(): SupabaseClient | null {
  return configuredSupabase;
}

class SupabaseNewsletterCampaignStore implements NewsletterCampaignStore {
  constructor(private readonly client: SupabaseClient) {}

  async createCampaign(campaign: EmailCampaign): Promise<EmailCampaign> {
    const { data, error } = await this.client
      .from("email_campaigns")
      .insert(toCampaignRow(campaign))
      .select("*")
      .single();
    if (error || !data) throw error || new Error("EMAIL_CAMPAIGN_CREATE_FAILED");
    return fromCampaignRow(data);
  }

  async getCampaign(campaignId: string): Promise<EmailCampaign | null> {
    const { data, error } = await this.client
      .from("email_campaigns")
      .select("*")
      .eq("id", campaignId)
      .maybeSingle();
    if (error) throw error;
    return data ? fromCampaignRow(data) : null;
  }

  async updateCampaign(campaign: EmailCampaign): Promise<EmailCampaign> {
    const { data, error } = await this.client
      .from("email_campaigns")
      .update(toCampaignRow(campaign))
      .eq("id", campaign.id)
      .select("*")
      .single();
    if (error || !data) throw error || new Error("EMAIL_CAMPAIGN_UPDATE_FAILED");
    return fromCampaignRow(data);
  }

  async listRecentCampaigns(limit: number): Promise<EmailCampaign[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const { data, error } = await this.client
      .from("email_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(boundedLimit);
    if (error) throw error;
    return (data || []).map(fromCampaignRow);
  }

  async createEligibleRecipients(campaignId: string): Promise<number> {
    let offset = 0;
    let inserted = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await this.client
        .from("newsletter_subscribers")
        .select("email")
        .eq("status", "subscribed")
        .eq("marketing_consent", true)
        .order("email", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const emails = (data || [])
        .map(row => typeof row.email === "string" ? row.email.trim().toLowerCase() : "")
        .filter(Boolean);
      if (emails.length === 0) break;
      const rows = emails.map(subscriberEmail => ({ campaign_id: campaignId, subscriber_email: subscriberEmail }));
      const { data: insertedRows, error: insertError } = await this.client
        .from("email_campaign_recipients")
        .upsert(rows, { onConflict: "campaign_id,subscriber_email", ignoreDuplicates: true })
        .select("id");
      if (insertError) throw insertError;
      inserted += Array.isArray(insertedRows) ? insertedRows.length : 0;
      if (emails.length < pageSize) break;
      offset += pageSize;
    }
    return inserted;
  }

  async claimRecipient(campaignId: string, leaseToken: string, leaseMs: number): Promise<{ recipient: EmailCampaignRecipient; leaseToken: string } | null> {
    const { data, error } = await this.client.rpc("claim_email_campaign_recipient", {
      p_campaign_id: campaignId,
      p_lease_token: leaseToken,
      p_lease_ms: leaseMs,
    });
    if (error) throw error;
    const first = Array.isArray(data) ? data[0] : data;
    return first ? { recipient: fromRecipientRow(first), leaseToken } : null;
  }

  async readSubscriber(email: string): Promise<CampaignSubscriberEligibility | null> {
    const { data, error } = await this.client
      .from("newsletter_subscribers")
      .select("status, marketing_consent")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      status: data.status as CampaignSubscriberEligibility["status"],
      marketing_consent: data.marketing_consent === true,
    };
  }

  async prepareUnsubscribeToken(email: string): Promise<string> {
    const issued = issueUnsubscribeToken();
    const { data, error } = await this.client
      .from("newsletter_subscribers")
      .update({
        unsubscribe_token_hash: issued.tokenHash,
        unsubscribe_token_expires_at: issued.expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("email", email)
      .eq("status", "subscribed")
      .eq("marketing_consent", true)
      .select("email")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("SUBSCRIBER_NOT_MARKETING_ELIGIBLE");
    return issued.token;
  }

  async markRecipientSent(recipientId: string, leaseToken: string, providerMessageId?: string): Promise<EmailCampaignRecipient | null> {
    return this.updateOwnedRecipient(recipientId, leaseToken, {
      status: "sent",
      provider_message_id: providerMessageId || null,
      error_detail: null,
      sent_at: new Date().toISOString(),
      lease_until: null,
      lease_token: null,
      updated_at: new Date().toISOString(),
    });
  }

  async markRecipientSkipped(recipientId: string, leaseToken: string, reason: string): Promise<EmailCampaignRecipient | null> {
    return this.updateOwnedRecipient(recipientId, leaseToken, {
      status: "skipped_unsubscribed",
      error_detail: reason.slice(0, 500),
      sent_at: null,
      lease_until: null,
      lease_token: null,
      updated_at: new Date().toISOString(),
    });
  }

  async markRecipientFailed(recipientId: string, leaseToken: string, errorDetail: string, nextAttemptAt: string): Promise<EmailCampaignRecipient | null> {
    return this.updateOwnedRecipient(recipientId, leaseToken, {
      status: "failed",
      error_detail: errorDetail.slice(0, 500),
      sent_at: null,
      next_attempt_at: nextAttemptAt,
      lease_until: null,
      lease_token: null,
      updated_at: new Date().toISOString(),
    });
  }

  async summarizeRecipients(campaignId: string): Promise<CampaignCounts> {
    let offset = 0;
    const pageSize = 1000;
    const counts: CampaignCounts = { total: 0, success: 0, failed: 0, skipped: 0 };
    while (true) {
      const { data, error } = await this.client
        .from("email_campaign_recipients")
        .select("status")
        .eq("campaign_id", campaignId)
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const rows = data || [];
      for (const row of rows) {
        counts.total += 1;
        if (row.status === "sent") counts.success += 1;
        else if (row.status === "failed") counts.failed += 1;
        else if (row.status === "skipped_unsubscribed") counts.skipped += 1;
      }
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
    return counts;
  }

  async listSendingCampaigns(limit: number): Promise<EmailCampaign[]> {
    const { data, error } = await this.client
      .from("email_campaigns")
      .select("*")
      .eq("status", "sending")
      .order("created_at", { ascending: true })
      .limit(Math.max(1, Math.min(100, limit)));
    if (error) throw error;
    return (data || []).map(fromCampaignRow);
  }

  async listRetryableRecipients(campaignId: string): Promise<EmailCampaignRecipient[]> {
    const { data, error } = await this.client
      .from("email_campaign_recipients")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("status", "failed")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(fromRecipientRow);
  }

  async resetFailedRecipients(campaignId: string): Promise<number> {
    const { data, error } = await this.client.rpc("reset_email_campaign_failed_recipients", {
      p_campaign_id: campaignId,
    });
    if (error) throw error;
    return Number(data || 0);
  }

  private async updateOwnedRecipient(recipientId: string, leaseToken: string, patch: Record<string, unknown>): Promise<EmailCampaignRecipient | null> {
    const { data, error } = await this.client
      .from("email_campaign_recipients")
      .update(patch)
      .eq("id", recipientId)
      .eq("lease_token", leaseToken)
      .in("status", ["pending", "failed"])
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? fromRecipientRow(data) : null;
  }
}

function toCampaignRow(campaign: EmailCampaign): Record<string, unknown> {
  return {
    id: campaign.id,
    campaign_type: campaign.campaignType,
    product_id: campaign.productId,
    subject: campaign.subject,
    body_html: campaign.bodyHtml,
    body_text: campaign.bodyText,
    status: campaign.status,
    created_by_telegram_id: campaign.createdByTelegramId,
    approved_by_telegram_id: campaign.approvedByTelegramId,
    created_at: campaign.createdAt,
    approved_at: campaign.approvedAt,
    test_sent_at: campaign.testSentAt,
    test_sent_by_telegram_id: campaign.testSentByTelegramId,
    test_provider_message_id: campaign.testProviderMessageId,
    general_send_confirmed_at: campaign.generalSendConfirmedAt,
    general_send_confirmed_by_telegram_id: campaign.generalSendConfirmedByTelegramId,
    sent_at: campaign.sentAt,
    recipients_total: campaign.counts.total,
    recipients_success: campaign.counts.success,
    recipients_failed: campaign.counts.failed,
    recipients_skipped: campaign.counts.skipped,
  };
}

function fromCampaignRow(row: Record<string, unknown>): EmailCampaign {
  const campaignType = (row.campaign_type || "product") as EmailCampaignType;
  return {
    id: String(row.id),
    campaignType,
    productId: nullableString(row.product_id),
    subject: String(row.subject),
    bodyHtml: String(row.body_html),
    bodyText: String(row.body_text),
    status: row.status as EmailCampaignStatus,
    createdByTelegramId: String(row.created_by_telegram_id),
    approvedByTelegramId: nullableString(row.approved_by_telegram_id),
    createdAt: String(row.created_at),
    approvedAt: nullableString(row.approved_at),
    testSentAt: nullableString(row.test_sent_at),
    testSentByTelegramId: nullableString(row.test_sent_by_telegram_id),
    testProviderMessageId: nullableString(row.test_provider_message_id),
    generalSendConfirmedAt: nullableString(row.general_send_confirmed_at),
    generalSendConfirmedByTelegramId: nullableString(row.general_send_confirmed_by_telegram_id),
    sentAt: nullableString(row.sent_at),
    counts: {
      total: numberValue(row.recipients_total),
      success: numberValue(row.recipients_success),
      failed: numberValue(row.recipients_failed),
      skipped: numberValue(row.recipients_skipped),
    },
  };
}

function fromRecipientRow(row: Record<string, unknown>): EmailCampaignRecipient {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    subscriberEmail: String(row.subscriber_email),
    status: row.status as EmailCampaignRecipientStatus,
    providerMessageId: nullableString(row.provider_message_id),
    errorDetail: nullableString(row.error_detail),
    sentAt: nullableString(row.sent_at),
    attemptCount: numberValue(row.attempt_count),
    nextAttemptAt: String(row.next_attempt_at),
    leaseUntil: nullableString(row.lease_until),
    leaseToken: nullableString(row.lease_token),
    processingStartedAt: nullableString(row.processing_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
