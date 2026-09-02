export const AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY = "autonomous_curator_floor_fallback";
export const AUTONOMOUS_CURATOR_FLOOR_FALLBACK_VERSION = "1";

/**
 * The public catalog may expose these fallback rows with their official Shopee
 * image even when editorial review marked that image as review_required.
 * This is deliberately narrower than the canonical editorial image contract:
 * weekly/newsletter eligibility continues to require the normal clean/reviewed
 * proof and therefore remains fail-closed.
 */
export function isAutonomousCuratorFloorFallback(createdBy: unknown): boolean {
  return String(createdBy || "") === AUTONOMOUS_CURATOR_FLOOR_FALLBACK_CREATED_BY;
}
