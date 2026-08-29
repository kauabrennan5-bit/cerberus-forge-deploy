export type WeeklyDraftDiagnosticStage =
  | "RUNTIME_CONFIG"
  | "SUPABASE_READ"
  | "PRODUCT_SELECTION"
  | "PRODUCT_ELIGIBILITY"
  | "RANKING"
  | "GEMINI"
  | "HTML_RENDER"
  | "DRAFT_PERSIST"
  | "TELEGRAM_DELIVERY"
  | "UNKNOWN_INTERNAL";

export type WeeklyDraftDiagnosticReason =
  | "TELEGRAM_ADMIN_CHAT_MISSING"
  | "TELEGRAM_ACTOR_MISSING"
  | "PUBLIC_URL_MISSING"
  | "PUBLIC_URL_INVALID"
  | "SUPABASE_CONFIG_MISSING"
  | "SUPABASE_READ_FAILED"
  | "NO_NEW_PRODUCTS"
  | "INSUFFICIENT_PRODUCTS"
  | "RANKING_FAILED"
  | "GEMINI_CONFIG_MISSING"
  | "GEMINI_BUDGET_EXCEEDED"
  | "GEMINI_REQUEST_FAILED"
  | "GEMINI_OUTPUT_REJECTED"
  | "GEMINI_COMMERCIAL_FACT_REJECTED"
  | "HTML_RENDER_FAILED"
  | "DRAFT_INSERT_FAILED"
  | "DRAFT_PRODUCTS_PERSIST_FAILED"
  | "DRAFT_APPROVAL_PERSIST_FAILED"
  | "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED"
  | "TELEGRAM_CARD_REFERENCE_PERSIST_FAILED"
  | "UNKNOWN_INTERNAL";

export type WeeklyDraftDiagnostic = {
  attemptId: string;
  stage: WeeklyDraftDiagnosticStage;
  reason: WeeklyDraftDiagnosticReason;
  activeProductCount?: number;
  newProductCount?: number;
  eligibleProductCount?: number;
  campaignId?: string;
  draftCreated?: boolean;
  draftStatus?: string;
};

export class WeeklyDraftDiagnosticError extends Error {
  constructor(public readonly diagnostic: WeeklyDraftDiagnostic) {
    super(`WEEKLY_DRAFT_DIAGNOSTIC:${diagnostic.stage}:${diagnostic.reason}`);
    this.name = "WeeklyDraftDiagnosticError";
  }
}

export function isWeeklyDraftDiagnosticError(error: unknown): error is WeeklyDraftDiagnosticError {
  return error instanceof WeeklyDraftDiagnosticError;
}

export function classifyGeminiDiagnosticReason(error: unknown): WeeklyDraftDiagnosticReason {
  const message = error instanceof Error ? error.message : "";
  if (message === "WEEKLY_COPY_GEMINI_NOT_CONFIGURED") return "GEMINI_CONFIG_MISSING";
  if (message === "WEEKLY_COPY_GEMINI_BUDGET_EXCEEDED") return "GEMINI_BUDGET_EXCEEDED";
  if (message === "WEEKLY_COPY_COMMERCIAL_FACT_FORBIDDEN") return "GEMINI_COMMERCIAL_FACT_REJECTED";
  if (
    message === "WEEKLY_COPY_INVALID_JSON"
    || message === "WEEKLY_COPY_INCOMPLETE"
    || message === "WEEKLY_COPY_PRODUCT_COUNT_INVALID"
    || message.startsWith("WEEKLY_COPY_CAPTION_MISSING:")
  ) return "GEMINI_OUTPUT_REJECTED";
  return "GEMINI_REQUEST_FAILED";
}

export function logWeeklyDraftStage(
  attemptId: string,
  stage: WeeklyDraftDiagnosticStage,
  event: "START" | "SUCCESS" | "FAIL",
  reason?: WeeklyDraftDiagnosticReason,
): void {
  const suffix = reason ? ` reason=${reason}` : "";
  console.info(`[NEWSLETTER-WEEKLY] attempt=${attemptId} stage=${stage} event=${event}${suffix}`);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

const STAGE_LABEL: Record<WeeklyDraftDiagnosticStage, string> = {
  RUNTIME_CONFIG: "Configuração",
  SUPABASE_READ: "Supabase",
  PRODUCT_SELECTION: "Seleção de produtos",
  PRODUCT_ELIGIBILITY: "Elegibilidade de produtos",
  RANKING: "Ranking",
  GEMINI: "Gemini",
  HTML_RENDER: "Renderização HTML",
  DRAFT_PERSIST: "Persistência do rascunho",
  TELEGRAM_DELIVERY: "Telegram",
  UNKNOWN_INTERNAL: "Interno",
};

export function formatWeeklyDraftDiagnosticTelegram(diagnostic: WeeklyDraftDiagnostic): string {
  const lines = [
    "⚠️ <b>WEEKLY-TEST NÃO CRIADA</b>",
    "",
    `Etapa: <b>${escapeHtml(STAGE_LABEL[diagnostic.stage])}</b>`,
    `Motivo: <code>${escapeHtml(diagnostic.reason)}</code>`,
  ];
  if (Number.isSafeInteger(diagnostic.activeProductCount)) lines.push(`Produtos ativos: ${diagnostic.activeProductCount}`);
  if (Number.isSafeInteger(diagnostic.newProductCount)) lines.push(`Produtos novos: ${diagnostic.newProductCount}`);
  if (Number.isSafeInteger(diagnostic.eligibleProductCount)) lines.push(`Produtos elegíveis: ${diagnostic.eligibleProductCount}`);
  if (diagnostic.draftCreated && diagnostic.campaignId) {
    lines.push("", "O rascunho foi persistido, mas o fluxo não chegou à aprovação.", `<code>${escapeHtml(diagnostic.campaignId)}</code>`);
  }
  lines.push("", "Nenhum email foi enviado e nenhuma chamada Brevo foi iniciada.");
  return lines.join("\n");
}
