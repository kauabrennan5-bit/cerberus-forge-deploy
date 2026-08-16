/**
 * Bloco 16 — Fase C — Fronteira de aprovação do Agent Runtime.
 *
 * REQUIRES_APPROVAL NÃO executa nesta fase. A aprovação permanece uma
 * autoridade EXTERNA ao agente: um agente nunca pode fornecer
 * approved=true como prova suficiente para si mesmo.
 *
 * Não cria novo sistema de aprovação; usa a abstração existente do contrato
 * (ApprovalContract da Fase A) com um provider injetável. O provider default
 * NUNCA aprova — aprovação real (Operator/PendingApproval) é integração de
 * fase futura autorizada.
 */

import type { ApprovalDecisionState } from "./types";

/**
 * Provider de aprovação injetável. Recebe o approvalContext declarado e
 * retorna o estado REAL de aprovação, resolvido por autoridade externa
 * (no default: PENDING sempre — nada é aprovado por via declarativa).
 */
export interface ApprovalProvider {
  resolve(parts: {
    requiresApproval: boolean;
    approvalId: string | null;
  }): Promise<ApprovalDecisionState>;
}

/**
 * Provider default: nunca aprova. Um approvalId declarado pelo agente não
 * é prova suficiente; o estado retornado permanece PENDING quando aprovação
 * é exigida e NOT_REQUIRED quando não é.
 */
export class NeverApproveProvider implements ApprovalProvider {
  async resolve(parts: {
    requiresApproval: boolean;
    approvalId: string | null;
  }): Promise<ApprovalDecisionState> {
    if (!parts.requiresApproval) {
      return "NOT_REQUIRED";
    }
    return "PENDING";
  }
}

/** Singleton default — o runtime usa este provider quando nenhum é injetado. */
export const DEFAULT_APPROVAL_PROVIDER: ApprovalProvider =
  Object.freeze(new NeverApproveProvider());
