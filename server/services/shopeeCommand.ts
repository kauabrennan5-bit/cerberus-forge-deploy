/**
 * Compatibility entrypoint for the manual Shopee command.
 * The implementation lives in shopeeCommandRanked so the ranking/image
 * qualification contract stays isolated from the generic product pipeline.
 *
 * The explicit setTestShopeeClient bridge below is test-only. Production never
 * sets a client override, so live image qualification still uses the official
 * Affiliate image URL + canonical probe/reviewer path.
 */
export * from "./shopeeCommandRanked";

import { extractProductForReview } from "./productAutomation";
import type { ShopeeImageQualification } from "./shopeeCandidateQualification";
import {
  setTestShopeeClient as setRankedTestShopeeClient,
  setTestShopeeImageQualifier as setRankedTestShopeeImageQualifier,
} from "./shopeeCommandRanked";

async function qualifyLegacyTestImage(imageUrl: string): Promise<ShopeeImageQualification> {
  const extracted = await extractProductForReview(imageUrl);
  const data = extracted.success ? extracted.data : null;
  const observedImage = String(data?.imagemPrincipal || data?.imagens?.[0] || imageUrl).trim();
  const clean = data?.imageEditorialStatus === "clean" && /^https:\/\//i.test(observedImage);

  return {
    state: clean ? "QUALIFIED" : "HARD_REJECT",
    reason: clean ? "LEGACY_TEST_CLEAN_IMAGE" : "LEGACY_TEST_IMAGE_REJECTED",
    probe: {
      ok: clean,
      httpStatus: clean ? 200 : null,
      mimeType: clean ? "image/webp" : null,
      width: clean ? 800 : null,
      height: clean ? 800 : null,
      format: clean ? "webp" : null,
      byteLength: clean ? 1024 : null,
      reason: clean ? null : "LEGACY_TEST_IMAGE_REJECTED",
    },
    assessment: null,
    curationReason: clean ? null : "no_commercial_image",
    visualScore: clean ? 100 : 0,
  };
}

export function setTestShopeeClient(client: Parameters<typeof setRankedTestShopeeClient>[0]): void {
  setRankedTestShopeeClient(client);
  if (client) {
    setRankedTestShopeeImageQualifier(async imageUrl => qualifyLegacyTestImage(imageUrl));
  } else {
    setRankedTestShopeeImageQualifier(null);
  }
}
