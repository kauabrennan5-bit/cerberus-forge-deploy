import { supabase } from "../repositories/productsRepository";

export type PersistedCircuitState = "CLOSED" | "OPEN";

export interface PersistedOperatorState {
  stateKey: string;
  actionId: string;
  incidentId?: string;
  circuitState: PersistedCircuitState;
  failureCount: number;
  retryCount: number;
  lastExecutionAt?: number;
  cooldownUntil?: number;
  circuitOpenUntil?: number;
  lastTransitionAt: number;
  metadata?: Record<string, unknown>;
}

export interface OperatorStateLoadResult {
  ok: boolean;
  states: PersistedOperatorState[];
  reason?: string;
}

let persistenceStatus: "UNKNOWN" | "READY" | "SAFE_MODE" = "UNKNOWN";
let persistenceReason = "Ainda não inicializado.";

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidPersistedOperatorState(value: unknown): value is PersistedOperatorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PersistedOperatorState>;
  return Boolean(
    typeof state.stateKey === "string" && state.stateKey.length > 0 &&
    typeof state.actionId === "string" && state.actionId.length > 0 &&
    (state.circuitState === "CLOSED" || state.circuitState === "OPEN") &&
    Number.isInteger(state.failureCount) && state.failureCount >= 0 &&
    Number.isInteger(state.retryCount) && state.retryCount >= 0 &&
    finiteNonNegative(state.lastTransitionAt) &&
    (state.lastExecutionAt === undefined || finiteNonNegative(state.lastExecutionAt)) &&
    (state.cooldownUntil === undefined || finiteNonNegative(state.cooldownUntil)) &&
    (state.circuitOpenUntil === undefined || finiteNonNegative(state.circuitOpenUntil))
  );
}

function toPersistedState(row: any): PersistedOperatorState | null {
  const state: PersistedOperatorState = {
    stateKey: String(row.state_key || ""),
    actionId: String(row.action_id || ""),
    incidentId: row.incident_id ? String(row.incident_id) : undefined,
    circuitState: row.circuit_state === "OPEN" ? "OPEN" : "CLOSED",
    failureCount: Number(row.failure_count || 0),
    retryCount: Number(row.retry_count || 0),
    lastExecutionAt: row.last_execution_at ? Date.parse(row.last_execution_at) : undefined,
    cooldownUntil: row.cooldown_until ? Date.parse(row.cooldown_until) : undefined,
    circuitOpenUntil: row.circuit_open_until ? Date.parse(row.circuit_open_until) : undefined,
    lastTransitionAt: row.last_transition_at ? Date.parse(row.last_transition_at) : Date.now(),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  };
  return isValidPersistedOperatorState(state) ? state : null;
}

export async function loadPersistedOperatorState(): Promise<OperatorStateLoadResult> {
  if (!supabase) {
    persistenceStatus = "SAFE_MODE";
    persistenceReason = "Cliente Supabase não configurado; auto-heal permanece bloqueado em modo seguro.";
    return { ok: false, states: [], reason: persistenceReason };
  }

  const { data, error } = await supabase
    .from("operator_state")
    .select("state_key, action_id, incident_id, circuit_state, failure_count, retry_count, last_execution_at, cooldown_until, circuit_open_until, last_transition_at, metadata")
    .limit(500);

  if (error) {
    persistenceStatus = "SAFE_MODE";
    persistenceReason = `Não foi possível carregar operator_state: ${error.message}`;
    return { ok: false, states: [], reason: persistenceReason };
  }

  const states = (Array.isArray(data) ? data : [])
    .map(toPersistedState)
    .filter((state): state is PersistedOperatorState => Boolean(state));

  if (Array.isArray(data) && states.length !== data.length) {
    persistenceStatus = "SAFE_MODE";
    persistenceReason = "operator_state contém registro inválido; auto-heal permanece bloqueado até revisão administrativa.";
    return { ok: false, states: [], reason: persistenceReason };
  }

  persistenceStatus = "READY";
  persistenceReason = `${states.length} estado(s) crítico(s) carregado(s).`;
  return { ok: true, states };
}

export async function persistOperatorState(state: PersistedOperatorState): Promise<boolean> {
  if (!supabase || !isValidPersistedOperatorState(state)) return false;

  const row = {
    state_key: state.stateKey,
    action_id: state.actionId,
    incident_id: state.incidentId || null,
    circuit_state: state.circuitState,
    failure_count: state.failureCount,
    retry_count: state.retryCount,
    last_execution_at: state.lastExecutionAt ? new Date(state.lastExecutionAt).toISOString() : null,
    cooldown_until: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
    circuit_open_until: state.circuitOpenUntil ? new Date(state.circuitOpenUntil).toISOString() : null,
    last_transition_at: new Date(state.lastTransitionAt).toISOString(),
    metadata: state.metadata || {},
  };

  const { error } = await supabase.from("operator_state").upsert(row, { onConflict: "state_key" });
  if (error) {
    persistenceStatus = "SAFE_MODE";
    persistenceReason = `Falha ao persistir operator_state: ${error.message}`;
    return false;
  }
  persistenceStatus = "READY";
  persistenceReason = "Última alteração crítica persistida.";
  return true;
}

export function getOperatorPersistenceStatus(): { status: typeof persistenceStatus; reason: string } {
  return { status: persistenceStatus, reason: persistenceReason };
}
