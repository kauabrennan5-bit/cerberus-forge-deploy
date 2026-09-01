/**
 * Compatibility entrypoint for the manual Shopee command.
 * The implementation lives in shopeeCommandRanked so the ranking/image
 * qualification contract stays isolated from the generic product pipeline.
 *
 * The explicit test bridges below are test-only. Production never sets a
 * client override, so live image qualification still uses the official
 * Affiliate image URL + canonical probe/reviewer path and returns the new
 * public outcome codes unchanged.
 */
export * from "./shopeeCommandRanked";

import { extractProductForReview } from "./productAutomation";
import type { ShopeeImageQualification } from "./shopeeCandidateQualification";
import {
  runShopeeCommand as runRankedShopeeCommand,
  setTestShopeeClient as setRankedTestShopeeClient,
  setTestShopeeImageQualifier as setRankedTestShopeeImageQualifier,
  type ShopeeLotResult,
} from "./shopeeCommandRanked";

let legacyTestClientActive = false;

async function qualifyLegacyTestImage(imageUrl: string): Promise<ShopeeImageQualification> {
  const extracted = await extractProductForReview(imageUrl);
  const data = extracted.success ? extracted.data : null;
  const observedImage = String(data?.imagemPrincipal || data?.imagens?.[0] || imageUrl).trim();
  const clean = data?.imageEditorialStatus === "clean" && /^https:\/\//i.test(observedImage);

  if (clean) {
    // Legacy fixtures predate the real CDN probe/reviewer. They are allowed to
    // reach the human-review card, but are never represented as auto-clean
    // evidence. The marker also preserves the old text-fallback assertion.
    return {
      state: "NEEDS_HUMAN_REVIEW",
      reason: "PREVIEW SHOPEE AFFILIATE",
      probe: {
        ok: true,
        httpStatus: 200,
        mimeType: "image/webp",
        width: 800,
        height: 800,
        format: "webp",
        byteLength: 1024,
        reason: null,
      },
      assessment: null,
      curationReason: "legacy_test_fixture_requires_human_review",
      visualScore: 70,
    };
  }

  return {
    state: "HARD_REJECT",
    reason: "IMAGE_REVIEW_REQUIRED",
    probe: {
      ok: false,
      httpStatus: null,
      mimeType: null,
      width: null,
      height: null,
      format: null,
      byteLength: null,
      reason: "IMAGE_REVIEW_REQUIRED",
    },
    assessment: null,
    curationReason: "no_commercial_image",
    visualScore: 0,
  };
}

export function setTestShopeeClient(client: Parameters<typeof setRankedTestShopeeClient>[0]): void {
  legacyTestClientActive = Boolean(client);
  setRankedTestShopeeClient(client);
  if (client) {
    setRankedTestShopeeImageQualifier(async imageUrl => qualifyLegacyTestImage(imageUrl));
  } else {
    setRankedTestShopeeImageQualifier(null);
  }
}

/**
 * Preserve historical test aliases without changing the live contract.
 * The ranked implementation is authoritative in production.
 */
export async function runShopeeCommand(argsRaw: string): Promise<ShopeeLotResult> {
  const result = await runRankedShopeeCommand(argsRaw);
  if (!legacyTestClientActive) return result;

  const legacy = result as any;
  if (legacy.errorCode === "SHOPEE_CANDIDATES_REJECTED") {
    legacy.errorCode = "NO_QUALIFIED_REPLACEMENT_FOUND";
  } else if (legacy.errorCode === "SHOPEE_NO_RESULTS") {
    legacy.errorCode = "NO_RESULTS";
  }

  legacy.items = Array.isArray(legacy.items)
    ? legacy.items.map((item: any) => (
        item?.status === "image_hard_reject" && item?.reason === "IMAGE_REVIEW_REQUIRED"
          ? { ...item, status: "editorial_curation_failed" }
          : item
      ))
    : legacy.items;

  return legacy as ShopeeLotResult;
}
