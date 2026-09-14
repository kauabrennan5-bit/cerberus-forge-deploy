// Operational proof trigger only; runtime semantics unchanged.
import "dotenv/config";
import { runAutonomousCuratorContinuousV2 } from "../server/services/autonomousCuratorContinuousV2";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`CONTINUOUS_V2_DEEP_DRY_RUN_SECRET_MISSING:${label}`);
}

type DeepProof = {
  dryRun?: boolean;
  renderDependency?: boolean;
  reviewOnly?: boolean;
  autoPublished?: number;
  catalogMutations?: number;
  reviewsCreated?: number;
  telegramMessagesSent?: number;
  productionRunOpened?: boolean;
  deepEvaluations?: number;
  pipelineEvaluations?: number;
  qualifiedCandidates?: number;
};

async function main(): Promise<void> {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);
  requireAny("SHOPEE_APP_ID", ["SHOPEE_APP_ID", "SHOPEE_AFFILIATE_APP_ID"]);
  requireAny("SHOPEE_APP_SECRET", ["SHOPEE_APP_SECRET", "SHOPEE_AFFILIATE_APP_SECRET"]);

  const result = await runAutonomousCuratorContinuousV2({
    dryRun: true,
    notify: false,
    env: process.env,
  });
  const proof = result as typeof result & DeepProof;

  const violations = [
    proof.dryRun !== true && "dryRun",
    proof.renderDependency !== false && "renderDependency",
    proof.reviewOnly !== true && "reviewOnly",
    proof.autoPublished !== 0 && "autoPublished",
    proof.catalogMutations !== 0 && "catalogMutations",
    proof.reviewsCreated !== 0 && "reviewsCreated",
    proof.telegramMessagesSent !== 0 && "telegramMessagesSent",
    proof.productionRunOpened !== false && "productionRunOpened",
    result.publishedThisCycle !== 0 && "publishedThisCycle",
    result.queuedProducts !== 0 && "queuedProducts",
  ].filter(Boolean);
  if (violations.length > 0) {
    throw new Error(`CONTINUOUS_V2_DEEP_DRY_RUN_MUTATION_CONTRACT_VIOLATED:${violations.join(",")}`);
  }
  if (!Number.isFinite(proof.pipelineEvaluations) || Number(proof.pipelineEvaluations) <= 0) {
    throw new Error("CONTINUOUS_V2_DEEP_DRY_RUN_NOT_DEEP_ENOUGH");
  }

  if (result.failedThisCycle > 0 || result.status === "failed") {
    throw new Error("CONTINUOUS_V2_DEEP_DRY_RUN_OPERATIONAL_FAILURE");
  }

  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    mode: "continuous-v2-deep-dry-run",
    dryRun: proof.dryRun,
    renderDependency: proof.renderDependency,
    reviewOnly: proof.reviewOnly,
    autoPublished: proof.autoPublished,
    catalogMutations: proof.catalogMutations,
    reviewsCreated: proof.reviewsCreated,
    telegramMessagesSent: proof.telegramMessagesSent,
    productionRunOpened: proof.productionRunOpened,
    deepEvaluations: proof.deepEvaluations,
    pipelineEvaluations: proof.pipelineEvaluations,
    qualifiedCandidates: proof.qualifiedCandidates,
    status: result.status,
    failedThisCycle: result.failedThisCycle,
  }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "CONTINUOUS_V2_DEEP_DRY_RUN_FAILED";
  console.error(message);
  process.exitCode = 1;
});
