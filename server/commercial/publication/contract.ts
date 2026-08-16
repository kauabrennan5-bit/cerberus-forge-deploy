// ============================================================================
// Bloco N5 — Governed Publication — Contrato de Publicação v1.0
//
// - CANDIDATE != FACT CANÔNICO: o contrato descreve uma INTENÇÃO de promoção,
//   nunca a migração silenciosa de um candidato para produto.
// - NUNCA inventar campos ausentes: qualquer dado não obtido é UNKNOWN/null.
// - affiliate_url somente quando fornecido por fonte válida (admin ou
//   configuração declarada). URL normal do marketplace NÃO é derivada para
//   "link de afiliado" — a derivação sem evidência criaria falsa economia.
// - SCORE SEM RACIONAL = SEM SIGNIFICADO: decisão exige assessment completo,
//   não um número de score.
// ============================================================================

import type { PolicyDecisionValue } from "../../policyEngine/types";
import type { ApprovalDecisionState } from "../../agentRuntime/types";

export const PUBLICATION_CONTRACT_VERSION = "1.0";

/** Catálogo fechado dos resultados possíveis de uma tentativa de publicação. */
export type PublicationOutcome =
  | "PUBLISHED"
  | "DENIED"
  | "WAITING_APPROVAL"
  | "APPROVAL_REQUIRED"
  | "REJECTED_BY_REVIEW"
  | "ALREADY_PUBLISHED" // idempotência: replay de publicação já concluída
  | "DUPLICATE_DETECTED"
  | "VALIDATION_FAILED"
  | "MISSING_DATA"
  | "INVALID_URL"
  | "NOT_FOUND"
  | "INCOMPATIBLE"
  | "POLICY_DENIED"
  | "POLICY_ERROR"
  | "INTERNAL_ERROR";

/** Catálogo fechado dos motivos de falha do preflight. */
export type PreflightFailureCode =
  | "CANDIDATE_NOT_FOUND"
  | "CANDIDATE_NOT_APPROVED"
  | "ALREADY_PROMOTED"
  | "ASSESSMENT_NOT_FOUND"
  | "ASSESSMENT_NOT_ACTIONABLE"
  | "ASSESSMENT_MISMATCH"
  | "MISSING_TITLE"
  | "MISSING_CATEGORY"
  | "MISSING_PRICE"
  | "PRICE_UNKNOWN"
  | "SOURCE_URL_MISSING"
  | "SOURCE_URL_INVALID"
  | "OPEN_CONTRADICTIONS"
  | "COLLECTION_FAILURES_OPEN"
  | "DUPLICATE_SLUG"
  | "DUPLICATE_URL"
  | "INVALID_AFFILIATE_URL";

/** Catálogo fechado de erros do executor. */
export type ExecutionFailureCode =
  | "POLICY_NOT_EVALUATED"
  | "POLICY_DENIED"
  | "POLICY_ERROR"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_VALID"
  | "APPROVAL_EXPIRED"
  | "PRODUCT_CREATION_FAILED"
  | "PROMOTION_LINK_FAILED"
  | "VALIDATION_FAILED"
  | "DUPLICATE_DETECTED"
  | "ROLLBACK_FAILED"
  | "STORE_ERROR"
  | "DUPLICATE_EXECUTION";

/**
 * AffiliateLink: única forma legítima de publicar com rastreamento de
 * afiliado. É fornecido explicitamente (admin ou configuração declarada);
 * o sistema JAMAIS deriva affiliate_url de uma URL comum de marketplace.
 */
export interface AffiliateLinkSource {
  /** Quem/qual configuração forneceu o link (ex.: "admin:manual", "config:affiliate_program:shopee"). */
  provider: string;
  /** Id do registro externo quando aplicável (ex.: id do programa de afiliados cadastrado). */
  providerRef?: string | null;
  /** A URL rastreada fornecida. */
  affiliateUrl: string;
  /** Quando o link foi fornecido. */
  providedAt: string;
}

/** Proveniência completa da publicação — rastro auditável. */
export interface PublicationProvenance {
  /** Avaliação do filtro N4 que sustentou a decisão (assessment_id). */
  assessmentId: string;
  /** Versão do filtro que gerou a avaliação. */
  filterVersion: string;
  /** Referência ao registro da decisão de publicação (decision_id). */
  decisionId: string;
  /** Avaliação de política que autorizou (evaluation_id, do Policy Engine). */
  policyEvaluationId: string | null;
  /** Aprovação humana que autorizou a execução (approval_id, quando houver). */
  approvalId: string | null;
  /** Quem executou/decidiu (namespace do Operator). */
  decidedBy: "operator-admin" | "operator" | "system";
  /** Execution id do Agent Runtime (execution_id). */
  executionId: string;
  /** Idempotency key que garante replay sem duplicata. */
  idempotencyKey: string;
  /** Registro de auditoria da sequência de eventos. */
  auditTrail: ReadonlyArray<PublicationAuditEvent>;
  /** Correlation id que amarra decisão → avaliação → execução → resultado. */
  correlationId: string;
}

export interface PublicationAuditEvent {
  stage:
    | "PUBLICATION_REQUESTED"
    | "PREFLIGHT_PASSED"
    | "PREFLIGHT_FAILED"
    | "POLICY_EVALUATED"
    | "POLICY_FAILED"
    | "APPROVAL_REQUIRED"
    | "APPROVAL_GRANTED"
    | "APPROVAL_MISSING"
    | "PRODUCT_CREATED"
    | "PROMOTION_LINKED"
    | "PUBLICATION_VALIDATED"
    | "PUBLICATION_RESTORED"
    | "EXECUTION_FINISHED";
  at: string;
  message: string;
  actor?: string;
}

/**
 * PublicationDecision: decisão de publicação explícita (RECOMMENDATION != DECISION).
 * Contém candidate, assessment e decisão documentada com rationale completo.
 */
export interface PublicationDecision {
  decisionId: string;
  candidateId: string;
  assessmentId: string;
  /** A avaliação de política que cobre esta decisão (ALLOW/APPROVAL_REQUIRED). */
  policyDecision: PolicyDecisionValue;
  /** Estado de aprovação requerido/grantado. */
  approvalState: ApprovalDecisionState;
  /** Rationale legível — a decisão deve explicar, não apenas pontuar. */
  rationale: string;
  decidedBy: "operator-admin" | "operator" | "system";
  decidedAt: string;
  correlationId: string;
}

/**
 * PublicationContract v1.0 — artefato declarativo de uma publicação.
 *
 * Nenhum campo ausente é inventado: valores desconhecidos são UNKNOWN/null.
 */
export interface PublicationContract {
  schemaVersion: string;
  contractVersion: string;
  candidateId: string;
  assessmentId: string;
  decisionId: string;
  executionId: string;
  sourceUrl: string;
  marketplace: string;
  title: string;
  description: string | null;
  price: number | null;
  /** UNKNOWN quando o preço observado não é KNOWN no candidato/assessment. */
  priceState: "KNOWN" | "UNKNOWN";
  images: ReadonlyArray<string> | null;
  /** UNKNOWN quando não há fonte válida de link de afiliado. */
  affiliateUrl: string | null;
  affiliateState: "AVAILABLE" | "UNKNOWN";
  affiliateSource: AffiliateLinkSource | null;
  provenance: PublicationProvenance;
  createdAt: string;
  updatedAt: string;
}

export function unknownPriceState(price: number | null | undefined): "KNOWN" | "UNKNOWN" {
  return price !== null && price !== undefined ? "KNOWN" : "UNKNOWN";
}

/** Registra um evento de auditoria determinístico no contrato. */
export function recordAuditEvent(
  trail: ReadonlyArray<PublicationAuditEvent>,
  event: PublicationAuditEvent
): ReadonlyArray<PublicationAuditEvent> {
  return Object.freeze([...trail, Object.freeze(event)]);
}
