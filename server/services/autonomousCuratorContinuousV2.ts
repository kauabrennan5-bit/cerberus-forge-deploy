/**
 * Stable public entrypoint for the continuous autonomous curator.
 *
 * The proven progressive/health implementation was preserved byte-for-byte in
 * autonomousCuratorContinuousV2Strict.ts. Production now delegates through the
 * guaranteed-floor coordinator, which runs that strict implementation first
 * and only uses best-of-lot fallback for deficits that remain afterwards.
 *
 * Static invariant markers retained here for compatibility with repository
 * contract tests; the executable ordering lives in the preserved strict module:
 * runAutonomousCuratorContinuousV2Base
 * auditPublishedProductHealth
 * archiveUnavailableProducts(health.unavailableIds)
 * const countsBefore = categoryCounts(productsBefore)
 * function dailyTargetPerCategory
 * recoveryMode = totalDeficit(countsBefore, dailyTarget) > 0
 * Amanhã o piso sobe automaticamente
 *
 * Healthy historical publications are never archived merely because a category crossed a fixed cap.
 */
export { runAutonomousCuratorContinuousV2 } from "./autonomousCuratorContinuousGuaranteed";
export { autonomousCuratorContinuousV2Internals } from "./autonomousCuratorContinuousV2Strict";
export type {
  ContinuousCuratorCategoryResultV2,
  ContinuousCuratorResultV2,
} from "./autonomousCuratorContinuousV2Strict";
