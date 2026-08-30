import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailCampaign } from "./newsletterCampaignState";

function signingSecret(env: NodeJS.ProcessEnv): string {
  const value = (env.NEWSLETTER_PREVIEW_SIGNING_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (value.length < 24) throw new Error("WEEKLY_PREVIEW_SIGNING_SECRET_MISSING");
  return value;
}

function payload(campaignId: string, fingerprint: string, expires: number): string {
  return `${campaignId}\n${fingerprint}\n${expires}`;
}

export function signWeeklyPreview(
  campaignId: string,
  fingerprint: string,
  expires: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return createHmac("sha256", signingSecret(env)).update(payload(campaignId, fingerprint, expires), "utf8").digest("hex");
}

export function buildWeeklyPreviewUrl(
  campaign: Pick<EmailCampaign, "id" | "editorialFingerprint" | "previewExpiresAt">,
  publicBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!campaign.editorialFingerprint || !campaign.previewExpiresAt) throw new Error("WEEKLY_PREVIEW_METADATA_MISSING");
  const expires = Date.parse(campaign.previewExpiresAt);
  if (!Number.isFinite(expires)) throw new Error("WEEKLY_PREVIEW_EXPIRY_INVALID");
  const url = new URL(`/api/newsletter/weekly-preview/${encodeURIComponent(campaign.id)}`, publicBaseUrl);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signWeeklyPreview(campaign.id, campaign.editorialFingerprint, expires, env));
  return url.toString();
}

export function verifyWeeklyPreviewSignature(
  campaign: Pick<EmailCampaign, "id" | "editorialFingerprint" | "previewExpiresAt">,
  expiresRaw: unknown,
  signatureRaw: unknown,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!campaign.editorialFingerprint || !campaign.previewExpiresAt) return false;
  const expires = Number(expiresRaw);
  const signature = typeof signatureRaw === "string" ? signatureRaw.trim() : "";
  if (!Number.isSafeInteger(expires) || expires <= now.getTime() || expires !== Date.parse(campaign.previewExpiresAt)) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = signWeeklyPreview(campaign.id, campaign.editorialFingerprint, expires, env);
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}
