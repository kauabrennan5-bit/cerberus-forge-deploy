import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import {
  buildAutonomousCuratorHumanTasteModel,
  getAutonomousCuratorHumanTasteSummary,
  setAutonomousCuratorHumanTasteModel,
} from "./autonomousCuratorHumanTaste";

const DEFAULT_HUMAN_TASTE_REFRESH_MS = 60_000;
let learningTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<ReturnType<typeof getAutonomousCuratorHumanTasteSummary>> | null = null;

export async function refreshAutonomousCuratorHumanTaste(): Promise<ReturnType<typeof getAutonomousCuratorHumanTasteSummary>> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const [products, reviews] = await Promise.all([
        productsRepository.getProducts(),
        telegramRepo.listReviewsByStatus(["rejected", "cancelled"], 100),
      ]);
      const model = buildAutonomousCuratorHumanTasteModel(products, reviews);
      setAutonomousCuratorHumanTasteModel(model);
      const summary = getAutonomousCuratorHumanTasteSummary(model);
      console.info(
        `[AUTONOMOUS-CURATOR] human_feedback_learning_loaded approved=${summary.approvedExamples} rejected=${summary.rejectedExamples} categories=${summary.categoriesLearned} version=${summary.version}`,
      );
      return summary;
    } catch {
      const summary = getAutonomousCuratorHumanTasteSummary();
      console.warn(
        `[AUTONOMOUS-CURATOR] human_feedback_learning_unavailable using_cached=true approved=${summary.approvedExamples} rejected=${summary.rejectedExamples}`,
      );
      return summary;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function startAutonomousCuratorHumanTasteLearning(refreshMs = DEFAULT_HUMAN_TASTE_REFRESH_MS): void {
  if (learningTimer) return;
  void refreshAutonomousCuratorHumanTaste();
  const safeRefreshMs = Math.max(30_000, Math.min(15 * 60_000, Math.trunc(refreshMs || DEFAULT_HUMAN_TASTE_REFRESH_MS)));
  learningTimer = setInterval(() => {
    void refreshAutonomousCuratorHumanTaste();
  }, safeRefreshMs);
  learningTimer.unref?.();
}

export function stopAutonomousCuratorHumanTasteLearningForTests(): void {
  if (learningTimer) clearInterval(learningTimer);
  learningTimer = null;
}
