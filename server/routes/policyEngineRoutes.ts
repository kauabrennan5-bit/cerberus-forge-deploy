/**
 * Cerberus Finds Archive — Bloco 15 — Fase D — Integração read-only
 * do Policy Engine.
 *
 * Fronteiras: POLICY != EXECUTION · ALLOW != EXECUTION
 *             REQUIRES_APPROVAL != APPROVAL · DECISION JOURNAL != EXECUTOR
 *
 * Superfície DE AVALIAÇÃO, não de execução:
 * - POST /api/policy/evaluate  — avalia uma solicitação declarativa e
 *   retorna a decisão do Policy Engine (única fonte da regra).
 * - GET  /api/policy/journal   — consulta read-only do Decision Journal.
 *
 * Nenhuma rota deste módulo executa actions, cria jobs, chama Telegram,
 * Operator, autoHeal, LLM, marketplace ou mutação de products. Nenhuma
 * regra de política vive fora do Policy Engine (sem if agent/action/risk
 * paralelos).
 *
 * Autenticação: EXCLUSIVAMENTE o requireAdminAuth existente do server.ts.
 * Sem admin auth → 401. Rota pública: inexistente.
 */
import type { Express, Request, Response, NextFunction } from "express";
import {
  evaluatePolicy,
} from "../policyEngine/policyEngine";
import type { PolicyDecision, PolicyRequest } from "../policyEngine/types";
import { POLICY_REASON_CODE_CATALOG } from "../policyEngine/types";
import {
  deriveEvaluationId,
  insertEvaluation,
  listEvaluations,
  getEvaluation,
  sanitizeText,
} from "../repositories/policyJournalRepository";

export interface PolicyRouteParams {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: NextFunction) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valida o payload declarativo contra o contrato do Policy Engine
 *  (tipos e presença). NÃO aplica regras de política — regras vivem
 *  somente no engine; validação inválida → 400, nunca decisão inventada. */
function validateEvaluatePayload(body: unknown): {
  valid: true;
  request: PolicyRequest;
} | { valid: false; errors: string[] } {
  if (!isPlainObject(body)) {
    return { valid: false, errors: ["payload deve ser um objeto JSON"] };
  }
  const fields: ReadonlyArray<[string, keyof PolicyRequest]> = [
    ["agent_id", "agentId"],
    ["agent_version", "agentVersion"],
    ["policy_version", "policyVersion"],
    ["tool", "tool"],
    ["action", "action"],
    ["target_table", "targetTable"],
    ["risk", "risk"],
    ["memory_scope", "memoryScope"],
  ];
  const errors: string[] = [];
  const partial: Partial<Record<keyof PolicyRequest, string>> = {};
  for (const [field, key] of fields) {
    const value = body[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`campo obrigatório inválido: ${field}`);
    } else {
      partial[key] = value.trim();
    }
  }
  if (body.context !== undefined && typeof body.context !== "string") {
    errors.push("context deve ser string");
  }
  const approvalValues = ["NONE", "PENDING", "APPROVED", "REJECTED", "EXPIRED"];
  if (
    body.approval_state !== undefined &&
    !(typeof body.approval_state === "string" && approvalValues.includes(body.approval_state))
  ) {
    errors.push(
      `approval_state inválido; valores aceitos: ${approvalValues.join(", ")}`,
    );
  }
  if (errors.length > 0) return { valid: false, errors };
  const request: PolicyRequest = {
    agentId: partial.agentId as string,
    agentVersion: partial.agentVersion as string,
    policyVersion: partial.policyVersion as string,
    tool: partial.tool as string,
    action: partial.action as string,
    targetTable: partial.targetTable as string,
    risk: partial.risk as string,
    memoryScope: partial.memoryScope as string,
    context:
      typeof body.context === "string" ? sanitizeText(body.context) : undefined,
    approvalState:
      typeof body.approval_state === "string"
        ? (body.approval_state as PolicyRequest["approvalState"])
        : undefined,
  };
  return { valid: true, request };
}

/**
 * POST /api/policy/evaluate — avalia uma solicitação declarativa.
 * persist=false (default): avalia e retorna sem gravar.
 * persist=true: avalia, registra no Decision Journal (idempotente) e
 * retorna a MESMA decisão, com confirmação explícita da persistência.
 * persist=true NUNCA executa a action.
 */
export function registerPolicyEngineRoutes(params: PolicyRouteParams): void {
  const { app, requireAdminAuth } = params;

  app.post(
    "/api/policy/evaluate",
    requireAdminAuth,
    async (req: Request, res: Response) => {
      try {
        const payload = validateEvaluatePayload(req.body);
        if (payload.valid === false) {
          return res.status(400).json({
            success: false,
            code: "INVALID_PAYLOAD",
            errors: payload.errors,
            error: "Payload inválido. Nenhum avaliação foi executada.",
          });
        }

        // Única fonte da decisão: o Policy Engine.
        const decision: PolicyDecision = evaluatePolicy(payload.request);

        const persistParam = String(
          req.body && req.body.persist !== undefined ? req.body.persist : "false",
        )
          .trim()
          .toLowerCase();
        const persist = persistParam === "true";

        if (!persist) {
          return res.status(200).json({
            success: true,
            decision: decision.decision,
            reason_code: decision.reasonCode,
            reason: decision.reason,
            evaluationId: deriveEvaluationId(
              decision as PolicyDecision & {
                context?: string;
                approvalState?: string;
              },
            ),
            agent_id: decision.agentId,
            agent_version: decision.agentVersion,
            policy_version: decision.policyVersion,
            policy_engine_version: decision.policyEngineVersion,
            checks: decision.checks,
            persisted: false,
            note: "Avaliação declarativa somente. Nenhuma ação foi executada, nenhum job foi criado, nenhuma aprovação foi gerada.",
          });
        }

        const evaluationId = deriveEvaluationId(
          decision as PolicyDecision & {
            context?: string;
            approvalState?: string;
          },
        );
        const journalResult = await insertEvaluation({
          decision,
          evaluationId,
          context: payload.request.context,
          approvalState: payload.request.approvalState ?? null,
        });

        const baseResponse = {
          success: true,
          decision: decision.decision,
          reason_code: decision.reasonCode,
          reason: decision.reason,
          evaluationId,
          agent_id: decision.agentId,
          agent_version: decision.agentVersion,
          policy_version: decision.policyVersion,
          policy_engine_version: decision.policyEngineVersion,
          checks: decision.checks,
          persisted: true,
          note:
            decision.decision === "ALLOW"
              ? "Decisão declarativa persistida no Decision Journal. Nenhuma ação foi executada, nenhum job foi criado, nenhuma aprovação foi gerada. ALLOW != EXECUTION."
              : decision.decision === "REQUIRES_APPROVAL"
                ? "Decisão declarativa persistida no Decision Journal. A policy determinou que aprovação seria necessária; nenhuma aprovação ocorreu, nenhuma espera foi iniciada."
                : "Decisão declarativa persistida no Decision Journal. Nenhuma ação foi executada, nenhum job foi criado, nenhuma aprovação foi gerada.",
        };

        if (
          journalResult.outcome === "inserted" ||
          journalResult.outcome === "identical_duplicate"
        ) {
          return res.status(200).json({
            ...baseResponse,
            journal: {
              outcome: journalResult.outcome,
              evaluation_id: evaluationId,
            },
          });
        }

        // Falha do journal: a decisão continua válida (journalFailure !==
        // decisionDenied), mas a gravação não ocorreu — reportado
        // explicitamente. NUNCA transformar falha do journal em ALLOW.
        return res.status(200).json({
          ...baseResponse,
          journal: {
            outcome: journalResult.outcome,
            error: journalResult.error ?? null,
            persisted_actual: false,
            warning:
              "Falha de persistência do Decision Journal. A decisão acima é a decisão real do Policy Engine e NÃO deve ser tratada como autorização de execução.",
          },
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          code: "POLICY_ROUTE_ERROR",
          error: "Erro interno na rota de avaliação. Nenhuma ação foi executada.",
        });
      }
    },
  );

  /**
   * GET /api/policy/journal — consulta read-only do Decision Journal.
   * ?evaluation_id=... — uma avaliação específica;
   * ?decision=ALLOW|DENY|REQUIRES_APPROVAL&page=&page_size= — listagem.
   * Sem parâmetro: listagem padrão (página 1, 25 itens).
   * Somente leitura: nenhum PUT/PATCH/DELETE/CRUD é criado.
   */
  app.get(
    "/api/policy/journal",
    requireAdminAuth,
    async (req: Request, res: Response) => {
      try {
        const evaluationId =
          typeof req.query.evaluation_id === "string"
            ? req.query.evaluation_id.trim()
            : "";
        if (evaluationId) {
          const result = await getEvaluation(evaluationId);
          if (result.outcome === "missing_supabase" && result.record === undefined) {
            return res.status(404).json({
              success: false,
              code: "EVALUATION_NOT_FOUND",
              error: result.error ?? "avaliação não encontrada",
            });
          }
          if (result.outcome === "database_error") {
            return res.status(500).json({
              success: false,
              code: "JOURNAL_ERROR",
              error: result.error ?? "erro ao consultar o journal",
            });
          }
          return res.status(200).json({
            success: true,
            evaluation: result.record ?? null,
          });
        }
        const decisionParam =
          typeof req.query.decision === "string"
            ? req.query.decision.trim().toUpperCase()
            : null;
        const page = Number(req.query.page ?? "1");
        const pageSize = Number(req.query.page_size ?? "25");
        const result = await listEvaluations({
          page: Number.isFinite(page) ? page : 1,
          pageSize: Number.isFinite(pageSize) ? pageSize : 25,
          decision:
            decisionParam === "ALLOW" ||
            decisionParam === "DENY" ||
            decisionParam === "REQUIRES_APPROVAL"
              ? decisionParam
              : null,
        });
        if (result.outcome === "database_error") {
          return res.status(500).json({
            success: false,
            code: "JOURNAL_ERROR",
            error: result.error ?? "erro ao consultar o journal",
          });
        }
        const record = result.record as unknown as {
          evaluations: unknown[];
          page: number;
          pageSize: number;
          total: number;
        };
        return res.status(200).json({
          success: true,
          evaluations: record?.evaluations ?? [],
          page: record?.page ?? 1,
          page_size: record?.pageSize ?? 25,
          total: record?.total ?? 0,
        });
      } catch (error) {
        return res.status(500).json({
          success: false,
          code: "POLICY_ROUTE_ERROR",
          error: "Erro interno na consulta do journal.",
        });
      }
    },
  );
}
