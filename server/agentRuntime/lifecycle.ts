/**
 * Bloco 16 — Fase C — Máquina de lifecycle do Agent Runtime.
 *
 * Usa EXCLUSIVAMENTE a máquina fechada da Fase A (canTransition /
 * TRANSITION_TABLE). Nenhuma função deste módulo consegue modificar
 * diretamente o estado ignorando a máquina: o estado é imutável
 * (Object.freeze) e toda transição passa pela função fechada
 * applyTransition, que valida contra a tabela antes de produzir o
 * novo estado.
 *
 * Exemplos de estados proibidos (permanecem proibidos):
 *   DENIED → PLANNED = impossível
 *   EXPIRED → PLANNED = impossível
 *   CANCELLED → RUNNING = impossível
 *   REQUIRES_APPROVAL → RUNNING sem aprovação válida = impossível
 *   PLANNED → RUNNING nesta fase = impossível sem executor (executores
 *   estão desconectados por projeto nesta fase).
 *
 * Nenhum estado SUCCEEDED é produzido nesta fase: nada foi executado.
 */

import {
  canTransition,
  isLifecycleState,
} from "./validation";
import type { ExecutionLifecycleState, RequestedBy } from "./types";
import type { LifecycleTransition } from "./contracts";

/** Estado interno imutável de uma execução controlada pelo runtime. */
export interface ExecutionMachineState {
  state: ExecutionLifecycleState;
  transitions: ReadonlyArray<LifecycleTransition>;
}

/**
 * Estado inicial da máquina. Toda execução nasce em REQUESTED e passa por
 * POLICY_EVALUATED (única porta de entrada autorizada pela máquina).
 */
export function initialMachineState(
  clock: () => string = () => new Date().toISOString()
): ExecutionMachineState {
  return Object.freeze({ state: "REQUESTED", transitions: Object.freeze([]) });
}

/**
 * Resultado de uma tentativa de transição. Default deny: par inválido ou
 * transição não permitida pela tabela → REJECTED com reason code.
 */
export interface TransitionOutcome {
  ok: boolean;
  state: ExecutionMachineState;
  transition: LifecycleTransition | null;
  reasonCode: "TRANSITION_FORBIDDEN" | "TRANSITION_FORBIDDEN_BY_GATE" | null;
}

/**
 * Transição fechada da máquina. O estado retornado é sempre um novo objeto
 * congelado; o estado anterior permanece intocado. A gate adicional
 * (RUNNING requer executor) aplica-se a esta fase.
 */
export function applyTransition(
  machine: ExecutionMachineState,
  from: ExecutionLifecycleState,
  to: ExecutionLifecycleState,
  requestedBy: RequestedBy,
  clock: () => string = () => new Date().toISOString(),
  gateExecutorConnected: boolean = false
): TransitionOutcome {
  if (machine.state !== from) {
    return Object.freeze({
      ok: false,
      state: machine,
      transition: null,
      reasonCode: "TRANSITION_FORBIDDEN",
    });
  }
  if (!canTransition(from, to)) {
    return Object.freeze({
      ok: false,
      state: machine,
      transition: null,
      reasonCode: "TRANSITION_FORBIDDEN",
    });
  }
  // Gate desta fase: executores estão desconectados; RUNNING/SUCCEEDED nunca.
  if (to === "RUNNING" && !gateExecutorConnected) {
    return Object.freeze({
      ok: false,
      state: machine,
      transition: null,
      reasonCode: "TRANSITION_FORBIDDEN_BY_GATE",
    });
  }
  const transition: LifecycleTransition = Object.freeze({
    from,
    to,
    at: clock(),
    requestedBy,
  });
  return Object.freeze({
    ok: true,
    state: Object.freeze<ExecutionMachineState>({
      state: to,
      transitions: Object.freeze([...machine.transitions, transition]),
    }),
    transition,
    reasonCode: null,
  });
}

/** Verificação de estado declarado (catálogo fechado). */
export function isValidLifecycleState(value: string): boolean {
  return isLifecycleState(value);
}
