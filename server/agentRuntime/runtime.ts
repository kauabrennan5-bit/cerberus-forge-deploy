/**
 * Bloco 16 — Fase C — Entry point do Agent Runtime.
 *
 * RUNTIME é a ÚNICA porta futura pela qual um agente poderá solicitar
 * execução. Nesta fase: orquestra o contrato da Fase A + Policy Engine do
 * Bloco 15, produz plano imutável e NUNCA executa.
 *
 * AGENT REQUEST != AUTHORIZATION · POLICY != EXECUTION ·
 * ALLOW != EXECUTED · UNKNOWN != ALLOW · FAILURE TO VERIFY != PERMISSION.
 *
 * Sem rota HTTP, sem Supabase, sem Telegram, sem LLM — módulo puro
 * (D-6 do design review do Bloco 16).
 */

import type { PolicyDecision } from "../policyEngine/types";
import {
  runAgentPipeline,
  defaultRuntimeDependencies,
  type RuntimeDependencies,
} from "./pipeline";
import type { AgentRuntimeRequest, RuntimeResult } from "./contracts";

export const RUNTIME_VERSION = "1.0";

/**
 * executeRuntime: entry point da pipeline fechada. Usa o Policy Engine real
 * e as funções puras do registry por padrão; testes injetam dependências.
 */
export async function executeRuntime(
  request: AgentRuntimeRequest,
  options?: {
    deps?: Omit<
      Partial<RuntimeDependencies>,
      "evaluatePolicy" | "registryLookup" | "clock"
    > & {
      evaluatePolicy?: (decision: PolicyDecision) => PolicyDecision;
      registryLookup?: (agentId: string) => import("../agentRegistry/types").AgentDefinition | undefined;
      clock?: () => string;
    };
  }
): Promise<RuntimeResult> {
  const base = options?.deps;
  if (!base || !base.evaluatePolicy) {
    throw new Error(
      "Runtime requires evaluatePolicy from the Bloco 15 Policy Engine; passing it is mandatory."
    );
  }
  return runAgentPipeline(request, {
    evaluatePolicy: base.evaluatePolicy,
    registryLookup: base.registryLookup,
    executionStore: base.executionStore,
    approvalProvider: base.approvalProvider,
    clock: base.clock,
  });
}

export type { AgentRuntimeRequest, RuntimeResult, RuntimeDependencies };
export { runAgentPipeline, PIPELINE_STAGES } from "./pipeline";
