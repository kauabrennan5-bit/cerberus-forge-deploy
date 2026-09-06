import * as productsRepository from "../repositories/productsRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import {
  buildAutonomousCuratorHumanTasteModel,
  getAutonomousCuratorHumanTasteSummary,
  setAutonomousCuratorHumanTasteModel,
} from "./autonomousCuratorHumanTaste";

export async function refreshAutonomousCuratorHumanTaste(): Promise<ReturnType<typeof getAutonomousCuratorHumanTasteSummary>> {
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
  }
}
