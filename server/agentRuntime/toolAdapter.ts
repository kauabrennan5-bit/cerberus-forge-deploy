/**
 * Bloco 16 — Fase C — Fronteira do Tool Adapter.
 *
 * Agent Runtime → Tool Adapter → EXECUTOR FUTURO.
 *
 * Nesta fase o Tool Adapter NÃO executa nada. É proibido chamar Telegram,
 * publicar produto, alterar preço, alterar products, chamar marketplace,
 * disparar job real, chamar LLM para executar ação, enviar mensagens
 * externas ou alterar infraestrutura.
 *
 * A EXISTÊNCIA do adapter não significa autorização de execução.
 * Toda tentativa de execução nesta fase resulta em EXECUTOR_NOT_CONNECTED.
 */

import type {
  AgentActionName,
  AgentRiskLevel,
  AgentToolName,
} from "../agentRegistry/types";
import type { ToolAdapterContract } from "./types";

/** Status resolvido de um adapter — executores reais permanecem
 *  NOT_CONNECTED; somente o executor de prova (controlado) resolve. */
export type ToolAdapterResolveStatus =
  | "NOT_CONNECTED"
  | "TOOL_UNKNOWN"
  | "ACTION_UNSUPPORTED"
  | "PROOF_EXECUTED";

/** Resultado da resolução de adapter (sem dados de execução). */
export interface ToolAdapterResolution {
  status: ToolAdapterResolveStatus;
  tool: AgentToolName | null;
  version: string | null;
  reasonCode: string;
  /** Prova de que nada externo foi invocado: sempre null nesta fase. */
  externalInvocation: null;
}

/** Interface de um adapter individual. */
export interface ToolAdapter {
  contract: ToolAdapterContract;
  /** Resolve uma ação. Nesta fase: NUNCA executa. */
  resolve(action: AgentActionName): ToolAdapterResolution;
}

/**
 * ProofExecutor — executor de PROVA (Bloco 16, Fase D).
 *
 * Executa APENAS via contrato read-only local (sem Supabase, sem Telegram,
 * sem marketplace, sem LLM). Serve exclusivamente ao loop de prova
 * controlado (executeProof=true) autorizado por admin. externalInvocation
 * é SEMPRE null — a prova não invoca nada externo.
 *
 * FRONTIERA: DECISION JOURNAL != EXECUTOR — o executor de prova não executa
 * a ação canônica; apenas comprova o loop REQUESTED → POLICY_EVALUATED →
 * EXECUTED com o Policy Engine como única autoridade.
 */
export class ProofExecutor implements ToolAdapter {
  readonly contract: ToolAdapterContract = Object.freeze({
    toolId: "products.read",
    version: "1.0",
    supportedActions: ["READ_PRODUCT"] as ReadonlyArray<AgentActionName>,
    inputSchemaVersion: "1.0",
    outputSchemaVersion: "1.0",
    risk: "LOW",
  });

  resolve(action: AgentActionName): ToolAdapterResolution {
    if (!this.contract.supportedActions.includes(action)) {
      return Object.freeze({
        status: "ACTION_UNSUPPORTED",
        tool: this.contract.toolId,
        version: this.contract.version,
        reasonCode: "EXECUTOR_ACTION_UNSUPPORTED",
        externalInvocation: null,
      });
    }
    return Object.freeze({
      status: "PROOF_EXECUTED",
      tool: this.contract.toolId,
      version: this.contract.version,
      reasonCode: "PROOF_EXECUTED",
      externalInvocation: null,
    });
  }
}

const PROOF_EXECUTOR = new ProofExecutor();

/**
 * Registro de adapters disponíveis. Contém SOMENTE o executor de prova
 * controlado (autorizado pela Fase D). Executores reais (Telegram,
 * SafeAutoHeal, marketplace) permanecem deliberadamente ausentes e só
 * entrarão mediante autorização explícita em fase própria.
 */
export const ADAPTER_REGISTRY: ReadonlyMap<AgentToolName, ToolAdapter> = Object.freeze(
  (() => {
    const m = new Map<AgentToolName, ToolAdapter>();
    m.set(PROOF_EXECUTOR.contract.toolId, PROOF_EXECUTOR);
    return m;
  })()
);

/**
 * Factory de resolução: busca o adapter da tool; ausente → NOT_CONNECTED.
 * Nenhuma chamada externa acontece em nenhum caminho.
 */
export function resolveToolAdapter(
  tool: AgentToolName,
  action: AgentActionName,
  adapterRegistry: ReadonlyMap<AgentToolName, ToolAdapter> = ADAPTER_REGISTRY
): ToolAdapterResolution {
  const adapter = adapterRegistry.get(tool);
  if (!adapter) {
    return Object.freeze({
      status: "NOT_CONNECTED",
      tool,
      version: null,
      reasonCode: "EXECUTOR_NOT_CONNECTED",
      externalInvocation: null,
    });
  }
  if (!adapter.contract.supportedActions.includes(action)) {
    return Object.freeze({
      status: "ACTION_UNSUPPORTED",
      tool,
      version: adapter.contract.version,
      reasonCode: "EXECUTOR_ACTION_UNSUPPORTED",
      externalInvocation: null,
    });
  }
  return adapter.resolve(action);
}

/** Catálogo de reason codes do adapter boundary (complemento fechado). */
export const TOOL_ADAPTER_REASON_CODES = Object.freeze([
  "EXECUTOR_NOT_CONNECTED",
  "EXECUTOR_ACTION_UNSUPPORTED",
] as const);

export type { AgentToolName, AgentActionName, AgentRiskLevel };
