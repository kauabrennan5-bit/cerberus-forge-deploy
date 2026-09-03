import type { PublicProductCategory } from "../../src/lib/productCategory";
import type { ContinuousCuratorCategoryResultV2 } from "./autonomousCuratorContinuousV2Base";

export type CuratorBlockerType =
  | "image"
  | "score"
  | "ai_rate_limit"
  | "ai_quota"
  | "ai_timeout"
  | "ai_model_not_found"
  | "ai_auth"
  | "ai_provider_5xx"
  | "ai_provider_unavailable"
  | "mismatch"
  | "identity"
  | "shopee"
  | "catalog"
  | "other";

export type CuratorBlockerSummary = Partial<Record<CuratorBlockerType, number>>;

function normalized(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

export function classifyCuratorBlocker(reason: unknown): CuratorBlockerType {
  const text = normalized(reason);
  if (/IMAGE|VISUAL|CURATION/.test(text)) return "image";
  if (/SCORE|THRESHOLD|OFF_BRAND|QUALITY/.test(text)) return "score";
  if (/429|RATE_LIMIT|RATE LIMITED|TOO_MANY_REQUESTS|RESOURCE_EXHAUSTED/.test(text) && !/QUOTA|BILLING|CREDIT/.test(text)) return "ai_rate_limit";
  if (/QUOTA|INSUFFICIENT_QUOTA|BILLING|CREDIT_BALANCE|SPEND_LIMIT/.test(text)) return "ai_quota";
  if (/TIMEOUT|TIMED_OUT|DEADLINE/.test(text)) return "ai_timeout";
  if (/MODEL_UNAVAILABLE|MODEL_NOT_FOUND|MODEL NOT FOUND|HTTP_404/.test(text)) return "ai_model_not_found";
  if (/AUTH_ERROR|UNAUTHENTICATED|API_KEY|PERMISSION_DENIED|HTTP_401|HTTP_403/.test(text)) return "ai_auth";
  if (/HTTP_50[0-4]|\b50[0-4]\b/.test(text)) return "ai_provider_5xx";
  if (/PROVIDER_UNAVAILABLE|SERVICE_UNAVAILABLE|OVERLOADED|NETWORK/.test(text)) return "ai_provider_unavailable";
  if (/MISMATCH|CATEGORY_MISMATCH|IDENTITY_MISMATCH/.test(text)) return "mismatch";
  if (/IDENTITY|DUPLICATE|ALREADY_OWNED|RESERVED/.test(text)) return "identity";
  if (/SHOPEE|LISTING|AFFILIATE/.test(text)) return "shopee";
  if (/CATALOG|PUBLICLY_VALIDATED|PUBLIC_CATALOG/.test(text)) return "catalog";
  return "other";
}

export function summarizeCuratorBlockers(categories: readonly ContinuousCuratorCategoryResultV2[]): CuratorBlockerSummary {
  const summary: CuratorBlockerSummary = {};
  for (const category of categories) {
    if (category.published) continue;
    const key = classifyCuratorBlocker(category.reason);
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

export function blockerForCategory(
  categories: readonly ContinuousCuratorCategoryResultV2[],
  category: PublicProductCategory,
): { type: CuratorBlockerType; reason: string } {
  const result = categories.find(item => item.category === category);
  const reason = String(result?.reason || "NO_CATEGORY_RESULT").replace(/\s+/g, " ").trim().slice(0, 160);
  return { type: classifyCuratorBlocker(reason), reason };
}

export function safeAiFailureType(reason: unknown): string | null {
  const type = classifyCuratorBlocker(reason);
  return type.startsWith("ai_") ? type : null;
}
