import type {
  ComponentHealth,
  HealthStatus,
  HistoryRecord,
  OperatorSystemReport,
} from "./cerberusOperatorLegacy";
import {
  getOperatorMode,
  getOperatorPersistenceState,
  getRecentCorrections,
} from "./cerberusOperatorLegacy";
export {
  AVAILABLE_OPERATOR_ACTIONS,
  approveOperatorAction,
  getAutoHealAuditLog,
  getEscalatedIncidents,
  getIncidents,
  getOperationalState,
  getOperatorMode,
  getOperatorPersistenceState,
  getOperatorStateHistory,
  getPendingApprovals,
  getRecentCorrections,
  initializeOperatorState,
  requestOperatorApproval,
  runSafeAutoHeal,
  setOperatorMode,
} from "./cerberusOperatorLegacy";
export type {
  ComponentHealth,
  HealthStatus,
  HistoryRecord,
  Incident,
  IncidentSeverity,
  IncidentStatus,
  OperatorActionView,
  OperatorMode,
  OperatorSystemReport,
  PendingApproval,
} from "./cerberusOperatorLegacy";
import {
  OperatorStateMachine,
  OperationalStateStore,
  type ComponentObservation,
} from "./operatorAutonomy";
import {
  runOperatorHealthChecksV2,
  type OperatorHealthObservation,
} from "./operatorHealthChecksV2";
import { synchronizeOperatorIncidents } from "./operatorIncidentRecovery";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_HISTORY_RECORDS = 100;
const machine = new OperatorStateMachine();
const stateStore = new OperationalStateStore();
let schedulerTimer: NodeJS.Timeout | null = null;
let lastReport: OperatorSystemReport | null = null;
let healthHistory: HistoryRecord[] = [];

function healthStatus(status: OperatorHealthObservation["status"]): HealthStatus {
  if (status === "RECOVERING") return "DEGRADED";
  return status;
}

function componentHealth(observation: OperatorHealthObservation): ComponentHealth {
  const diagnostic = observation.diagnostic || {};
  return {
    name: observation.name,
    status: healthStatus(observation.status),
    latencyMs: observation.latencyMs,
    timestamp: observation.timestamp,
    error: observation.error,
    httpStatus: observation.httpStatus,
    details: Object.keys(diagnostic).length > 0 ? JSON.stringify(diagnostic) : undefined,
  };
}

function overallStatus(components: Record<string, ComponentHealth>): HealthStatus {
  const statuses = Object.values(components).map(component => component.status);
  if (statuses.includes("DOWN")) return "DOWN";
  if (statuses.includes("DEGRADED") || statuses.includes("UNKNOWN")) return "DEGRADED";
  return "HEALTHY";
}

function toStateObservation(observation: OperatorHealthObservation): ComponentObservation {
  return {
    name: observation.name,
    status: observation.status,
    timestamp: observation.timestamp,
    latencyMs: observation.latencyMs,
    error: observation.error,
  };
}

export async function runSystemHealthCheck(): Promise<OperatorSystemReport> {
  machine.beginHealthCheck("Início de health check V2 periódico ou manual.");
  const result = await runOperatorHealthChecksV2();
  if (machine.getState() === "CHECKING") {
    machine.transition("DIAGNOSING", "Health V2 coletado; reconciliando incidentes persistidos.");
  }
  const incidentSync = await synchronizeOperatorIncidents(result.observations);
  const components = Object.fromEntries(result.observations.map(observation => [observation.name, componentHealth(observation)] as const));
  const failing = result.observations.filter(observation => observation.status === "DOWN" || observation.status === "DEGRADED");
  const incidentsByComponent = Object.fromEntries(failing.map(observation => [observation.name, `health:${observation.name}`] as const));
  let transition;
  if (failing.length === 0 && machine.getState() === "DIAGNOSING") {
    transition = machine.transition("RESOLVED", "Todos os componentes independentes estão saudáveis.");
  }
  stateStore.update(result.observations.map(toStateObservation), incidentsByComponent, transition);
  const state = stateStore.snapshot(getOperatorMode(), machine);
  const next = new Date(Date.now() + CHECK_INTERVAL_MS);
  for (const observation of result.observations) {
    healthHistory.unshift({ timestamp: observation.timestamp, component: observation.name, status: healthStatus(observation.status), latencyMs: observation.latencyMs, error: observation.error });
  }
  if (healthHistory.length > MAX_HISTORY_RECORDS) healthHistory = healthHistory.slice(0, MAX_HISTORY_RECORDS);
  const persistence = getOperatorPersistenceState();
  lastReport = {
    overallStatus: overallStatus(components), mode: getOperatorMode(), components,
    activeIncidentsCount: incidentSync.active, recentCorrectionsCount: getRecentCorrections().length,
    lastCheckAt: result.checkedAt, nextCheckAt: next.toISOString(), autonomyLevel: state.autonomyLevel,
    operatorState: state.operatorState, escalationCount: state.escalations,
    persistenceStatus: persistence.status, persistenceReason: persistence.reason,
  };
  return lastReport;
}

export function getLastReport(): OperatorSystemReport | null { return lastReport; }
export function getHealthHistory(): HistoryRecord[] { return [...healthHistory]; }

export function startOperatorScheduler(): void {
  if (schedulerTimer) return;
  console.log(`[OPERATOR SCHEDULER V2] Health independente a cada ${CHECK_INTERVAL_MS / 60000} minutos.`);
  schedulerTimer = setInterval(() => {
    void runSystemHealthCheck().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[OPERATOR SCHEDULER V2] heartbeat failed: ${message.slice(0, 180)}`);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopOperatorScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}
