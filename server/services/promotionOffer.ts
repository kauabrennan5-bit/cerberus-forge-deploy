import type { PromotionOffer, PromotionOfferCondition } from "../../src/types";

const VALID_CONDITIONS: ReadonlySet<PromotionOfferCondition> = new Set([
  "pix",
  "pix_with_coupon",
  "coupon",
  "other",
]);

export const LEGACY_PROMOTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normaliza o ajuste confirmado pelo administrador antes de ele cruzar a
 * fronteira review -> produto canônico. Não calcula desconto, não altera o
 * preço-base e descarta qualquer formato ambíguo.
 */
export function normalizePromotionOffer(value: unknown): PromotionOffer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const price = candidate.price;
  const condition = candidate.condition;
  const source = candidate.source;
  const confirmedAt = candidate.confirmedAt;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return undefined;
  if (typeof condition !== "string" || !VALID_CONDITIONS.has(condition as PromotionOfferCondition)) return undefined;
  if (source !== "admin_confirmed") return undefined;
  if (typeof confirmedAt !== "number" || !Number.isFinite(confirmedAt) || confirmedAt <= 0) return undefined;
  const explicitExpiry = candidate.expiresAt ?? candidate.validUntil;
  const expiresAt = typeof explicitExpiry === "number" && Number.isFinite(explicitExpiry)
    ? explicitExpiry
    : confirmedAt + LEGACY_PROMOTION_TTL_MS;
  if (expiresAt <= confirmedAt) return undefined;
  const benefits = Array.isArray(candidate.benefits)
    ? candidate.benefits.filter((benefit): benefit is string => typeof benefit === "string" && benefit.trim().length > 0).map(benefit => benefit.trim()).slice(0, 8)
    : [];
  return {
    price,
    condition: condition as PromotionOfferCondition,
    benefits,
    source: "admin_confirmed",
    confirmedAt,
    expiresAt,
  };
}

export function isPromotionValidAt(value: unknown, now: Date | number = Date.now()): value is PromotionOffer {
  const offer = normalizePromotionOffer(value);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return Boolean(offer && Number.isFinite(nowMs) && offer.expiresAt > nowMs);
}

export function validPromotionAt(value: unknown, now: Date | number = Date.now()): PromotionOffer | undefined {
  const offer = normalizePromotionOffer(value);
  return offer && isPromotionValidAt(offer, now) ? offer : undefined;
}

export function promotionConditionLabel(condition: PromotionOfferCondition): string {
  if (condition === "pix") return "no Pix";
  if (condition === "pix_with_coupon") return "no Pix com cupom";
  if (condition === "coupon") return "com cupom";
  return "sob condição observada";
}
