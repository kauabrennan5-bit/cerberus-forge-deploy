import type { AutoHealMode, AutoHealRisk } from "./safeAutoHealEngine";

export type OperationalStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN" | "RECOVERING";
export type MachineState = "IDLE" | "CHECKING" | "DIAGNOSING" | "WAITING_APPROVAL" | "HEALING" | "VALIDATING" | "RECOVERING" | "RESOLVED" | "ESCALATED";
export type Decision = "NO_ACTION" | "AUTO_HEAL" | "WAIT_APPROVAL" | "ESCALATE";

export interface ComponentObservation {
  name: string;
  status: OperationalStatus;
  timestamp: string;
  latencyMs: number;
  error?: string;
}

export interface ComponentOperationalState {
  component: string;
  status: OperationalStatus;
  lastCheck: string;
  lastError?: string;
  lastRecovery?: string;
  currentIncidentId?: string;
  consecutiveFailures: number;
  outageDurationMs?: number;
}

export interface OperationalStateSnapshot {
  status: OperationalStatus;
  operatorState: MachineState;
  autonomyLevel: 0 | 1 | 2 | 3;
  components: Record<string, ComponentOperationalState>;
  escalations: number;
  lastTransition?: StateTransition;
}

export interface StateTransition {
  from: MachineState;
  to: MachineState;
  reason: string;
  timestamp: string;
}

const ALLOWED_TRANSITIONS: Record<MachineState, MachineState[]> = {
  IDLE: ["CHECKING"],
  CHECKING: ["DIAGNOSING", "IDLE", "ESCALATED"],
  DIAGNOSING: ["WAITING_APPROVAL", "HEALING", "RESOLVED", "ESCALATED", "IDLE"],
  WAITING_APPROVAL: ["HEALING", "ESCALATED", "IDLE"],
  HEALING: ["VALIDATING", "RECOVERING", "ESCALATED"],
  VALIDATING: ["RECOVERING", "RESOLVED", "ESCALATED"],
  RECOVERING: ["RESOLVED", "ESCALATED"],
  RESOLVED: ["IDLE", "CHECKING"],
  ESCALATED: ["IDLE", "CHECKING"],
};

export class OperatorStateMachine {
  private state: MachineState = "IDLE";
  private readonly history: StateTransition[] = [];

  getState(): MachineState {
    return this.state;
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  transition(to: MachineState, reason: string): StateTransition {
    if (!ALLOWED_TRANSITIONS[this.state].includes(to)) {
      throw new Error(`INVALID_OPERATOR_TRANSITION:${this.state}->${to}`);
    }
    const transition: StateTransition = {
      from: this.state,
      to,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.state = to;
    this.history.unshift(transition);
    if (this.history.length > 100) this.history.length = 100;
    return transition;
  }
}

export function autonomyLevelFor(mode: AutoHealMode): 0 | 1 | 2 | 3 {
  if (mode === "SAFE_AUTO_HEAL") return 1;
  if (mode === "ADMIN_APPROVAL") return 2;
  return 0;
}

export interface DecisionInput {
  mode: AutoHealMode;
  risk?: AutoHealRisk;
  hasRegisteredAction: boolean;
  requiresApproval?: boolean;
  circuitOpen?: boolean;
  consecutiveFailures: number;
  maxFailures: number;
}

/** O Decision Engine apenas classifica. Nunca executa uma ação. */
export function decideRecovery(input: DecisionInput): Decision {
  if (input.circuitOpen || input.consecutiveFailures >= input.maxFailures) return "ESCALATE";
  if (!input.hasRegisteredAction || !input.risk) return "ESCALATE";
  if (input.risk === "HIGH" || input.risk === "CRITICAL") return "ESCALATE";
  if (input.mode === "OBSERVE") return "NO_ACTION";
  if (input.risk === "MEDIUM" || input.requiresApproval || input.mode === "ADMIN_APPROVAL") return "WAIT_APPROVAL";
  return "AUTO_HEAL";
}

export class OperationalStateStore {
  private readonly state = new Map<string, ComponentOperationalState>();
  private escalationCount = 0;
  private lastTransition?: StateTransition;

  update(observations: ComponentObservation[], incidentsByComponent: Record<string, string | undefined>, transition?: StateTransition): void {
    const now = Date.now();
    if (transition) this.lastTransition = transition;

    for (const observation of observations) {
      const previous = this.state.get(observation.name);
      const failed = observation.status === "DOWN" || observation.status === "DEGRADED";
      const recovered = previous && (previous.status === "DOWN" || previous.status === "DEGRADED") && observation.status === "HEALTHY";
      const priorFailureCount = previous?.consecutiveFailures || 0;
      const lastCheck = observation.timestamp;

      this.state.set(observation.name, {
        component: observation.name,
        status: recovered ? "RECOVERING" : observation.status,
        lastCheck,
        lastError: failed ? observation.error || previous?.lastError : undefined,
        lastRecovery: recovered ? lastCheck : previous?.lastRecovery,
        currentIncidentId: incidentsByComponent[observation.name],
        consecutiveFailures: failed ? priorFailureCount + 1 : 0,
        outageDurationMs: failed
          ? previous?.outageDurationMs ? previous.outageDurationMs + Math.max(0, now - new Date(previous.lastCheck).getTime()) : 0
          : 0,
      });
    }
  }

  markEscalated(): void {
    this.escalationCount += 1;
  }

  snapshot(mode: AutoHealMode, machine: OperatorStateMachine): OperationalStateSnapshot {
    const components = Object.fromEntries(this.state.entries());
    const statuses = Object.values(components).map(component => component.status);
    let status: OperationalStatus = "HEALTHY";
    if (statuses.length === 0 || statuses.includes("UNKNOWN")) status = "UNKNOWN";
    if (statuses.includes("DEGRADED") || statuses.includes("RECOVERING")) status = "DEGRADED";
    if (statuses.includes("DOWN")) status = "DOWN";
    return {
      status,
      operatorState: machine.getState(),
      autonomyLevel: autonomyLevelFor(mode),
      components,
      escalations: this.escalationCount,
      lastTransition: this.lastTransition,
    };
  }
}
