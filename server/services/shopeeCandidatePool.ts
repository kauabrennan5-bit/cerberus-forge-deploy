import { validateOfficialProductLink } from "./shopeeProviderRuntime";

export type SharedCandidatePoolEntry = {
  shopId: string | number | null | undefined;
  itemId: string | number | null | undefined;
  productLink: string | null | undefined;
  affiliateLink?: string | null | undefined;
  category?: string | null | undefined;
  price?: number | null | undefined;
  imageUrl?: string | null | undefined;
};

export type SharedCandidatePoolDecision = {
  eligible: boolean;
  reason?: string;
  identityKey?: string;
};

function httpsUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function affiliateUrl(value: unknown): boolean {
  const url = httpsUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === "shopee.com.br" || host.endsWith(".shopee.com.br");
}

export function sharedCandidateIdentity(entry: SharedCandidatePoolEntry): string | null {
  const shopId = String(entry.shopId || "").trim();
  const itemId = String(entry.itemId || "").trim();
  return shopId && itemId ? `${shopId}:${itemId}` : null;
}

/**
 * Discovery contract shared by autonomous curator, rotation and recovery.
 * Editorial/visual model decisions are intentionally not evaluated here.
 * Only facts required before entering the common candidate pool are gates.
 */
export function evaluateSharedCandidatePoolEntry(
  entry: SharedCandidatePoolEntry,
  options: { expectedCategory?: string; seenIdentityKeys?: ReadonlySet<string> } = {},
): SharedCandidatePoolDecision {
  const identityKey = sharedCandidateIdentity(entry);
  if (!identityKey) return { eligible: false, reason: "IDENTITY_MISSING" };
  if (options.seenIdentityKeys?.has(identityKey)) return { eligible: false, reason: "DUPLICATE_IN_SEARCH_POOL", identityKey };
  if (!validateOfficialProductLink(String(entry.productLink || ""), String(entry.shopId), String(entry.itemId))) {
    return { eligible: false, reason: "OFFICIAL_PRODUCT_LINK_INVALID", identityKey };
  }
  if (!affiliateUrl(entry.affiliateLink)) {
    return { eligible: false, reason: "AFFILIATE_LINK_INVALID", identityKey };
  }
  if (options.expectedCategory && entry.category && entry.category !== options.expectedCategory) {
    return { eligible: false, reason: "CATEGORY_MISMATCH", identityKey };
  }
  if (entry.price !== undefined && entry.price !== null && (!Number.isFinite(Number(entry.price)) || Number(entry.price) <= 0)) {
    return { eligible: false, reason: "PRICE_UNVERIFIED", identityKey };
  }
  if (!httpsUrl(entry.imageUrl)) return { eligible: false, reason: "IMAGE_USABLE_MISSING", identityKey };
  return { eligible: true, identityKey };
}

export const shopeeCandidatePoolInternals = { httpsUrl, affiliateUrl };
