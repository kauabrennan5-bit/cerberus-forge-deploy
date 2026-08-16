/**
 * Bloco 15 — Fase B — Mapa fechado de compatibilidade tool/action.
 *
 * REGRAS:
 * - Catálogo fechado: cada action pertence a EXATAMENTE uma tool permitida.
 * - Combinação tool/action não listada = DENY (TOOL_ACTION_MISMATCH).
 * - Este mapa NÃO é executável; apenas declara compatibilidade.
 *
 * Dependency: tipos declarativos da Fase A.
 */

import type { AgentActionName, AgentToolName } from "../agentRegistry/types";

/** Cada action mapeia para a ÚNICA tool declarativa capaz de realizá-la. */
export const ACTION_TOOL_MAP: Readonly<Record<AgentActionName, AgentToolName>> = Object.freeze({
  READ_PRODUCT: "products.read",
  READ_OBSERVATION: "observations.read",
  ANALYZE_PRODUCT: "commercial.analyze",
  READ_COMMERCIAL_SIGNAL: "commercial.signals.read",
  READ_COMMERCIAL_ARTIFACT: "commercial.signals.read",
  READ_JOB_QUEUE: "job_queue.read",
  READ_OPERATIONAL_EVENT: "operational.read",
  CREATE_RECOMMENDATION: "commercial.recommend",
  CREATE_SIGNAL: "commercial.analyze",
  PUBLISH_PRODUCT: "products.write",
  UPDATE_PRODUCT: "products.write",
  DELETE_PRODUCT: "products.write",
  UPDATE_PRICE: "products.write",
  SEND_TELEGRAM: "telegram.send",
  ENQUEUE_JOB: "job_queue.enqueue",
  RUN_RECOVERY: "operational.read",
});

/** Para cada tool, o conjunto de actions com que é compatível.
 *  Derivado de ACTION_TOOL_MAP (função pura, determinística). */
export function toolAllowedActions(tool: AgentToolName): ReadonlyArray<AgentActionName> {
  const actions: AgentActionName[] = [];
  for (const action of Object.keys(ACTION_TOOL_MAP) as AgentActionName[]) {
    if (ACTION_TOOL_MAP[action] === tool) {
      actions.push(action);
    }
  }
  return Object.freeze(actions);
}
