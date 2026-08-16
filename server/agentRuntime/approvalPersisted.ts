/**
 * Bloco 16 — Fase D — Fronteira de aprovação com aprovação oficial.
 *
 * O provider default da Fase C (NeverApproveProvider) nunca aprova. Nesta
 * fase a aprovação REAL passa a existir, mas continua uma autoridade
 * EXTERNA ao agente:
 *
 *   1. O agente NUNCA declara approved=true como prova para si mesmo;
 *   2. Uma aprovação só é criada por via administrativa (admin auth);
 *   3. approval_id falso, de outro agente, de outra action, de outra
 *      intention, expirado ou incompatível com a política atual é
 *      rejeitado (default deny);
 *   4. toda aprovação aprovada exige RE-AVALIAÇÃO da política antes de
 *      qualquer execução (POLICY_CHANGED → DENY ou nova aprovação).
 *
 * Este módulo NÃO toca o mecanismo legado de PendingApproval do Operator
 * (auto-heal in-memory). O Operator permanece a autoridade do seu
 * domínio; o runtime tem o seu ApprovalStore próprio.
 *
 * FRONTIERA DOCUMENTADA: MEMORY != AUTHORITY — o ApprovalProvider é
 * apenas uma porta de leitura da autoridade administrativa; quem decide
 * continua sendo o Policy Engine.
 */

import type { ApprovalProvider } from "./approval";
import type { ApprovalDecisionState } from "./types";

// ============================================================================
// Contrato do ApprovalStore
// ============================================================================

/** Uma aprovação oficial criada por via administrativa. */
export interface RuntimeApproval {
  /** Id oficial (nunca o approvalId declarado pelo agente). */
  approvalId: string;
  executionId: string;
  intentionKey: string;
  agentId: string;
  agentVersion: string;
  policyVersion: string;
  tool: string;
  action: string;
  risk: string;
  evaluationId: string;
  /** Quem aprovou (via admin auth; sempre operator-admin ou admin). */
  approvedBy: string;
  approvedAt: string;
  /** Expiração determinística da aprovação. */
  expiresAt: string;
  state: "APPROVED" | "REVOKED" | "EXPIRED";
  correlationId: string | null;
}

export interface ApprovalWriteResult {
  outcome:
    | "created"
    | "revoked"
    | "not_found"
    | "already_revoked"
    | "expired"
    | "invalid_context";
  approval?: RuntimeApproval;
  error?: string;
}

export interface ApprovalStore {
  /** Cria uma aprovação oficial (somente via admin). */
  create(parts: {
    executionId: string;
    intentionKey: string;
    agentId: string;
    agentVersion: string;
    policyVersion: string;
    tool: string;
    action: string;
    risk: string;
    evaluationId: string;
    approvedBy: string;
    approvedAt: string;
    expiresAt: string;
    correlationId?: string | null;
  }): Promise<ApprovalWriteResult>;
  /**
   * Resolve o estado de uma intenção de execução:
   * - sem requiresApproval → NOT_REQUIRED
   * - sem aprovação → PENDING
   * - aprovação oficial válida (não expirada, contextos idênticos, mesma
   *   policy_version) → APPROVED
   * - aprovação expirada → EXPIRED
   * - aprovação revogada → REJECTED
   */
  resolve(parts: {
    intentionKey: string;
    executionId: string;
    policyVersion: string;
    requiresApproval: boolean;
    approvalId?: string | null;
    clock: () => string;
  }): Promise<ApprovalDecisionState>;
  /** Lista aprovações (admin-only). */
  list(): Promise<ReadonlyArray<RuntimeApproval>>;
  /** Revoga uma aprovação (admin-only). */
  revoke(approvalId: string): Promise<ApprovalWriteResult>;
}

// ============================================================================
// Expiração padrão da aprovação (Fase D: 30 minutos)
// ============================================================================
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** Deriva approval_id oficial determinístico (não é o declared approvalId). */
export function deriveOfficialApprovalId(parts: {
  intentionKey: string;
  executionId: string;
  policyVersion: string;
}): string {
  const payload = JSON.stringify({
    intentionKey: parts.intentionKey,
    executionId: parts.executionId,
    policyVersion: parts.policyVersion,
  });
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash << 5) - hash + payload.charCodeAt(i);
    hash |= 0;
  }
  return `appr-${Math.abs(hash).toString(36)}-${payload.length.toString(36)}`;
}

// ============================================================================
// Store em memória — TEST-ONLY e fallback oficial da Fase D
// ============================================================================
/**
 * Store oficial de aprovações do runtime. Persistência em memória com
 * expiração determinística — a aprovação real do runtime nesta fase é o
 * ciclo decisão do engine → aprovação oficial → RE-EVALUAÇÃO da política.
 * A tabela oficial de approvals é decisão de fase seguinte autorizada
 * (nova migration); o journal de execuções já persiste approval_id oficial.
 *
 * A aprovação em memória é deliberada: uma aprovação que não pode ser
 * re-avaliada contra a política atual no momento da execução não é
 * autoridade. O runtime re-avalia sempre.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, RuntimeApproval>();

  async create(parts: {
    executionId: string;
    intentionKey: string;
    agentId: string;
    agentVersion: string;
    policyVersion: string;
    tool: string;
    action: string;
    risk: string;
    evaluationId: string;
    approvedBy: string;
    approvedAt: string;
    expiresAt: string;
    correlationId?: string | null;
  }): Promise<ApprovalWriteResult> {
    const approvalId = deriveOfficialApprovalId({
      intentionKey: parts.intentionKey,
      executionId: parts.executionId,
      policyVersion: parts.policyVersion,
    });
    const existing = this.approvals.get(approvalId);
    if (existing) {
      if (existing.state !== "APPROVED") {
        return { outcome: "already_revoked", approval: existing };
      }
      return { outcome: "created", approval: existing };
    }
    const approval: RuntimeApproval = Object.freeze({
      approvalId,
      executionId: parts.executionId,
      intentionKey: parts.intentionKey,
      agentId: parts.agentId,
      agentVersion: parts.agentVersion,
      policyVersion: parts.policyVersion,
      tool: parts.tool,
      action: parts.action,
      risk: parts.risk,
      evaluationId: parts.evaluationId,
      approvedBy: parts.approvedBy,
      approvedAt: parts.approvedAt,
      expiresAt: parts.expiresAt,
      state: "APPROVED",
      correlationId: parts.correlationId ?? null,
    });
    this.approvals.set(approvalId, approval);
    return { outcome: "created", approval };
  }

  async resolve(parts: {
    intentionKey: string;
    executionId: string;
    policyVersion: string;
    requiresApproval: boolean;
    approvalId?: string | null;
    clock: () => string;
  }): Promise<ApprovalDecisionState> {
    if (!parts.requiresApproval) return "NOT_REQUIRED";
    const now = parts.clock();
    for (const approval of this.approvals.values()) {
      if (approval.state !== "APPROVED") continue;
      const sameIntention = approval.intentionKey === parts.intentionKey;
      const sameExecution = approval.executionId === parts.executionId;
      const samePolicy = approval.policyVersion === parts.policyVersion;
      if (!sameIntention || !sameExecution || !samePolicy) continue;
      if (parts.approvalId && approval.approvalId !== parts.approvalId) {
        // approvalId declarado incompatível com a aprovação oficial —
        // default deny: esta aprovação não conta.
        continue;
      }
      if (now > approval.expiresAt) {
        this.approvals.set(approval.approvalId, {
          ...approval,
          state: "EXPIRED",
        });
        return "EXPIRED";
      }
      return "APPROVED";
    }
    // Há aprovações expiradas/revogadas para esta intention? Se sim, a
    // intenção permanece bloqueada (não volta a PENDING silenciosamente).
    for (const approval of this.approvals.values()) {
      if (
        approval.intentionKey === parts.intentionKey &&
        approval.executionId === parts.executionId &&
        approval.state !== "APPROVED"
      ) {
        return approval.state === "EXPIRED" ? "EXPIRED" : "REJECTED";
      }
    }
    return "PENDING";
  }

  async list(): Promise<ReadonlyArray<RuntimeApproval>> {
    return Object.freeze([...this.approvals.values()]);
  }

  async revoke(approvalId: string): Promise<ApprovalWriteResult> {
    const existing = this.approvals.get(approvalId);
    if (!existing) return { outcome: "not_found" };
    if (existing.state !== "APPROVED") {
      return { outcome: "already_revoked", approval: existing };
    }
    this.approvals.set(approvalId, { ...existing, state: "REVOKED" });
    return { outcome: "revoked", approval: { ...existing, state: "REVOKED" } };
  }
}

// ============================================================================
// Provider persistido: integração oficial com a pipeline do runtime
// ============================================================================

/**
 * Provider oficial do runtime: resolve o estado de aprovação de uma
 * intenção específica contra o ApprovalStore. O approvalId declarado pelo
 * próprio agente (request.approvalContext.approvalId) NUNCA é tratado como
 * prova — a pipeline passa approvalId: null e a resolução acontece por
 * intenção + plan + policy_version.
 *
 * Falha de leitura = PENDING (fail-closed: nunca aprova por
 * indisponibilidade).
 */
export class OfficialApprovalProvider implements ApprovalProvider {
  constructor(
    private readonly store: ApprovalStore,
    private readonly parts: {
      intentionKey: string;
      executionId: string;
      policyVersion: string;
      clock: () => string;
    }
  ) {}

  async resolve(requestParts: {
    requiresApproval: boolean;
    approvalId: string | null;
  }): Promise<ApprovalDecisionState> {
    if (!requestParts.requiresApproval) return "NOT_REQUIRED";
    try {
      return await this.store.resolve({
        intentionKey: this.parts.intentionKey,
        executionId: this.parts.executionId,
        policyVersion: this.parts.policyVersion,
        requiresApproval: true,
        approvalId: null, // declaração do agente nunca é prova
        clock: this.parts.clock,
      });
    } catch (error) {
      return "PENDING";
    }
  }
}
