export type OperationKind = "CATALOG_SYNC" | "PRODUCT_PUBLICATION" | "HEALTH_CHECK" | "AUTO_HEAL";

export type OperationStage =
  | "SUPABASE_READ"
  | "SUPABASE_WRITE"
  | "CATALOG_EXPORT"
  | "GITHUB_AUTH"
  | "GITHUB_WRITE"
  | "PUBLIC_CATALOG_VALIDATION"
  | "HEALTH_CHECK"
  | "RECOVERY_VALIDATION";

export type OperationalFailureCode =
  | "SUPABASE_PERSISTENCE_ERROR"
  | "CATALOG_GENERATION_ERROR"
  | "GITHUB_AUTH_ERROR"
  | "GITHUB_SYNC_ERROR"
  | "DEPLOY_ERROR"
  | "PUBLIC_CATALOG_VALIDATION_ERROR"
  | "PUBLICATION_ERROR"
  | "TELEGRAM_DELIVERY_ERROR"
  | "UNKNOWN_OPERATION_ERROR";

export type DependencyName = "Supabase" | "Exportador" | "GitHub" | "Render Static Site" | "Telegram" | "Backend" | "Analytics";
export type RecoveryClass = "AUTO" | "ADMIN_APPROVAL" | "MANUAL" | "NOT_APPLICABLE";

export interface OperationalDiagnostic {
  operationId: string;
  correlationId: string;
  operation: OperationKind;
  stage: OperationStage;
  dependency: DependencyName;
  code: OperationalFailureCode;
  message: string;
  likelyCause: string;
  impact: string;
  recoverability: RecoveryClass;
  retryable: boolean;
  httpStatus?: number;
  cause?: string;
  occurredAt: string;
}

let sequence = 0;

export function createOperationId(prefix: "PUB" | "SYNC" | "HC" | "HEAL" = "SYNC"): string {
  sequence = (sequence + 1) % 10_000;
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}-${timestamp}-${sequence.toString().padStart(4, "0")}`;
}

/** Remove valores com aparência de segredo antes de persistir ou exibir diagnósticos. */
export function sanitizeOperationalText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value || "Erro sem detalhes técnicos.");
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/gi, "[REDACTED_GITHUB_TOKEN]")
    .replace(/-----BEGIN[\s\S]*?-----END[^\n]*/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/access_token=[^\s&]+/gi, "access_token=[REDACTED]")
    .slice(0, 500);
}

export function createOperationalDiagnostic(input: Omit<OperationalDiagnostic, "occurredAt" | "cause" | "correlationId"> & { correlationId?: string; cause?: unknown }): OperationalDiagnostic {
  const operationId = String(input.operationId || "").trim();
  const correlationId = String(input.correlationId || operationId).trim();
  if (!operationId || !correlationId) throw new Error("INVALID_OPERATIONAL_DIAGNOSTIC_CORRELATION");
  return {
    ...input,
    operationId,
    correlationId,
    cause: input.cause ? sanitizeOperationalText(input.cause) : undefined,
    occurredAt: new Date().toISOString(),
  };
}

export function formatDiagnosticForAdmin(diagnostic: OperationalDiagnostic): string {
  const http = diagnostic.httpStatus ? ` HTTP ${diagnostic.httpStatus}.` : "";
  return [
    `<b>${diagnostic.code}</b> · <code>${diagnostic.operationId}</code> · <code>${diagnostic.correlationId}</code>`,
    `Etapa: ${diagnostic.stage} · Dependência: ${diagnostic.dependency}.${http}`,
    `Impacto: ${diagnostic.impact}`,
    `Causa provável: ${diagnostic.likelyCause}`,
    `Recuperação: ${diagnostic.recoverability}${diagnostic.retryable ? " (repetível)" : ""}.`,
  ].join("\n");
}
