export type AutoHealMode = "OBSERVE" | "SAFE_AUTO_HEAL" | "ADMIN_APPROVAL" | "DRY_RUN";

export type ActionResultStatus =
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | "DRY_RUN"
  | "APPROVAL_REQUIRED"
  | "TIMEOUT"
  | "COOLDOWN"
  | "CIRCUIT_OPEN"
  | "BUDGET_EXCEEDED"
  | "FORBIDDEN";

export type AutoHealRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AutoHealContext {
  incidentId?: string;
  incidentFingerprint?: string;
  actor: "CERBERUS" | "ADMIN";
  adminId?: string;
}

export interface AutoHealCheck {
  ok: boolean;
  details?: string;
}

export interface SafeAction<TSnapshot = unknown, TResult = unknown> {
  id: string;
  name: string;
  description: string;
  risk: AutoHealRisk;
  allowed: boolean;
  timeoutMs: number;
  cooldownMs: number;
  maxRetries: number;
  retryable: boolean;
  requiresApproval?: boolean;
  preconditions: (context: AutoHealContext) => Promise<AutoHealCheck>;
  snapshot?: (context: AutoHealContext) => Promise<TSnapshot>;
  execute: (context: AutoHealContext) => Promise<TResult>;
  validate: (result: TResult, context: AutoHealContext) => Promise<AutoHealCheck>;
  rollback?: (snapshot: TSnapshot | undefined, context: AutoHealContext) => Promise<void>;
}

export interface AutoHealAuditLog {
  actionId: string;
  incidentId?: string;
  timestamp: string;
  actor: "CERBERUS" | "ADMIN";
  risk: AutoHealRisk;
  status: ActionResultStatus;
  preconditions: string;
  result: string;
  durationMs: number;
  validation?: string;
  rollback: boolean;
  error?: string;
}

export interface AutoHealActionResult {
  status: ActionResultStatus;
  message: string;
  actionId: string;
  durationMs: number;
  audit: AutoHealAuditLog;
}

export interface PersistedAutoHealState {
  stateKey: string;
  actionId: string;
  incidentId?: string;
  failureCount: number;
  retryCount: number;
  lastExecutionAt?: number;
  cooldownUntil?: number;
  circuitOpenUntil?: number;
}

export const AUTO_HEAL_POLICY = Object.freeze({
  backoffBaseMs: 100,
  maxCircuitFailures: 3,
  circuitCooldownMs: 30 * 60 * 1000,
  maxAttemptsPerHour: 20,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("ACTION_TIMEOUT")), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }) as Promise<T>;
}

/**
 * Motor determinístico para ações seguras previamente registradas.
 * Não aceita comandos arbitrários, shell, SQL, secrets ou caminhos externos.
 */
export class SafeAutoHealEngine {
  private readonly actions = new Map<string, SafeAction>();
  private readonly lastExecutedAt = new Map<string, number>();
  private readonly failureCounts = new Map<string, number>();
  private readonly retryCounts = new Map<string, number>();
  private readonly circuitOpenUntil = new Map<string, number>();
  private readonly auditLog: AutoHealAuditLog[] = [];
  private budgetWindowStartedAt: number;
  private budgetUsed = 0;

  constructor(
    actions: SafeAction[],
    private readonly now: () => number = () => Date.now(),
    private readonly circuitCooldownMs = AUTO_HEAL_POLICY.circuitCooldownMs,
    private readonly maxCircuitFailures = AUTO_HEAL_POLICY.maxCircuitFailures,
    private readonly maxAttemptsPerHour = AUTO_HEAL_POLICY.maxAttemptsPerHour,
    private readonly onStateChange?: (state: PersistedAutoHealState) => Promise<void>,
  ) {
    for (const action of actions) this.actions.set(action.id, action);
    this.budgetWindowStartedAt = this.now();
  }

  getActions(): SafeAction[] {
    return [...this.actions.values()];
  }

  getAuditLog(): AutoHealAuditLog[] {
    return [...this.auditLog];
  }

  getCriticalState(): PersistedAutoHealState[] {
    const keys = new Set([
      ...this.lastExecutedAt.keys(),
      ...this.failureCounts.keys(),
      ...this.retryCounts.keys(),
      ...this.circuitOpenUntil.keys(),
    ]);
    return [...keys].map(stateKey => {
      const [actionId, ...incidentParts] = stateKey.split(":");
      const circuitOpenUntil = this.circuitOpenUntil.get(stateKey);
      return {
        stateKey,
        actionId,
        incidentId: incidentParts.join(":") || undefined,
        failureCount: this.failureCounts.get(stateKey) || 0,
        retryCount: this.retryCounts.get(stateKey) || 0,
        lastExecutionAt: this.lastExecutedAt.get(stateKey),
        cooldownUntil: this.lastExecutedAt.has(stateKey)
          ? (this.lastExecutedAt.get(stateKey) || 0) + (this.actions.get(actionId)?.cooldownMs || 0)
          : undefined,
        circuitOpenUntil,
      };
    });
  }

  hydrate(states: PersistedAutoHealState[]): void {
    for (const state of states) {
      if (!state.stateKey || !this.actions.has(state.actionId)) continue;
      if (state.lastExecutionAt !== undefined) this.lastExecutedAt.set(state.stateKey, state.lastExecutionAt);
      if (state.failureCount > 0) this.failureCounts.set(state.stateKey, state.failureCount);
      if (state.retryCount > 0) this.retryCounts.set(state.stateKey, state.retryCount);
      if (state.circuitOpenUntil && state.circuitOpenUntil > this.now()) this.circuitOpenUntil.set(state.stateKey, state.circuitOpenUntil);
    }
  }

  private keyFor(actionId: string, context: AutoHealContext): string {
    return `${actionId}:${context.incidentFingerprint || context.incidentId || "system"}`;
  }

  private record(entry: AutoHealAuditLog): AutoHealAuditLog {
    this.auditLog.unshift(entry);
    if (this.auditLog.length > 100) this.auditLog.length = 100;
    return entry;
  }

  private result(
    action: SafeAction | { id: string; risk: AutoHealRisk },
    context: AutoHealContext,
    status: ActionResultStatus,
    message: string,
    startedAt: number,
    extra: Partial<AutoHealAuditLog> = {},
  ): AutoHealActionResult {
    const audit = this.record({
      actionId: action.id,
      incidentId: context.incidentId,
      timestamp: new Date(this.now()).toISOString(),
      actor: context.actor,
      risk: action.risk,
      status,
      preconditions: extra.preconditions || "Não avaliadas",
      result: message,
      durationMs: this.now() - startedAt,
      validation: extra.validation,
      rollback: extra.rollback || false,
      error: extra.error,
    });

    return { status, message, actionId: action.id, durationMs: audit.durationMs, audit };
  }

  private resetBudgetIfNeeded(): void {
    if (this.now() - this.budgetWindowStartedAt >= 60 * 60 * 1000) {
      this.budgetWindowStartedAt = this.now();
      this.budgetUsed = 0;
    }
  }

  private async persist(key: string, actionId: string, context: AutoHealContext): Promise<void> {
    if (!this.onStateChange) return;
    await this.onStateChange({
      stateKey: key,
      actionId,
      incidentId: context.incidentId,
      failureCount: this.failureCounts.get(key) || 0,
      retryCount: this.retryCounts.get(key) || 0,
      lastExecutionAt: this.lastExecutedAt.get(key),
      cooldownUntil: this.lastExecutedAt.has(key)
        ? (this.lastExecutedAt.get(key) || 0) + (this.actions.get(actionId)?.cooldownMs || 0)
        : undefined,
      circuitOpenUntil: this.circuitOpenUntil.get(key),
    });
  }

  async run(actionId: string, mode: AutoHealMode, context: AutoHealContext): Promise<AutoHealActionResult> {
    const startedAt = this.now();
    const action = this.actions.get(actionId);
    if (!action || !action.allowed) {
      return this.result({ id: actionId, risk: "CRITICAL" }, context, "FORBIDDEN", "Ação não registrada ou não autorizada.", startedAt);
    }

    if (action.risk === "CRITICAL") {
      return this.result(action, context, "FORBIDDEN", "Ações críticas nunca podem ser executadas automaticamente.", startedAt);
    }

    if (mode === "OBSERVE") {
      return this.result(action, context, "SKIPPED", "Modo OBSERVE: ação apenas diagnosticada, sem execução.", startedAt);
    }

    if (action.requiresApproval || action.risk === "HIGH" || (action.risk === "MEDIUM" && mode === "ADMIN_APPROVAL" && !context.adminId)) {
      if (!context.adminId) {
        return this.result(action, context, "APPROVAL_REQUIRED", "Ação requer aprovação administrativa explícita.", startedAt);
      }
    }

    if (mode === "DRY_RUN") {
      return this.result(action, context, "DRY_RUN", `DRY RUN: ${action.name} seria executada após pré-condições válidas; nenhuma alteração foi feita.`, startedAt);
    }

    this.resetBudgetIfNeeded();
    if (this.budgetUsed >= this.maxAttemptsPerHour) {
      return this.result(action, context, "BUDGET_EXCEEDED", "Orçamento horário de auto-heal atingido; nova tentativa foi bloqueada e o incidente deve ser escalado.", startedAt);
    }

    const key = this.keyFor(actionId, context);
    const openUntil = this.circuitOpenUntil.get(key) || 0;
    if (openUntil > this.now()) {
      return this.result(action, context, "CIRCUIT_OPEN", "Circuit breaker ativo para esta ação/incidente. Intervenção administrativa necessária.", startedAt);
    }

    const lastExecution = this.lastExecutedAt.get(key);
    if (lastExecution !== undefined && this.now() - lastExecution < action.cooldownMs) {
      return this.result(action, context, "COOLDOWN", "Ação em cooldown para prevenir loop de autocorreção.", startedAt);
    }

    const precondition = await action.preconditions(context);
    if (!precondition.ok) {
      return this.result(action, context, "SKIPPED", "Pré-condições não atendidas; ação não executada.", startedAt, { preconditions: precondition.details || "Falhou" });
    }

    let snapshot: unknown;
    let rollbackExecuted = false;
    let lastError = "";
    let budgetExceeded = false;

    try {
      snapshot = action.snapshot ? await action.snapshot(context) : undefined;
      const attempts = action.retryable ? Math.max(1, action.maxRetries + 1) : 1;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        this.resetBudgetIfNeeded();
        if (this.budgetUsed >= this.maxAttemptsPerHour) {
          budgetExceeded = true;
          lastError = "EXTERNAL_BUDGET_EXCEEDED";
          break;
        }
        this.budgetUsed += 1;
        this.retryCounts.set(key, Math.max(0, attempt - 1));
        try {
          this.lastExecutedAt.set(key, this.now());
          const executionResult = await withTimeout(action.execute(context), action.timeoutMs);
          const validation = await withTimeout(action.validate(executionResult, context), action.timeoutMs);

          if (!validation.ok) throw new Error(`VALIDATION_FAILED:${validation.details || "sem detalhes"}`);

          this.failureCounts.set(key, 0);
          this.retryCounts.set(key, Math.max(0, attempt - 1));
          await this.persist(key, actionId, context);
          return this.result(action, context, "SUCCESS", "Ação concluída e validada com sucesso.", startedAt, {
            preconditions: precondition.details || "OK",
            validation: validation.details || "OK",
          });
        } catch (error: any) {
          lastError = error?.message || String(error);
          const isTimeout = lastError === "ACTION_TIMEOUT";
          const canRetry = action.retryable && attempt < attempts && !isTimeout;
          if (canRetry) await sleep(AUTO_HEAL_POLICY.backoffBaseMs * 2 ** (attempt - 1));
          else break;
        }
      }

      if (action.rollback) {
        try {
          await withTimeout(action.rollback(snapshot, context), action.timeoutMs);
          rollbackExecuted = true;
        } catch (rollbackError: any) {
          lastError += ` | ROLLBACK_FAILED:${rollbackError?.message || rollbackError}`;
        }
      }

      const failures = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, failures);
      if (failures >= this.maxCircuitFailures) {
        this.circuitOpenUntil.set(key, this.now() + this.circuitCooldownMs);
      }
      await this.persist(key, actionId, context);

      return this.result(action, context, budgetExceeded ? "BUDGET_EXCEEDED" : lastError === "ACTION_TIMEOUT" ? "TIMEOUT" : "FAILED", budgetExceeded ? "Orçamento de auto-heal atingido; retries interrompidos e escalonamento necessário." : "Ação não foi validada; rollback aplicado quando disponível e escalonamento necessário.", startedAt, {
        preconditions: precondition.details || "OK",
        rollback: rollbackExecuted,
        error: lastError,
      });
    } catch (error: any) {
      return this.result(action, context, "FAILED", "Falha inesperada antes da execução segura.", startedAt, {
        preconditions: precondition.details || "OK",
        rollback: rollbackExecuted,
        error: error?.message || String(error),
      });
    }
  }
}
