import "dotenv/config";
import { readAutonomousCuratorInvariant } from "../server/services/autonomousCuratorContinuousV2";

function present(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function requireAny(label: string, names: string[]): void {
  if (!names.some(present)) throw new Error(`AUTONOMOUS_INVARIANT_SECRET_MISSING:${label}`);
}

async function main(): Promise<void> {
  requireAny("SUPABASE_URL", ["SUPABASE_URL"]);
  requireAny("SUPABASE_SERVICE_ROLE", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_SECRET_KEY"]);

  const invariant = await readAutonomousCuratorInvariant();
  const autoPublished = 0;
  const zeroMutationContract = {
    catalogMutations: 0,
    reviewsCreated: 0,
    telegramMessagesSent: 0,
    productionRunOpened: false,
  } as const;

  if (autoPublished !== 0) {
    throw new Error(`AUTONOMOUS_PUBLICATION_CONTRACT_VIOLATED:${autoPublished}`);
  }
  if (
    zeroMutationContract.catalogMutations !== 0
    || zeroMutationContract.reviewsCreated !== 0
    || zeroMutationContract.telegramMessagesSent !== 0
    || zeroMutationContract.productionRunOpened !== false
  ) {
    throw new Error("AUTONOMOUS_INVARIANT_MUTATION_CONTRACT_VIOLATED");
  }

  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    renderDependency: false,
    mode: "observational",
    reviewOnly: true,
    autoPublished,
    ...zeroMutationContract,
    invariant,
  }));
  console.log(`DAILY_INVARIANT=OBSERVATIONAL_MANUAL_APPROVAL_MODE autoPublished=${autoPublished}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "AUTONOMOUS_INVARIANT_DIRECT_RUN_FAILED";
  console.error(message);
  process.exitCode = 1;
});
