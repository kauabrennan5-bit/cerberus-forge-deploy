import { checkOpenAIVisualProviderHealth } from "../server/services/aiProviderHealth";

async function main(): Promise<void> {
  const provider = await checkOpenAIVisualProviderHealth({ env: process.env });
  console.log(JSON.stringify({
    runtime: "github-actions-direct",
    renderDependency: false,
    configured: provider.configured,
    enabled: provider.enabled,
    status: provider.status,
    httpStatus: provider.httpStatus,
  }));
  if (!provider.configured || !provider.enabled || provider.status !== "healthy") {
    throw new Error("OPENAI_PROVIDER_CANARY_FAILED");
  }
}

main().catch(() => {
  console.error("OPENAI_PROVIDER_CANARY_FAILED");
  process.exitCode = 1;
});
