import type { Product } from "../../src/types";
import type { NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { compareWeeklyEditorialSnapshot } from "./newsletterWeeklyEditorial";
import type { EmailCampaign } from "./newsletterCampaignState";

export class WeeklyContentChangedError extends Error {
  constructor(public readonly reasonCode: string, public readonly productId?: string) {
    super(`WEEKLY_CONTENT_CHANGED_REGENERATE_REQUIRED:${reasonCode}${productId ? `:${productId}` : ""}`);
    this.name = "WeeklyContentChangedError";
  }
}

export async function assertWeeklyApprovedContentCurrent(input: {
  campaign: EmailCampaign;
  productsLoader: () => Promise<Product[]>;
  store?: NewsletterCampaignStore;
  now?: Date;
}): Promise<void> {
  const { campaign } = input;
  if (!campaign.editorialSnapshot || !campaign.editorialFingerprint) {
    await invalidate(input, "EDITORIAL_SNAPSHOT_MISSING");
  }
  const result = compareWeeklyEditorialSnapshot(
    campaign.editorialSnapshot!,
    await input.productsLoader(),
    input.now || new Date(),
  );
  if (result.valid === false) return invalidate(input, result.code, result.productId);
  if (result.fingerprint !== campaign.editorialFingerprint) {
    await invalidate(input, "EDITORIAL_FINGERPRINT_MISMATCH");
  }
}

async function invalidate(
  input: { campaign: EmailCampaign; store?: NewsletterCampaignStore },
  reasonCode: string,
  productId?: string,
): Promise<never> {
  if (input.store) {
    await input.store.updateCampaign({
      ...input.campaign,
      status: "cancelled",
      archivedAt: new Date().toISOString(),
      archiveReason: `CONTENT_CHANGED_REGENERATE_REQUIRED:${reasonCode}${productId ? `:${productId}` : ""}`,
    });
  }
  throw new WeeklyContentChangedError(reasonCode, productId);
}
